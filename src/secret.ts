// secret.ts — keep credentials out of two places they must never reach:
//   1. the SQLite config blob (store a `file:`/`env:` reference instead of the
//      literal, so the truth source on disk holds only a pointer); and
//   2. any command's stdout (redact secret-bearing fields before printing, so a
//      reading agent never receives the value in its context).
// Both cli.ts and delivery/email.ts share this so the rule is defined once.
import { readFileSync } from "node:fs";

// Field names whose values are credentials. Matched case-insensitively against
// the keys inside a channel config JSON blob.
const SECRET_FIELD_RE = /(password|passwd|secret|token|api[_-]?key|app[_-]?pass|webhook)/i;

// A stored value that is itself just a pointer is not sensitive — show it.
function isReference(value: string): boolean {
  return value.startsWith("file:") || value.startsWith("env:");
}

function expandHome(p: string): string {
  if (p === "~") return process.env.HOME ?? p;
  if (p.startsWith("~/")) return (process.env.HOME ?? "") + p.slice(1);
  return p;
}

// Resolve a credential at use-time. `file:<path>` reads a (0600) file,
// `env:<VAR>` reads an environment variable, anything else is a literal
// (back-compat). The resolved value is returned to the caller and used in-process
// only — it is never echoed, so triggering a send never surfaces the secret.
export function resolveSecret(value: string): string {
  if (value.startsWith("file:")) {
    const path = expandHome(value.slice("file:".length).trim());
    try {
      return readFileSync(path, "utf8").replace(/\r?\n$/, "");
    } catch (e: any) {
      throw new Error(`could not read secret file ${path}: ${e?.message ?? e}`);
    }
  }
  if (value.startsWith("env:")) {
    const name = value.slice("env:".length).trim();
    const v = process.env[name];
    if (v === undefined || v === "") {
      throw new Error(`secret env var ${name} is not set`);
    }
    return v;
  }
  return value;
}

// Mask literal credentials in a config value before it is printed. References
// (`file:`/`env:`) are left visible — they are pointers, not secrets, and seeing
// them is useful. Only `channel.*` values are inspected (the only secret-bearing
// keys); everything else passes through untouched.
export function redactConfigValue(key: string, value: string | null): string | null {
  if (value == null) return value;
  if (!key.startsWith("channel.")) return value;
  let obj: any;
  try {
    obj = JSON.parse(value);
  } catch {
    return value; // not JSON — nothing structured to redact
  }
  if (obj == null || typeof obj !== "object") return value;
  let changed = false;
  for (const k of Object.keys(obj)) {
    if (SECRET_FIELD_RE.test(k) && typeof obj[k] === "string" && !isReference(obj[k])) {
      obj[k] = "***";
      changed = true;
    }
  }
  return changed ? JSON.stringify(obj) : value;
}

// Redact a whole {key: value} map (for `config list`).
export function redactConfigMap(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) out[k] = redactConfigValue(k, v) as string;
  return out;
}
