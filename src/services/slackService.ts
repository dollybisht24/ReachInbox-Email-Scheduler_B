import axios from 'axios';
import { env } from '../config/env';
import { prisma } from '../db/prisma';
import { redisClient } from '../queue/redis';

export interface SlackTokenResponse {
  ok: boolean;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: {
    name: string;
    id: string;
  };
  authed_user?: {
    id: string;
    scope?: string;
    access_token?: string;
    token_type?: string;
  };
  incoming_webhook?: {
    channel: string;
    channel_id: string;
    configuration_url: string;
    url: string;
  };
  error?: string;
}

/**
 * Generates the Slack OAuth v2 authorization URL
 */
export function getSlackAuthUrl(state: string): string {
  if (!env.SLACK_CLIENT_ID) {
    throw new Error('SLACK_CLIENT_ID is not configured in environment variables');
  }

  const scopes = [
    'chat:write',
    'channels:read',
    'incoming-webhook',
  ].join(',');

  const params = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID,
    scope: scopes,
    redirect_uri: env.SLACK_CALLBACK_URL,
    state,
  });

  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

/**
 * Exchanges the authorization code for an OAuth access token
 */
export async function exchangeSlackCode(code: string): Promise<SlackTokenResponse> {
  const params = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID,
    client_secret: env.SLACK_CLIENT_SECRET,
    code,
    redirect_uri: env.SLACK_CALLBACK_URL,
  });

  const response = await axios.post<SlackTokenResponse>(
    'https://slack.com/api/oauth.v2.access',
    params.toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  return response.data;
}

/**
 * Posts a notification to Slack when an hourly sender rate limit is exceeded.
 * Safe fallback: if Slack is not connected or fails, logs warning and does not crash worker.
 * Deduplicates per sender + hour bucket so the user is not spammed.
 */
export async function notifySlackHourlyLimitHit(params: {
  userId: string;
  senderEmail: string;
  hourlyLimit: number;
  hourBucket: number;
  delayMsUntilNextWindow: number;
}): Promise<boolean> {
  const { userId, senderEmail, hourlyLimit, hourBucket, delayMsUntilNextWindow } = params;

  try {
    // 1. Deduplication check via Redis
    const dedupKey = `slack_dedup:${userId}:${senderEmail.toLowerCase()}:${hourBucket}`;
    const alreadySent = await redisClient.get(dedupKey);
    if (alreadySent) {
      // Already sent alert for this sender in this hour window
      return false;
    }

    // 2. Fetch user's Slack connection from DB
    const integration = await prisma.slackIntegration.findUnique({
      where: { userId },
    });

    if (!integration || !integration.accessToken) {
      console.log(`[Slack] No active Slack integration for user ${userId}. Rate limit handled without Slack alert.`);
      return false;
    }

    // 3. Mark as sent in Redis for 2 hours to prevent duplicate alerts
    await redisClient.set(dedupKey, '1', 'EX', 7200);

    const nextWindowMins = Math.ceil(delayMsUntilNextWindow / 60000);
    const message = `⚠️ *Rate Limit Alert — ReachInbox Email Scheduler*\n` +
      `Sender \`${senderEmail}\` has reached its hourly threshold of *${hourlyLimit} emails/hour*.\n` +
      `Subsequent emails have been safely rescheduled to the next window in ~*${nextWindowMins} minutes*. No jobs were dropped!`;

    // 4. Send message to Slack channel via Webhook URL or chat.postMessage API
    const targetChannel = integration.channelId || '#general';
    let isSuccess = false;

    if (integration.accessToken.startsWith('http://') || integration.accessToken.startsWith('https://')) {
      // Incoming Webhook URL delivery
      const webhookResp = await axios.post(integration.accessToken, { text: message });
      isSuccess = webhookResp.status === 200;
    } else {
      // Bot OAuth Access Token delivery
      const resp = await axios.post(
        'https://slack.com/api/chat.postMessage',
        {
          channel: targetChannel,
          text: message,
        },
        {
          headers: {
            Authorization: `Bearer ${integration.accessToken}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
        }
      );
      isSuccess = Boolean(resp.data && resp.data.ok);
    }

    if (isSuccess) {
      console.log(`[Slack Alert Delivered] Sender: ${senderEmail} | Channel: ${targetChannel}`);
      await prisma.slackIntegration.update({
        where: { id: integration.id },
        data: { lastNotifiedAt: new Date() },
      });
      return true;
    } else {
      console.warn(`[Slack API Warning] Could not post message to channel ${targetChannel}`);
      return false;
    }
  } catch (error: any) {
    console.error(`[Slack Error] Failed to send rate-limit alert:`, error.message);
    return false;
  }
}
