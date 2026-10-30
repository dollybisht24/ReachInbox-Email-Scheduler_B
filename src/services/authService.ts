import axios from 'axios';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { prisma } from '../db/prisma';

export interface GoogleUserProfile {
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

export interface AuthSessionPayload {
  userId: string;
  email: string;
  name: string;
  avatar?: string;
}

/**
 * Builds Google OAuth 2.0 authorization URL
 */
export function getGoogleOAuthUrl(state: string): string {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new Error('GOOGLE_CLIENT_ID is not configured in environment variables');
  }

  const rootUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  const options = {
    redirect_uri: env.GOOGLE_CALLBACK_URL,
    client_id: env.GOOGLE_CLIENT_ID,
    access_type: 'offline',
    response_type: 'code',
    prompt: 'select_account consent',
    scope: [
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' '),
    state,
  };

  const qs = new URLSearchParams(options);
  return `${rootUrl}?${qs.toString()}`;
}

/**
 * Exchanges authorization code for Google access token
 */
export async function exchangeGoogleCodeForTokens(code: string): Promise<{
  access_token: string;
  id_token: string;
}> {
  const url = 'https://oauth2.googleapis.com/token';
  const values = {
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: env.GOOGLE_CALLBACK_URL,
    grant_type: 'authorization_code',
  };

  const response = await axios.post(url, new URLSearchParams(values).toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  return response.data;
}

/**
 * Fetches user profile using Google access token
 */
export async function getGoogleUserProfile(accessToken: string): Promise<GoogleUserProfile> {
  const url = `https://www.googleapis.com/oauth2/v2/userinfo?alt=json&access_token=${accessToken}`;
  const response = await axios.get<GoogleUserProfile>(url);
  return response.data;
}

/**
 * Creates or updates user record from Google profile and ensures default sender exists
 */
export async function upsertGoogleUser(profile: GoogleUserProfile) {
  const user = await prisma.user.upsert({
    where: { email: profile.email },
    update: {
      name: profile.name,
      avatar: profile.picture,
      googleId: profile.id,
    },
    create: {
      email: profile.email,
      name: profile.name,
      avatar: profile.picture,
      googleId: profile.id,
    },
  });

  // Ensure user's own email exists in sender list
  const existingUserSender = await prisma.sender.findFirst({
    where: { userId: user.id, email: profile.email },
  });

  if (!existingUserSender) {
    await prisma.sender.create({
      data: {
        userId: user.id,
        name: profile.name,
        email: profile.email,
        hourlyLimit: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
      },
    });
  }

  // Ensure default campaign sender exists for the user
  const sendersCount = await prisma.sender.count({
    where: { userId: user.id },
  });

  if (sendersCount === 1) {
    await prisma.sender.create({
      data: {
        userId: user.id,
        name: 'ReachInbox Campaigns',
        email: 'campaigns@reachinbox.ai',
        hourlyLimit: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
      },
    });
  }

  return user;
}

/**
 * Signs a secure JWT session token
 */
export function signSessionToken(payload: AuthSessionPayload): string {
  return jwt.sign(payload, env.SESSION_SECRET, {
    expiresIn: '7d',
  });
}

/**
 * Verifies and decodes a session JWT token
 */
export function verifySessionToken(token: string): AuthSessionPayload {
  return jwt.verify(token, env.SESSION_SECRET) as AuthSessionPayload;
}
