import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/env';

export interface SendEmailOptions {
  fromName?: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  body: string;
  senderSmtp?: {
    smtpHost?: string | null;
    smtpPort?: number | null;
    smtpSecure?: boolean | null;
    smtpUser?: string | null;
    smtpPass?: string | null;
  };
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  previewUrl?: string | false;
  deliveredVia?: 'gmail' | 'smtp' | 'ethereal';
  error?: string;
}

let etherealTransporter: Transporter | null = null;
let etherealAccountInfo: { user: string; pass: string } | null = null;

/**
 * Creates or retrieves the appropriate Nodemailer transporter:
 * 1. Sender-specific SMTP / Gmail credentials (if configured)
 * 2. Global GMAIL_USER + GMAIL_APP_PASSWORD in .env (Real Gmail sending)
 * 3. Custom real SMTP credentials in .env
 * 4. Ethereal Email (Automated test SMTP fallback)
 */
export async function getTransporter(senderSmtp?: SendEmailOptions['senderSmtp']): Promise<{
  transporter: Transporter;
  type: 'gmail' | 'smtp' | 'ethereal';
}> {
  // 1. Sender-level real SMTP / Gmail configuration
  if (senderSmtp && senderSmtp.smtpUser && senderSmtp.smtpPass) {
    const isGmail =
      (senderSmtp.smtpHost && senderSmtp.smtpHost.includes('gmail')) ||
      senderSmtp.smtpUser.toLowerCase().includes('@gmail.com');

    if (isGmail) {
      console.log(`[EmailService] Using Sender-Specific Gmail SMTP for: ${senderSmtp.smtpUser}`);
      return {
        transporter: nodemailer.createTransport({
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
      transporter: nodemailer.createTransport({
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
  if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) {
    console.log(`[EmailService] Using Global Real Gmail SMTP Service for: ${env.GMAIL_USER}`);
    return {
      transporter: nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: env.GMAIL_USER,
          pass: env.GMAIL_APP_PASSWORD,
        },
      }),
      type: 'gmail',
    };
  }

  // 3. Global Custom SMTP credentials configured in .env
  if (env.SMTP_USER && env.SMTP_PASS && env.SMTP_HOST !== 'smtp.ethereal.email') {
    console.log(`[EmailService] Using Global Custom SMTP Server (${env.SMTP_HOST}) for: ${env.SMTP_USER}`);
    return {
      transporter: nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: {
          user: env.SMTP_USER,
          pass: env.SMTP_PASS,
        },
      }),
      type: 'smtp',
    };
  }

  // 4. Default Ethereal Email test account (Fake SMTP)
  if (etherealTransporter) {
    return { transporter: etherealTransporter, type: 'ethereal' };
  }

  if (env.ETHEREAL_USER && env.ETHEREAL_PASS) {
    console.log(`[EmailService] Using provided Ethereal credentials for: ${env.ETHEREAL_USER}`);
    etherealTransporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: {
        user: env.ETHEREAL_USER,
        pass: env.ETHEREAL_PASS,
      },
    });
    return { transporter: etherealTransporter, type: 'ethereal' };
  }

  // Auto-generate test account on Ethereal
  console.log('[EmailService] Auto-generating Ethereal test account...');
  const testAccount = await nodemailer.createTestAccount();
  etherealAccountInfo = {
    user: testAccount.user,
    pass: testAccount.pass,
  };
  console.log(`[EmailService] Created Ethereal account: ${testAccount.user}`);

  etherealTransporter = nodemailer.createTransport({
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
export async function sendEtherealEmail(options: SendEmailOptions): Promise<SendEmailResult> {
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
    const previewUrl = isRealDelivery ? false : nodemailer.getTestMessageUrl(info);

    console.log(`\n========================================`);
    if (isRealDelivery) {
      console.log(`🚀 [REAL EMAIL DISPATCHED TO LIVE INBOX via ${type.toUpperCase()}]`);
    } else {
      console.log(`📫 [ETHEREAL TEST SMTP DELIVERED]`);
    }
    console.log(`To:          ${options.toEmail}`);
    console.log(`From:        ${senderAddress}`);
    console.log(`Subject:     ${options.subject}`);
    console.log(`MessageId:   ${info.messageId}`);
    if (previewUrl) {
      console.log(`Preview URL: ${previewUrl}`);
    } else if (isRealDelivery) {
      console.log(`Status:      Sent in REAL life directly to recipient's inbox!`);
    }
    console.log(`========================================\n`);

    return {
      success: true,
      messageId: info.messageId,
      previewUrl: previewUrl || (isRealDelivery ? 'Sent via Real Gmail / SMTP' : undefined),
      deliveredVia: type,
    };
  } catch (err: any) {
    console.error(`[EmailService Send Failure] To: ${options.toEmail} | Error:`, err.message);
    return {
      success: false,
      error: err.message || 'SMTP transmission failure',
    };
  }
}

export function getCachedEtherealCredentials() {
  return etherealAccountInfo;
}
