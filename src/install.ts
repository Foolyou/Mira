// install.ts — register Mira into the two brains and into cron. Works for both
// distribution forms: the self-contained binary (primary) and `bunx`/global npm
// (secondary, Bun-only). Every target points at ONE invocation and ONE
// workspace so the SQLite truth source stays shared.
import { homedir } from "os";
import { join, dirname } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

// The npm package name (secondary path). `bunx <PKG> mcp` resolves to the CLI.
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

// Claude Code: write/merge a project-local .mcp.json. Also returns the
// user-scope command for those who prefer a global registration.
export function installClaudeCode(t: InstallTarget, cwd = process.cwd()) {
  const file = join(cwd, ".mcp.json");
  let doc: any = {};
  if (existsSync(file)) {
    try {
      doc = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error(`${file} exists but is not valid JSON; fix or remove it first`);
    }
  }
  doc.mcpServers ??= {};
  doc.mcpServers.mira = {
    command: t.invoker.command,
    args: args(t, "mcp", "--workspace", t.workspace),
  };
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  return {
    wrote: file,
    entry: doc.mcpServers.mira,
    user_scope_command: `claude mcp add mira --scope user -- ${shell(t, "mcp", "--workspace", t.workspace)}`,
  };
}

// Codex: append an [mcp_servers.mira] block to ~/.codex/config.toml if absent.
export function installCodex(t: InstallTarget) {
  const file = join(homedir(), ".codex", "config.toml");
  mkdirSync(dirname(file), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (/^\s*\[mcp_servers\.mira\]/m.test(existing)) {
    return { file, added: false, note: "[mcp_servers.mira] already present — left untouched" };
  }
  const argv = args(t, "mcp", "--workspace", t.workspace);
  const argsToml = "[" + argv.map((a) => `"${a}"`).join(", ") + "]";
  const block = `\n[mcp_servers.mira]\ncommand = "${t.invoker.command}"\nargs = ${argsToml}\n`;
  writeFileSync(file, existing + block);
  return { file, added: true, note: "appended [mcp_servers.mira]" };
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
