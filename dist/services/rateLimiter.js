"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getHourBucket = getHourBucket;
exports.getMsUntilNextHourWindow = getMsUntilNextHourWindow;
exports.checkAndIncrementSenderRateLimit = checkAndIncrementSenderRateLimit;
exports.getSenderCurrentHourUsage = getSenderCurrentHourUsage;
const redis_1 = require("../queue/redis");
/**
 * Atomic Redis Lua Script to check and increment hourly sender counter
 * Returns:
 *   -1 if the current count is >= limit (rate limit hit)
 *   newVal (>= 1) if successfully incremented
 */
const RATE_LIMIT_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

local current = redis.call('GET', key)
if current and tonumber(current) >= limit then
  return -1
end

local newVal = redis.call('INCR', key)
if newVal == 1 then
  redis.call('EXPIRE', key, ttl)
end

return newVal
`;
/**
 * Computes the current 1-hour time bucket (Unix epoch in hours)
 */
function getHourBucket(date = new Date()) {
    return Math.floor(date.getTime() / 3600000);
}
/**
 * Calculates remaining milliseconds until the next hour window starts
 */
function getMsUntilNextHourWindow(date = new Date()) {
    const currentBucket = getHourBucket(date);
    const nextBucketStart = (currentBucket + 1) * 3600000;
    const diff = nextBucketStart - date.getTime();
    // Add a small jitter (1-5s) to prevent thundering herd when the next hour window begins
    const jitter = Math.floor(Math.random() * 3000) + 1000;
    return Math.max(1000, diff + jitter);
}
/**
 * Checks and atomically increments the sender's hourly quota.
 * Returns whether sending is allowed, or if rate limit exceeded along with delay until next window.
 */
async function checkAndIncrementSenderRateLimit(senderEmail, hourlyLimit) {
    const normalizedSender = senderEmail.toLowerCase().trim();
    const bucket = getHourBucket();
    const key = `ratelimit:${normalizedSender}:${bucket}`;
    const ttlSeconds = 7200; // 2 hours TTL for clean expiration
    try {
        const result = (await redis_1.redisClient.eval(RATE_LIMIT_LUA, 1, key, hourlyLimit.toString(), ttlSeconds.toString()));
        const delayUntilNext = getMsUntilNextHourWindow();
        if (result === -1) {
            // Limit exceeded
            const current = await redis_1.redisClient.get(key);
            return {
                allowed: false,
                currentCount: parseInt(current || `${hourlyLimit}`, 10),
                limit: hourlyLimit,
                hourBucket: bucket,
                delayMsUntilNextWindow: delayUntilNext,
            };
        }
        return {
            allowed: true,
            currentCount: result,
            limit: hourlyLimit,
            hourBucket: bucket,
            delayMsUntilNextWindow: delayUntilNext,
        };
    }
    catch (error) {
        console.error('[RateLimiter Error] Failed to execute atomic script:', error);
        // In case of Redis error, fail open or safely retry
        throw error;
    }
}
/**
 * Helper to inspect current hourly usage without incrementing
 */
async function getSenderCurrentHourUsage(senderEmail) {
    const normalizedSender = senderEmail.toLowerCase().trim();
    const bucket = getHourBucket();
    const key = `ratelimit:${normalizedSender}:${bucket}`;
    const count = await redis_1.redisClient.get(key);
    return count ? parseInt(count, 10) : 0;
}
