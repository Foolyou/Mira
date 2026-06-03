// A task entering a terminal state (done or cancelled) suppresses its pending
// one-time reminders; `reminder cancel` does it explicitly. Recurring specs are
// independent of task state.
import { test, expect, describe, afterAll } from "bun:test";
import { openDb } from "../src/db.ts";
import { sweep } from "../src/sweep.ts";
import * as core from "../src/core.ts";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";

let counter = 0;
const made: string[] = [];
function freshDb() {
  const p = join(tmpdir(), `mira-cancel-${process.pid}-${counter++}.db`);
  made.push(p);
  return openDb({ path: p });
}
afterAll(() => {
  for (const p of made) for (const s of ["", "-wal", "-shm"]) try { rmSync(p + s); } catch {}
});

function activeSpecs(db: any) {
  return db.query("SELECT * FROM reminder_specs WHERE status='active'").all();
}

describe("terminal task states suppress pending reminders", () => {
  test("task done cancels the one-time reminder; sweep delivers nothing", async () => {
    const db = freshDb();
    const t = core.addTask(db, { title: "reimburse" }) as any;
    core.addReminder(db, t.id, "2026-06-06 09:00");
    core.doneTask(db, t.id);
    expect(activeSpecs(db).length).toBe(0);
    const r = await sweep(db, { now: "2026-06-06 09:05" });
    expect(r.delivered).toBe(0);
    db.close();
  });

  test("task update --status cancelled also cancels the reminder", async () => {
    const db = freshDb();
    const t = core.addTask(db, { title: "reimburse" }) as any;
    core.addReminder(db, t.id, "2026-06-06 09:00");
    core.updateTask(db, t.id, { status: "cancelled" });
    expect(activeSpecs(db).length).toBe(0);
    const r = await sweep(db, { now: "2026-06-06 09:05" });
    expect(r.delivered).toBe(0);
    db.close();
  });

  test("a non-terminal status update leaves the reminder active", () => {
    const db = freshDb();
    const t = core.addTask(db, { title: "reimburse" }) as any;
    core.addReminder(db, t.id, "2026-06-06 09:00");
    core.updateTask(db, t.id, { status: "in_progress", priority: "high" });
    expect(activeSpecs(db).length).toBe(1);
    db.close();
  });

  test("recurring specs are untouched by task state", () => {
    const db = freshDb();
    const t = core.addTask(db, { title: "reimburse" }) as any;
    core.addReminder(db, t.id, "2026-06-06 09:00");
    core.addRecurrence(db, { title: "monthly", pattern_type: "monthly", pattern_config: "{}", remind_time: "09:00" });
    core.doneTask(db, t.id);
    const remaining = activeSpecs(db);
    expect(remaining.length).toBe(1); // only the recurring spec survives
    expect(remaining[0].rule_id).not.toBeNull();
    db.close();
  });
});

describe("reminder cancel primitive", () => {
  test("cancel by spec id", () => {
    const db = freshDb();
    const t = core.addTask(db, { title: "x" }) as any;
    const spec = core.addReminder(db, t.id, "2026-06-06 09:00") as any;
    const out = core.cancelReminder(db, spec.id) as any;
    expect(out.status).toBe("cancelled");
    expect(activeSpecs(db).length).toBe(0);
    // cancelling again (no longer active) returns null
    expect(core.cancelReminder(db, spec.id)).toBeNull();
    db.close();
  });

  test("cancel all on a task returns the count", () => {
    const db = freshDb();
    const t = core.addTask(db, { title: "x" }) as any;
    core.addReminder(db, t.id, "2026-06-06 09:00");
    core.addReminder(db, t.id, "2026-06-07 09:00");
    expect(core.cancelTaskReminders(db, t.id)).toBe(2);
    expect(activeSpecs(db).length).toBe(0);
    db.close();
  });
});
