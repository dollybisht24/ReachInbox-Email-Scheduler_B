"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const server_1 = require("./server");
const env_1 = require("./config/env");
const emailWorker_1 = require("./workers/emailWorker");
const emailQueue_1 = require("./queue/emailQueue");
const searchService_1 = require("./services/searchService");
const redis_1 = require("./queue/redis");
const prisma_1 = require("./db/prisma");
async function main() {
    console.log('--- Starting ReachInbox Email Scheduler System ---');
    // 1. Initialize Elasticsearch index if reachable
    (0, searchService_1.initElasticsearch)().catch((err) => {
        console.warn('[Elasticsearch Init Warning]', err.message);
    });
    // 2. Start BullMQ Worker in-process
    const worker = (0, emailWorker_1.startEmailWorker)();
    // 3. Reconcile any uncompleted/pending jobs from database across restarts
    await (0, emailQueue_1.reconcilePendingJobs)();
    // 4. Start Express HTTP Server
    const app = (0, server_1.createServer)();
    const server = app.listen(env_1.env.PORT, () => {
        console.log(`[ReachInbox API] Server running on http://localhost:${env_1.env.PORT}`);
        console.log(`[Bull Board] Queue dashboard running at http://localhost:${env_1.env.PORT}/admin/queues`);
        console.log(`[Environment] Concurrency: ${env_1.env.WORKER_CONCURRENCY} | Max/Hour: ${env_1.env.MAX_EMAILS_PER_HOUR_PER_SENDER}`);
    });
    // Graceful shutdown handling
    const shutdown = async (signal) => {
        console.log(`\n[Shutdown] Received ${signal}. Closing worker, queue, and database gracefully...`);
        try {
            server.close();
            await worker.close();
            await redis_1.redisClient.quit();
            await prisma_1.prisma.$disconnect();
            console.log('[Shutdown] All connections terminated cleanly.');
            process.exit(0);
        }
        catch (err) {
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
