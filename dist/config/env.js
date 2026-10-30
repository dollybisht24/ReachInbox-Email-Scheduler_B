"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
// Load environment variables from .env file
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, '../../.env') });
exports.env = {
    PORT: parseInt(process.env.PORT || '3000', 10),
    BACKEND_URL: process.env.BACKEND_URL || 'http://localhost:3000',
    FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',
    DATABASE_URL: process.env.DATABASE_URL || 'postgresql://reachinbox:reachinbox_secret_password@localhost:5432/reachinbox_db?schema=public',
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
    ELASTICSEARCH_URL: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
    SESSION_SECRET: process.env.SESSION_SECRET || 'reachinbox_dev_jwt_secret_token_outbox_labs_2026',
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
    GOOGLE_CALLBACK_URL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback',
    SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID || '',
    SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET || '',
    SLACK_CALLBACK_URL: process.env.SLACK_CALLBACK_URL || 'http://localhost:3000/api/slack/callback',
    ETHEREAL_USER: process.env.ETHEREAL_USER || '',
    ETHEREAL_PASS: process.env.ETHEREAL_PASS || '',
    GMAIL_USER: process.env.GMAIL_USER || '',
    GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD || '',
    SMTP_USER: process.env.SMTP_USER || process.env.ETHEREAL_USER || '',
    SMTP_PASS: process.env.SMTP_PASS || process.env.ETHEREAL_PASS || '',
    SMTP_HOST: process.env.SMTP_HOST || 'smtp.ethereal.email',
    SMTP_PORT: parseInt(process.env.SMTP_PORT || '587', 10),
    SMTP_SECURE: process.env.SMTP_SECURE === 'true',
    WORKER_CONCURRENCY: parseInt(process.env.WORKER_CONCURRENCY || '5', 10),
    MIN_DELAY_BETWEEN_EMAILS_MS: parseInt(process.env.MIN_DELAY_BETWEEN_EMAILS_MS || '1000', 10),
    MAX_EMAILS_PER_HOUR_PER_SENDER: parseInt(process.env.MAX_EMAILS_PER_HOUR_PER_SENDER || '100', 10),
    QUEUE_MAX_ATTEMPTS: parseInt(process.env.QUEUE_MAX_ATTEMPTS || '3', 10),
    QUEUE_BACKOFF_MS: parseInt(process.env.QUEUE_BACKOFF_MS || '5000', 10),
};
