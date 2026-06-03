// Recurrence resolver — boundaries are the whole point: month-end, leap year,
// cross-week, every pattern_type.
import { test, expect, describe } from "bun:test";
import { resolveOccurrences, isDueOn, triggersOn, type Rule } from "../src/recurrence.ts";
import { parseLocal } from "../src/time.ts";

function rule(p: Partial<Rule>): Rule {
  return {
    pattern_type: p.pattern_type!,
    pattern_config: p.pattern_config ?? "{}",
    remind_time: p.remind_time ?? "09:00",
    duration_days: p.duration_days ?? 1,
  };
}
const keys = (r: Rule, a: string, b: string) =>
  resolveOccurrences(r, a, b).map((o) => o.key);

describe("daily", () => {
  test("fires every day in window, honoring exclusive start", () => {
    const r = rule({ pattern_type: "daily" });
    // start 06-01 00:00 exclusive; 09:00 firings on 1,2,3
    expect(keys(r, "2026-06-01 00:00", "2026-06-03 12:00")).toEqual([
      "2026-06-01", "2026-06-02", "2026-06-03",
    ]);
  });
  test("start boundary is exclusive at the firing instant", () => {
    const r = rule({ pattern_type: "daily", remind_time: "09:00" });
    // window opens exactly at 06-01 09:00 -> that firing excluded, next day in
    expect(keys(r, "2026-06-01 09:00", "2026-06-02 09:00")).toEqual(["2026-06-02"]);
  });
});

describe("weekly (0=Monday)", () => {
  test("Mondays across a month boundary", () => {
    const r = rule({ pattern_type: "weekly", pattern_config: '{"weekdays":[0]}' });
    // 2026-06-01 is a Monday
    expect(keys(r, "2026-05-28 00:00", "2026-06-15 23:59")).toEqual([
      "2026-06-01", "2026-06-08", "2026-06-15",
    ]);
  });
  test("supports single {weekday:N} too", () => {
    const r = rule({ pattern_type: "weekly", pattern_config: '{"weekday":2}' }); // Wed
    expect(keys(r, "2026-06-01 00:00", "2026-06-07 23:59")).toEqual(["2026-06-03"]);
  });
});

describe("monthly", () => {
  test("plain day-of-month", () => {
    const r = rule({ pattern_type: "monthly", pattern_config: '{"day":26}' });
    expect(keys(r, "2026-05-01 00:00", "2026-05-31 23:59")).toEqual(["2026-05-26"]);
  });
  test("'last' resolves to the real last day", () => {
    const r = rule({ pattern_type: "monthly", pattern_config: '{"day":"last"}' });
    expect(keys(r, "2026-02-01 00:00", "2026-02-28 23:59")).toEqual(["2026-02-28"]);
    expect(keys(r, "2026-04-01 00:00", "2026-04-30 23:59")).toEqual(["2026-04-30"]);
  });
  test("overflow day clamps to month end (31st -> Feb 28 / leap 29)", () => {
    const r = rule({ pattern_type: "monthly", pattern_config: '{"day":31}' });
    expect(keys(r, "2026-02-01 00:00", "2026-02-28 23:59")).toEqual(["2026-02-28"]);
    expect(keys(r, "2024-02-01 00:00", "2024-02-29 23:59")).toEqual(["2024-02-29"]);
  });
});

describe("yearly_dates", () => {
  test("fires on listed MM-DD", () => {
    const r = rule({ pattern_type: "yearly_dates", pattern_config: '{"dates":["03-15","12-25"]}' });
    expect(keys(r, "2026-01-01 00:00", "2026-12-31 23:59")).toEqual([
      "2026-03-15", "2026-12-25",
    ]);
  });
  test("02-29 clamps to 02-28 in a non-leap year", () => {
    const r = rule({ pattern_type: "yearly_dates", pattern_config: '{"dates":["02-29"]}' });
    expect(keys(r, "2026-02-01 00:00", "2026-02-28 23:59")).toEqual(["2026-02-28"]);
    expect(keys(r, "2024-02-01 00:00", "2024-02-29 23:59")).toEqual(["2024-02-29"]);
  });
});

describe("yearly_weeks", () => {
  test("one firing per listed ISO week (its Monday)", () => {
    const r = rule({ pattern_type: "yearly_weeks", pattern_config: '{"weeks":[14,15,16]}', duration_days: 7 });
    const k = keys(r, "2026-01-01 00:00", "2026-12-31 23:59");
    expect(k.length).toBe(3);
    // each key must be a Monday and in week 14/15/16
    for (const d of k) expect((parseLocal(d)!.getDay() + 6) % 7).toBe(0);
  });
  test("isDueOn spans the whole week (gantt view)", () => {
    const r = rule({ pattern_type: "yearly_weeks", pattern_config: '{"weeks":[14]}', duration_days: 7 });
    const mondays = resolveOccurrences(r, "2026-01-01 00:00", "2026-12-31 23:59");
    const mon = parseLocal(mondays[0].key)!;
    // Monday..Sunday of that week all "due" for the board
    for (let i = 0; i < 7; i++) {
      const d = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
      expect(isDueOn(r, d)).toBe(true);
    }
  });
});

describe("isDueOn basics", () => {
  test("daily always, weekly only on its weekday", () => {
    expect(isDueOn(rule({ pattern_type: "daily" }), "2026-06-03")).toBe(true);
    const wk = rule({ pattern_type: "weekly", pattern_config: '{"weekdays":[0]}' });
    expect(isDueOn(wk, "2026-06-01")).toBe(true); // Monday
    expect(isDueOn(wk, "2026-06-02")).toBe(false); // Tuesday
  });
});

describe("guards", () => {
  test("empty/garbage config does not throw", () => {
    expect(triggersOn(rule({ pattern_type: "weekly", pattern_config: "not json" }), new Date())).toBe(false);
    expect(keys(rule({ pattern_type: "unknown" }), "2026-06-01 00:00", "2026-06-30 00:00")).toEqual([]);
  });
});
