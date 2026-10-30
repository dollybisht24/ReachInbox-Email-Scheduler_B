"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthRouter = void 0;
const express_1 = require("express");
const prisma_1 = require("../db/prisma");
const redis_1 = require("../queue/redis");
const emailQueue_1 = require("../queue/emailQueue");
exports.healthRouter = (0, express_1.Router)();
exports.healthRouter.get('/api/health', async (_req, res) => {
    let dbStatus = 'disconnected';
    let redisStatus = 'disconnected';
    let queueCounts = {};
    try {
        await prisma_1.prisma.$queryRaw `SELECT 1`;
        dbStatus = 'connected';
    }
    catch (err) {
        dbStatus = `error: ${err.message}`;
    }
    try {
        const ping = await redis_1.redisClient.ping();
        redisStatus = ping === 'PONG' ? 'connected' : 'unresponsive';
    }
    catch (err) {
        redisStatus = `error: ${err.message}`;
    }
    try {
        queueCounts = await emailQueue_1.emailQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
    }
    catch (err) {
        queueCounts = { error: err.message };
    }
    const isHealthy = dbStatus === 'connected' && redisStatus === 'connected';
    res.status(isHealthy ? 200 : 503).json({
        status: isHealthy ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        services: {
            database: dbStatus,
            redis: redisStatus,
            queue: queueCounts,
        },
    });
});
