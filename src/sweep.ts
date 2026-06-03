// sweep.ts — the daemonless heart. cron calls `mira sweep` every 5 minutes;
// this runs once and exits. Exactly-once delivery is guaranteed by the
// UNIQUE(spec_id, occurrence_key) constraint plus an atomic claim inside an
// IMMEDIATE transaction — safe across pure-cron, Claude Code, and Codex all
// sweeping concurrently.
import type { Database } from "bun:sqlite";
import {
  configGet,
  configSet,
  deliveryMode,
  defaultChannel,
  maxAttempts,
} from "./db.ts";
import { parseLocal, fmtDate, fmtTime, nowTs, startOfDay } from "./time.ts";
import { resolveOccurrences, type Rule } from "./recurrence.ts";
import { getChannel, type Payload } from "./delivery/index.ts";
import { renderReminder } from "./render.ts";

export interface SweepOptions {
  now?: string; // 'YYYY-MM-DD HH:MM' — defaults to wall clock
  dryRun?: boolean;
  lastSweep?: string; // override window start (mostly for tests)
}

interface Candidate {
  spec_id: number;
  occurrence_key: string;
  channel: string;
}

export interface SweepResult {
  now: string;
  last_sweep: string;
  mode: string;
  candidates: number;
  claimed: number;
  delivered: number;
  failed: number;
  skipped_backlogged: number;
  payloads: Array<{ log_id: number; channel: string } & Payload>;
  dry_run: boolean;
}

function oneTimeKey(remindAt: string): string | null {
  const d = parseLocal(remindAt);
  if (!d) return null;
  return `${fmtDate(d)}T${fmtTime(d)}`;
}

// Build the candidate (spec × occurrence) set due in (lastSweep, now].
function candidates(
  db: Database,
  now: string,
  lastSweep: string,
  fallbackChannel: string,
): Candidate[] {
  const nowD = parseLocal(now)!;
  const out: Candidate[] = [];

  // One-time: task-bound specs whose remind_at has arrived.
  const oneShots = db
    .query(
      `SELECT s.id AS spec_id, s.remind_at AS remind_at
         FROM reminder_specs s
        WHERE s.status = 'active' AND s.rule_id IS NULL
          AND s.task_id IS NOT NULL AND s.remind_at <> ''`,
    )
    .all() as { spec_id: number; remind_at: string }[];
  for (const r of oneShots) {
    const at = parseLocal(r.remind_at);
    if (!at || at.getTime() > nowD.getTime()) continue;
    const key = oneTimeKey(r.remind_at);
    if (key) out.push({ spec_id: r.spec_id, occurrence_key: key, channel: fallbackChannel });
  }

  // Recurring: rule-bound specs; materialize firings in the window.
  const recs = db
    .query(
      `SELECT s.id AS spec_id, r.id AS rule_id, r.pattern_type, r.pattern_config,
              r.remind_time, r.duration_days, r.channel_override
         FROM reminder_specs s
         JOIN recurrence_rules r ON r.id = s.rule_id
        WHERE s.status = 'active' AND r.active = 1`,
    )
    .all() as Array<{
      spec_id: number;
      rule_id: number;
      pattern_type: string;
      pattern_config: string;
      remind_time: string;
      duration_days: number;
      channel_override: string;
    }>;
  for (const r of recs) {
    const rule: Rule = {
      id: r.rule_id,
      pattern_type: r.pattern_type,
      pattern_config: r.pattern_config,
      remind_time: r.remind_time,
      duration_days: r.duration_days,
    };
    const occ = resolveOccurrences(rule, lastSweep, now);
    for (const o of occ) {
      out.push({
        spec_id: r.spec_id,
        occurrence_key: o.key,
        channel: r.channel_override || fallbackChannel,
      });
    }
  }
  return out;
}

