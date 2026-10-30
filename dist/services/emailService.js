"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTransporter = getTransporter;
exports.sendEtherealEmail = sendEtherealEmail;
exports.getCachedEtherealCredentials = getCachedEtherealCredentials;
const nodemailer_1 = __importDefault(require("nodemailer"));
const env_1 = require("../config/env");
let etherealTransporter = null;
let etherealAccountInfo = null;
/**
 * Creates or retrieves the appropriate Nodemailer transporter:
 * 1. Sender-specific SMTP / Gmail credentials (if configured)
 * 2. Global GMAIL_USER + GMAIL_APP_PASSWORD in .env (Real Gmail sending)
 * 3. Custom real SMTP credentials in .env
 * 4. Ethereal Email (Automated test SMTP fallback)
 */
async function getTransporter(senderSmtp) {
    // 1. Sender-level real SMTP / Gmail configuration
    if (senderSmtp && senderSmtp.smtpUser && senderSmtp.smtpPass) {
        const isGmail = (senderSmtp.smtpHost && senderSmtp.smtpHost.includes('gmail')) ||
            senderSmtp.smtpUser.toLowerCase().includes('@gmail.com');
        if (isGmail) {
            console.log(`[EmailService] Using Sender-Specific Gmail SMTP for: ${senderSmtp.smtpUser}`);
            return {
                transporter: nodemailer_1.default.createTransport({
                    service: 'gmail',
                    auth: {
                        user: senderSmtp.smtpUser,
                        pass: senderSmtp.smtpPass,
                    },
                }),
                type: 'gmail',
            };
        }
        console.log(`[EmailService] Using Sender-Specific Custom SMTP (${senderSmtp.smtpHost || 'smtp.gmail.com'}) for: ${senderSmtp.smtpUser}`);
        return {
            transporter: nodemailer_1.default.createTransport({
                host: senderSmtp.smtpHost || 'smtp.gmail.com',
                port: senderSmtp.smtpPort || (senderSmtp.smtpSecure ? 465 : 587),
                secure: senderSmtp.smtpSecure ?? true,
                auth: {
                    user: senderSmtp.smtpUser,
                    pass: senderSmtp.smtpPass,
                },
            }),
            type: 'smtp',
        };
    }
    // 2. Global Real Gmail credentials configured in .env
    if (env_1.env.GMAIL_USER && env_1.env.GMAIL_APP_PASSWORD) {
        console.log(`[EmailService] Using Global Real Gmail SMTP Service for: ${env_1.env.GMAIL_USER}`);
        return {
            transporter: nodemailer_1.default.createTransport({
                service: 'gmail',
                auth: {
                    user: env_1.env.GMAIL_USER,
                    pass: env_1.env.GMAIL_APP_PASSWORD,
                },
            }),
            type: 'gmail',
        };
    }
    // 3. Global Custom SMTP credentials configured in .env
    if (env_1.env.SMTP_USER && env_1.env.SMTP_PASS && env_1.env.SMTP_HOST !== 'smtp.ethereal.email') {
        console.log(`[EmailService] Using Global Custom SMTP Server (${env_1.env.SMTP_HOST}) for: ${env_1.env.SMTP_USER}`);
        return {
            transporter: nodemailer_1.default.createTransport({
                host: env_1.env.SMTP_HOST,
                port: env_1.env.SMTP_PORT,
                secure: env_1.env.SMTP_SECURE,
                auth: {
                    user: env_1.env.SMTP_USER,
                    pass: env_1.env.SMTP_PASS,
                },
            }),
            type: 'smtp',
        };
    }
    // 4. Default Ethereal Email test account (Fake SMTP)
    if (etherealTransporter) {
        return { transporter: etherealTransporter, type: 'ethereal' };
    }
    if (env_1.env.ETHEREAL_USER && env_1.env.ETHEREAL_PASS) {
        console.log(`[EmailService] Using provided Ethereal credentials for: ${env_1.env.ETHEREAL_USER}`);
        etherealTransporter = nodemailer_1.default.createTransport({
            host: env_1.env.SMTP_HOST,
            port: env_1.env.SMTP_PORT,
            secure: env_1.env.SMTP_SECURE,
            auth: {
                user: env_1.env.ETHEREAL_USER,
                pass: env_1.env.ETHEREAL_PASS,
            },
        });
        return { transporter: etherealTransporter, type: 'ethereal' };
    }
    // Auto-generate test account on Ethereal
    console.log('[EmailService] Auto-generating Ethereal test account...');
    const testAccount = await nodemailer_1.default.createTestAccount();
    etherealAccountInfo = {
        user: testAccount.user,
        pass: testAccount.pass,
    };
    console.log(`[EmailService] Created Ethereal account: ${testAccount.user}`);
    etherealTransporter = nodemailer_1.default.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
            user: testAccount.user,
            pass: testAccount.pass,
        },
    });
    return { transporter: etherealTransporter, type: 'ethereal' };
}
/**
 * Sends an email using either Real Gmail/SMTP or Ethereal Test SMTP
 */
async function sendEtherealEmail(options) {
    try {
        const { transporter, type } = await getTransporter(options.senderSmtp);
        const senderAddress = options.fromName
            ? `"${options.fromName}" <${options.fromEmail}>`
            : options.fromEmail;
        const info = await transporter.sendMail({
            from: senderAddress,
            to: options.toEmail,
            subject: options.subject,
            text: options.body,
            html: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.6; color: #1e293b; padding: 16px;">
        ${options.body.replace(/\n/g, '<br/>')}
      </div>`,
        });
        const isRealDelivery = type === 'gmail' || type === 'smtp';
        const previewUrl = isRealDelivery ? false : nodemailer_1.default.getTestMessageUrl(info);
        console.log(`\n========================================`);
        if (isRealDelivery) {
            console.log(`🚀 [REAL EMAIL DISPATCHED TO LIVE INBOX via ${type.toUpperCase()}]`);
        }
        else {
            console.log(`📫 [ETHEREAL TEST SMTP DELIVERED]`);
        }
        console.log(`To:          ${options.toEmail}`);
        console.log(`From:        ${senderAddress}`);
        console.log(`Subject:     ${options.subject}`);
        console.log(`MessageId:   ${info.messageId}`);
        if (previewUrl) {
            console.log(`Preview URL: ${previewUrl}`);
        }
        else if (isRealDelivery) {
            console.log(`Status:      Sent in REAL life directly to recipient's inbox!`);
        }
        console.log(`========================================\n`);
        return {
            success: true,
            messageId: info.messageId,
            previewUrl: previewUrl || (isRealDelivery ? 'Sent via Real Gmail / SMTP' : undefined),
            deliveredVia: type,
        };
    }
    catch (err) {
        console.error(`[EmailService Send Failure] To: ${options.toEmail} | Error:`, err.message);
        return {
            success: false,
            error: err.message || 'SMTP transmission failure',
        };
    }
}
function getCachedEtherealCredentials() {
    return etherealAccountInfo;
}
