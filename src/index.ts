import { createServer } from './server';
import { env } from './config/env';
import { startEmailWorker } from './workers/emailWorker';
import { reconcilePendingJobs } from './queue/emailQueue';
import { initElasticsearch } from './services/searchService';
import { redisClient } from './queue/redis';
import { prisma } from './db/prisma';

async function main() {
  console.log('--- Starting ReachInbox Email Scheduler System ---');

  // 1. Initialize Elasticsearch index if reachable
  initElasticsearch().catch((err) => {
    console.warn('[Elasticsearch Init Warning]', err.message);
  });

  // 2. Start BullMQ Worker in-process
  const worker = startEmailWorker();

  // 3. Reconcile any uncompleted/pending jobs from database across restarts
  await reconcilePendingJobs();

  // 4. Start Express HTTP Server
  const app = createServer();
  const server = app.listen(env.PORT, () => {
    console.log(`[ReachInbox API] Server running on http://localhost:${env.PORT}`);
    console.log(`[Bull Board] Queue dashboard running at http://localhost:${env.PORT}/admin/queues`);
    console.log(`[Environment] Concurrency: ${env.WORKER_CONCURRENCY} | Max/Hour: ${env.MAX_EMAILS_PER_HOUR_PER_SENDER}`);
  });

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    console.log(`\n[Shutdown] Received ${signal}. Closing worker, queue, and database gracefully...`);
    try {
      server.close();
      await worker.close();
      await redisClient.quit();
      await prisma.$disconnect();
      console.log('[Shutdown] All connections terminated cleanly.');
      process.exit(0);
    } catch (err: any) {
      console.error('[Shutdown Error]', err.message);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[Fatal Startup Error]', err);
  process.exit(1);
});
