import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../config/env';
import { logger } from './logger';

/**
 * Email behind an interface. Three drivers:
 *   file    — development default: writes .eml files to ./data/mail so nothing is lost
 *   console — prints to stdout
 *   smtp / resend — real delivery; NOT implemented here, and they throw rather than
 *                   silently dropping mail. See docs/ARCHITECTURE.md.
 *
 * Rationale: a silent no-op mailer is worse than a visible failure, because the agency
 * believes an approval link was sent when it never was.
 */
export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Where a reply should go, when different from the system sender. */
  replyTo?: string;
}

export interface MailDriver {
  send(mail: OutboundMail): Promise<{ delivered: boolean; detail: string }>;
}

class FileMail implements MailDriver {
  async send(mail: OutboundMail) {
    await fs.mkdir(env.mailDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const id = crypto.randomBytes(4).toString('hex');
    const file = path.join(env.mailDir, `${stamp}-${id}.eml`);
    const content = [
      `From: ${env.mailFrom}`,
      `To: ${mail.to}`,
      mail.replyTo ? `Reply-To: ${mail.replyTo}` : '',
      `Subject: ${mail.subject}`,
      `Date: ${new Date().toUTCString()}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      mail.text,
      '',
      mail.html ? `<!-- html alternative -->\n${mail.html}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    await fs.writeFile(file, content, 'utf8');
    logger.info('Email written to development outbox', { to: mail.to, subject: mail.subject, file });
    return { delivered: true, detail: `Written to ${file}` };
  }
}

class ConsoleMail implements MailDriver {
  async send(mail: OutboundMail) {
    logger.info('Email (console driver)', { to: mail.to, subject: mail.subject, body: mail.text.slice(0, 500) });
    return { delivered: true, detail: 'Logged to console' };
  }
}

class UnconfiguredMail implements MailDriver {
  constructor(private readonly driverName: string) {}
  async send(mail: OutboundMail) {
    logger.warn(`Mail driver "${this.driverName}" is not implemented; email was NOT sent`, {
      to: mail.to,
      subject: mail.subject,
    });
    return {
      delivered: false,
      detail: `Driver "${this.driverName}" is not configured. Set MAIL_DRIVER=file for development, or implement the driver (see docs/ARCHITECTURE.md).`,
    };
  }
}

export const mail: MailDriver =
  env.mailDriver === 'file'
    ? new FileMail()
    : env.mailDriver === 'console'
      ? new ConsoleMail()
      : new UnconfiguredMail(env.mailDriver);
