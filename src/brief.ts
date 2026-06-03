// brief.ts — the daily/weekly read-model, delivered as an HTML email (no
// headless PNG rendering like v1). Also surfaces the delivery backlog so a
// stuck reminder shows up as an alert rather than failing silently.
import type { Database } from "bun:sqlite";
import { dashboard, timeline } from "./core.ts";
import { escapeHtml } from "./render.ts";
import { getChannel, type Payload } from "./delivery/index.ts";
import { defaultChannel, maxAttempts } from "./db.ts";
import { fmtDate } from "./time.ts";

export function deliveryAlerts(db: Database) {
  const cap = maxAttempts(db);
  const stuck = db
    .query(
      `SELECT dl.id, dl.occurrence_key, dl.attempts, dl.last_error, s.task_id, s.rule_id
         FROM delivery_log dl JOIN reminder_specs s ON s.id = dl.spec_id
        WHERE dl.state = 'failed' AND dl.attempts >= ?`,
    )
    .all(cap) as any[];
  const claimedStale = db
    .query("SELECT COUNT(*) n FROM delivery_log WHERE state='claimed'").get() as { n: number };
  return { stuck, cap, claimed_unacked: claimedStale.n };
}

export function buildBrief(db: Database, opts: { weekly?: boolean; day?: string } = {}): Payload {
  const d = dashboard(db, opts.day);
  const horizon = opts.weekly ? 7 : 2;
  const tl = timeline(db, horizon, opts.day);
  const alerts = deliveryAlerts(db);
  const kind = opts.weekly ? "周报" : "日报";
  const today = opts.day ?? fmtDate(new Date());

  const lines: string[] = [`# Mira ${kind} · ${today}`, ""];
  if (alerts.stuck.length) {
    lines.push(`⚠️ 投递告警：${alerts.stuck.length} 条提醒达重试上限未送达`);
  }
  lines.push(`逾期 ${d.overdue.length} · 今日到期 ${d.due_today.length} · 今日周期 ${d.recurring_today.length}`);
  if (d.overdue.length) {
    lines.push("", "## 逾期");
    for (const t of d.overdue as any[]) lines.push(`- ${t.title} (${t.due_at})`);
  }
  if (d.due_today.length) {
    lines.push("", "## 今日到期");
    for (const t of d.due_today as any[]) lines.push(`- ${t.title} (${t.due_at})`);
  }
  if (d.recurring_today.length) {
    lines.push("", "## 今日周期");
    for (const r of d.recurring_today as any[]) lines.push(`- 🔁 ${r.title} @ ${r.remind_time}`);
  }
  if (d.family_watch.length) {
    lines.push("", "## 👨‍👩‍👧 家庭");
    for (const t of d.family_watch as any[]) lines.push(`- ${t.title}`);
  }
  if (opts.weekly && tl.items.length) {
    lines.push("", "## 未来 7 天");
    for (const it of tl.items) lines.push(`- ${it.at} ${it.kind === "recurring" ? "🔁" : "⏰"} ${it.title}`);
  }
  const text = lines.join("\n");

  const section = (title: string, rows: string[]) =>
    rows.length
      ? `<h3>${escapeHtml(title)}</h3><ul>${rows.map((r) => `<li>${r}</li>`).join("")}</ul>`
      : "";
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px">` +
    `<h2>Mira ${kind} · ${today}</h2>` +
    (alerts.stuck.length
      ? `<p style="background:#fee;border-left:3px solid #c00;padding:8px">⚠️ 投递告警：${alerts.stuck.length} 条提醒达重试上限未送达</p>`
      : "") +
    `<p style="color:#666">逾期 ${d.overdue.length} · 今日到期 ${d.due_today.length} · 今日周期 ${d.recurring_today.length}</p>` +
    section("逾期", (d.overdue as any[]).map((t) => `${escapeHtml(t.title)} <span style="color:#c00">${t.due_at}</span>`)) +
    section("今日到期", (d.due_today as any[]).map((t) => `${escapeHtml(t.title)} <span style="color:#999">${t.due_at}</span>`)) +
    section("今日周期", (d.recurring_today as any[]).map((r) => `🔁 ${escapeHtml(r.title)} @ ${r.remind_time}`)) +
    section("👨‍👩‍👧 家庭", (d.family_watch as any[]).map((t) => escapeHtml(t.title))) +
    (opts.weekly ? section("未来 7 天", tl.items.map((it) => `${it.at} ${it.kind === "recurring" ? "🔁" : "⏰"} ${escapeHtml(it.title)}`)) : "") +
    `</div>`;

  return { subject: `Mira ${kind} · ${today}`, text, html };
}

export async function sendBrief(
  db: Database,
  opts: { weekly?: boolean; day?: string } = {},
): Promise<{ sent: boolean; channel: string; payload: Payload }> {
  const payload = buildBrief(db, opts);
  const channel = defaultChannel(db);
  const ch = getChannel(db, channel);
  await ch.send(payload);
  return { sent: true, channel, payload };
}
