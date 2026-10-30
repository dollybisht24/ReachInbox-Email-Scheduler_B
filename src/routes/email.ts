import { Router, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { requireAuth, AuthenticatedRequest } from '../middlewares/authMiddleware';
import { enqueueEmailJob } from '../queue/emailQueue';
import { indexEmailRecord, searchEmails } from '../services/searchService';
import { env } from '../config/env';

export const emailRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
});

const ScheduleEmailSchema = z.object({
  subject: z.string().min(1, 'Subject is required').max(255),
  body: z.string().min(1, 'Email body is required'),
  recipients: z.array(z.string().email('Invalid email address')).min(1, 'At least one recipient is required'),
  senderEmail: z.string().email('Invalid sender email'),
  senderId: z.string().optional(),
  startTime: z.string().optional().nullable(),
  delaySeconds: z.number().min(0).default(0),
  maxPerHour: z.number().min(1).default(env.MAX_EMAILS_PER_HOUR_PER_SENDER),
});

/**
 * Schedule New Emails
 * Persists records in PostgreSQL first, then enqueues BullMQ delayed jobs
 */
emailRouter.post('/api/emails/schedule', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const parsed = ScheduleEmailSchema.parse(req.body);
    const userId = req.user!.id;

    // Validate sender ownership or resolve sender
    let senderId = parsed.senderId;
    if (!senderId) {
      const existingSender = await prisma.sender.findFirst({
        where: { userId, email: parsed.senderEmail },
      });
      if (existingSender) {
        senderId = existingSender.id;
      } else {
        const newSender = await prisma.sender.create({
          data: {
            userId,
            email: parsed.senderEmail,
            name: req.user!.name || 'Sender',
            hourlyLimit: parsed.maxPerHour,
          },
        });
        senderId = newSender.id;
      }
    }

    const baseStartTime = parsed.startTime ? new Date(parsed.startTime).getTime() : Date.now();
    const delayStepMs = parsed.delaySeconds * 1000;

    // Persist records in PostgreSQL
    const createdRecords = [];
    for (let i = 0; i < parsed.recipients.length; i++) {
      const recipient = parsed.recipients[i];
      // Target schedule time staggered by delaySeconds per recipient
      const scheduledTime = new Date(baseStartTime + i * delayStepMs);

      const record = await prisma.emailJob.create({
        data: {
          userId,
          senderId,
          senderEmail: parsed.senderEmail,
          recipient,
          subject: parsed.subject,
          body: parsed.body,
          status: 'SCHEDULED',
          scheduledAt: scheduledTime,
          delaySeconds: parsed.delaySeconds,
          maxPerHour: parsed.maxPerHour,
        },
      });

      // Enqueue delayed job in BullMQ with deterministic ID
      await enqueueEmailJob(
        {
          emailJobId: record.id,
          userId,
          senderEmail: record.senderEmail,
          recipient: record.recipient,
          subject: record.subject,
          body: record.body,
          maxPerHour: record.maxPerHour,
          delaySeconds: record.delaySeconds,
        },
        scheduledTime
      );

      // Async index to Elasticsearch
      indexEmailRecord({
        id: record.id,
        userId: record.userId,
        senderEmail: record.senderEmail,
        recipient: record.recipient,
        subject: record.subject,
        body: record.body,
        status: 'SCHEDULED',
        scheduledAt: record.scheduledAt,
        createdAt: record.createdAt,
      }).catch((e) => console.warn(`ES indexing error on schedule: ${e.message}`));

      createdRecords.push(record);
    }

    return res.status(201).json({
      success: true,
      scheduledCount: createdRecords.length,
      emails: createdRecords,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: err.errors });
    }
    console.error('[Schedule Error]', err);
    return res.status(500).json({ error: 'Failed to schedule emails', message: err.message });
  }
});

/**
 * Fetch Scheduled Emails (SCHEDULED, RATE_LIMITED_RESCHEDULED, PROCESSING)
 */
emailRouter.get('/api/emails/scheduled', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const emails = await prisma.emailJob.findMany({
      where: {
        userId: req.user!.id,
        status: { in: ['SCHEDULED', 'RATE_LIMITED_RESCHEDULED', 'PROCESSING'] },
      },
      include: { sender: true },
      orderBy: { scheduledAt: 'asc' },
    });

    return res.json({ emails, count: emails.length });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to fetch scheduled emails' });
  }
});

/**
 * Fetch Sent Emails (SENT, FAILED)
 */
emailRouter.get('/api/emails/sent', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const emails = await prisma.emailJob.findMany({
      where: {
        userId: req.user!.id,
        status: { in: ['SENT', 'FAILED'] },
      },
      include: { sender: true },
      orderBy: { updatedAt: 'desc' },
    });

    return res.json({ emails, count: emails.length });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to fetch sent emails' });
  }
});

