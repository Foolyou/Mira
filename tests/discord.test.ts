// Discord channel — webhook-only notification delivery. Mirrors the email
// channel: configured entirely in the workspace DB, the webhook URL is a secret
// (resolved at send-time, redacted in config output), and `send-test` /
// `discord send` exercise it end-to-end. We stub global fetch so no network is
// touched.
import { test, expect, describe, afterEach } from "bun:test";
import { openDb, configSet } from "../src/db.ts";
import { sendDiscord, sendTest } from "../src/delivery/index.ts";
import { redactConfigValue } from "../src/secret.ts";
import { DiscordChannel } from "../src/delivery/discord.ts";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";

let counter = 0;
function freshDb() {
  const p = join(tmpdir(), `mira-discord-${process.pid}-${counter++}.db`);
  const db = openDb({ path: p });
  return { db, cleanup: () => { db.close(); for (const s of ["", "-wal", "-shm"]) try { rmSync(p + s); } catch {} } };
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Capture the outgoing request and reply with a configurable response.
function stubFetch(reply: { ok: boolean; status?: number; statusText?: string; body?: string } = { ok: true }) {
  const calls: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return {
      ok: reply.ok,
      status: reply.status ?? (reply.ok ? 204 : 400),
      statusText: reply.statusText ?? (reply.ok ? "No Content" : "Bad Request"),
      text: async () => reply.body ?? "",
    } as any;
  }) as any;
  return calls;
}

describe("discord send", () => {
  test("posts an embed with subject as title and text as description", async () => {
    const { db, cleanup } = freshDb();
    configSet(db, "channel.discord", JSON.stringify({ webhook_url: "https://discord.com/api/webhooks/1/abc", username: "Mira" }));
    const calls = stubFetch({ ok: true });
    try {
      const res = await sendDiscord(db, { subject: "Status", html: "<h1>Status</h1><p>All &amp; well</p>" });
      expect(res.sent).toBe(true);
      expect(res.channel).toBe("discord");
      // HTML body is flattened to text for Discord.
      expect(res.payload.text).toBe("Status\nAll & well");
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe("https://discord.com/api/webhooks/1/abc");
      expect(calls[0].init.method).toBe("POST");
      const body = JSON.parse(calls[0].init.body);
      expect(body.username).toBe("Mira");
      expect(body.embeds[0].title).toBe("Status");
      expect(body.embeds[0].description).toBe("Status\nAll & well");
    } finally { cleanup(); }
  });

  test("requires a subject or a body", async () => {
    const { db, cleanup } = freshDb();
    configSet(db, "channel.discord", JSON.stringify({ webhook_url: "https://x/y" }));
    stubFetch();
    try {
      await expect(sendDiscord(db, {})).rejects.toThrow();
    } finally { cleanup(); }
  });

  test("errors clearly when channel.discord is not configured", async () => {
    const { db, cleanup } = freshDb();
    stubFetch();
    try {
      await expect(sendDiscord(db, { text: "hi" })).rejects.toThrow(/channel.discord is not configured/);
    } finally { cleanup(); }
  });

  test("surfaces a non-2xx webhook response as an error", async () => {
    const { db, cleanup } = freshDb();
    configSet(db, "channel.discord", JSON.stringify({ webhook_url: "https://x/y" }));
    stubFetch({ ok: false, status: 404, statusText: "Not Found", body: "unknown webhook" });
    try {
      await expect(sendDiscord(db, { text: "hi" })).rejects.toThrow(/Discord webhook failed: 404/);
    } finally { cleanup(); }
  });

  test("send-test routes through the discord channel when it is the default", async () => {
    const { db, cleanup } = freshDb();
    configSet(db, "channel.discord", JSON.stringify({ webhook_url: "https://discord.com/api/webhooks/1/abc" }));
    const calls = stubFetch({ ok: true });
    try {
      const res = await sendTest(db, { channel: "discord" });
      expect(res.sent).toBe(true);
      expect(res.channel).toBe("discord");
      expect(calls.length).toBe(1);
      expect(JSON.parse(calls[0].init.body).embeds[0].title).toContain("Mira");
    } finally { cleanup(); }
  });

  test("verify GETs the webhook without posting a message", async () => {
    const { db, cleanup } = freshDb();
    configSet(db, "channel.discord", JSON.stringify({ webhook_url: "https://discord.com/api/webhooks/1/abc" }));
    const calls = stubFetch({ ok: true, status: 200, statusText: "OK" });
    try {
      await new DiscordChannel(db).verify();
      expect(calls.length).toBe(1);
      expect(calls[0].init.method).toBe("GET");
    } finally { cleanup(); }
  });
});

