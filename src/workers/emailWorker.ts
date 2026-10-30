import { Worker, Job } from 'bullmq';
import { EMAIL_QUEUE_NAME, EmailJobPayload, rescheduleJobToFuture } from '../queue/emailQueue';
import { createRedisClient } from '../queue/redis';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { checkAndIncrementSenderRateLimit } from '../services/rateLimiter';
import { sendEtherealEmail } from '../services/emailService';
import { notifySlackHourlyLimitHit } from '../services/slackService';
import { indexEmailRecord } from '../services/searchService';

/**
 * Core processor for individual email jobs
 */
export async function processEmailJob(job: Job<EmailJobPayload>): Promise<any> {
  const { emailJobId, userId, senderEmail, recipient, subject, body, maxPerHour } = job.data;

  console.log(`[Worker] Processing Job ${job.id} for EmailRecord ${emailJobId} -> ${recipient}`);

  // 1. Idempotency Check & Status Validation from PostgreSQL
  const emailRecord = await prisma.emailJob.findUnique({
    where: { id: emailJobId },
    include: { sender: true },
  });

  if (!emailRecord) {
    console.warn(`[Worker Warning] EmailRecord ${emailJobId} not found in database. Skipping.`);
    return { skipped: true, reason: 'Record not found' };
  }

  // Idempotency: Do not resend if already marked SENT
  if (emailRecord.status === 'SENT') {
    console.log(`[Worker Idempotency] Job ${job.id} was already marked SENT. Skipping duplicate execution.`);
    return { skipped: true, reason: 'Already sent' };
  }

  // 2. Enforce atomic Redis hourly rate limit per sender
  const limitToEnforce = emailRecord.maxPerHour || maxPerHour || env.MAX_EMAILS_PER_HOUR_PER_SENDER;
  const rateLimitResult = await checkAndIncrementSenderRateLimit(senderEmail, limitToEnforce);

  if (!rateLimitResult.allowed) {
    console.warn(
      `[Worker Rate Limit Reached] Sender: ${senderEmail} has reached hourly capacity (${limitToEnforce}/hr). Rescheduling job ${job.id} into next hour window (+${Math.round(rateLimitResult.delayMsUntilNextWindow / 1000)}s)...`
    );

    const nextScheduledTime = new Date(Date.now() + rateLimitResult.delayMsUntilNextWindow);

    // Update database record to reflect rate-limited reschedule status and new target time
    await prisma.emailJob.update({
      where: { id: emailJobId },
      data: {
        status: 'RATE_LIMITED_RESCHEDULED',
        scheduledAt: nextScheduledTime,
      },
    });

    // Re-enqueue job in BullMQ for the future window (never drop or permanently fail!)
    await rescheduleJobToFuture(job.data, rateLimitResult.delayMsUntilNextWindow);

    // Trigger Slack notification (deduplicated per sender and hour bucket)
    await notifySlackHourlyLimitHit({
      userId,
      senderEmail,
      hourlyLimit: limitToEnforce,
      hourBucket: rateLimitResult.hourBucket,
      delayMsUntilNextWindow: rateLimitResult.delayMsUntilNextWindow,
    });

    return {
      rescheduled: true,
      nextScheduledTime,
      delayMs: rateLimitResult.delayMsUntilNextWindow,
    };
  }

  // 3. Mark record as PROCESSING in PostgreSQL
  await prisma.emailJob.update({
    where: { id: emailJobId },
    data: {
      status: 'PROCESSING',
      attempts: { increment: 1 },
    },
  });

  // Optional: Apply configurable minimum delay between sends if requested
  if (env.MIN_DELAY_BETWEEN_EMAILS_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, env.MIN_DELAY_BETWEEN_EMAILS_MS));
  }

  // 4. Send actual email via Real Gmail/SMTP or Ethereal test SMTP
  let senderSmtp = emailRecord.sender?.smtpPass
    ? {
        smtpHost: emailRecord.sender.smtpHost,
        smtpPort: emailRecord.sender.smtpPort,
        smtpSecure: emailRecord.sender.smtpSecure,
        smtpUser: emailRecord.sender.smtpUser,
        smtpPass: emailRecord.sender.smtpPass,
      }
    : undefined;

  if (!senderSmtp) {
    const liveSender = await prisma.sender.findFirst({
      where: { userId: emailRecord.userId, email: senderEmail },
    });
    if (liveSender?.smtpPass) {
      senderSmtp = {
        smtpHost: liveSender.smtpHost,
        smtpPort: liveSender.smtpPort,
        smtpSecure: liveSender.smtpSecure,
        smtpUser: liveSender.smtpUser,
        smtpPass: liveSender.smtpPass,
      };
    }
  }

  const sendResult = await sendEtherealEmail({
    fromName: emailRecord.sender?.name || 'ReachInbox Outbox',
    fromEmail: senderEmail,
    toEmail: recipient,
    subject,
    body,
    senderSmtp,
  });

  // 5. Handle Outcome & Persist
  if (sendResult.success) {
    // Record success in PostgreSQL
    const updated = await prisma.emailJob.update({
      where: { id: emailJobId },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        messageId: sendResult.messageId,
        etherealPreviewUrl: sendResult.previewUrl || null,
        errorMessage: null,
      },
    });

    // Update Elasticsearch Index
    await indexEmailRecord({
      id: updated.id,
      userId: updated.userId,
      senderEmail: updated.senderEmail,
      recipient: updated.recipient,
      subject: updated.subject,
      body: updated.body,
      status: 'SENT',
      scheduledAt: updated.scheduledAt,
      sentAt: updated.sentAt,
      createdAt: updated.createdAt,
    });

    return {
      success: true,
      messageId: sendResult.messageId,
      previewUrl: sendResult.previewUrl,
    };
  } else {
    // Delivery failure: evaluate retry attempts
    const isFinalAttempt = job.attemptsMade >= (job.opts.attempts || env.QUEUE_MAX_ATTEMPTS) - 1;

    if (isFinalAttempt) {
      // Record permanent failure in PostgreSQL
      const updated = await prisma.emailJob.update({
        where: { id: emailJobId },
        data: {
          status: 'FAILED',
          failedAt: new Date(),
          errorMessage: sendResult.error || 'SMTP delivery failure',
        },
      });

      // Update Elasticsearch Index
      await indexEmailRecord({
        id: updated.id,
        userId: updated.userId,
        senderEmail: updated.senderEmail,
        recipient: updated.recipient,
        subject: updated.subject,
        body: updated.body,
        status: 'FAILED',
        scheduledAt: updated.scheduledAt,
        sentAt: null,
        createdAt: updated.createdAt,
      });
    }

    // Throw error so BullMQ triggers exponential backoff retry if attempts remain
    throw new Error(`SMTP Send Failed: ${sendResult.error}`);
  }
}

/**
 * Creates and initializes the BullMQ Worker
 */
export function startEmailWorker(): Worker<EmailJobPayload> {
  const worker = new Worker<EmailJobPayload>(EMAIL_QUEUE_NAME, processEmailJob, {
    connection: createRedisClient(),
    concurrency: env.WORKER_CONCURRENCY,
    lockDuration: 30000,
  });

  worker.on('ready', () => {
    console.log(`[EmailWorker] Worker online with concurrency: ${env.WORKER_CONCURRENCY}`);
  });

  worker.on('completed', (job) => {
    console.log(`[EmailWorker] Job ${job.id} completed successfully`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[EmailWorker] Job ${job?.id} failed: ${err.message}`);
  });

  worker.on('error', (err) => {
    console.error('[EmailWorker Error]', err.message);
  });

  return worker;
}
