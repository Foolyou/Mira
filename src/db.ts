// db.ts — the single source of truth: workspace resolution, schema, additive
// migrations, and config. Everything else in Mira opens its DB through here.
import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync, existsSync, copyFileSync } from "fs";

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Workspace / path resolution. There is NO global/home workspace: a workspace
// is just a `.mira` directory and Mira always works against the one in the
// current working directory unless told otherwise. Order (highest precedence
// first):
//   per-call override  >  MIRA_WORKSPACE env  >  default <cwd>/.mira
// A workspace must be created explicitly with `mira init`; data commands error
// if it does not exist (so you never silently spawn a second, empty DB just by
// running from the wrong directory). Granular MIRA_DB_PATH / MIRA_DEMO_DB_PATH
// override the individual db file (used by Docker and tests).
// ---------------------------------------------------------------------------
let workspaceOverride: string | null = null;

export function setWorkspaceOverride(ws: string | null): void {
  workspaceOverride = ws;
}

export function resolveWorkspace(): string {
  return (
    workspaceOverride ??
    process.env.MIRA_WORKSPACE ??
    join(process.cwd(), ".mira")
  );
}

export function dbPath(demo = false): string {
  if (!demo && process.env.MIRA_DB_PATH) return process.env.MIRA_DB_PATH;
  if (demo && process.env.MIRA_DEMO_DB_PATH) return process.env.MIRA_DEMO_DB_PATH;
  return join(resolveWorkspace(), demo ? "demo.db" : "mira.db");
}

// Has this workspace been initialized (its mira.db exists)? Used by the CLI to
// refuse data commands until `mira init` has run.
export function isInitialized(workspace?: string): boolean {
  const ws = workspace ?? resolveWorkspace();
  return existsSync(join(ws, "mira.db"));
}

// Create (or no-op return) a workspace at `workspace`, running migrations. If a
// legacy nested layout (<workspace>/workspace/mira.db, from the pre-redesign
// `.mira/workspace` convention) is found, copy it up so existing data is
// adopted rather than orphaned — the old copy is left in place as a backup.
export function initWorkspace(workspace?: string): {
  workspace: string;
  db_path: string;
  created: boolean;
  migrated_from?: string;
} {
  const ws = workspace ?? resolveWorkspace();
  const target = join(ws, "mira.db");
  if (existsSync(target)) {
    const db = openDb({ path: target, create: true });
    db.close();
    return { workspace: ws, db_path: target, created: false };
  }
  mkdirSync(ws, { recursive: true });
  let migratedFrom: string | undefined;
  const legacy = join(ws, "workspace", "mira.db");
  if (existsSync(legacy)) {
    copyFileSync(legacy, target);
    for (const sfx of ["-wal", "-shm"]) {
      if (existsSync(legacy + sfx)) copyFileSync(legacy + sfx, target + sfx);
    }
    migratedFrom = legacy;
  }
  const db = openDb({ path: target, create: true });
  db.close();
  return { workspace: ws, db_path: target, created: true, ...(migratedFrom ? { migrated_from: migratedFrom } : {}) };
}

// ---------------------------------------------------------------------------
// Opening. WAL + busy_timeout make the atomic claim safe under concurrent
// "brains" (cron / Claude Code / Codex) all sweeping at once.
// ---------------------------------------------------------------------------
export function openDb(opts: { demo?: boolean; path?: string; create?: boolean } = {}): Database {
  const path = opts.path ?? dbPath(opts.demo);
  const create = opts.create ?? true;
  if (path !== ":memory:" && create) {
    const dir = path.replace(/[^/]+$/, "");
    if (dir) mkdirSync(dir, { recursive: true });
  }
  const db = new Database(path, { create });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  initDb(db);
  return db;
}

