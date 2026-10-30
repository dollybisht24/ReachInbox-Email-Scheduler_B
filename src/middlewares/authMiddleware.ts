import { Request, Response, NextFunction } from 'express';
import { verifySessionToken, AuthSessionPayload } from '../services/authService';
import { prisma } from '../db/prisma';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    name: string;
    avatar?: string | null;
  };
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
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

    const decoded: AuthSessionPayload = verifySessionToken(token);

    // Verify user exists in database
    const user = await prisma.user.findUnique({
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
  } catch (err: any) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired session token.',
    });
  }
}
