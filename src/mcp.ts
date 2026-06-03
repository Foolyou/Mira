#!/usr/bin/env bun
// mcp.ts — the convenience layer. Wraps the SAME core as the CLI; it must never
// expose a capability the CLI lacks (so Codex-over-shell stays at parity).
// Workspace/demo are per-call args, flipped through the single db.ts seam.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb, setWorkspaceOverride, configGet, configSet } from "./db.ts";
import * as core from "./core.ts";
import { sweep, deliverAck } from "./sweep.ts";
import { buildBrief } from "./brief.ts";
import type { Database } from "bun:sqlite";

// Per-call DB resolution. The server may be launched with --workspace; an
// individual tool call can still override workspace, and demo flips to demo.db.
const SERVER_WS = (() => {
  const i = process.argv.indexOf("--workspace");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

function withDb<T>(args: { workspace?: string; demo?: boolean }, fn: (db: Database) => T): T {
  setWorkspaceOverride(args.workspace ?? SERVER_WS ?? null);
  const db = openDb({ demo: !!args.demo });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const ctx = { workspace: z.string().optional(), demo: z.boolean().optional() };
const ok = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

const server = new McpServer({ name: "mira", version: "2.0.0" });

server.tool("add_task", "Add a task", {
  title: z.string(), area: z.string().optional(), priority: z.string().optional(),
  due_at: z.string().optional(), due_text: z.string().optional(),
  company_id: z.number().optional(), project_id: z.number().optional(), ...ctx,
}, async (a) => ok(withDb(a, (db) => core.addTask(db, a))));

server.tool("update_task", "Update a task by id", {
  id: z.number(), status: z.string().optional(), priority: z.string().optional(),
  area: z.string().optional(), title: z.string().optional(), due_at: z.string().optional(),
  due_text: z.string().optional(), ...ctx,
}, async (a) => ok(withDb(a, (db) => {
  const { id, workspace, demo, ...patch } = a as any;
  return core.updateTask(db, id, patch);
})));

server.tool("done_task", "Mark a task done", { id: z.number(), ...ctx },
  async (a) => ok(withDb(a, (db) => core.doneTask(db, a.id))));

server.tool("list_tasks", "List tasks with optional filters", {
  status: z.string().optional(), area: z.string().optional(),
  company_id: z.number().optional(), limit: z.number().optional(), ...ctx,
}, async (a) => ok(withDb(a, (db) => core.listTasks(db, a))));

server.tool("add_reminder", "Add a one-time reminder on a task", {
  task_id: z.number(), at: z.string(), ...ctx,
}, async (a) => ok(withDb(a, (db) => core.addReminder(db, a.task_id, a.at))));

server.tool("add_recurrence", "Add a recurrence rule (and its delivery spec)", {
  title: z.string(), pattern_type: z.string(), pattern_config: z.string(),
  remind_time: z.string().optional(), area: z.string().optional(),
  duration_days: z.number().optional(), company_id: z.number().optional(), ...ctx,
}, async (a) => ok(withDb(a, (db) => core.addRecurrence(db, a))));

server.tool("sweep_preview", "Preview which reminders are due (dry-run, no delivery)", {
  now: z.string().optional(), ...ctx,
}, async (a) => ok(await withDbAsync(a, (db) => sweep(db, { now: a.now, dryRun: true }))));

server.tool("brief", "Build the daily/weekly brief payload", {
  weekly: z.boolean().optional(), day: z.string().optional(), ...ctx,
}, async (a) => ok(withDb(a, (db) => buildBrief(db, { weekly: a.weekly, day: a.day }))));

server.tool("dashboard", "Dashboard: overdue, due-today, recurring-today, family", {
  day: z.string().optional(), ...ctx,
}, async (a) => ok(withDb(a, (db) => core.dashboard(db, a.day))));

server.tool("search", "Search tasks, notes, companies", { q: z.string(), ...ctx },
  async (a) => ok(withDb(a, (db) => core.search(db, a.q))));

server.tool("timeline", "Upcoming reminders + recurrence firings over N days", {
  days: z.number().optional(), ...ctx,
}, async (a) => ok(withDb(a, (db) => core.timeline(db, a.days ?? 14))));

server.tool("meeting_prep", "Prep pack for a company meeting", { company_id: z.number(), ...ctx },
  async (a) => ok(withDb(a, (db) => core.meetingPrep(db, a.company_id))));

server.tool("context", "Company/project context bundle", {
  company_id: z.number().optional(), project_id: z.number().optional(), ...ctx,
}, async (a) => ok(withDb(a, (db) => core.context(db, a.company_id, a.project_id))));

server.tool("counts", "Headline counts", { ...ctx },
  async (a) => ok(withDb(a, (db) => core.counts(db))));

server.tool("deliver_ack", "B2 callback: confirm an agent delivered a claimed payload", {
  log_id: z.number(), channel: z.string(), by: z.string().optional(), ...ctx,
}, async (a) => ok(withDb(a, (db) => deliverAck(db, a.log_id, a.channel, a.by ?? "claude-code"))));

server.tool("config_get", "Read a config value", { key: z.string(), ...ctx },
  async (a) => ok(withDb(a, (db) => ({ key: a.key, value: configGet(db, a.key) }))));

server.tool("config_set", "Write a config value", { key: z.string(), value: z.string(), ...ctx },
  async (a) => ok(withDb(a, (db) => { configSet(db, a.key, a.value); return { key: a.key, value: configGet(db, a.key) }; })));

// async variant of withDb for tools that await (sweep)
async function withDbAsync<T>(args: { workspace?: string; demo?: boolean }, fn: (db: Database) => Promise<T>): Promise<T> {
  setWorkspaceOverride(args.workspace ?? SERVER_WS ?? null);
  const db = openDb({ demo: !!args.demo });
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

// Exported so the CLI can launch it as `mira mcp` (one binary, one artifact).
export async function startMcp(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Still runnable directly (`bun src/mcp.ts` / the legacy mira-mcp bin / bunx).
if (import.meta.main) await startMcp();
