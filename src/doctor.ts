// doctor.ts — self-check: configuration sanity, channel connectivity, and the
// delivery backlog. The whole point of v2 is that a reminder never fails
// silently; doctor is where a human (or a brief) sees trouble early.
import type { Database } from "bun:sqlite";
import {
  SCHEMA_VERSION,
  configGet,
  deliveryMode,
  defaultChannel,
  maxAttempts,
} from "./db.ts";
import { deliveryAlerts } from "./brief.ts";
import { EmailChannel } from "./delivery/email.ts";

export interface DoctorReport {
  ok: boolean;
  schema_version: number;
  delivery_mode: string;
  default_channel: string;
  max_attempts: number;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  backlog: ReturnType<typeof deliveryAlerts>;
  last_sweep: string | null;
}

export async function doctor(
  db: Database,
  opts: { checkChannel?: boolean } = {},
): Promise<DoctorReport> {
  const checks: DoctorReport["checks"] = [];
  const mode = deliveryMode(db);
  const channel = defaultChannel(db);

  // schema
  const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  checks.push({
    name: "schema",
    ok: uv === SCHEMA_VERSION,
    detail: `user_version=${uv}, expected ${SCHEMA_VERSION}`,
  });

  // delivery config
  if (mode === "mira" || mode === "both") {
    if (channel === "email") {
      const raw = configGet(db, "channel.email");
      checks.push({
        name: "email-config",
        ok: !!raw,
        detail: raw ? "present" : "missing channel.email (mira/both mode needs it)",
      });
      if (raw && opts.checkChannel) {
        try {
          await new EmailChannel(db).verify();
          checks.push({ name: "email-connectivity", ok: true, detail: "SMTP verify ok" });
        } catch (e: any) {
          checks.push({ name: "email-connectivity", ok: false, detail: String(e?.message ?? e) });
        }
      }
    } else if (channel === "stdout") {
      checks.push({
        name: "channel",
        ok: true,
        detail: "default_channel=stdout (dev/agent — no real delivery)",
      });
    }
  }

  // orphan specs (spec pointing at neither task nor rule)
  const orphans = (db
    .query("SELECT COUNT(*) n FROM reminder_specs WHERE task_id IS NULL AND rule_id IS NULL")
    .get() as { n: number }).n;
  checks.push({ name: "spec-integrity", ok: orphans === 0, detail: `${orphans} orphan specs` });

  const backlog = deliveryAlerts(db);
  checks.push({
    name: "delivery-backlog",
    ok: backlog.stuck.length === 0,
    detail: `${backlog.stuck.length} stuck at attempts cap (${maxAttempts(db)}), ${backlog.claimed_unacked} claimed-unacked`,
  });

  const lastSweep = configGet(db, "sweep.last_at");
  checks.push({
    name: "sweep-clock",
    ok: true,
    detail: lastSweep ? `last sweep ${lastSweep}` : "never swept",
  });

  return {
    ok: checks.every((c) => c.ok),
    schema_version: SCHEMA_VERSION,
    delivery_mode: mode,
    default_channel: channel,
    max_attempts: maxAttempts(db),
    checks,
    backlog,
    last_sweep: lastSweep,
  };
}

// Verify migration counts against the source, for the post-import check.
export function verifyImport(
  db: Database,
  expected: { tasks?: number; recurrence_rules?: number },
): { ok: boolean; tasks: number; recurrence_rules: number } {
  const tasks = (db.query("SELECT COUNT(*) n FROM tasks").get() as { n: number }).n;
  const rules = (db.query("SELECT COUNT(*) n FROM recurrence_rules").get() as { n: number }).n;
  return {
    ok:
      (expected.tasks == null || expected.tasks === tasks) &&
      (expected.recurrence_rules == null || expected.recurrence_rules === rules),
    tasks,
    recurrence_rules: rules,
  };
}
