// install.ts — register Mira into the brains (as an Agent Skill) and into cron.
// Works for both distribution forms: the self-contained binary (primary) and
// `bunx`/global npm (secondary, Bun-only). Cron targets point at ONE invocation
// and ONE cwd so the SQLite truth source stays shared; the skill is the
// same SKILL.md for every agent (the open Agent Skills standard), written from
// the string baked into the binary.
import { homedir } from "os";
import { join, dirname } from "path";
import { writeFileSync, mkdirSync } from "fs";
import { skillMarkdown } from "./skill.ts";

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
  cwd: string;
}

function shell(t: InstallTarget, ...rest: string[]): string {
  return ["cd", sh(t.cwd), "&&", t.invoker.command, ...t.invoker.prefix, ...rest].join(" ");
}

// The brains Mira can install its skill into, and the scope to write it at.
export type SkillAgent = "claude-code" | "codex";
export type SkillScope = "project" | "user";
export interface SkillInstallOptions {
  cwd?: string;
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

// Install the Mira skill for one agent. Writes the canonical SKILL.md (baked
// into the binary) so the agent picks Mira up implicitly by description and can
// drive the CLI. Overwrites an existing copy so re-running keeps it current.
export function installSkill(agent: SkillAgent, scope: SkillScope, opts: SkillInstallOptions = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const dir = skillDir(agent, scope, cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, skillMarkdown());
  return { agent, scope, cwd, wrote: file };
}

// Cron: return the crontab lines (we print, never auto-overwrite the user's
// crontab — installing is `mira install cron | crontab -` if they want it).
export function cronLines(t: InstallTarget): string {
  const logDir =
    t.invoker.command.includes("/") ? dirname(t.invoker.command) : homedir();
  const log = (n: string) => join(logDir, n);
  return [
    cronHeader(t.cwd),
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
// the cleaned text. It removes only the cron registration for `cwd`, preserving
// Mira cron blocks from other directories.
export function cronUninstall(current: string, cwd = process.cwd()): string {
  const lines = current.split("\n");
  const kept: string[] = [];
  let removingOldWorkspaceBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const targetLine = isTargetCronLine(line, cwd);
    const workspace = cronWorkspace(line);
    const targetWorkspace = join(cwd, ".mira");

    if (/^#\s*Mira\b/.test(line)) {
      const next = nextNonEmpty(lines, i + 1);
      if (line === cronHeader(cwd) || (next && (isTargetCronLine(next, cwd) || cronWorkspace(next) === targetWorkspace))) {
        continue;
      }
    }

    if (targetLine) continue;

    if (workspace) {
      removingOldWorkspaceBlock = workspace === targetWorkspace;
      if (removingOldWorkspaceBlock) continue;
    }

    if (removingOldWorkspaceBlock) {
      if (isMiraScheduleLine(line) || line.trim() === "") continue;
      removingOldWorkspaceBlock = false;
    }

    kept.push(line);
  }

  // Collapse the blank lines left behind and keep a single trailing newline.
  const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n+$/, "");
  return out ? out + "\n" : "";
}

function cronHeader(cwd: string): string {
  return `# Mira — cwd=${cwd}`;
}

function isTargetCronLine(line: string, cwd: string): boolean {
  return line.includes(`cd ${sh(cwd)} &&`) && isMiraScheduleLine(line);
}

function isMiraScheduleLine(line: string): boolean {
  return /\bmira\b.*\b(sweep|brief)\b/.test(line);
}

function cronWorkspace(line: string): string | null {
  const m = line.match(/^\s*MIRA_WORKSPACE=(.+?)\s*$/);
  if (!m) return null;
  return m[1].replace(/^['"]|['"]$/g, "");
}

function nextNonEmpty(lines: string[], start: number): string | null {
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trim()) return lines[i];
  }
  return null;
}

function sh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
