import { Router, Request, Response } from 'express';
import { prisma } from '../db/prisma';
import { redisClient } from '../queue/redis';
import { emailQueue } from '../queue/emailQueue';

export const healthRouter = Router();

healthRouter.get('/api/health', async (_req: Request, res: Response) => {
  let dbStatus = 'disconnected';
  let redisStatus = 'disconnected';
  let queueCounts = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = 'connected';
  } catch (err: any) {
    dbStatus = `error: ${err.message}`;
  }

  try {
    const ping = await redisClient.ping();
    redisStatus = ping === 'PONG' ? 'connected' : 'unresponsive';
  } catch (err: any) {
    redisStatus = `error: ${err.message}`;
  }

  try {
    queueCounts = await emailQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
  } catch (err: any) {
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
