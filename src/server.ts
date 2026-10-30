import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { env } from './config/env';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { slackRouter } from './routes/slack';
import { emailRouter } from './routes/email';
import { bullBoardRouter } from './queue/bullBoard';

export function createServer() {
  const app = express();

  // CORS configuration for frontend credentials
  app.use(
    cors({
      origin: [env.FRONTEND_URL, 'http://localhost:5173', 'http://127.0.0.1:5173'],
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );

  app.use(cookieParser());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Bull Board Queue Dashboard mounted at /admin/queues
  app.use('/admin/queues', bullBoardRouter);

  // Application Routes
  app.use(healthRouter);
  app.use(authRouter);
  app.use(slackRouter);
  app.use(emailRouter);

  // Serve compiled React frontend in production if built
  const possibleDistPaths = [
    path.resolve(__dirname, '../../frontend/dist'),
    path.resolve(__dirname, '../public'),
    path.resolve(process.cwd(), 'frontend/dist'),
    path.resolve(process.cwd(), '../frontend/dist'),
  ];

  const publicDistPath = possibleDistPaths.find((p) => fs.existsSync(p));

  if (publicDistPath) {
    console.log(`[Static Files] Serving frontend assets from: ${publicDistPath}`);
    app.use(express.static(publicDistPath));

    app.get('*', (req, res, next) => {
      if (
        req.path.startsWith('/api') ||
        req.path.startsWith('/auth') ||
        req.path.startsWith('/admin')
      ) {
        return next();
      }
      res.sendFile(path.join(publicDistPath, 'index.html'));
    });
  }

  // Global Error Handler
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[Global Error]', err);
    res.status(err.status || 500).json({
      error: err.name || 'InternalServerError',
      message: err.message || 'An unexpected error occurred',
    });
  });

  return app;
}
