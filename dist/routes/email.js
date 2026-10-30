"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.emailRouter = void 0;
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const zod_1 = require("zod");
const prisma_1 = require("../db/prisma");
const authMiddleware_1 = require("../middlewares/authMiddleware");
const emailQueue_1 = require("../queue/emailQueue");
const searchService_1 = require("../services/searchService");
const env_1 = require("../config/env");
exports.emailRouter = (0, express_1.Router)();
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
});
const ScheduleEmailSchema = zod_1.z.object({
    subject: zod_1.z.string().min(1, 'Subject is required').max(255),
    body: zod_1.z.string().min(1, 'Email body is required'),
    recipients: zod_1.z.array(zod_1.z.string().email('Invalid email address')).min(1, 'At least one recipient is required'),
    senderEmail: zod_1.z.string().email('Invalid sender email'),
    senderId: zod_1.z.string().optional(),
    startTime: zod_1.z.string().optional().nullable(),
    delaySeconds: zod_1.z.number().min(0).default(0),
    maxPerHour: zod_1.z.number().min(1).default(env_1.env.MAX_EMAILS_PER_HOUR_PER_SENDER),
});
/**
 * Schedule New Emails
 * Persists records in PostgreSQL first, then enqueues BullMQ delayed jobs
 */
exports.emailRouter.post('/api/emails/schedule', authMiddleware_1.requireAuth, async (req, res) => {
    try {
        const parsed = ScheduleEmailSchema.parse(req.body);
        const userId = req.user.id;
        // Validate sender ownership or resolve sender
        let senderId = parsed.senderId;
        if (!senderId) {
            const existingSender = await prisma_1.prisma.sender.findFirst({
                where: { userId, email: parsed.senderEmail },
            });
            if (existingSender) {
                senderId = existingSender.id;
            }
            else {
                const newSender = await prisma_1.prisma.sender.create({
                    data: {
                        userId,
                        email: parsed.senderEmail,
                        name: req.user.name || 'Sender',
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
            const record = await prisma_1.prisma.emailJob.create({
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
            await (0, emailQueue_1.enqueueEmailJob)({
                emailJobId: record.id,
                userId,
                senderEmail: record.senderEmail,
                recipient: record.recipient,
                subject: record.subject,
                body: record.body,
                maxPerHour: record.maxPerHour,
                delaySeconds: record.delaySeconds,
            }, scheduledTime);
            // Async index to Elasticsearch
            (0, searchService_1.indexEmailRecord)({
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
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            return res.status(400).json({ error: 'Validation failed', details: err.errors });
        }
        console.error('[Schedule Error]', err);
        return res.status(500).json({ error: 'Failed to schedule emails', message: err.message });
    }
});
/**
 * Fetch Scheduled Emails (SCHEDULED, RATE_LIMITED_RESCHEDULED, PROCESSING)
 */
exports.emailRouter.get('/api/emails/scheduled', authMiddleware_1.requireAuth, async (req, res) => {
    try {
        const emails = await prisma_1.prisma.emailJob.findMany({
            where: {
                userId: req.user.id,
                status: { in: ['SCHEDULED', 'RATE_LIMITED_RESCHEDULED', 'PROCESSING'] },
            },
            include: { sender: true },
            orderBy: { scheduledAt: 'asc' },
        });
        return res.json({ emails, count: emails.length });
    }
    catch (err) {
        return res.status(500).json({ error: 'Failed to fetch scheduled emails' });
    }
});
/**
 * Fetch Sent Emails (SENT, FAILED)
 */
exports.emailRouter.get('/api/emails/sent', authMiddleware_1.requireAuth, async (req, res) => {
    try {
        const emails = await prisma_1.prisma.emailJob.findMany({
            where: {
                userId: req.user.id,
                status: { in: ['SENT', 'FAILED'] },
            },
            include: { sender: true },
            orderBy: { updatedAt: 'desc' },
        });
        return res.json({ emails, count: emails.length });
    }
    catch (err) {
        return res.status(500).json({ error: 'Failed to fetch sent emails' });
    }
});
/**
 * Search emails by keyword using Elasticsearch with tenant isolation
 */
exports.emailRouter.get('/api/emails/search', authMiddleware_1.requireAuth, async (req, res) => {
    const query = req.query.q;
    if (!query || query.trim().length === 0) {
        return res.json({ total: 0, results: [] });
    }
    try {
        const searchResult = await (0, searchService_1.searchEmails)(req.user.id, query.trim());
        return res.json(searchResult);
    }
    catch (err) {
        return res.status(500).json({ error: 'Search query failed', message: err.message });
    }
});
/**
 * Recipient file parser (CSV / TXT upload)
 */
exports.emailRouter.post('/api/emails/parse-recipients', authMiddleware_1.requireAuth, upload.single('file'), (req, res) => {
    try {
        let content = '';
        if (req.file) {
            content = req.file.buffer.toString('utf-8');
        }
        else if (req.body.text) {
            content = req.body.text;
        }
        else {
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
    }
    catch (err) {
        return res.status(400).json({ error: 'Failed to parse recipients file', message: err.message });
    }
});
/**
 * Fetch a single email record by ID
 */
exports.emailRouter.get('/api/emails/:id', authMiddleware_1.requireAuth, async (req, res) => {
    try {
        const email = await prisma_1.prisma.emailJob.findFirst({
            where: {
                id: req.params.id,
                userId: req.user.id,
            },
            include: { sender: true },
        });
        if (!email) {
            return res.status(404).json({ error: 'Email record not found' });
        }
        return res.json({ email });
    }
    catch (err) {
        return res.status(500).json({ error: 'Failed to fetch email details' });
    }
});
/**
 * Cancel/Delete a scheduled email job
 */
exports.emailRouter.delete('/api/emails/:id', authMiddleware_1.requireAuth, async (req, res) => {
    try {
        const email = await prisma_1.prisma.emailJob.findFirst({
            where: {
                id: req.params.id,
                userId: req.user.id,
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
        const job = await (await Promise.resolve().then(() => __importStar(require('../queue/emailQueue')))).emailQueue.getJob(queueJobId);
        if (job) {
            await job.remove();
        }
        await prisma_1.prisma.emailJob.delete({
            where: { id: email.id },
        });
        return res.json({ success: true, message: 'Scheduled email cancelled successfully' });
    }
    catch (err) {
        return res.status(500).json({ error: 'Failed to cancel scheduled email' });
    }
});
/**
 * Configure Real Gmail / SMTP credentials for a Sender
 */
exports.emailRouter.post('/api/sender/smtp', authMiddleware_1.requireAuth, async (req, res) => {
    const { senderEmail, smtpUser, smtpPass, smtpHost, smtpPort, smtpSecure, name } = req.body;
    const userId = req.user.id;
    if (!senderEmail || typeof senderEmail !== 'string') {
        return res.status(400).json({ error: 'senderEmail is required' });
    }
    try {
        const isGmail = (smtpHost && smtpHost.includes('gmail')) || (smtpUser && smtpUser.includes('@gmail.com'));
        const existingSender = await prisma_1.prisma.sender.findFirst({
            where: { userId, email: senderEmail },
        });
        let sender;
        if (existingSender) {
            sender = await prisma_1.prisma.sender.update({
                where: { id: existingSender.id },
                data: {
                    smtpUser: smtpUser || null,
                    smtpPass: smtpPass || null,
                    smtpHost: smtpHost || (isGmail ? 'smtp.gmail.com' : null),
                    smtpPort: smtpPort ? Number(smtpPort) : (isGmail ? 465 : null),
                    smtpSecure: smtpSecure !== undefined ? Boolean(smtpSecure) : true,
                },
            });
        }
        else {
            sender = await prisma_1.prisma.sender.create({
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
    }
    catch (err) {
        return res.status(500).json({ error: 'Failed to save sender SMTP settings', message: err.message });
    }
});
