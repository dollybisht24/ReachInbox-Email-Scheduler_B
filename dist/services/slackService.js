"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSlackAuthUrl = getSlackAuthUrl;
exports.exchangeSlackCode = exchangeSlackCode;
exports.notifySlackHourlyLimitHit = notifySlackHourlyLimitHit;
const axios_1 = __importDefault(require("axios"));
const env_1 = require("../config/env");
const prisma_1 = require("../db/prisma");
const redis_1 = require("../queue/redis");
/**
 * Generates the Slack OAuth v2 authorization URL
 */
function getSlackAuthUrl(state) {
    if (!env_1.env.SLACK_CLIENT_ID) {
        throw new Error('SLACK_CLIENT_ID is not configured in environment variables');
    }
    const scopes = [
        'chat:write',
        'channels:read',
        'incoming-webhook',
    ].join(',');
    const params = new URLSearchParams({
        client_id: env_1.env.SLACK_CLIENT_ID,
        scope: scopes,
        redirect_uri: env_1.env.SLACK_CALLBACK_URL,
        state,
    });
    return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}
/**
 * Exchanges the authorization code for an OAuth access token
 */
async function exchangeSlackCode(code) {
    const params = new URLSearchParams({
        client_id: env_1.env.SLACK_CLIENT_ID,
        client_secret: env_1.env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: env_1.env.SLACK_CALLBACK_URL,
    });
    const response = await axios_1.default.post('https://slack.com/api/oauth.v2.access', params.toString(), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
    });
    return response.data;
}
/**
 * Posts a notification to Slack when an hourly sender rate limit is exceeded.
 * Safe fallback: if Slack is not connected or fails, logs warning and does not crash worker.
 * Deduplicates per sender + hour bucket so the user is not spammed.
 */
async function notifySlackHourlyLimitHit(params) {
    const { userId, senderEmail, hourlyLimit, hourBucket, delayMsUntilNextWindow } = params;
    try {
        // 1. Deduplication check via Redis
        const dedupKey = `slack_dedup:${userId}:${senderEmail.toLowerCase()}:${hourBucket}`;
        const alreadySent = await redis_1.redisClient.get(dedupKey);
        if (alreadySent) {
            // Already sent alert for this sender in this hour window
            return false;
        }
        // 2. Fetch user's Slack connection from DB
        const integration = await prisma_1.prisma.slackIntegration.findUnique({
            where: { userId },
        });
        if (!integration || !integration.accessToken) {
            console.log(`[Slack] No active Slack integration for user ${userId}. Rate limit handled without Slack alert.`);
            return false;
        }
        // 3. Mark as sent in Redis for 2 hours to prevent duplicate alerts
        await redis_1.redisClient.set(dedupKey, '1', 'EX', 7200);
        const nextWindowMins = Math.ceil(delayMsUntilNextWindow / 60000);
        const message = `⚠️ *Rate Limit Alert — ReachInbox Email Scheduler*\n` +
            `Sender \`${senderEmail}\` has reached its hourly threshold of *${hourlyLimit} emails/hour*.\n` +
            `Subsequent emails have been safely rescheduled to the next window in ~*${nextWindowMins} minutes*. No jobs were dropped!`;
        // 4. Send message to Slack channel via Webhook URL or chat.postMessage API
        const targetChannel = integration.channelId || '#general';
        let isSuccess = false;
        if (integration.accessToken.startsWith('http://') || integration.accessToken.startsWith('https://')) {
            // Incoming Webhook URL delivery
            const webhookResp = await axios_1.default.post(integration.accessToken, { text: message });
            isSuccess = webhookResp.status === 200;
        }
        else {
            // Bot OAuth Access Token delivery
            const resp = await axios_1.default.post('https://slack.com/api/chat.postMessage', {
                channel: targetChannel,
                text: message,
            }, {
                headers: {
                    Authorization: `Bearer ${integration.accessToken}`,
                    'Content-Type': 'application/json; charset=utf-8',
                },
            });
            isSuccess = Boolean(resp.data && resp.data.ok);
        }
        if (isSuccess) {
            console.log(`[Slack Alert Delivered] Sender: ${senderEmail} | Channel: ${targetChannel}`);
            await prisma_1.prisma.slackIntegration.update({
                where: { id: integration.id },
                data: { lastNotifiedAt: new Date() },
            });
            return true;
        }
        else {
            console.warn(`[Slack API Warning] Could not post message to channel ${targetChannel}`);
            return false;
        }
    }
    catch (error) {
        console.error(`[Slack Error] Failed to send rate-limit alert:`, error.message);
        return false;
    }
}
