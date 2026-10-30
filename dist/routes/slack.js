"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.slackRouter = void 0;
const express_1 = require("express");
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("../config/env");
const prisma_1 = require("../db/prisma");
const authMiddleware_1 = require("../middlewares/authMiddleware");
const slackService_1 = require("../services/slackService");
exports.slackRouter = (0, express_1.Router)();
/**
 * Initiates Slack OAuth Connection
 */
exports.slackRouter.get('/api/slack/connect', authMiddleware_1.requireAuth, (req, res) => {
    if (!env_1.env.SLACK_CLIENT_ID || !env_1.env.SLACK_CLIENT_SECRET) {
        return res.status(400).json({
            error: 'Slack OAuth not configured',
            message: 'SLACK_CLIENT_ID or SLACK_CLIENT_SECRET is missing in .env. Please configure Slack app credentials to connect live Slack workspace.',
        });
    }
    const state = crypto_1.default.randomBytes(16).toString('hex') + `:${req.user.id}`;
    res.cookie('slack_oauth_state', state, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 10 * 60 * 1000,
    });
    const authUrl = (0, slackService_1.getSlackAuthUrl)(state);
    return res.redirect(authUrl);
});
/**
 * Slack OAuth Callback
 */
exports.slackRouter.get('/api/slack/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) {
        return res.redirect(`${env_1.env.FRONTEND_URL}/dashboard?slack_error=${encodeURIComponent(String(error))}`);
    }
    if (!code || typeof code !== 'string') {
        return res.redirect(`${env_1.env.FRONTEND_URL}/dashboard?slack_error=missing_code`);
    }
    const storedState = req.cookies?.slack_oauth_state;
    if (!state || state !== storedState) {
        return res.redirect(`${env_1.env.FRONTEND_URL}/dashboard?slack_error=invalid_state`);
    }
    res.clearCookie('slack_oauth_state');
    // Extract user ID embedded in state
    const userId = state.split(':')[1];
    if (!userId) {
        return res.redirect(`${env_1.env.FRONTEND_URL}/dashboard?slack_error=invalid_user`);
    }
    try {
        const tokenData = await (0, slackService_1.exchangeSlackCode)(code);
        if (!tokenData.ok || !tokenData.access_token) {
            throw new Error(tokenData.error || 'Failed to exchange Slack token');
        }
        await prisma_1.prisma.slackIntegration.upsert({
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
        return res.redirect(`${env_1.env.FRONTEND_URL}/dashboard?slack=connected`);
    }
    catch (err) {
        console.error('[Slack OAuth Callback Error]', err.message);
        return res.redirect(`${env_1.env.FRONTEND_URL}/dashboard?slack_error=${encodeURIComponent(err.message)}`);
    }
});
/**
 * Disconnects Slack integration
 */
exports.slackRouter.post('/api/slack/disconnect', authMiddleware_1.requireAuth, async (req, res) => {
    try {
        await prisma_1.prisma.slackIntegration.deleteMany({
            where: { userId: req.user.id },
        });
        return res.json({
            success: true,
            message: 'Slack disconnected successfully',
        });
    }
    catch (err) {
        return res.status(500).json({ error: 'Failed to disconnect Slack' });
    }
});
/**
 * Connects Slack using a direct incoming webhook URL
 */
exports.slackRouter.post('/api/slack/webhook', authMiddleware_1.requireAuth, async (req, res) => {
    const { webhookUrl, channelName } = req.body;
    if (!webhookUrl || typeof webhookUrl !== 'string' || !webhookUrl.startsWith('https://')) {
        return res.status(400).json({ error: 'Invalid webhook URL. Must start with https://' });
    }
    try {
        const integration = await prisma_1.prisma.slackIntegration.upsert({
            where: { userId: req.user.id },
            update: {
                accessToken: webhookUrl.trim(),
                channelName: channelName || 'incoming-webhook',
                teamName: 'Custom Webhook Workspace',
                connectedAt: new Date(),
            },
            create: {
                userId: req.user.id,
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
    }
    catch (err) {
        return res.status(500).json({ error: 'Failed to save Slack webhook', message: err.message });
    }
});
