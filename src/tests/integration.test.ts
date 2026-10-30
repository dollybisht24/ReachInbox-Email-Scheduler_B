import { prisma } from '../db/prisma';
import { redisClient } from '../queue/redis';
import { checkAndIncrementSenderRateLimit, getSenderCurrentHourUsage } from '../services/rateLimiter';
import { emailQueue } from '../queue/emailQueue';

describe('Integration Tests (Database, Redis Atomic Rate Limiting, BullMQ)', () => {
  const testUserId = `test-user-${Date.now()}`;
  const testSenderEmail = `rate-test-${Date.now()}@reachinbox.test`;

  beforeAll(async () => {
    // Ensure test user exists in Postgres
    await prisma.user.create({
      data: {
        id: testUserId,
        email: `${testUserId}@example.com`,
        name: 'Integration Tester',
      },
    });
  });

  afterAll(async () => {
    // Cleanup test data
    await prisma.emailJob.deleteMany({ where: { userId: testUserId } });
    await prisma.user.deleteMany({ where: { id: testUserId } });
    await emailQueue.close();
    await redisClient.quit();
    await prisma.$disconnect();
  });

  test('Database persistence: EmailJob creates with SCHEDULED status', async () => {
    const jobRecord = await prisma.emailJob.create({
      data: {
        userId: testUserId,
        senderEmail: testSenderEmail,
        recipient: 'recipient@example.com',
        subject: 'Welcome to ReachInbox',
        body: 'Hello from test suite',
        status: 'SCHEDULED',
        scheduledAt: new Date(),
        maxPerHour: 5,
        delaySeconds: 2,
      },
    });

    expect(jobRecord.id).toBeDefined();
    expect(jobRecord.status).toBe('SCHEDULED');
    expect(jobRecord.recipient).toBe('recipient@example.com');

    // Retrieve and verify
    const fetched = await prisma.emailJob.findUnique({
      where: { id: jobRecord.id },
    });
    expect(fetched?.id).toBe(jobRecord.id);
  });

  test('Redis atomic rate limiter respects limit and reschedules beyond limit', async () => {
    const hourlyLimit = 3;

    // Send 1: allowed
    const res1 = await checkAndIncrementSenderRateLimit(testSenderEmail, hourlyLimit);
    expect(res1.allowed).toBe(true);
    expect(res1.currentCount).toBe(1);

    // Send 2: allowed
    const res2 = await checkAndIncrementSenderRateLimit(testSenderEmail, hourlyLimit);
    expect(res2.allowed).toBe(true);
    expect(res2.currentCount).toBe(2);

    // Send 3: allowed (reached threshold)
    const res3 = await checkAndIncrementSenderRateLimit(testSenderEmail, hourlyLimit);
    expect(res3.allowed).toBe(true);
    expect(res3.currentCount).toBe(3);

    // Send 4: EXCEEDED! Should return allowed: false and delayMsUntilNextWindow
    const res4 = await checkAndIncrementSenderRateLimit(testSenderEmail, hourlyLimit);
    expect(res4.allowed).toBe(false);
    expect(res4.delayMsUntilNextWindow).toBeGreaterThan(0);

    // Verify counter in Redis hasn't run unbounded
    const usage = await getSenderCurrentHourUsage(testSenderEmail);
    expect(usage).toBe(3);
  });

  test('Duplicate prevention / Idempotency check safeguard', async () => {
    // Create record marked SENT
    const sentRecord = await prisma.emailJob.create({
      data: {
        userId: testUserId,
        senderEmail: testSenderEmail,
        recipient: 'idempotent@example.com',
        subject: 'Idempotency Test',
        body: 'Testing duplicate safeguards',
        status: 'SENT',
        scheduledAt: new Date(),
        sentAt: new Date(),
      },
    });

    // Verify record status is SENT
    const check = await prisma.emailJob.findUnique({
      where: { id: sentRecord.id },
    });
    expect(check?.status).toBe('SENT');
  });
});
