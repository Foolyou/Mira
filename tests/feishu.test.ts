// Feishu channel — bot DM through the user's local lark-cli. Tests inject a
// command runner so no real Feishu API call is made.
import { test, expect, describe } from "bun:test";
import { openDb } from "../src/db.ts";
import { FeishuChannel, type CommandResult } from "../src/delivery/feishu.ts";
import { getChannel } from "../src/delivery/index.ts";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";

let counter = 0;
function freshDb() {
  const p = join(tmpdir(), `mira-feishu-${process.pid}-${counter++}.db`);
  const db = openDb({ path: p });
  return { db, cleanup: () => { db.close(); for (const s of ["", "-wal", "-shm"]) try { rmSync(p + s); } catch {} } };
}

function ok(stdout: unknown = { ok: true }): CommandResult {
  return { exitCode: 0, stdout: JSON.stringify(stdout), stderr: "" };
}

function userOk() {
  return ok({ ok: true, data: { user: { open_id: "ou_self" } } });
}

function botOk() {
  return ok({ identities: { bot: { available: true, status: "ready", message: "Bot identity: ready" } } });
}

describe("feishu channel", () => {
  test("looks up the current user and sends a bot direct message to self", async () => {
    const { db, cleanup } = freshDb();
    const calls: string[][] = [];
    const replies = [
      userOk(),
      ok({ ok: true, data: { message_id: "om_1" } }),
    ];
    try {
      const ch = new FeishuChannel(db, (args) => {
        calls.push(args);
        return replies.shift()!;
      });
      await ch.send({ subject: "Status", text: "All & well" });

      expect(calls.length).toBe(2);
      expect(calls[0]).toEqual(["contact", "+get-user", "--as", "user", "--format", "json"]);
      expect(calls[1].slice(0, 8)).toEqual([
        "im",
        "+messages-send",
        "--as",
        "bot",
        "--user-id",
        "ou_self",
        "--text",
        "Status\n\nAll & well",
      ]);
      expect(calls[1]).toContain("--format");
      expect(calls[1]).toContain("json");
    } finally { cleanup(); }
  });

  test("verify checks local user auth and bot readiness without sending", async () => {
    const { db, cleanup } = freshDb();
    const calls: string[][] = [];
    const replies = [userOk(), botOk()];
    try {
      const ch = new FeishuChannel(db, (args) => {
        calls.push(args);
        return replies.shift()!;
      });
      await ch.verify();

      expect(calls).toEqual([
        ["contact", "+get-user", "--as", "user", "--format", "json"],
        ["auth", "status"],
      ]);
    } finally { cleanup(); }
  });

  test("verify errors when bot identity is not ready", async () => {
    const { db, cleanup } = freshDb();
    const replies = [
      userOk(),
      ok({ identities: { bot: { available: false, status: "missing", message: "Bot identity: unavailable" } } }),
    ];
    try {
      const ch = new FeishuChannel(db, () => replies.shift()!);
      await expect(ch.verify()).rejects.toThrow(/bot identity is not ready/);
    } finally { cleanup(); }
  });

  test("surfaces lark-cli failures clearly", async () => {
    const { db, cleanup } = freshDb();
    try {
      const ch = new FeishuChannel(db, () => ({ exitCode: 1, stdout: "", stderr: "not logged in" }));
      await expect(ch.send({ subject: "Ping", text: "body" })).rejects.toThrow(/Feishu current-user lookup failed: exit 1/);
    } finally { cleanup(); }
  });

  test("errors when current-user output has no open_id", async () => {
    const { db, cleanup } = freshDb();
    try {
      const ch = new FeishuChannel(db, () => ok({ ok: true, data: { user: {} } }));
      await expect(ch.verify()).rejects.toThrow(/data\.user\.open_id/);
    } finally { cleanup(); }
  });

  test("getChannel resolves feishu", () => {
    const { db, cleanup } = freshDb();
    try {
      expect(getChannel(db, "feishu")).toBeInstanceOf(FeishuChannel);
    } finally { cleanup(); }
  });
});
