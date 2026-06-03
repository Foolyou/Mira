// The #1 test: exactly-once delivery. Plus the three delivery modes and the
// failure/retry/attempts-cap state machine.
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { openDb, configSet } from "../src/db.ts";
import { sweep, deliverAck } from "../src/sweep.ts";
import * as core from "../src/core.ts";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";

let counter = 0;
const made: string[] = [];
function freshDbPath(): string {
  const p = join(tmpdir(), `mira-test-${process.pid}-${counter++}.db`);
  made.push(p);
  return p;
}
afterAll(() => {
  for (const p of made) for (const s of ["", "-wal", "-shm"]) try { rmSync(p + s); } catch {}
});

// Silence the stdout delivery channel during tests.
let origWrite: typeof process.stdout.write;
beforeAll(() => {
  origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: any) => {
    if (typeof s === "string" && s.startsWith('{"channel"')) return true;
    return origWrite(s);
  }) as any;
});
afterAll(() => { process.stdout.write = origWrite; });

function rows(db: any) {
  return db.query("SELECT id,spec_id,occurrence_key,state,attempts FROM delivery_log").all();
}

describe("exactly-once (the #1 guarantee)", () => {
  test("sweeping the same occurrence twice delivers once", async () => {
    const db = openDb({ path: freshDbPath() });
    const t = core.addTask(db, { title: "one-time" }) as any;
    core.addReminder(db, t.id, "2026-06-03 09:00");

    const a = await sweep(db, { now: "2026-06-03 09:05" });
    const b = await sweep(db, { now: "2026-06-03 09:10" });

    expect(a.delivered).toBe(1);
    expect(b.delivered).toBe(0);
    const dl = rows(db);
    expect(dl.length).toBe(1);
    expect(dl[0].state).toBe("delivered");
    db.close();
  });

  test("two concurrent brains on one DB file deliver once total", async () => {
    const path = freshDbPath();
    const setup = openDb({ path });
    const t = core.addTask(setup, { title: "shared" }) as any;
    core.addReminder(setup, t.id, "2026-06-03 09:00");
    setup.close();

    const brain1 = openDb({ path });
    const brain2 = openDb({ path });
    const [r1, r2] = await Promise.all([
      sweep(brain1, { now: "2026-06-03 09:05" }),
      sweep(brain2, { now: "2026-06-03 09:05" }),
    ]);
    expect(r1.delivered + r2.delivered).toBe(1);

    const dl = rows(brain1);
    expect(dl.length).toBe(1);
    expect(dl.filter((r: any) => r.state === "delivered").length).toBe(1);
    brain1.close();
    brain2.close();
  });

  test("recurrence: re-sweeping the same window creates no duplicate", async () => {
    const db = openDb({ path: freshDbPath() });
    core.addRecurrence(db, { title: "daily", pattern_type: "daily", pattern_config: "{}", remind_time: "09:00" });
    const w = { lastSweep: "2026-06-01 00:00", now: "2026-06-03 12:00" } as const;
    const a = await sweep(db, w);
    const b = await sweep(db, w); // identical window again
    expect(a.delivered).toBe(3); // 06-01, 06-02, 06-03
    expect(b.delivered).toBe(0);
    expect(rows(db).length).toBe(3);
    db.close();
  });
});

describe("delivery modes", () => {
  test("mode=mira delivers and marks delivered", async () => {
    const db = openDb({ path: freshDbPath() });
    const t = core.addTask(db, { title: "m" }) as any;
    core.addReminder(db, t.id, "2026-06-03 09:00");
    const r = await sweep(db, { now: "2026-06-03 09:05" });
    expect(r.mode).toBe("mira");
    expect(r.delivered).toBe(1);
    expect((rows(db)[0] as any).state).toBe("delivered");
    db.close();
  });

  test("mode=agent emits payload, leaves claimed, then deliver-ack completes it", async () => {
    const db = openDb({ path: freshDbPath() });
    configSet(db, "delivery.mode", "agent");
    const t = core.addTask(db, { title: "a" }) as any;
    core.addReminder(db, t.id, "2026-06-03 09:00");

    const r = await sweep(db, { now: "2026-06-03 09:05" });
    expect(r.delivered).toBe(0);
    expect(r.payloads.length).toBe(1);
    expect((rows(db)[0] as any).state).toBe("claimed");

    const logId = r.payloads[0].log_id;
    const ack = deliverAck(db, logId, "email", "codex");
    expect(ack.ok).toBe(true);
    expect((rows(db)[0] as any).state).toBe("delivered");
    db.close();
  });

  test("mode=agent re-emits claimed-but-unacked payloads on the next sweep", async () => {
    const db = openDb({ path: freshDbPath() });
    configSet(db, "delivery.mode", "agent");
    const t = core.addTask(db, { title: "a2" }) as any;
    core.addReminder(db, t.id, "2026-06-03 09:00");
    await sweep(db, { now: "2026-06-03 09:05" });
    const again = await sweep(db, { now: "2026-06-03 09:10" });
    expect(again.payloads.length).toBe(1); // still unacked -> re-emitted
    db.close();
  });

  test("mode=both delivers AND emits payload", async () => {
    const db = openDb({ path: freshDbPath() });
    configSet(db, "delivery.mode", "both");
    const t = core.addTask(db, { title: "b" }) as any;
    core.addReminder(db, t.id, "2026-06-03 09:00");
    const r = await sweep(db, { now: "2026-06-03 09:05" });
    expect(r.delivered).toBe(1);
    expect(r.payloads.length).toBe(1);
    expect((rows(db)[0] as any).state).toBe("delivered");
    db.close();
  });
});

describe("failure / retry / attempts cap", () => {
  test("failed delivery retries until the cap, then is reported as backlog", async () => {
    const db = openDb({ path: freshDbPath() });
    configSet(db, "delivery.default_channel", "email"); // no channel.email config -> send throws
    configSet(db, "delivery.max_attempts", "2");
    const t = core.addTask(db, { title: "fails" }) as any;
    core.addReminder(db, t.id, "2026-06-03 09:00");

    const r1 = await sweep(db, { now: "2026-06-03 09:05" });
    expect(r1.failed).toBe(1);
    expect((rows(db)[0] as any).attempts).toBe(1);

    const r2 = await sweep(db, { now: "2026-06-03 09:10" });
    expect(r2.failed).toBe(1);
    expect((rows(db)[0] as any).attempts).toBe(2);

    // attempts now at cap (2): no longer claimed, surfaced as backlog
    const r3 = await sweep(db, { now: "2026-06-03 09:15" });
    expect(r3.claimed).toBe(0);
    expect(r3.skipped_backlogged).toBe(1);
    expect((rows(db)[0] as any).state).toBe("failed");
    db.close();
  });
});
