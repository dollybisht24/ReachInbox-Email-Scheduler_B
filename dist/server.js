"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServer = createServer;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const env_1 = require("./config/env");
const health_1 = require("./routes/health");
const auth_1 = require("./routes/auth");
const slack_1 = require("./routes/slack");
const email_1 = require("./routes/email");
const bullBoard_1 = require("./queue/bullBoard");
function createServer() {
    const app = (0, express_1.default)();
    // CORS configuration for frontend credentials
    const allowedOrigins = [
        env_1.env.FRONTEND_URL,
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'https://reachinbox-frontend-beryl.vercel.app',
    ];
    app.use((0, cors_1.default)({
        origin: (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
                return callback(null, true);
            }
            callback(null, true);
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'bypass-tunnel-reminder'],
    }));
    app.use((0, cookie_parser_1.default)());
    app.use(express_1.default.json({ limit: '10mb' }));
    app.use(express_1.default.urlencoded({ extended: true, limit: '10mb' }));
    // Bull Board Queue Dashboard mounted at /admin/queues
    app.use('/admin/queues', bullBoard_1.bullBoardRouter);
    // Application Routes
    app.use(health_1.healthRouter);
    app.use(auth_1.authRouter);
    app.use(slack_1.slackRouter);
    app.use(email_1.emailRouter);
    // Serve compiled React frontend in production if built
    const possibleDistPaths = [
        path_1.default.resolve(__dirname, '../../frontend/dist'),
        path_1.default.resolve(__dirname, '../public'),
        path_1.default.resolve(process.cwd(), 'frontend/dist'),
        path_1.default.resolve(process.cwd(), '../frontend/dist'),
    ];
    const publicDistPath = possibleDistPaths.find((p) => fs_1.default.existsSync(p));
    if (publicDistPath) {
        console.log(`[Static Files] Serving frontend assets from: ${publicDistPath}`);
        app.use(express_1.default.static(publicDistPath));
        app.get('*', (req, res, next) => {
            if (req.path.startsWith('/api') ||
                req.path.startsWith('/auth') ||
                req.path.startsWith('/admin')) {
                return next();
            }
            res.sendFile(path_1.default.join(publicDistPath, 'index.html'));
        });
    }
    // Global Error Handler
    app.use((err, _req, res, _next) => {
        console.error('[Global Error]', err);
        res.status(err.status || 500).json({
            error: err.name || 'InternalServerError',
            message: err.message || 'An unexpected error occurred',
        });
    });
    return app;
}
