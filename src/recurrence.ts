// recurrence.ts — the ONE recurrence resolver. It answers both questions that
// v1 split across three tangled code paths:
//   resolveOccurrences(rule, from, to) -> firing points to materialize
//   isDueOn(rule, day)                 -> "show on the board today?"
//
// pattern_type ∈ daily | weekly | monthly | yearly_dates | yearly_weeks
// pattern_config (JSON):
//   weekly       {weekday:N} | {weekdays:[N,...]}   (0=Mon … 6=Sun)
//   monthly      {day:N} | {day:"last"}
//   yearly_dates {dates:["MM-DD", ...]}
//   yearly_weeks {weeks:[ISOweek,...]}
import {
  parseLocal,
  fmtDate,
  miraWeekday,
  isoWeek,
  startOfDay,
  addDays,
  lastDayOfMonth,
} from "./time.ts";

export interface Rule {
  id?: number;
  pattern_type: string;
  pattern_config: string; // JSON string
  remind_time: string; // 'HH:MM'
  duration_days?: number;
}

export interface Occurrence {
  key: string; // 'YYYY-MM-DD' — the trigger date, unique per (spec, day)
  at: Date; // firing datetime = trigger date @ remind_time
}

function cfg(rule: Rule): any {
  try {
    return JSON.parse(rule.pattern_config || "{}");
  } catch {
    return {};
  }
}

function weekdaySet(c: any): Set<number> {
  if (Array.isArray(c.weekdays)) return new Set(c.weekdays.map(Number));
  if (typeof c.weekday === "number") return new Set([c.weekday]);
  return new Set();
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// Does the rule FIRE on this specific day (the trigger day, not a span day)?
export function triggersOn(rule: Rule, day: Date): boolean {
  const c = cfg(rule);
  const y = day.getFullYear();
  const m0 = day.getMonth();
  const dom = day.getDate();
  switch (rule.pattern_type) {
    case "daily":
      return true;
    case "weekly":
      return weekdaySet(c).has(miraWeekday(day));
    case "monthly": {
      const last = lastDayOfMonth(y, m0);
      if (c.day === "last") return dom === last;
      const n = Number(c.day);
      if (!Number.isFinite(n)) return false;
      // day N, but clamp overflow (e.g. "31st" fires on the 28th in Feb)
      if (dom === n) return true;
      return n > last && dom === last;
    }
    case "yearly_dates": {
      const dates: string[] = Array.isArray(c.dates) ? c.dates : [];
      const mmdd = `${String(m0 + 1).padStart(2, "0")}-${String(dom).padStart(2, "0")}`;
      if (dates.includes(mmdd)) return true;
      // 02-29 rule clamps to 02-28 in non-leap years
      if (!isLeap(y) && dates.includes("02-29") && mmdd === "02-28") return true;
      return false;
    }
    case "yearly_weeks": {
      const weeks: number[] = Array.isArray(c.weeks) ? c.weeks.map(Number) : [];
      // one firing per listed week, on its Monday
      return miraWeekday(day) === 0 && weeks.includes(isoWeek(day));
    }
    default:
      return false;
  }
}

// Materialize firing points strictly within (from, to].
export function resolveOccurrences(
  rule: Rule,
  fromTs: string | Date,
  toTs: string | Date,
): Occurrence[] {
  const from = typeof fromTs === "string" ? parseLocal(fromTs) : fromTs;
  const to = typeof toTs === "string" ? parseLocal(toTs) : toTs;
  if (!from || !to || from.getTime() >= to.getTime()) return [];

  const [hh, mi] = (rule.remind_time || "09:00").split(":").map(Number);
  const out: Occurrence[] = [];
  // Walk day by day from the day of `from` through the day of `to`.
  let cursor = startOfDay(from);
  const lastDay = startOfDay(to);
  // guard against pathological ranges
  let guard = 0;
  while (cursor.getTime() <= lastDay.getTime() && guard++ < 4000) {
    if (triggersOn(rule, cursor)) {
      const at = new Date(
        cursor.getFullYear(),
        cursor.getMonth(),
        cursor.getDate(),
        hh || 0,
        mi || 0,
        0,
        0,
      );
      if (at.getTime() > from.getTime() && at.getTime() <= to.getTime()) {
        out.push({ key: fmtDate(cursor), at });
      }
    }
    cursor = addDays(cursor, 1);
  }
  return out;
}

// Dashboard view: is the rule "active" on `day`, accounting for duration_days
// so a multi-day span (e.g. a 7-day travel week) shows across the board.
export function isDueOn(rule: Rule, day: Date | string): boolean {
  const d = typeof day === "string" ? parseLocal(day) : day;
  if (!d) return false;
  const dur = Math.max(1, rule.duration_days ?? 1);
  for (let k = 0; k < dur; k++) {
    if (triggersOn(rule, addDays(startOfDay(d), -k))) return true;
  }
  return false;
}
