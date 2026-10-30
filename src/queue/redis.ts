import IORedis, { RedisOptions } from 'ioredis';
import { env } from '../config/env';

export const redisOptions: RedisOptions = {
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false,
};

export const createRedisClient = () => {
  return new IORedis(env.REDIS_URL, redisOptions);
};

// Singleton client for direct commands (rate limiter, cache, deduplication)
export const redisClient = createRedisClient();

redisClient.on('error', (err) => {
  console.error('[Redis Client Error]', err.message);
});

redisClient.on('connect', () => {
  console.log('[Redis] Connected successfully to Redis server');
});
