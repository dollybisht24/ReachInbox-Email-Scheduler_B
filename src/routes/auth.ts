import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { env } from '../config/env';
import { prisma } from '../db/prisma';
import {
  getGoogleOAuthUrl,
  exchangeGoogleCodeForTokens,
  getGoogleUserProfile,
  upsertGoogleUser,
  signSessionToken,
} from '../services/authService';
import { requireAuth, AuthenticatedRequest } from '../middlewares/authMiddleware';

export const authRouter = Router();

/**
 * Public Auth Config (reports whether live OAuth is configured)
 */
authRouter.get('/api/auth/config', (_req: Request, res: Response) => {
  return res.json({
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    slack: Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET),
  });
});

/**
 * Initiates Google OAuth Flow
 */
const handleGoogleAuth = (req: Request, res: Response) => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return res.status(400).json({
      error: 'Google OAuth not configured',
      message:
        'GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing in .env. Please configure your Google Cloud Console credentials to use live Google login, or use the instant Demo Login button on the login screen for testing.',
    });
  }

  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60 * 1000, // 10 minutes
  });

  // Track the frontend origin that initiated the login (e.g. Vercel vs localhost)
  const referer = req.headers.referer || req.headers.origin || env.FRONTEND_URL;
  const targetFrontend = String(referer).replace(/\/$/, '').replace(/\/login$/, '');
  res.cookie('oauth_origin', targetFrontend, {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60 * 1000,
  });

  const authUrl = getGoogleOAuthUrl(state);
  return res.redirect(authUrl);
};

authRouter.get('/auth/google', handleGoogleAuth);
authRouter.get('/api/auth/google', handleGoogleAuth);

/**
 * Google OAuth Callback
 */
const handleGoogleCallback = async (req: Request, res: Response) => {
  const { code, state, error } = req.query;

  const returnFrontend =
    req.cookies?.oauth_origin ||
    env.FRONTEND_URL ||
    'https://reachinbox-frontend-beryl.vercel.app';
  res.clearCookie('oauth_origin', { path: '/' });

  if (error) {
    return res.redirect(`${returnFrontend}/login?error=${encodeURIComponent(String(error))}`);
  }

  if (!code || typeof code !== 'string') {
    return res.redirect(`${returnFrontend}/login?error=missing_code`);
  }

  const storedState = req.cookies?.oauth_state;
  if (storedState && state && state !== storedState) {
    return res.redirect(`${returnFrontend}/login?error=invalid_state`);
  }

  res.clearCookie('oauth_state', { path: '/' });

  try {
    const tokens = await exchangeGoogleCodeForTokens(code);
    const profile = await getGoogleUserProfile(tokens.access_token);
    const user = await upsertGoogleUser(profile);

    const sessionToken = signSessionToken({
      userId: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar || undefined,
    });

    res.cookie('reachinbox_token', sessionToken, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    return res.redirect(`${returnFrontend}/dashboard?token=${sessionToken}`);
  } catch (err: any) {
    console.error('[Google OAuth Error]', err.response?.data || err.message);
    return res.redirect(
      `${returnFrontend}/login?error=${encodeURIComponent(
        err.message || 'Authentication failed'
      )}`
    );
  }
};

authRouter.get('/auth/google/callback', handleGoogleCallback);
authRouter.get('/api/auth/google/callback', handleGoogleCallback);

/**
 * Google Credential (JWT) Login from Frontend
 */
const handleGoogleCredential = async (req: Request, res: Response) => {
  const { credential, email, name, avatar } = req.body;
  let userEmail = email;
  let userName = name;
  let userAvatar = avatar;
  let googleId;

  if (credential && typeof credential === 'string') {
    try {
      const parts = credential.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        userEmail = payload.email || userEmail;
        userName = payload.name || userName;
        userAvatar = payload.picture || userAvatar;
        googleId = payload.sub;
      }
    } catch (e: any) {
      console.warn('[Google Credential Parse Warning]', e.message);
    }
  }

  if (!userEmail) {
    return res.status(400).json({ error: 'Valid email is required' });
  }

  try {
    const user = await prisma.user.upsert({
      where: { email: userEmail },
      update: {
        name: userName || userEmail.split('@')[0],
        avatar: userAvatar,
        ...(googleId ? { googleId } : {}),
      },
      create: {
        email: userEmail,
        name: userName || userEmail.split('@')[0],
        avatar: userAvatar,
        googleId,
      },
    });

    // Ensure user has their own email as an active sender
    const existingSender = await prisma.sender.findFirst({
      where: { userId: user.id, email: userEmail },
    });
    if (!existingSender) {
      await prisma.sender.create({
        data: {
          userId: user.id,
          name: user.name,
          email: user.email,
          hourlyLimit: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
        },
      });
    }

    const sessionToken = signSessionToken({
      userId: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar || undefined,
    });

    res.cookie('reachinbox_token', sessionToken, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({
      success: true,
      user,
      token: sessionToken,
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to process Google sign-in', message: err.message });
  }
};

authRouter.post('/auth/google-credential', handleGoogleCredential);
authRouter.post('/api/auth/google-credential', handleGoogleCredential);

/**
 * Demo Login (for developer evaluation when Google OAuth credentials are not provided)
 */
authRouter.post('/auth/demo-login', async (req: Request, res: Response) => {
  const demoEmail = req.body.email || 'evaluator@reachinbox.test';
  const demoName = req.body.name || 'Outbox Reviewer';

  try {
    const user = await prisma.user.upsert({
      where: { email: demoEmail },
      update: { name: demoName },
      create: {
        email: demoEmail,
        name: demoName,
        avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop&crop=faces',
        googleId: `demo_${Date.now()}`,
      },
    });

    // Ensure default senders exist
    const count = await prisma.sender.count({ where: { userId: user.id } });
    if (count === 0) {
      await prisma.sender.createMany({
        data: [
          {
            userId: user.id,
            name: demoName,
            email: demoEmail,
            hourlyLimit: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
          },
          {
            userId: user.id,
            name: 'ReachInbox Campaigns',
            email: 'campaigns@reachinbox.ai',
            hourlyLimit: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
          },
        ],
      });
    }

    const sessionToken = signSessionToken({
      userId: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar || undefined,
    });

    res.cookie('reachinbox_token', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({
      success: true,
      user,
      token: sessionToken,
    });
  } catch (err: any) {
    console.error('[Demo Login Error]', err.message);
    return res.status(500).json({ error: 'Failed to create demo session' });
  }
});

/**
 * Logout Endpoint
 */
authRouter.post('/auth/logout', (_req: Request, res: Response) => {
  res.clearCookie('reachinbox_token');
  return res.json({ success: true, message: 'Logged out successfully' });
});

/**
 * Current User Profile with senders and Slack status
 */
authRouter.get('/api/me', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: {
        senders: true,
        slackIntegration: {
          select: {
            id: true,
            teamName: true,
            channelName: true,
            connectedAt: true,
            lastNotifiedAt: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        createdAt: user.createdAt,
      },
      senders: user.senders,
      slack: user.slackIntegration
        ? {
            connected: true,
            teamName: user.slackIntegration.teamName,
            channelName: user.slackIntegration.channelName,
            connectedAt: user.slackIntegration.connectedAt,
            lastNotifiedAt: user.slackIntegration.lastNotifiedAt,
          }
        : {
            connected: false,
          },
      oauthConfigured: {
        google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
        slack: Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET),
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});
