import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { env } from '../config/env';
import { prisma } from '../db/prisma';
import { requireAuth, AuthenticatedRequest } from '../middlewares/authMiddleware';
import { getSlackAuthUrl, exchangeSlackCode } from '../services/slackService';

export const slackRouter = Router();

/**
 * Initiates Slack OAuth Connection
 */
slackRouter.get('/api/slack/connect', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
    return res.status(400).json({
      error: 'Slack OAuth not configured',
      message:
        'SLACK_CLIENT_ID or SLACK_CLIENT_SECRET is missing in .env. Please configure Slack app credentials to connect live Slack workspace.',
    });
  }

  const state = crypto.randomBytes(16).toString('hex') + `:${req.user!.id}`;
  res.cookie('slack_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
  });

  const authUrl = getSlackAuthUrl(state);
  return res.redirect(authUrl);
});

/**
 * Slack OAuth Callback
 */
slackRouter.get('/api/slack/callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`${env.FRONTEND_URL}/dashboard?slack_error=${encodeURIComponent(String(error))}`);
  }

  if (!code || typeof code !== 'string') {
    return res.redirect(`${env.FRONTEND_URL}/dashboard?slack_error=missing_code`);
  }

  const storedState = req.cookies?.slack_oauth_state;
  if (!state || state !== storedState) {
    return res.redirect(`${env.FRONTEND_URL}/dashboard?slack_error=invalid_state`);
  }

  res.clearCookie('slack_oauth_state');

  // Extract user ID embedded in state
  const userId = (state as string).split(':')[1];
  if (!userId) {
    return res.redirect(`${env.FRONTEND_URL}/dashboard?slack_error=invalid_user`);
  }

  try {
    const tokenData = await exchangeSlackCode(code);

    if (!tokenData.ok || !tokenData.access_token) {
      throw new Error(tokenData.error || 'Failed to exchange Slack token');
    }

    await prisma.slackIntegration.upsert({
      where: { userId },
      update: {
        accessToken: tokenData.access_token,
        slackUserId: tokenData.authed_user?.id || tokenData.bot_user_id,
        teamId: tokenData.team?.id,
        teamName: tokenData.team?.name,
        channelId: tokenData.incoming_webhook?.channel_id,
        channelName: tokenData.incoming_webhook?.channel,
        connectedAt: new Date(),
      },
      create: {
        userId,
        accessToken: tokenData.access_token,
        slackUserId: tokenData.authed_user?.id || tokenData.bot_user_id,
        teamId: tokenData.team?.id,
        teamName: tokenData.team?.name,
        channelId: tokenData.incoming_webhook?.channel_id,
        channelName: tokenData.incoming_webhook?.channel,
      },
    });

    console.log(`[Slack] Successfully connected workspace: ${tokenData.team?.name} for user ${userId}`);
    return res.redirect(`${env.FRONTEND_URL}/dashboard?slack=connected`);
  } catch (err: any) {
    console.error('[Slack OAuth Callback Error]', err.message);
    return res.redirect(
      `${env.FRONTEND_URL}/dashboard?slack_error=${encodeURIComponent(err.message)}`
    );
  }
});

/**
 * Disconnects Slack integration
 */
slackRouter.post('/api/slack/disconnect', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await prisma.slackIntegration.deleteMany({
      where: { userId: req.user!.id },
    });

    return res.json({
      success: true,
      message: 'Slack disconnected successfully',
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to disconnect Slack' });
  }
});

/**
 * Connects Slack using a direct incoming webhook URL
 */
slackRouter.post('/api/slack/webhook', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { webhookUrl, channelName } = req.body;

  if (!webhookUrl || typeof webhookUrl !== 'string' || !webhookUrl.startsWith('https://')) {
    return res.status(400).json({ error: 'Invalid webhook URL. Must start with https://' });
  }

  try {
    const integration = await prisma.slackIntegration.upsert({
      where: { userId: req.user!.id },
      update: {
        accessToken: webhookUrl.trim(),
        channelName: channelName || 'incoming-webhook',
        teamName: 'Custom Webhook Workspace',
        connectedAt: new Date(),
      },
      create: {
        userId: req.user!.id,
        accessToken: webhookUrl.trim(),
        channelName: channelName || 'incoming-webhook',
        teamName: 'Custom Webhook Workspace',
      },
    });

    return res.json({
      success: true,
      message: 'Slack webhook connected successfully',
      integration: {
        channelName: integration.channelName,
        teamName: integration.teamName,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to save Slack webhook', message: err.message });
  }
});
