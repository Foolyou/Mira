// install.ts — register Mira into the brains (as an Agent Skill) and into cron.
// Works for both distribution forms: the self-contained binary (primary) and
// `bunx`/global npm (secondary, Bun-only). Cron targets point at ONE invocation
// and ONE workspace so the SQLite truth source stays shared; the skill is the
// same SKILL.md for every agent (the open Agent Skills standard), written from
// the string baked into the binary.
import { homedir } from "os";
import { join, dirname } from "path";
import { writeFileSync, mkdirSync } from "fs";
import { SKILL_MD } from "./skill.ts";

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
export function installSkill(agent: SkillAgent, scope: SkillScope, cwd = process.cwd()) {
  const dir = skillDir(agent, scope, cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, SKILL_MD);
  return { agent, scope, wrote: file };
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
