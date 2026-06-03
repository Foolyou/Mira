// delivery/index.ts — the channel port. A channel just takes a rendered
// payload and gets it in front of the user. Config lives only in the Mira
// workspace, never in the agent, so Claude Code and Codex deliver byte-for-byte
// identically.
import type { Database } from "bun:sqlite";
import { StdoutChannel } from "./stdout.ts";
import { EmailChannel } from "./email.ts";
import { defaultChannel } from "../db.ts";
import { nowTs } from "../time.ts";

export interface Payload {
  subject: string;
  text: string;
  html?: string;
  imagePath?: string;
}

export interface Channel {
  send(payload: Payload): Promise<void>;
}

// Resolve a channel by name. Unknown names fall back to stdout so a
// misconfiguration degrades to "printed" rather than "silently dropped".
export function getChannel(db: Database, name: string): Channel {
  switch (name) {
    case "email":
      return new EmailChannel(db);
    case "stdout":
    case "":
      return new StdoutChannel();
    default:
      // ntfy/feishu are future fast channels; until implemented, be loud.
      return new StdoutChannel(`(channel '${name}' not implemented; using stdout)`);
  }
}

// Send a minimal end-to-end test message through a channel (default: the
// configured default channel). This is the real exercise that `doctor
// --check-channel` is not: --check-channel only verifies SMTP login, whereas
// this actually delivers, so something lands in the inbox. The payload carries
// no secrets, so the returned object is safe to print.
export async function sendTest(
  db: Database,
  opts: { channel?: string } = {},
): Promise<{ sent: boolean; channel: string; payload: Payload }> {
  const name = opts.channel || defaultChannel(db);
  const ch = getChannel(db, name);
  const ts = nowTs();
  const payload: Payload = {
    subject: `Mira 测试 · ${ts}`,
    text: `这是 Mira 的测试投递。\n\n通道:${name}\n时间:${ts}\n\n收到即说明该通道配置可用。`,
    html: `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px"><h3>Mira 测试 ✓</h3><p>这是 Mira 的测试投递。</p><ul><li>通道:${name}</li><li>时间:${ts}</li></ul><p style="color:#666">收到即说明该通道配置可用。</p></div>`,
  };
  await ch.send(payload);
  return { sent: true, channel: name, payload };
}
