// render.ts — turn a due reminder into a deliverable payload (text + optional
// HTML). Kept deliberately small; the brief/dashboard build richer HTML.
import type { Database } from "bun:sqlite";
import type { Payload } from "./delivery/index.ts";

export interface SpecRow {
  spec_id: number;
  task_id: number | null;
  rule_id: number | null;
  occurrence_key: string;
}

export function renderReminder(db: Database, row: SpecRow): Payload {
  if (row.task_id) {
    const t = db
      .query("SELECT title, area, priority, due_text, due_at FROM tasks WHERE id = ?")
      .get(row.task_id) as
      | { title: string; area: string; priority: string; due_text: string; due_at: string }
      | undefined;
    const title = t?.title ?? `task #${row.task_id}`;
    const meta = t
      ? [t.area, t.priority, t.due_text || t.due_at].filter(Boolean).join(" · ")
      : "";
    return {
      subject: `⏰ ${title}`,
      text: meta ? `⏰ 提醒：${title}\n${meta}` : `⏰ 提醒：${title}`,
      html: `<p>⏰ <b>${escapeHtml(title)}</b></p>${meta ? `<p style="color:#666">${escapeHtml(meta)}</p>` : ""}`,
    };
  }
  if (row.rule_id) {
    const r = db
      .query("SELECT title, area FROM recurrence_rules WHERE id = ?")
      .get(row.rule_id) as { title: string; area: string } | undefined;
    const title = r?.title ?? `rule #${row.rule_id}`;
    return {
      subject: `🔁 ${title}`,
      text: `🔁 周期提醒：${title}（${row.occurrence_key}）${r?.area ? `\n${r.area}` : ""}`,
      html: `<p>🔁 <b>${escapeHtml(title)}</b> <span style="color:#999">${row.occurrence_key}</span></p>`,
    };
  }
  return { subject: "⏰ Mira 提醒", text: "⏰ Mira 提醒" };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