/**
 * Search emails by keyword using Elasticsearch with tenant isolation
 */
emailRouter.get('/api/emails/search', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const query = req.query.q as string;
  if (!query || query.trim().length === 0) {
    return res.json({ total: 0, results: [] });
  }

  try {
    const searchResult = await searchEmails(req.user!.id, query.trim());
    return res.json(searchResult);
  } catch (err: any) {
    return res.status(500).json({ error: 'Search query failed', message: err.message });
  }
});

/**
 * Recipient file parser (CSV / TXT upload)
 */
emailRouter.post(
  '/api/emails/parse-recipients',
  requireAuth,
  upload.single('file'),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      let content = '';
      if (req.file) {
        content = req.file.buffer.toString('utf-8');
      } else if (req.body.text) {
        content = req.body.text;
      } else {
        return res.status(400).json({ error: 'No file or text provided' });
      }

      // Regex to extract all valid email addresses
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      const matches = content.match(emailRegex) || [];
      const uniqueEmails = Array.from(new Set(matches.map((e) => e.toLowerCase().trim())));

      return res.json({
        success: true,
        count: uniqueEmails.length,
        recipients: uniqueEmails,
        preview: uniqueEmails.slice(0, 10),
      });
    } catch (err: any) {
      return res.status(400).json({ error: 'Failed to parse recipients file', message: err.message });
    }
  }
);

/**
 * Fetch a single email record by ID
 */
emailRouter.get('/api/emails/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const email = await prisma.emailJob.findFirst({
      where: {
        id: req.params.id,
        userId: req.user!.id,
      },
      include: { sender: true },
    });

    if (!email) {
      return res.status(404).json({ error: 'Email record not found' });
    }

    return res.json({ email });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to fetch email details' });
  }
});

/**
 * Cancel/Delete a scheduled email job
 */
emailRouter.delete('/api/emails/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const email = await prisma.emailJob.findFirst({
      where: {
        id: req.params.id,
        userId: req.user!.id,
      },
    });

    if (!email) {
      return res.status(404).json({ error: 'Email record not found' });
    }

    if (email.status === 'SENT') {
      return res.status(400).json({ error: 'Cannot cancel an email that has already been sent' });
    }

    // Attempt to remove from BullMQ queue
    const queueJobId = `email_${email.id}`;
    const job = await (await import('../queue/emailQueue')).emailQueue.getJob(queueJobId);
    if (job) {
      await job.remove();
    }

    await prisma.emailJob.delete({
      where: { id: email.id },
    });

    return res.json({ success: true, message: 'Scheduled email cancelled successfully' });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to cancel scheduled email' });
  }
});

/**
 * Configure Real Gmail / SMTP credentials for a Sender
 */
emailRouter.post('/api/sender/smtp', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { senderEmail, smtpUser, smtpPass, smtpHost, smtpPort, smtpSecure, name } = req.body;
  const userId = req.user!.id;

  if (!senderEmail || typeof senderEmail !== 'string') {
    return res.status(400).json({ error: 'senderEmail is required' });
  }

  try {
    const isGmail = (smtpHost && smtpHost.includes('gmail')) || (smtpUser && smtpUser.includes('@gmail.com'));

    const existingSender = await prisma.sender.findFirst({
      where: { userId, email: senderEmail },
    });

    let sender;
    if (existingSender) {
      sender = await prisma.sender.update({
        where: { id: existingSender.id },
        data: {
          smtpUser: smtpUser || null,
          smtpPass: smtpPass || null,
          smtpHost: smtpHost || (isGmail ? 'smtp.gmail.com' : null),
          smtpPort: smtpPort ? Number(smtpPort) : (isGmail ? 465 : null),
          smtpSecure: smtpSecure !== undefined ? Boolean(smtpSecure) : true,
        },
      });
    } else {
      sender = await prisma.sender.create({
        data: {
          userId,
          email: senderEmail,
          name: name || senderEmail.split('@')[0],
          smtpUser: smtpUser || null,
          smtpPass: smtpPass || null,
          smtpHost: smtpHost || (isGmail ? 'smtp.gmail.com' : null),
          smtpPort: smtpPort ? Number(smtpPort) : (isGmail ? 465 : null),
          smtpSecure: smtpSecure !== undefined ? Boolean(smtpSecure) : true,
        },
      });
    }

    console.log(`[Sender SMTP] Configured real sending credentials for sender: ${senderEmail}`);
    return res.json({
      success: true,
      message: 'SMTP credentials configured successfully',
      sender: {
        id: sender.id,
        email: sender.email,
        hasSmtpConfigured: Boolean(sender.smtpUser && sender.smtpPass),
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to save sender SMTP settings', message: err.message });
  }
});
