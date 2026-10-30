"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.redisClient = exports.createRedisClient = exports.redisOptions = void 0;
const ioredis_1 = __importDefault(require("ioredis"));
const env_1 = require("../config/env");
exports.redisOptions = {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
};
const createRedisClient = () => {
    return new ioredis_1.default(env_1.env.REDIS_URL, exports.redisOptions);
};
exports.createRedisClient = createRedisClient;
// Singleton client for direct commands (rate limiter, cache, deduplication)
exports.redisClient = (0, exports.createRedisClient)();
exports.redisClient.on('error', (err) => {
    console.error('[Redis Client Error]', err.message);
});
exports.redisClient.on('connect', () => {
    console.log('[Redis] Connected successfully to Redis server');
});
