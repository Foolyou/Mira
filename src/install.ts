// install.ts — register Mira into the brains (as an Agent Skill) and into cron.
// Works for both distribution forms: the self-contained binary (primary) and
// `bunx`/global npm (secondary, Bun-only). Cron targets point at ONE invocation
// and ONE workspace so the SQLite truth source stays shared; the skill is the
// same SKILL.md for every agent (the open Agent Skills standard), written from
// the string baked into the binary.
import { homedir } from "os";
import { join, dirname, resolve } from "path";
import { writeFileSync, mkdirSync } from "fs";
import { skillMarkdown } from "./skill.ts";
import { initWorkspace, isInitialized } from "./db.ts";

// The npm package name (secondary path). `bunx <PKG> <command>` runs the CLI.
export const NPM_PKG = "mira-copilot";

// How Mira gets launched, before its own subcommand. Three shapes:
//   binary  -> { command: "/abs/mira",  prefix: [] }
//   bunx    -> { command: "bunx",       prefix: ["mira-copilot"] }
//   global  -> { command: "mira",       prefix: [] }   (bun add -g)
export interface Invoker {
  command: string;
  prefix: string[];
}

export interface InstallTarget {
  invoker: Invoker;
  workspace: string;
}

function args(t: InstallTarget, ...rest: string[]): string[] {
  return [...t.invoker.prefix, ...rest];
}
function shell(t: InstallTarget, ...rest: string[]): string {
  return [t.invoker.command, ...args(t, ...rest)].join(" ");
}

// The brains Mira can install its skill into, and the scope to write it at.
export type SkillAgent = "claude-code" | "codex";
export type SkillScope = "project" | "user";
export interface SkillInstallOptions {
  cwd?: string;
  workspace?: string;
}

// Where each agent discovers a skill named "mira". Project scope is a dir under
// the current repo/cwd; user scope is global (Codex honors $CODEX_HOME). Both
// load the SKILL.md standard, so the file we write is identical across agents.
function skillDir(agent: SkillAgent, scope: SkillScope, cwd: string): string {
  if (agent === "claude-code") {
    const root = scope === "user" ? join(homedir(), ".claude") : join(cwd, ".claude");
    return join(root, "skills", "mira");
  }
  // codex
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const root = scope === "user" ? home : join(cwd, ".codex");
  return join(root, "skills", "mira");
}

// The workspace a freshly installed skill should bind to, or undefined when
// none should be baked in. Project scope binds the cwd's `.mira` (an absolute
// path, so the agent always hits the same DB regardless of where it later cd's).
// User scope is global — there is no single project dir, so we bake no path and
// the SKILL.md tells the agent to use (and `mira init`) the cwd's `.mira`.
export function defaultSkillWorkspace(scope: SkillScope, cwd = process.cwd()): string | undefined {
  return scope === "user" ? undefined : join(cwd, ".mira");
}

function normalizeWorkspace(workspace: string, cwd: string): string {
  return workspace.startsWith("~")
    ? join(homedir(), workspace.slice(1))
    : resolve(cwd, workspace);
}

// Install the Mira skill for one agent. Writes the canonical SKILL.md (baked
// into the binary) so the agent picks Mira up implicitly by description and can
// drive the CLI. Overwrites an existing copy so re-running keeps it current.
// When a concrete workspace is bound (project scope or an explicit --workspace)
// and it has not been initialized yet, it is created here so the agent can use
// Mira immediately without a separate `mira init`.
export function installSkill(agent: SkillAgent, scope: SkillScope, opts: SkillInstallOptions = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const dir = skillDir(agent, scope, cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  const bound = opts.workspace ?? defaultSkillWorkspace(scope, cwd);
  const workspace = bound ? normalizeWorkspace(bound, cwd) : undefined;
  writeFileSync(file, skillMarkdown(workspace));
  let initialized = false;
  if (workspace && !isInitialized(workspace)) {
    initWorkspace(workspace);
    initialized = true;
  }
  return { agent, scope, workspace: workspace ?? null, wrote: file, initialized };
}

// Cron: return the crontab lines (we print, never auto-overwrite the user's
// crontab — installing is `mira install cron | crontab -` if they want it).
export function cronLines(t: InstallTarget): string {
  const logDir =
    t.invoker.command.includes("/") ? dirname(t.invoker.command) : homedir();
  const log = (n: string) => join(logDir, n);
  return [
    `# Mira — the only clock. Install: mira install cron | crontab -`,
    `MIRA_WORKSPACE=${t.workspace}`,
    `*/5 * * * *  ${shell(t, "sweep")} >> ${log("mira-sweep.log")} 2>&1`,
    `30 7  * * *  ${shell(t, "brief", "--send")} >> ${log("mira-brief.log")} 2>&1`,
    `0 14  * * *  ${shell(t, "brief", "--send")} >> ${log("mira-brief.log")} 2>&1`,
    `0 20  * * *  ${shell(t, "brief", "--send")} >> ${log("mira-brief.log")} 2>&1`,
    `0 7   * * 0  ${shell(t, "brief", "--send", "--weekly")} >> ${log("mira-brief.log")} 2>&1`,
    "",
  ].join("\n");
}

// Strip Mira-managed lines from an existing crontab, returning what should
// remain. The inverse of cronLines: we never touch the user's crontab directly
// (`mira install cron --uninstall | crontab -` is theirs to run), we just emit
// the cleaned text. Lines are matched by content, not position, so a hand-moved
// block is still removed: the header comment, the MIRA_WORKSPACE assignment, and
// any schedule line invoking `mira sweep`/`mira brief`.
export function cronUninstall(current: string): string {
  const kept = current.split("\n").filter((l) => {
    if (/^#\s*Mira\b/.test(l)) return false;
    if (/^\s*MIRA_WORKSPACE=/.test(l)) return false;
    if (/\bmira\b.*\b(sweep|brief)\b/.test(l)) return false;
    return true;
  });
  // Collapse the blank lines left behind and keep a single trailing newline.
  const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n+$/, "");
  return out ? out + "\n" : "";
}