export async function sweep(
  db: Database,
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const now = opts.now ?? nowTs();
  const nowD = parseLocal(now);
  if (!nowD) throw new Error(`invalid --now: ${now}`);
  // Window start: explicit override, else stored last sweep, else start of
  // today (so a fresh DB fires today's earlier reminders once, not history).
  const lastSweep =
    opts.lastSweep ??
    configGet(db, "sweep.last_at") ??
    `${fmtDate(startOfDay(nowD))} 00:00`;

  const mode = deliveryMode(db);
  const fallback = defaultChannel(db);
  const cap = maxAttempts(db);
  const cands = candidates(db, now, lastSweep, fallback);

  // --- Atomic INSERT-OR-IGNORE + claim, all inside one IMMEDIATE txn ---
  db.exec("BEGIN IMMEDIATE");
  let claimedRows: Array<{
    id: number;
    spec_id: number;
    occurrence_key: string;
    channel: string;
    task_id: number | null;
    rule_id: number | null;
  }> = [];
  let skippedBacklogged = 0;
  try {
    const ins = db.query(
      `INSERT OR IGNORE INTO delivery_log(spec_id, occurrence_key, state, channel, created_at)
       VALUES(?, ?, 'pending', ?, ?)`,
    );
    for (const c of cands) ins.run(c.spec_id, c.occurrence_key, c.channel, now);

    // Count rows that are stuck failed at the attempts cap (reported, not retried).
    skippedBacklogged = (
      db
        .query(
          `SELECT COUNT(*) AS n FROM delivery_log dl
             JOIN reminder_specs s ON s.id = dl.spec_id
            WHERE dl.state = 'failed' AND dl.attempts >= ? AND s.status = 'active'`,
        )
        .get(cap) as { n: number }
    ).n;

    // Claim everything deliverable for an active spec: fresh pending + failed
    // still under the attempts cap. Atomic UPDATE...RETURNING — whoever wins
    // the write lock claims; the other process sees nothing left to claim.
    claimedRows = db
      .query(
        `UPDATE delivery_log SET state = 'claimed', claimed_at = ?
          WHERE id IN (
            SELECT dl.id FROM delivery_log dl
              JOIN reminder_specs s ON s.id = dl.spec_id
             WHERE s.status = 'active'
               AND (dl.state = 'pending' OR (dl.state = 'failed' AND dl.attempts < ?))
          )
          RETURNING id, spec_id, occurrence_key, channel`,
      )
      .all(now, cap) as any[];

    // In agent/both mode, already-claimed-but-unacked rows are re-emitted so a
    // brain that missed the last sweep still gets the payload.
    if (mode === "agent" || mode === "both") {
      const reEmit = db
        .query(
          `SELECT dl.id, dl.spec_id, dl.occurrence_key, dl.channel
             FROM delivery_log dl JOIN reminder_specs s ON s.id = dl.spec_id
            WHERE dl.state = 'claimed' AND s.status = 'active'
              AND dl.id NOT IN (${claimedRows.map((r) => r.id).join(",") || "-1"})`,
        )
        .all() as any[];
      claimedRows.push(...reEmit);
    }

    // Attach task_id/rule_id for rendering.
    for (const row of claimedRows) {
      const spec = db
        .query("SELECT task_id, rule_id FROM reminder_specs WHERE id = ?")
        .get(row.spec_id) as { task_id: number | null; rule_id: number | null };
      row.task_id = spec?.task_id ?? null;
      row.rule_id = spec?.rule_id ?? null;
    }

    if (opts.dryRun) {
      db.exec("ROLLBACK");
    } else {
      db.exec("COMMIT");
    }
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  // --- Deliver outside the txn. The 'claimed' marker is the durable owner. ---
  const payloads: SweepResult["payloads"] = [];
  let delivered = 0;
  let failed = 0;

  for (const row of claimedRows) {
    const payload = renderReminder(db, {
      spec_id: row.spec_id,
      task_id: row.task_id,
      rule_id: row.rule_id,
      occurrence_key: row.occurrence_key,
    });

    // agent mode: emit, don't send, leave claimed for the brain to ack.
    if (mode === "agent") {
      payloads.push({ log_id: row.id, channel: row.channel, ...payload });
      continue;
    }

    // mira and both: actually deliver via the default/override channel.
    if (mode === "both") {
      payloads.push({ log_id: row.id, channel: row.channel, ...payload });
    }
    if (opts.dryRun) {
      payloads.push({ log_id: row.id, channel: row.channel, ...payload });
      delivered++;
      continue;
    }
    try {
      const ch = getChannel(db, row.channel);
      await ch.send(payload);
      db.query(
        `UPDATE delivery_log SET state='delivered', delivered_by='mira',
           delivered_at=?, channel=? WHERE id=?`,
      ).run(now, row.channel, row.id);
      // tidy up: a delivered one-time spec is done
      if (row.task_id) {
        db.query(
          "UPDATE reminder_specs SET status='done' WHERE id=? AND rule_id IS NULL",
        ).run(row.spec_id);
      }
      delivered++;
    } catch (e: any) {
      db.query(
        `UPDATE delivery_log SET state='failed', attempts=attempts+1,
           last_error=? WHERE id=?`,
      ).run(String(e?.message ?? e), row.id);
      failed++;
    }
  }

  if (!opts.dryRun) configSet(db, "sweep.last_at", now);

  return {
    now,
    last_sweep: lastSweep,
    mode,
    candidates: cands.length,
    claimed: claimedRows.length,
    delivered,
    failed,
    skipped_backlogged: skippedBacklogged,
    payloads,
    dry_run: !!opts.dryRun,
  };
}

// B2 callback: a brain confirms it delivered a claimed payload.
export function deliverAck(
  db: Database,
  logId: number,
  channel: string,
  by = "agent",
): { ok: boolean; state: string } {
  const row = db
    .query("SELECT state, spec_id FROM delivery_log WHERE id = ?")
    .get(logId) as { state: string; spec_id: number } | undefined;
  if (!row) return { ok: false, state: "missing" };
  if (row.state === "delivered") return { ok: true, state: "delivered" };
  if (row.state !== "claimed") return { ok: false, state: row.state };
  db.query(
    `UPDATE delivery_log SET state='delivered', delivered_by=?, channel=?,
       delivered_at=? WHERE id=?`,
  ).run(by, channel, nowTs(), logId);
  db.query(
    "UPDATE reminder_specs SET status='done' WHERE id=? AND rule_id IS NULL",
  ).run(row.spec_id);
  return { ok: true, state: "delivered" };
}