describe("discord bot DM", () => {
  test("opens a DM channel then posts the embed there", async () => {
    const { db, cleanup } = freshDb();
    configSet(db, "channel.discord", JSON.stringify({ bot_token: "BOTTOKEN", user_id: "555" }));
    // First POST opens the DM (returns a channel id); second POST sends.
    let n = 0;
    const calls: { url: string; init: any }[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      n++;
      if (n === 1) return { ok: true, status: 200, statusText: "OK", text: async () => "", json: async () => ({ id: "dm-42" }) } as any;
      return { ok: true, status: 200, statusText: "OK", text: async () => "", json: async () => ({ id: "msg" }) } as any;
    }) as any;
    try {
      const res = await sendDiscord(db, { subject: "Ping", text: "private hi" });
      expect(res.sent).toBe(true);
      expect(calls.length).toBe(2);
      // open DM
      expect(calls[0].url).toContain("/users/@me/channels");
      expect(calls[0].init.headers.Authorization).toBe("Bot BOTTOKEN");
      expect(JSON.parse(calls[0].init.body).recipient_id).toBe("555");
      // send to the returned channel id
      expect(calls[1].url).toContain("/channels/dm-42/messages");
      expect(JSON.parse(calls[1].init.body).embeds[0].title).toBe("Ping");
    } finally { cleanup(); }
  });

  test("bot mode requires user_id", async () => {
    const { db, cleanup } = freshDb();
    configSet(db, "channel.discord", JSON.stringify({ bot_token: "X" }));
    stubFetch();
    try {
      await expect(sendDiscord(db, { text: "hi" })).rejects.toThrow(/user_id/);
    } finally { cleanup(); }
  });

  test("surfaces a 403 (no shared server / DMs closed) from the send step", async () => {
    const { db, cleanup } = freshDb();
    configSet(db, "channel.discord", JSON.stringify({ bot_token: "X", user_id: "9" }));
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      if (n === 1) return { ok: true, status: 200, statusText: "OK", text: async () => "", json: async () => ({ id: "dm" }) } as any;
      return { ok: false, status: 403, statusText: "Forbidden", text: async () => "Cannot send messages to this user" } as any;
    }) as any;
    try {
      await expect(sendDiscord(db, { text: "hi" })).rejects.toThrow(/Discord DM send failed: 403/);
    } finally { cleanup(); }
  });

  test("verify GETs /users/@me with the bot token", async () => {
    const { db, cleanup } = freshDb();
    configSet(db, "channel.discord", JSON.stringify({ bot_token: "BOTTOKEN", user_id: "1" }));
    const calls = stubFetch({ ok: true, status: 200, statusText: "OK" });
    try {
      await new DiscordChannel(db).verify();
      expect(calls.length).toBe(1);
      expect(calls[0].init.method).toBe("GET");
      expect(calls[0].url).toContain("/users/@me");
      expect(calls[0].init.headers.Authorization).toBe("Bot BOTTOKEN");
    } finally { cleanup(); }
  });
});

describe("discord secret handling", () => {
  test("redacts a literal webhook_url but keeps file:/env: references visible", () => {
    const literal = JSON.parse(redactConfigValue("channel.discord", JSON.stringify({ webhook_url: "https://discord.com/api/webhooks/1/secrettoken" }))!);
    expect(literal.webhook_url).toBe("***");
    const ref = JSON.parse(redactConfigValue("channel.discord", JSON.stringify({ webhook_url: "env:MIRA_DISCORD_WEBHOOK" }))!);
    expect(ref.webhook_url).toBe("env:MIRA_DISCORD_WEBHOOK");
  });

  test("redacts a literal bot_token but keeps the non-secret user_id visible", () => {
    const r = JSON.parse(redactConfigValue("channel.discord", JSON.stringify({ bot_token: "MTIz.abc.secret", user_id: "555" }))!);
    expect(r.bot_token).toBe("***");
    expect(r.user_id).toBe("555");
  });
});
