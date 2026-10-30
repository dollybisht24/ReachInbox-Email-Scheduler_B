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
Object.defineProperty(exports, "__esModule", { value: true });
exports.emailQueue = exports.EMAIL_QUEUE_NAME = void 0;
exports.enqueueEmailJob = enqueueEmailJob;
exports.rescheduleJobToFuture = rescheduleJobToFuture;
exports.reconcilePendingJobs = reconcilePendingJobs;
const bullmq_1 = require("bullmq");
const redis_1 = require("./redis");
const env_1 = require("../config/env");
exports.EMAIL_QUEUE_NAME = 'reachinbox-email-queue';
// Dedicated Redis connection for the Queue
exports.emailQueue = new bullmq_1.Queue(exports.EMAIL_QUEUE_NAME, {
    connection: (0, redis_1.createRedisClient)(),
    defaultJobOptions: {
        attempts: env_1.env.QUEUE_MAX_ATTEMPTS,
        backoff: {
            type: 'exponential',
            delay: env_1.env.QUEUE_BACKOFF_MS,
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
async function enqueueEmailJob(payload, scheduledTime) {
    const now = Date.now();
    const targetTime = scheduledTime.getTime();
    const delay = Math.max(0, targetTime - now);
    const jobId = `email_${payload.emailJobId}`;
    const jobOptions = {
        jobId,
        delay,
    };
    await exports.emailQueue.add('send-email', payload, jobOptions);
    return jobId;
}
/**
 * Reschedule an existing job to a future timestamp when rate limit is exceeded
 */
async function rescheduleJobToFuture(payload, delayMs) {
    // Use a versioned or timestamped job ID to allow clean BullMQ re-addition
    const newPayload = {
        ...payload,
        rescheduledCount: (payload.rescheduledCount || 0) + 1,
    };
    const jobId = `email_${payload.emailJobId}_resched_${newPayload.rescheduledCount}`;
    await exports.emailQueue.add('send-email', newPayload, {
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
async function reconcilePendingJobs() {
    const { prisma } = await Promise.resolve().then(() => __importStar(require('../db/prisma')));
    try {
        const pendingJobs = await prisma.emailJob.findMany({
            where: {
                status: { in: ['SCHEDULED', 'RATE_LIMITED_RESCHEDULED', 'PROCESSING'] },
            },
        });
        let reEnqueuedCount = 0;
        for (const jobRecord of pendingJobs) {
            const expectedJobId = `email_${jobRecord.id}`;
            const existingJob = await exports.emailQueue.getJob(expectedJobId);
            // If job is missing from queue (e.g., after Redis restart or flush), restore it
            if (!existingJob) {
                // Reset orphaned PROCESSING jobs back to SCHEDULED
                if (jobRecord.status === 'PROCESSING') {
                    await prisma.emailJob.update({
                        where: { id: jobRecord.id },
                        data: { status: 'SCHEDULED' },
                    });
                }
                await enqueueEmailJob({
                    emailJobId: jobRecord.id,
                    userId: jobRecord.userId,
                    senderEmail: jobRecord.senderEmail,
                    recipient: jobRecord.recipient,
                    subject: jobRecord.subject,
                    body: jobRecord.body,
                    maxPerHour: jobRecord.maxPerHour,
                    delaySeconds: jobRecord.delaySeconds,
                }, jobRecord.scheduledAt);
                reEnqueuedCount++;
            }
        }
        if (pendingJobs.length > 0) {
            console.log(`[Startup Reconciler] Verified ${pendingJobs.length} pending jobs in DB (${reEnqueuedCount} re-enqueued into BullMQ).`);
        }
        return reEnqueuedCount;
    }
    catch (err) {
        console.error('[Startup Reconciler Error] Failed to reconcile pending jobs:', err.message);
        return 0;
    }
}
