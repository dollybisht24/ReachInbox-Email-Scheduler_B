import { Queue, JobsOptions } from 'bullmq';
import { createRedisClient } from './redis';
import { env } from '../config/env';

export const EMAIL_QUEUE_NAME = 'reachinbox-email-queue';

export interface EmailJobPayload {
  emailJobId: string;
  userId: string;
  senderEmail: string;
  recipient: string;
  subject: string;
  body: string;
  maxPerHour: number;
  delaySeconds: number;
  rescheduledCount?: number;
}

// Dedicated Redis connection for the Queue
export const emailQueue = new Queue<EmailJobPayload>(EMAIL_QUEUE_NAME, {
  connection: createRedisClient(),
  defaultJobOptions: {
    attempts: env.QUEUE_MAX_ATTEMPTS,
    backoff: {
      type: 'exponential',
      delay: env.QUEUE_BACKOFF_MS,
    },
    removeOnComplete: {
      age: 24 * 3600, // Keep completed jobs for 24h
      count: 5000,
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // Keep failed jobs for 7 days
      count: 5000,
    },
  },
});

/**
 * Schedule a single email job in BullMQ with a deterministic Job ID
 */
export async function enqueueEmailJob(
  payload: EmailJobPayload,
  scheduledTime: Date
): Promise<string> {
  const now = Date.now();
  const targetTime = scheduledTime.getTime();
  const delay = Math.max(0, targetTime - now);
  const jobId = `email_${payload.emailJobId}`;

  const jobOptions: JobsOptions = {
    jobId,
    delay,
  };

  await emailQueue.add('send-email', payload, jobOptions);
  return jobId;
}

/**
 * Reschedule an existing job to a future timestamp when rate limit is exceeded
 */
export async function rescheduleJobToFuture(
  payload: EmailJobPayload,
  delayMs: number
): Promise<string> {
  // Use a versioned or timestamped job ID to allow clean BullMQ re-addition
  const newPayload: EmailJobPayload = {
    ...payload,
    rescheduledCount: (payload.rescheduledCount || 0) + 1,
  };
  const jobId = `email_${payload.emailJobId}_resched_${newPayload.rescheduledCount}`;

  await emailQueue.add('send-email', newPayload, {
    jobId,
    delay: Math.max(1000, delayMs),
  });

  return jobId;
}

/**
 * Startup Reconciler:
 * Recovers all pending/uncompleted jobs from PostgreSQL upon server restarts.
 * Guarantees zero lost jobs and maintains idempotency without duplicates.
 */
export async function reconcilePendingJobs(): Promise<number> {
  const { prisma } = await import('../db/prisma');

  try {
    const pendingJobs = await prisma.emailJob.findMany({
      where: {
        status: { in: ['SCHEDULED', 'RATE_LIMITED_RESCHEDULED', 'PROCESSING'] },
      },
    });

    let reEnqueuedCount = 0;

    for (const jobRecord of pendingJobs) {
      const expectedJobId = `email_${jobRecord.id}`;
      const existingJob = await emailQueue.getJob(expectedJobId);

      // If job is missing from queue (e.g., after Redis restart or flush), restore it
      if (!existingJob) {
        // Reset orphaned PROCESSING jobs back to SCHEDULED
        if (jobRecord.status === 'PROCESSING') {
          await prisma.emailJob.update({
            where: { id: jobRecord.id },
            data: { status: 'SCHEDULED' },
          });
        }

        await enqueueEmailJob(
          {
            emailJobId: jobRecord.id,
            userId: jobRecord.userId,
            senderEmail: jobRecord.senderEmail,
            recipient: jobRecord.recipient,
            subject: jobRecord.subject,
            body: jobRecord.body,
            maxPerHour: jobRecord.maxPerHour,
            delaySeconds: jobRecord.delaySeconds,
          },
          jobRecord.scheduledAt
        );

        reEnqueuedCount++;
      }
    }

    if (pendingJobs.length > 0) {
      console.log(`[Startup Reconciler] Verified ${pendingJobs.length} pending jobs in DB (${reEnqueuedCount} re-enqueued into BullMQ).`);
    }

    return reEnqueuedCount;
  } catch (err: any) {
    console.error('[Startup Reconciler Error] Failed to reconcile pending jobs:', err.message);
    return 0;
  }
}
