// Migration: import a copy of the real lifework.db and assert counts + samples.
import { test, expect, describe, afterAll } from "bun:test";
import { openDb } from "../src/db.ts";
import { importV1 } from "../src/import.ts";
import { sweep } from "../src/sweep.ts";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync, rmSync } from "fs";

const SRC = join(import.meta.dir, "..", "..", "data", "lifework.db");
const dbFile = join(tmpdir(), `mira-migration-${process.pid}.db`);
afterAll(() => { for (const s of ["", "-wal", "-shm"]) try { rmSync(dbFile + s); } catch {} });

describe("import-v1", () => {
  test.skipIf(!existsSync(SRC))("counts match the v1 source", () => {
    const db = openDb({ path: dbFile });
    const res = importV1(db, SRC);

    expect(res.tasks).toBe(27);
    expect(res.recurrence_rules).toBe(5);
    expect(res.companies).toBe(5);
    expect(res.notes).toBe(10);
    expect(res.captures).toBe(16);
    // 16 reminders: 12 scheduled -> specs, 4 done/cancelled skipped
    expect(res.reminder_specs_from_reminders).toBe(12);
    expect(res.reminders_skipped_inactive).toBe(4);
    // one spec materialized per active recurrence rule
    expect(res.reminder_specs_from_recurrence).toBe(5);

    // sampling: a known task survives with its label preserved
    const t = db.query("SELECT * FROM tasks WHERE id=9").get() as any;
    expect(t.title).toContain("公章");
    expect(t.due_text).toBe("5.26");
    expect(t.due_at).toBe("2026-05-26 09:00");

    // cron_id is gone (column does not exist on the v2 spec)
    const cols = db.query("PRAGMA table_info(reminder_specs)").all() as any[];
    expect(cols.some((c) => c.name === "cron_id")).toBe(false);
    db.close();
  });

  test.skipIf(!existsSync(SRC))("imported recurrence rules actually fire after migration", async () => {
    const db = openDb({ path: dbFile });
    // rule #1 每月报销 is monthly day 26 @ 09:00; sweep across that day
    const r = await sweep(db, {
      lastSweep: "2026-06-25 00:00",
      now: "2026-06-26 10:00",
    });
    // monthly day-6 rules (#4,#5) and day-26 rule (#1) — at least the day-26 fires
    expect(r.delivered).toBeGreaterThanOrEqual(1);
    db.close();
  });

  test("refuses to import over a non-empty DB without --force", () => {
    const db = openDb({ path: join(tmpdir(), `mira-guard-${process.pid}.db`) });
    db.query("INSERT INTO tasks(title,created_at,updated_at) VALUES('x','t','t')").run();
    expect(() => importV1(db, SRC)).toThrow();
    db.close();
    for (const s of ["", "-wal", "-shm"]) try { rmSync(join(tmpdir(), `mira-guard-${process.pid}.db`) + s); } catch {}
  });
});
