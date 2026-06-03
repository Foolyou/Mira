// core.ts — the structured layer. Every core* function returns a
// JSON-serializable value and never prints. The CLI is the one caller; add a
// capability once here, expose it as a `mira` command.
import type { Database } from "bun:sqlite";
import { nowTs, parseLocal, fmtDate, startOfDay, addDays } from "./time.ts";
import { isDueOn, type Rule } from "./recurrence.ts";

// ----------------------------- tasks --------------------------------------
export interface TaskInput {
  title: string;
  status?: string;
  priority?: string;
  area?: string;
  due_at?: string;
  due_text?: string;
  company_id?: number | null;
  project_id?: number | null;
  note_id?: number | null;
  parent_task_id?: number | null;
  context?: string;
}

export function addTask(db: Database, t: TaskInput) {
  const now = nowTs();
  const info = db
    .query(
      `INSERT INTO tasks(title,status,priority,area,due_at,due_text,company_id,
         project_id,note_id,parent_task_id,context,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      t.title,
      t.status ?? "todo",
      t.priority ?? "medium",
      t.area ?? "work",
      t.due_at ?? "",
      t.due_text ?? "",
      t.company_id ?? null,
      t.project_id ?? null,
      t.note_id ?? null,
      t.parent_task_id ?? null,
      t.context ?? "",
      now,
      now,
    );
  return getTask(db, Number(info.lastInsertRowid));
}

export function getTask(db: Database, id: number) {
  return db.query("SELECT * FROM tasks WHERE id = ?").get(id) ?? null;
}

const TASK_FIELDS = [
  "title",
  "status",
  "priority",
  "area",
  "due_at",
  "due_text",
  "company_id",
  "project_id",
  "note_id",
  "parent_task_id",
  "context",
];

// Terminal task states: a task here is finished or abandoned, so its pending
// one-time reminders should stop firing.
const TERMINAL_STATES = new Set(["done", "cancelled"]);

// Resolve every active one-time reminder attached to a task. Returns the number
// of specs affected. Recurring specs (rule_id NOT NULL) are independent of task
// state and are left untouched.
export function cancelTaskReminders(db: Database, taskId: number): number {
  const info = db
    .query(
      "UPDATE reminder_specs SET status='cancelled' WHERE task_id=? AND rule_id IS NULL AND status='active'",
    )
    .run(taskId);
  return info.changes;
}

export function updateTask(db: Database, id: number, patch: Record<string, any>) {
  const sets: string[] = [];
  const vals: any[] = [];
  for (const k of TASK_FIELDS) {
    if (k in patch) {
      sets.push(`${k} = ?`);
      vals.push(patch[k]);
    }
  }
  if (!sets.length) return getTask(db, id);
  sets.push("updated_at = ?");
  vals.push(nowTs(), id);
  db.query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  // Entering a terminal state suppresses any pending reminders, mirroring
  // `task done`.
  if ("status" in patch && TERMINAL_STATES.has(patch.status)) {
    cancelTaskReminders(db, id);
  }
  return getTask(db, id);
}

export function doneTask(db: Database, id: number) {
  db.query("UPDATE tasks SET status='done', updated_at=? WHERE id=?").run(
    nowTs(),
    id,
  );
  cancelTaskReminders(db, id);
  return getTask(db, id);
}

export interface TaskFilter {
  status?: string;
  area?: string;
  company_id?: number;
  project_id?: number;
  limit?: number;
}

export function listTasks(db: Database, f: TaskFilter = {}) {
  const where: string[] = [];
  const vals: any[] = [];
  if (f.status) {
    where.push("status = ?");
    vals.push(f.status);
  }
  if (f.area) {
    where.push("area = ?");
    vals.push(f.area);
  }
  if (f.company_id != null) {
    where.push("company_id = ?");
    vals.push(f.company_id);
  }
  if (f.project_id != null) {
    where.push("project_id = ?");
    vals.push(f.project_id);
  }
  const sql =
    "SELECT * FROM tasks" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY (due_at = '') ASC, due_at ASC, id DESC" +
    (f.limit ? ` LIMIT ${Number(f.limit)}` : "");
  return db.query(sql).all(...vals);
}

// --------------------------- reminders ------------------------------------
// One-time reminder: attach a spec directly to a task at an absolute time.
export function addReminder(db: Database, taskId: number, at: string) {
  const d = parseLocal(at);
  if (!d) throw new Error(`invalid --at timestamp: ${at}`);
  const now = nowTs();
  const info = db
    .query(
      `INSERT INTO reminder_specs(task_id, rule_id, remind_at, status, created_at)
       VALUES(?, NULL, ?, 'active', ?)`,
    )
    .run(taskId, at, now);
  return db
    .query("SELECT * FROM reminder_specs WHERE id = ?")
    .get(Number(info.lastInsertRowid));
}

// Cancel a single active reminder by spec id. Returns the updated spec, or null
// if no active spec with that id existed.
export function cancelReminder(db: Database, id: number) {
  const info = db
    .query(
      "UPDATE reminder_specs SET status='cancelled' WHERE id=? AND status='active'",
    )
    .run(id);
  if (!info.changes) return null;
  return db.query("SELECT * FROM reminder_specs WHERE id = ?").get(id);
}

export function listReminders(db: Database, includeInactive = false) {
  const sql = `
    SELECT s.*, t.title AS task_title, r.title AS rule_title
      FROM reminder_specs s
      LEFT JOIN tasks t ON t.id = s.task_id
      LEFT JOIN recurrence_rules r ON r.id = s.rule_id
     ${includeInactive ? "" : "WHERE s.status = 'active'"}
     ORDER BY s.id DESC`;
  return db.query(sql).all();
}

// --------------------------- recurrence -----------------------------------
export interface RecurrenceInput {
  title: string;
  pattern_type: string;
  pattern_config: string;
  remind_time?: string;
  area?: string;
  duration_days?: number;
  company_id?: number | null;
  project_id?: number | null;
  channel_override?: string;
}

export function addRecurrence(db: Database, r: RecurrenceInput) {
  const now = nowTs();
  const info = db
    .query(
      `INSERT INTO recurrence_rules(title,area,company_id,project_id,pattern_type,
         pattern_config,remind_time,duration_days,channel_override,active,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,1,?)`,
    )
    .run(
      r.title,
      r.area ?? "personal",
      r.company_id ?? null,
      r.project_id ?? null,
      r.pattern_type,
      r.pattern_config,
      r.remind_time ?? "09:00",
      r.duration_days ?? 1,
      r.channel_override ?? "",
      now,
    );
  const ruleId = Number(info.lastInsertRowid);
  // A recurrence is only delivered if a spec points at it.
  db.query(
    `INSERT INTO reminder_specs(task_id, rule_id, remind_at, status, created_at)
     VALUES(NULL, ?, '', 'active', ?)`,
  ).run(ruleId, now);
  return db.query("SELECT * FROM recurrence_rules WHERE id = ?").get(ruleId);
}

export function listRecurrences(db: Database) {
  return db
    .query("SELECT * FROM recurrence_rules WHERE active = 1 ORDER BY id DESC")
    .all();
}

// ----------------------------- read models --------------------------------
export function counts(db: Database) {
  const one = (sql: string, ...a: any[]) =>
    (db.query(sql).get(...a) as { n: number }).n;
  return {
    tasks_open: one("SELECT COUNT(*) n FROM tasks WHERE status NOT IN ('done','cancelled')"),
    tasks_done: one("SELECT COUNT(*) n FROM tasks WHERE status = 'done'"),
    reminders_active: one("SELECT COUNT(*) n FROM reminder_specs WHERE status='active'"),
    recurrence_rules: one("SELECT COUNT(*) n FROM recurrence_rules WHERE active=1"),
    deliveries_pending: one("SELECT COUNT(*) n FROM delivery_log WHERE state IN ('pending','claimed')"),
    deliveries_failed: one("SELECT COUNT(*) n FROM delivery_log WHERE state='failed'"),
    companies: one("SELECT COUNT(*) n FROM companies"),
    projects: one("SELECT COUNT(*) n FROM projects"),
  };
}

// Dashboard: tasks due / overdue + recurrence rules active on the given day.
export function dashboard(db: Database, dayStr?: string) {
  const day = dayStr ? parseLocal(dayStr) ?? new Date() : new Date();
  const dayKey = fmtDate(day);
  const tasks = db
    .query(
      "SELECT * FROM tasks WHERE status NOT IN ('done','cancelled') ORDER BY (due_at='') ASC, due_at ASC",
    )
    .all() as any[];
  const overdue = tasks.filter(
    (t) => t.due_at && parseLocal(t.due_at)! < startOfDay(day),
  );
  const today = tasks.filter((t) => t.due_at && t.due_at.startsWith(dayKey));
  const rules = (
    db.query("SELECT * FROM recurrence_rules WHERE active=1").all() as Rule[]
  ).filter((r) => isDueOn(r, day));
  const family = tasks.filter((t) => (t as any).area === "family");
  return {
    day: dayKey,
    overdue,
    due_today: today,
    recurring_today: rules,
    family_watch: family,
    open_total: tasks.length,
  };
}

export function search(db: Database, q: string, limit = 30) {
  const like = `%${q}%`;
  const tasks = db
    .query("SELECT id,title,status,area FROM tasks WHERE title LIKE ? LIMIT ?")
    .all(like, limit);
  const notes = db
    .query("SELECT id,kind,content FROM notes WHERE content LIKE ? LIMIT ?")
    .all(like, limit);
  const companies = db
    .query("SELECT id,name,summary FROM companies WHERE name LIKE ? OR summary LIKE ? LIMIT ?")
    .all(like, like, limit);
  return { query: q, tasks, notes, companies };
}

// Timeline: upcoming reminders (one-time) + recurrence firings over N days.
export function timeline(db: Database, days = 14, fromStr?: string) {
  const from = fromStr ? parseLocal(fromStr) ?? new Date() : new Date();
  const items: Array<{ at: string; kind: string; title: string }> = [];
  const oneShots = db
    .query(
      `SELECT s.remind_at, t.title FROM reminder_specs s JOIN tasks t ON t.id=s.task_id
        WHERE s.status='active' AND s.rule_id IS NULL AND s.remind_at<>''`,
    )
    .all() as { remind_at: string; title: string }[];
  for (const r of oneShots)
    items.push({ at: r.remind_at, kind: "reminder", title: r.title });

  const rules = db.query("SELECT * FROM recurrence_rules WHERE active=1").all() as any[];
  for (let k = 0; k < days; k++) {
    const day = addDays(startOfDay(from), k);
    for (const r of rules)
      if (isDueOn(r as Rule, day))
        items.push({ at: `${fmtDate(day)} ${r.remind_time}`, kind: "recurring", title: r.title });
  }
  items.sort((a, b) => a.at.localeCompare(b.at));
  return { from: fmtDate(from), days, items };
}

export function context(db: Database, companyId?: number, projectId?: number) {
  const out: any = {};
  if (companyId != null) {
    out.company = db.query("SELECT * FROM companies WHERE id=?").get(companyId) ?? null;
    out.projects = db.query("SELECT * FROM projects WHERE company_id=?").all(companyId);
    out.people = db.query("SELECT * FROM people WHERE company_id=?").all(companyId);
    out.tasks = db
      .query("SELECT * FROM tasks WHERE company_id=? AND status NOT IN ('done','cancelled')")
      .all(companyId);
  }
  if (projectId != null) {
    out.project = db.query("SELECT * FROM projects WHERE id=?").get(projectId) ?? null;
    out.project_tasks = db
      .query("SELECT * FROM tasks WHERE project_id=? AND status NOT IN ('done','cancelled')")
      .all(projectId);
  }
  return out;
}

export function meetingPrep(db: Database, companyId: number) {
  const company = db.query("SELECT * FROM companies WHERE id=?").get(companyId);
  const openTasks = db
    .query("SELECT * FROM tasks WHERE company_id=? AND status NOT IN ('done','cancelled')")
    .all(companyId);
  const recentNotes = db
    .query("SELECT * FROM notes WHERE company_id=? ORDER BY created_at DESC LIMIT 5")
    .all(companyId);
  const people = db.query("SELECT * FROM people WHERE company_id=?").all(companyId);
  return { company, open_tasks: openTasks, recent_notes: recentNotes, people };
}

// ---------------------- knowledge CRUD (minimal) --------------------------
export interface CompanyFilter {
  type?: string;
  limit?: number;
}

export function listCompanies(db: Database, f: CompanyFilter = {}) {
  const where: string[] = [];
  const vals: any[] = [];
  if (f.type) {
    where.push("type = ?");
    vals.push(f.type);
  }
  const sql =
    "SELECT * FROM companies" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY name ASC" +
    (f.limit ? ` LIMIT ${Number(f.limit)}` : "");
  return db.query(sql).all(...vals);
}

export function addCompany(db: Database, name: string, type = "client", summary = "") {
  const info = db
    .query("INSERT INTO companies(name,type,summary,created_at) VALUES(?,?,?,?)")
    .run(name, type, summary, nowTs());
  return db.query("SELECT * FROM companies WHERE id=?").get(Number(info.lastInsertRowid));
}

export interface ProjectFilter {
  company_id?: number;
  status?: string;
  limit?: number;
}

export function listProjects(db: Database, f: ProjectFilter = {}) {
  const where: string[] = [];
  const vals: any[] = [];
  if (f.company_id != null) {
    where.push("p.company_id = ?");
    vals.push(f.company_id);
  }
  if (f.status) {
    where.push("p.status = ?");
    vals.push(f.status);
  }
  const sql =
    `SELECT p.*, c.name AS company_name
       FROM projects p
       LEFT JOIN companies c ON c.id = p.company_id` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY c.name ASC, p.name ASC" +
    (f.limit ? ` LIMIT ${Number(f.limit)}` : "");
  return db.query(sql).all(...vals);
}

export function addProject(db: Database, name: string, companyId?: number | null, summary = "") {
  const info = db
    .query("INSERT INTO projects(company_id,name,summary,created_at) VALUES(?,?,?,?)")
    .run(companyId ?? null, name, summary, nowTs());
  return db.query("SELECT * FROM projects WHERE id=?").get(Number(info.lastInsertRowid));
}

export interface NoteFilter {
  company_id?: number;
  project_id?: number;
  kind?: string;
  limit?: number;
}

export function listNotes(db: Database, f: NoteFilter = {}) {
  const where: string[] = [];
  const vals: any[] = [];
  if (f.company_id != null) {
    where.push("n.company_id = ?");
    vals.push(f.company_id);
  }
  if (f.project_id != null) {
    where.push("n.project_id = ?");
    vals.push(f.project_id);
  }
  if (f.kind) {
    where.push("n.kind = ?");
    vals.push(f.kind);
  }
  const sql =
    `SELECT n.*, c.name AS company_name, p.name AS project_name
       FROM notes n
       LEFT JOIN companies c ON c.id = n.company_id
       LEFT JOIN projects p ON p.id = n.project_id` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY n.created_at DESC, n.id DESC" +
    (f.limit ? ` LIMIT ${Number(f.limit)}` : "");
  return db.query(sql).all(...vals);
}

export function addNote(
  db: Database,
  content: string,
  opts: { kind?: string; company_id?: number | null; project_id?: number | null; tags?: string } = {},
) {
  const info = db
    .query(
      "INSERT INTO notes(kind,content,company_id,project_id,tags,created_at) VALUES(?,?,?,?,?,?)",
    )
    .run(
      opts.kind ?? "quick_note",
      content,
      opts.company_id ?? null,
      opts.project_id ?? null,
      opts.tags ?? "",
      nowTs(),
    );
  return db.query("SELECT * FROM notes WHERE id=?").get(Number(info.lastInsertRowid));
}

export interface CaptureFilter {
  kind?: string;
  source?: string;
  status?: string;
  limit?: number;
}

export function listCaptures(db: Database, f: CaptureFilter = {}) {
  const where: string[] = [];
  const vals: any[] = [];
  if (f.kind) {
    where.push("kind = ?");
    vals.push(f.kind);
  }
  if (f.source) {
    where.push("source = ?");
    vals.push(f.source);
  }
  if (f.status) {
    where.push("classification_status = ?");
    vals.push(f.status);
  }
  const sql =
    "SELECT * FROM captures" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY created_at DESC, id DESC" +
    (f.limit ? ` LIMIT ${Number(f.limit)}` : "");
  return db.query(sql).all(...vals);
}

export function capture(db: Database, rawText: string, kind = "inbox", source = "manual") {
  const info = db
    .query("INSERT INTO captures(raw_text,kind,source,created_at) VALUES(?,?,?,?)")
    .run(rawText, kind, source, nowTs());
  return db.query("SELECT * FROM captures WHERE id=?").get(Number(info.lastInsertRowid));
}
