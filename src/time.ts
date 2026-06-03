// time.ts — Mira works in local naive time, matching v1's 'YYYY-MM-DD HH:MM'
// strings. Everything funnels through here so comparison and formatting stay
// consistent (and zero-padded strings stay lexicographically ordered).

// Parse 'YYYY-MM-DD', 'YYYY-MM-DD HH:MM', 'YYYY-MM-DDTHH:MM', or with :SS — as
// LOCAL time. Returns null on garbage.
export function parseLocal(s: string): Date | null {
  if (!s) return null;
  const m = s
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss] = m;
  return new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    hh ? Number(hh) : 0,
    mi ? Number(mi) : 0,
    ss ? Number(ss) : 0,
    0,
  );
}

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

// 'YYYY-MM-DD HH:MM'
export function fmtTs(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

// 'YYYY-MM-DD'
export function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 'HH:MM'
export function fmtTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function nowTs(): string {
  return fmtTs(new Date());
}

// Compare two local-time strings chronologically. Missing/garbage sorts last.
export function tsLeq(a: string, b: string): boolean {
  const da = parseLocal(a);
  const db = parseLocal(b);
  if (!da || !db) return false;
  return da.getTime() <= db.getTime();
}

// v1 weekday convention: 0 = Monday … 6 = Sunday. JS Date.getDay() is
// 0 = Sunday … 6 = Saturday, so we rotate.
export function miraWeekday(d: Date): number {
  return (d.getDay() + 6) % 7;
}

// ISO-8601 week number (1..53). Week starts Monday; week 1 contains the first
// Thursday of the year.
export function isoWeek(d: Date): number {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (t.getDay() + 6) % 7; // 0 = Monday
  t.setDate(t.getDate() - day + 3); // nearest Thursday
  const firstThursday = new Date(t.getFullYear(), 0, 4);
  const fday = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - fday + 3);
  return (
    1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 86400000))
  );
}

// Start of day for a local Date.
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

// Add days to a local Date (DST-naive, fine for our minute resolution).
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), 0, 0);
}

// Last day-of-month number for the month containing d.
export function lastDayOfMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}
