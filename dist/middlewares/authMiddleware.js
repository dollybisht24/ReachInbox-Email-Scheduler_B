"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
const authService_1 = require("../services/authService");
const prisma_1 = require("../db/prisma");
async function requireAuth(req, res, next) {
    try {
        // 1. Check HttpOnly cookie
        let token = req.cookies?.reachinbox_token;
        // 2. Or check Authorization header
        if (!token && req.headers.authorization) {
            const parts = req.headers.authorization.split(' ');
            if (parts.length === 2 && parts[0] === 'Bearer') {
                token = parts[1];
            }
        }
        if (!token) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'No active session found. Please log in with Google.',
            });
        }
        const decoded = (0, authService_1.verifySessionToken)(token);
        // Verify user exists in database
        const user = await prisma_1.prisma.user.findUnique({
            where: { id: decoded.userId },
            select: { id: true, email: true, name: true, avatar: true },
        });
        if (!user) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'User session is invalid or user no longer exists.',
            });
        }
        req.user = user;
        next();
    }
    catch (err) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Invalid or expired session token.',
        });
    }
}
