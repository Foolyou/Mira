// delivery/discord.ts — Discord notifications, send-only, in two shapes that
// share one channel:
//   • webhook  {webhook_url, username?, avatar_url?}   posts into a channel
//   • bot DM   {bot_token, user_id}                    private-messages a user
// Both are pure REST (no gateway, no daemon), so they fit Mira's one-shot model.
// The credential — webhook_url or bot_token — is resolved at send-time and
// redacted in config output. The shape is auto-detected: bot_token wins if both
// are present.
import type { Database } from "bun:sqlite";
import type { Channel, Payload } from "./index.ts";
import { configGet } from "../db.ts";
import { resolveSecret } from "../secret.ts";

const API = "https://discord.com/api/v10";

// Discord's hard caps; we truncate rather than let the API 400 a long reminder.
const EMBED_TITLE_LIMIT = 256;
const EMBED_DESC_LIMIT = 4096;

type DiscordConfig =
  | { kind: "webhook"; webhook_url: string; username?: string; avatar_url?: string }
  | { kind: "bot"; bot_token: string; user_id: string };

export class DiscordChannel implements Channel {
  constructor(private db: Database) {}

  private config(): DiscordConfig {
    const raw = configGet(this.db, "channel.discord");
    if (!raw) throw new Error("channel.discord is not configured (run: mira config set channel.discord '{...}')");
    let c: any;
    try {
      c = JSON.parse(raw);
    } catch {
      throw new Error("channel.discord config is not valid JSON");
    }
    // bot DM takes precedence so a config carrying both shapes is unambiguous.
    if (c.bot_token) {
      if (!c.user_id) throw new Error("channel.discord bot mode needs user_id (the recipient's numeric Discord ID)");
      // Supports a literal, `file:<path>`, or `env:<VAR>` — resolved here, used
      // in-process only, never echoed back to any caller.
      return { kind: "bot", bot_token: resolveSecret(String(c.bot_token)), user_id: String(c.user_id) };
    }
    if (c.webhook_url) {
      return {
        kind: "webhook",
        webhook_url: resolveSecret(String(c.webhook_url)),
        username: c.username ? String(c.username) : undefined,
        avatar_url: c.avatar_url ? String(c.avatar_url) : undefined,
      };
    }
    throw new Error("channel.discord needs either webhook_url (channel post) or bot_token + user_id (private DM)");
  }

  // An embed renders subject as a title and text as the body — cleaner than a
  // flat content string, and HTML is not useful to Discord so we use text.
  private embed(payload: Payload): Record<string, unknown> {
    return {
      title: trunc(payload.subject, EMBED_TITLE_LIMIT),
      description: trunc(payload.text, EMBED_DESC_LIMIT),
    };
  }

  async send(payload: Payload): Promise<void> {
    const c = this.config();
    if (c.kind === "webhook") {
      const body = JSON.stringify({
        ...(c.username ? { username: c.username } : {}),
        ...(c.avatar_url ? { avatar_url: c.avatar_url } : {}),
        embeds: [this.embed(payload)],
      });
      await post(c.webhook_url, { "content-type": "application/json" }, body, "Discord webhook");
      return;
    }
    // bot DM: open (or reuse) the DM channel with the recipient, then send.
    // Opening is idempotent — Discord returns the existing DM channel — so no
    // state to cache. Sending fails with 403 if the bot shares no server with
    // the user or the user disallows DMs; the error carries Discord's reason.
    const auth = { Authorization: `Bot ${c.bot_token}`, "content-type": "application/json" };
    const dm = await post(`${API}/users/@me/channels`, auth, JSON.stringify({ recipient_id: c.user_id }), "Discord open-DM");
    const channelId = dm?.id;
    if (!channelId) throw new Error("Discord open-DM returned no channel id");
    await post(`${API}/channels/${channelId}/messages`, auth, JSON.stringify({ embeds: [this.embed(payload)] }), "Discord DM send");
  }

  // Used by `mira doctor --check-channel` to check credentials without posting.
  //   webhook: GET the webhook URL (200 = valid id+token), sends nothing.
  //   bot:     GET /users/@me with the bot token (200 = token valid).
  async verify(): Promise<void> {
    const c = this.config();
    if (c.kind === "webhook") {
      await get(c.webhook_url, {}, "Discord webhook");
      return;
    }
    await get(`${API}/users/@me`, { Authorization: `Bot ${c.bot_token}` }, "Discord bot token");
  }
}

async function post(url: string, headers: Record<string, string>, body: string, what: string): Promise<any> {
  const res = await fetch(url, { method: "POST", headers, body });
  if (!res.ok) throw new Error(await errDetail(res, `${what} failed`));
  // 204 (webhook) has no body; the DM endpoints return JSON we need.
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

async function get(url: string, headers: Record<string, string>, what: string): Promise<void> {
  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) throw new Error(await errDetail(res, `${what} invalid`));
}

async function errDetail(res: Response, prefix: string): Promise<string> {
  const detail = await res.text().catch(() => "");
  return `${prefix}: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ""}`;
}

function trunc(s: string, n: number): string {
  if (!s) return s;
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
