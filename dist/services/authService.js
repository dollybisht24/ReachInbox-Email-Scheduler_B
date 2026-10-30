"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGoogleOAuthUrl = getGoogleOAuthUrl;
exports.exchangeGoogleCodeForTokens = exchangeGoogleCodeForTokens;
exports.getGoogleUserProfile = getGoogleUserProfile;
exports.upsertGoogleUser = upsertGoogleUser;
exports.signSessionToken = signSessionToken;
exports.verifySessionToken = verifySessionToken;
const axios_1 = __importDefault(require("axios"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../config/env");
const prisma_1 = require("../db/prisma");
/**
 * Builds Google OAuth 2.0 authorization URL
 */
function getGoogleOAuthUrl(state) {
    if (!env_1.env.GOOGLE_CLIENT_ID) {
        throw new Error('GOOGLE_CLIENT_ID is not configured in environment variables');
    }
    const rootUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
    const options = {
        redirect_uri: env_1.env.GOOGLE_CALLBACK_URL,
        client_id: env_1.env.GOOGLE_CLIENT_ID,
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
async function exchangeGoogleCodeForTokens(code) {
    const url = 'https://oauth2.googleapis.com/token';
    const values = {
        code,
        client_id: env_1.env.GOOGLE_CLIENT_ID,
        client_secret: env_1.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: env_1.env.GOOGLE_CALLBACK_URL,
        grant_type: 'authorization_code',
    };
    const response = await axios_1.default.post(url, new URLSearchParams(values).toString(), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
    });
    return response.data;
}
/**
 * Fetches user profile using Google access token
 */
async function getGoogleUserProfile(accessToken) {
    const url = `https://www.googleapis.com/oauth2/v2/userinfo?alt=json&access_token=${accessToken}`;
    const response = await axios_1.default.get(url);
    return response.data;
}
/**
 * Creates or updates user record from Google profile and ensures default sender exists
 */
async function upsertGoogleUser(profile) {
    const user = await prisma_1.prisma.user.upsert({
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
    const existingUserSender = await prisma_1.prisma.sender.findFirst({
        where: { userId: user.id, email: profile.email },
    });
    if (!existingUserSender) {
        await prisma_1.prisma.sender.create({
            data: {
                userId: user.id,
                name: profile.name,
                email: profile.email,
                hourlyLimit: env_1.env.MAX_EMAILS_PER_HOUR_PER_SENDER,
            },
        });
    }
    // Ensure default campaign sender exists for the user
    const sendersCount = await prisma_1.prisma.sender.count({
        where: { userId: user.id },
    });
    if (sendersCount === 1) {
        await prisma_1.prisma.sender.create({
            data: {
                userId: user.id,
                name: 'ReachInbox Campaigns',
                email: 'campaigns@reachinbox.ai',
                hourlyLimit: env_1.env.MAX_EMAILS_PER_HOUR_PER_SENDER,
            },
        });
    }
    return user;
}
/**
 * Signs a secure JWT session token
 */
function signSessionToken(payload) {
    return jsonwebtoken_1.default.sign(payload, env_1.env.SESSION_SECRET, {
        expiresIn: '7d',
    });
}
/**
 * Verifies and decodes a session JWT token
 */
function verifySessionToken(token) {
    return jsonwebtoken_1.default.verify(token, env_1.env.SESSION_SECRET);
}