function columnExists(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

// ---------------------------------------------------------------------------
// Schema + migrations. Additive and ordered, guarded by columnExists, with
// PRAGMA user_version as the baseline. Bumping schema => bump SCHEMA_VERSION
// and update the export test.
// ---------------------------------------------------------------------------
export function initDb(db: Database): void {
  db.exec("BEGIN");
  try {
    // --- knowledge layer (carried over from v1, unchanged in spirit) ---
    db.exec(`
      CREATE TABLE IF NOT EXISTS companies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        type TEXT DEFAULT 'client',
        summary TEXT DEFAULT '',
        relationship_status TEXT DEFAULT '',
        decision_maker TEXT DEFAULT '',
        concerns TEXT DEFAULT '',
        next_step TEXT DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER,
        name TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        summary TEXT DEFAULT '',
        stage TEXT DEFAULT '',
        next_step TEXT DEFAULT '',
        risk TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(company_id, name),
        FOREIGN KEY(company_id) REFERENCES companies(id)
      );
      CREATE TABLE IF NOT EXISTS people (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER,
        name TEXT NOT NULL,
        role TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(company_id, name),
        FOREIGN KEY(company_id) REFERENCES companies(id)
      );
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL DEFAULT 'quick_note',
        content TEXT NOT NULL,
        company_id INTEGER,
        project_id INTEGER,
        source TEXT DEFAULT 'manual',
        tags TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY(company_id) REFERENCES companies(id),
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE TABLE IF NOT EXISTS captures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        raw_text TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'inbox',
        source TEXT DEFAULT 'manual',
        note_id INTEGER,
        task_id INTEGER,
        classification_status TEXT DEFAULT 'needs_review',
        suggested_type TEXT DEFAULT '',
        confidence TEXT DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER,
        project_id INTEGER,
        task_id INTEGER,
        note_id INTEGER,
        title TEXT NOT NULL,
        kind TEXT DEFAULT 'link',
        url TEXT DEFAULT '',
        path TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deliverables (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER,
        project_id INTEGER,
        title TEXT NOT NULL,
        status TEXT DEFAULT 'planned',
        due_at TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ideas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT DEFAULT 'incubating',
        created_at TEXT NOT NULL
      );
    `);

    // --- tasks: due_at is the timestamp; due_text is a label only ---
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'todo',
        priority TEXT NOT NULL DEFAULT 'medium',
        area TEXT NOT NULL DEFAULT 'work',
        due_at TEXT DEFAULT '',
        due_text TEXT DEFAULT '',
        company_id INTEGER,
        project_id INTEGER,
        note_id INTEGER,
        parent_task_id INTEGER,
        context TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(company_id) REFERENCES companies(id),
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
    `);

    // --- recurrence_rules: the one and only recurrence truth ---
    db.exec(`
      CREATE TABLE IF NOT EXISTS recurrence_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        area TEXT NOT NULL DEFAULT 'personal',
        company_id INTEGER,
        project_id INTEGER,
        pattern_type TEXT NOT NULL,
        pattern_config TEXT NOT NULL DEFAULT '{}',
        remind_time TEXT NOT NULL DEFAULT '09:00',
        duration_days INTEGER NOT NULL DEFAULT 1,
        channel_override TEXT DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        FOREIGN KEY(company_id) REFERENCES companies(id),
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
    `);

    // --- reminder_specs: one-time (task_id) XOR recurring (rule_id) ---
    db.exec(`
      CREATE TABLE IF NOT EXISTS reminder_specs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        rule_id INTEGER,
        remind_at TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id),
        FOREIGN KEY(rule_id) REFERENCES recurrence_rules(id)
      );
    `);

    // --- delivery_log: occurrence + idempotent state machine (the core) ---
    db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spec_id INTEGER NOT NULL,
        occurrence_key TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        channel TEXT DEFAULT '',
        delivered_by TEXT DEFAULT '',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT DEFAULT '',
        claimed_at TEXT DEFAULT '',
        delivered_at TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(spec_id, occurrence_key),
        FOREIGN KEY(spec_id) REFERENCES reminder_specs(id)
      );
    `);

    // --- config: delivery mode + channel creds, lives in workspace ---
    db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Future additive migrations go here, each guarded by columnExists().
    // (none yet at SCHEMA_VERSION 1)
    void columnExists;

    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------
export function configGet(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM config WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function configSet(db: Database, key: string, value: string): void {
  db.query(
    "INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function configAll(db: Database): Record<string, string> {
  const rows = db.query("SELECT key, value FROM config ORDER BY key").all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// Defaults read lazily so a fresh DB behaves sanely without explicit config.
export function deliveryMode(db: Database): "mira" | "agent" | "both" {
  const v = configGet(db, "delivery.mode");
  return v === "agent" || v === "both" ? v : "mira";
}

export function defaultChannel(db: Database): string {
  return configGet(db, "delivery.default_channel") ?? "stdout";
}

export function maxAttempts(db: Database): number {
  const v = configGet(db, "delivery.max_attempts");
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 5;
}
