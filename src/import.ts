// import.ts — migrate real v1 data (data/lifework.db) into the v2 model.
//  - tasks            -> tasks (due_at kept; old due/due_text collapse to label)
//  - recurring_rules  -> recurrence_rules (+ remind_time default 09:00) + a spec
//  - reminders(active) -> reminder_specs; cron_id is dropped, done/cancelled skip
//  - knowledge layer  -> carried over verbatim, ids preserved to keep FKs valid
import { Database } from "bun:sqlite";
import type { Database as DB } from "bun:sqlite";
import { nowTs } from "./time.ts";

export interface ImportResult {
  source: string;
  companies: number;
  projects: number;
  people: number;
  notes: number;
  captures: number;
  resources: number;
  deliverables: number;
  ideas: number;
  tasks: number;
  recurrence_rules: number;
  reminder_specs_from_recurrence: number;
  reminder_specs_from_reminders: number;
  reminders_skipped_inactive: number;
}

function tableExists(db: DB, name: string): boolean {
  return !!db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function colExists(db: DB, table: string, col: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === col);
}

export function importV1(db: DB, sourcePath: string, opts: { force?: boolean } = {}): ImportResult {
  const existing = (db.query("SELECT COUNT(*) n FROM tasks").get() as { n: number }).n;
  if (existing > 0 && !opts.force) {
    throw new Error(`target already has ${existing} tasks; pass --force to import anyway`);
  }
  const src = new Database(sourcePath, { readonly: true });
  const now = nowTs();
  const res: ImportResult = {
    source: sourcePath,
    companies: 0, projects: 0, people: 0, notes: 0, captures: 0,
    resources: 0, deliverables: 0, ideas: 0, tasks: 0,
    recurrence_rules: 0, reminder_specs_from_recurrence: 0,
    reminder_specs_from_reminders: 0, reminders_skipped_inactive: 0,
  };

  db.exec("BEGIN");
  try {
    // --- knowledge layer (ids preserved so FK references stay valid) ---
    if (tableExists(src, "companies")) {
      for (const c of src.query("SELECT * FROM companies").all() as any[]) {
        db.query(
          `INSERT INTO companies(id,name,type,summary,relationship_status,decision_maker,concerns,next_step,created_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        ).run(c.id, c.name, c.type ?? "client", c.summary ?? "", c.relationship_status ?? "",
          c.decision_maker ?? "", c.concerns ?? "", c.next_step ?? "", c.created_at ?? now);
        res.companies++;
      }
    }
    if (tableExists(src, "projects")) {
      for (const p of src.query("SELECT * FROM projects").all() as any[]) {
        db.query(
          `INSERT INTO projects(id,company_id,name,status,summary,stage,next_step,risk,created_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        ).run(p.id, p.company_id ?? null, p.name, p.status ?? "active", p.summary ?? "",
          p.stage ?? "", p.next_step ?? "", p.risk ?? "", p.created_at ?? now);
        res.projects++;
      }
    }
    if (tableExists(src, "people")) {
      for (const p of src.query("SELECT * FROM people").all() as any[]) {
        db.query("INSERT INTO people(id,company_id,name,role,notes,created_at) VALUES(?,?,?,?,?,?)")
          .run(p.id, p.company_id ?? null, p.name, p.role ?? "", p.notes ?? "", p.created_at ?? now);
        res.people++;
      }
    }
    if (tableExists(src, "notes")) {
      for (const n of src.query("SELECT * FROM notes").all() as any[]) {
        db.query(
          "INSERT INTO notes(id,kind,content,company_id,project_id,source,tags,created_at) VALUES(?,?,?,?,?,?,?,?)",
        ).run(n.id, n.kind ?? "quick_note", n.content, n.company_id ?? null, n.project_id ?? null,
          n.source ?? "manual", n.tags ?? "", n.created_at ?? now);
        res.notes++;
      }
    }
    if (tableExists(src, "captures")) {
      for (const c of src.query("SELECT * FROM captures").all() as any[]) {
        db.query(
          `INSERT INTO captures(id,raw_text,kind,source,note_id,task_id,classification_status,suggested_type,confidence,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
        ).run(c.id, c.raw_text, c.kind ?? "inbox", c.source ?? "manual", c.note_id ?? null,
          c.task_id ?? null, c.classification_status ?? "needs_review", c.suggested_type ?? "",
          c.confidence ?? "", c.created_at ?? now);
        res.captures++;
      }
    }
    if (tableExists(src, "resources")) {
      for (const r of src.query("SELECT * FROM resources").all() as any[]) {
        db.query(
          `INSERT INTO resources(id,company_id,project_id,task_id,note_id,title,kind,url,path,notes,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(r.id, r.company_id ?? null, r.project_id ?? null, r.task_id ?? null, r.note_id ?? null,
          r.title, r.kind ?? "link", r.url ?? "", r.path ?? "", r.notes ?? "", r.created_at ?? now);
        res.resources++;
      }
    }
    if (tableExists(src, "deliverables")) {
      for (const d of src.query("SELECT * FROM deliverables").all() as any[]) {
        db.query(
          `INSERT INTO deliverables(id,company_id,project_id,title,status,due_at,notes,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        ).run(d.id, d.company_id ?? null, d.project_id ?? null, d.title, d.status ?? "planned",
          d.due_at ?? "", d.notes ?? "", d.created_at ?? now, d.updated_at ?? now);
        res.deliverables++;
      }
    }
    if (tableExists(src, "ideas")) {
      for (const i of src.query("SELECT * FROM ideas").all() as any[]) {
        db.query("INSERT INTO ideas(id,title,content,status,created_at) VALUES(?,?,?,?,?)")
          .run(i.id, i.title, i.content, i.status ?? "incubating", i.created_at ?? now);
        res.ideas++;
      }
    }

    // --- tasks: due_at kept, old due/due_text collapsed to a label ---
    const hasDue = colExists(src, "tasks", "due");
    const hasDueText = colExists(src, "tasks", "due_text");
    const hasDueAt = colExists(src, "tasks", "due_at");
    const hasParent = colExists(src, "tasks", "parent_task_id");
    for (const t of src.query("SELECT * FROM tasks").all() as any[]) {
      const dueText = (hasDueText && t.due_text) || (hasDue && t.due) || "";
      const dueAt = hasDueAt ? t.due_at ?? "" : "";
      db.query(
        `INSERT INTO tasks(id,title,status,priority,area,due_at,due_text,company_id,project_id,note_id,parent_task_id,context,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(t.id, t.title, t.status ?? "todo", t.priority ?? "medium", t.area ?? "work",
        dueAt, dueText, t.company_id ?? null, t.project_id ?? null, t.note_id ?? null,
        hasParent ? t.parent_task_id ?? null : null, t.context ?? "", t.created_at ?? now, t.updated_at ?? now);
      res.tasks++;
    }

    // --- recurring_rules -> recurrence_rules + one active spec each ---
    if (tableExists(src, "recurring_rules")) {
      for (const r of src.query("SELECT * FROM recurring_rules").all() as any[]) {
        db.query(
          `INSERT INTO recurrence_rules(id,title,area,company_id,project_id,pattern_type,pattern_config,remind_time,duration_days,channel_override,active,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(r.id, r.title, r.area ?? "personal", r.company_id ?? null, r.project_id ?? null,
          r.pattern_type, r.pattern_config ?? "{}", "09:00", r.duration_days ?? 1, "",
          r.active ?? 1, r.created_at ?? now);
        res.recurrence_rules++;
        if (r.active ?? 1) {
          db.query(
            "INSERT INTO reminder_specs(task_id,rule_id,remind_at,status,created_at) VALUES(NULL,?,'','active',?)",
          ).run(r.id, now);
          res.reminder_specs_from_recurrence++;
        }
      }
    }

    // --- reminders(active only) -> reminder_specs; cron_id dropped ---
    if (tableExists(src, "reminders")) {
      for (const rm of src.query("SELECT * FROM reminders").all() as any[]) {
        const active = rm.status === "scheduled" || rm.status === "active";
        if (!active) {
          res.reminders_skipped_inactive++;
          continue;
        }
        db.query(
          "INSERT INTO reminder_specs(task_id,rule_id,remind_at,status,created_at) VALUES(?,NULL,?,'active',?)",
        ).run(rm.task_id, rm.remind_at, rm.created_at ?? now);
        res.reminder_specs_from_reminders++;
      }
    }

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    src.close();
    throw e;
  }
  src.close();
  return res;
}
