// delivery/email.ts — SMTP via nodemailer (the one sanctioned external dep;
// hand-rolling SMTP+TLS+AUTH is the kind of thing that fails silently, and
// reliability beats dependency purity). Defaults target iCloud.
//
// config.channel.email is a JSON blob in the workspace DB:
//   {smtp_host, smtp_port, user, app_password, to, from}
import type { Database } from "bun:sqlite";
import type { Channel, Payload } from "./index.ts";
import { configGet } from "../db.ts";

interface EmailConfig {
  smtp_host: string;
  smtp_port: number;
  user: string;
  app_password: string;
  to: string;
  from?: string;
}

export class EmailChannel implements Channel {
  constructor(private db: Database) {}

  private config(): EmailConfig {
    const raw = configGet(this.db, "channel.email");
    if (!raw) throw new Error("channel.email is not configured (run: mira config set channel.email '{...}')");
    let c: any;
    try {
      c = JSON.parse(raw);
    } catch {
      throw new Error("channel.email config is not valid JSON");
    }
    const host = c.smtp_host || "smtp.mail.me.com";
    const port = Number(c.smtp_port || 587);
    if (!c.user || !c.app_password || !c.to) {
      throw new Error("channel.email needs user, app_password, and to");
    }
    return {
      smtp_host: host,
      smtp_port: port,
      user: c.user,
      app_password: c.app_password,
      to: c.to,
      from: c.from || c.user,
    };
  }

  async send(payload: Payload): Promise<void> {
    const c = this.config();
    // Lazy import so stdout-only / dry-run paths never need nodemailer present.
    const nodemailer = (await import("nodemailer")).default;
    const transport = nodemailer.createTransport({
      host: c.smtp_host,
      port: c.smtp_port,
      secure: c.smtp_port === 465, // 587 uses STARTTLS
      auth: { user: c.user, pass: c.app_password },
    });
    await transport.sendMail({
      from: c.from,
      to: c.to,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
      attachments: payload.imagePath
        ? [{ path: payload.imagePath }]
        : undefined,
    });
  }

  // Used by `mira doctor` to check connectivity without sending.
  async verify(): Promise<void> {
    const c = this.config();
    const nodemailer = (await import("nodemailer")).default;
    const transport = nodemailer.createTransport({
      host: c.smtp_host,
      port: c.smtp_port,
      secure: c.smtp_port === 465,
      auth: { user: c.user, pass: c.app_password },
    });
    await transport.verify();
  }
}
