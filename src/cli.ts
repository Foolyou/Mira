#!/usr/bin/env bun
// cli.ts — the contract. Everything a reminder needs is reachable here so that
// every brain (Claude Code, Codex, cron) drives Mira the same way: one `mira`
// command per capability. The agent skill in skill.ts just guides this surface.
import { openDb, resolveWorkspace, isInitialized, initWorkspace, configGet, configSet, configAll } from "./db.ts";
import { redactConfigValue, redactConfigMap } from "./secret.ts";
import { installSkill, cronLines, cronUninstall, NPM_PKG, type Invoker } from "./install.ts";
import { homedir } from "os";
import { resolve, join } from "path";
import * as core from "./core.ts";
import { sweep, deliverAck } from "./sweep.ts";
import { sendMail, sendDiscord, sendFeishu, sendTest } from "./delivery/index.ts";
import { sendBrief, buildBrief } from "./brief.ts";
import { importV1 } from "./import.ts";
import { doctor, verifyImport } from "./doctor.ts";
import { readFileSync } from "fs";

interface Parsed {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parse(argv: string[]): Parsed {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

function num(v: string | boolean | undefined): number | undefined {
  if (v === undefined || typeof v === "boolean") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function out(v: unknown): void {
  process.stdout.write(JSON.stringify(v, null, 2) + "\n");
}

// Resolve the path to write into agent/cron config. For the compiled single
// binary (the intended distribution), execPath IS the mira binary. Under
// `bun src/cli.ts` execPath is bun, so fall back to "mira" on PATH.
function selfBin(): string {
  const ep = process.execPath;
  return /[\\/]bun(\.exe)?$/.test(ep) ? "mira" : ep;
}
function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function flagText(flags: Record<string, string | boolean>, inlineKey: string, fileKey: string): string | undefined {
  const inline = str(flags[inlineKey]);
  const file = str(flags[fileKey]);
  if (inline && file) fail(`use either --${inlineKey} or --${fileKey}, not both`);
  if (file) return readFileSync(file, "utf8");
  return inline;
}

const HELP = `mira — daemonless personal operating copilot

USAGE
  mira <command> [args] [--flags]

TASKS
  task add <title> [--area a --priority p --due-at "YYYY-MM-DD HH:MM" --due-text t --company N --project N]
  task update <id> [--status s --priority p --due-at ... --title ...]
  task done <id>
  task list [--status s --area a --company N --limit N]

REMINDERS
  reminder add --task <id> --at "YYYY-MM-DD HH:MM"        one-time
  reminder cancel <id> | --task <id>                      stop a pending reminder (or all on a task)
  recur add <title> --pattern-type <t> --pattern-config '<json>' [--remind-time HH:MM --area a --duration N]
  recur list
  reminder list [--all]

DELIVERY LOOP (the heart)
  sweep [--now "YYYY-MM-DD HH:MM"] [--dry-run]
  brief [--send] [--weekly] [--day YYYY-MM-DD]
  send-test [--channel <c>]                            actually deliver a test message (default channel)
  deliver-ack <log_id> --channel <c> [--by name]
  mail send --subject <s> [--text t|--text-file path] [--html h|--html-file path] [--channel email]
  discord send [--subject s] [--text t|--text-file path] [--html h|--html-file path]   notify the Discord webhook
  feishu send [--subject s] [--text t|--text-file path] [--html h|--html-file path]    notify yourself via local lark-cli

READ MODELS
  dashboard [--day YYYY-MM-DD] | search <q> | timeline [--days N] | counts
  context [--company N --project N] | meeting-prep --company N

KNOWLEDGE
  company add <name> [--type t --summary s] | company list [--type t --limit N]
  project add <name> [--company N --summary s] | project list [--company N --status s --limit N]
  note add <content> [--company N --project N --kind k] | note list [--company N --project N --kind k --limit N]
  capture <text> | capture list [--kind k --source s --status s --limit N]

ADMIN
  init [--workspace dir]                               create the workspace (.mira) — required before first use
  config get <key> | config set <key> <value> | config list
  import-v1 --from <lifework.db> [--force]
  doctor [--check-channel]
  install claude-code|codex [--user] [--workspace dir] install the Mira skill (project, or --user/global)
  install cron [--via binary|bunx|global] [--bin path --workspace dir] | crontab -
  install cron --uninstall | crontab -                remove Mira's cron lines (prints the cleaned crontab)

GLOBAL FLAGS
  --workspace <dir> | --demo | --db <path>
  default workspace: <current-working-directory>/.mira  (create it with: mira init)
`;

async function main() {
  const { _, flags } = parse(process.argv.slice(2));
  const cmd = _[0];
  if (!cmd || cmd === "help" || flags.help) {
    process.stdout.write(HELP);
    return;
  }

  // `mira install <target>`: install the Mira skill into a brain, or emit cron.
  //   claude-code | codex  -> write SKILL.md (project scope; --user for global)
  //   cron                 -> print crontab lines (--via picks how Mira launches)
  if (cmd === "install") {
    const target = _[1];
    if (target === "claude-code" || target === "codex") {
      out(installSkill(target, flags.user ? "user" : "project", { workspace: str(flags.workspace) }));
    } else if (target === "cron") {
      // `--uninstall` is the inverse: read the current crontab, strip Mira's
      // managed lines, and print what should remain (pipe to `crontab -`).
      if (flags.uninstall) {
        const cur = Bun.spawnSync(["crontab", "-l"]);
        const current = cur.exitCode === 0 ? cur.stdout.toString() : "";
        process.stdout.write(cronUninstall(current));
        process.stderr.write("# pipe to crontab to apply: mira install cron --uninstall | crontab -\n");
        return;
      }
      const workspace = str(flags.workspace) ?? resolveWorkspace();
      const via = str(flags.via) ?? (/[\\/]bun(\.exe)?$/.test(process.execPath) ? "global" : "binary");
      let invoker: Invoker;
      if (via === "bunx") invoker = { command: "bunx", prefix: [NPM_PKG] };
      else if (via === "global") invoker = { command: "mira", prefix: [] };
      else if (via === "binary") invoker = { command: str(flags.bin) ?? selfBin(), prefix: [] };
      else { fail("--via must be binary|bunx|global"); }
      process.stdout.write(cronLines({ invoker: invoker!, workspace }));
    } else {
      fail("install <claude-code|codex|cron> [--user] [--via binary|bunx|global --bin path --workspace dir]");
    }
    return;
  }

  // The workspace for this invocation: --workspace (with ~ and relative-path
  // expansion) > MIRA_WORKSPACE/cwd default. There is no global fallback.
  const resolveWs = (): string => {
    const w = str(flags.workspace);
    if (w) return w.startsWith("~") ? join(homedir(), w.slice(1)) : resolve(process.cwd(), w);
    return resolveWorkspace();
  };

  // `mira init`: create the workspace (.mira) and run migrations. The one
  // command allowed to bring a workspace into existence; everything else errors
  // until it has run, so you never silently spawn a second empty DB by running
  // from the wrong directory.
  if (cmd === "init") {
    out(initWorkspace(resolveWs()));
    return;
  }

  const explicitDb = str(flags.db);
  const ws = resolveWs();
  // Refuse data commands on an uninitialized workspace. `--demo` and an explicit
  // `--db` path are exempt (ephemeral / advanced / test paths).
  if (!flags.demo && !explicitDb && !isInitialized(ws)) {
    const hint = str(flags.workspace) ? ` --workspace ${str(flags.workspace)}` : "";
    fail(`workspace not initialized at ${join(ws, "mira.db")} — run: mira init${hint}`);
  }

  const db = openDb({
    demo: !!flags.demo,
    path: explicitDb ?? (str(flags.workspace) ? join(ws, "mira.db") : undefined),
  });

  try {
    switch (cmd) {
      // -------------------- tasks --------------------
      case "task": {
        const sub = _[1];
        if (sub === "add") {
          const title = _[2];
          if (!title) fail("task add needs a title");
          out(core.addTask(db, {
            title,
            area: str(flags.area),
            priority: str(flags.priority),
            status: str(flags.status),
            due_at: str(flags["due-at"]),
            due_text: str(flags["due-text"]),
            company_id: num(flags.company) ?? null,
            project_id: num(flags.project) ?? null,
            context: str(flags.context),
          }));
        } else if (sub === "update") {
          const id = num(_[2]);
          if (id == null) fail("task update needs an id");
          const patch: Record<string, any> = {};
          for (const [k, key] of [["status", "status"], ["priority", "priority"], ["area", "area"], ["title", "title"], ["due-at", "due_at"], ["due-text", "due_text"], ["context", "context"]] as const) {
            if (k in flags) patch[key] = str(flags[k]);
          }
          if ("company" in flags) patch.company_id = num(flags.company);
          if ("project" in flags) patch.project_id = num(flags.project);
          out(core.updateTask(db, id, patch));
        } else if (sub === "done") {
          const id = num(_[2]);
          if (id == null) fail("task done needs an id");
          out(core.doneTask(db, id));
        } else if (sub === "list") {
          out(core.listTasks(db, {
            status: str(flags.status),
            area: str(flags.area),
            company_id: num(flags.company),
            project_id: num(flags.project),
            limit: num(flags.limit),
          }));
        } else fail(`unknown task subcommand: ${sub}`);
        break;
      }

      // -------------------- reminders / recurrence --------------------
      case "reminder": {
        const sub = _[1];
        if (sub === "add") {
          const task = num(flags.task);
          const at = str(flags.at);
          if (task == null || !at) fail("reminder add needs --task <id> --at <ts>");
          out(core.addReminder(db, task, at));
        } else if (sub === "cancel") {
          const id = num(_[2]);
          const task = num(flags.task);
          if (id != null) {
            const spec = core.cancelReminder(db, id);
            if (!spec) fail(`no active reminder with id ${id}`);
            out(spec);
          } else if (task != null) {
            out({ task_id: task, cancelled: core.cancelTaskReminders(db, task) });
          } else fail("reminder cancel needs an <id> or --task <id>");
        } else if (sub === "list") {
          out(core.listReminders(db, !!flags.all));
        } else fail(`unknown reminder subcommand: ${sub}`);
        break;
      }
      case "recur": {
        const sub = _[1];
        if (sub === "add") {
          const title = _[2];
          const pt = str(flags["pattern-type"]);
          const pc = str(flags["pattern-config"]) ?? "{}";
          if (!title || !pt) fail("recur add needs <title> --pattern-type <t> [--pattern-config json]");
          out(core.addRecurrence(db, {
            title,
            pattern_type: pt,
            pattern_config: pc,
            remind_time: str(flags["remind-time"]),
            area: str(flags.area),
            duration_days: num(flags.duration),
            company_id: num(flags.company) ?? null,
            project_id: num(flags.project) ?? null,
            channel_override: str(flags.channel),
          }));
        } else if (sub === "list") {
          out(core.listRecurrences(db));
        } else fail(`unknown recur subcommand: ${sub}`);
        break;
      }

      // -------------------- the heart --------------------
      case "sweep": {
        const res = await sweep(db, {
          now: str(flags.now),
          dryRun: !!flags["dry-run"],
        });
        out(res);
        break;
      }
      case "brief": {
        if (flags.send) {
          out(await sendBrief(db, { weekly: !!flags.weekly, day: str(flags.day) }));
        } else {
          out(buildBrief(db, { weekly: !!flags.weekly, day: str(flags.day) }));
        }
        break;
      }
      case "send-test": out(await sendTest(db, { channel: str(flags.channel) })); break;
      case "mail": {
        if (_[1] !== "send") fail("mail send --subject <s> [--text/--text-file] [--html/--html-file]");
        out(await sendMail(db, {
          subject: str(flags.subject) ?? "",
          text: flagText(flags, "text", "text-file"),
          html: flagText(flags, "html", "html-file"),
          channel: str(flags.channel),
        }));
        break;
      }
      case "discord": {
        if (_[1] !== "send") fail("discord send [--subject s] [--text/--text-file] [--html/--html-file]");
        out(await sendDiscord(db, {
          subject: str(flags.subject),
          text: flagText(flags, "text", "text-file"),
          html: flagText(flags, "html", "html-file"),
        }));
        break;
      }
      case "feishu": {
        if (_[1] !== "send") fail("feishu send [--subject s] [--text/--text-file] [--html/--html-file]");
        out(await sendFeishu(db, {
          subject: str(flags.subject),
          text: flagText(flags, "text", "text-file"),
          html: flagText(flags, "html", "html-file"),
        }));
        break;
      }
      case "deliver-ack": {
        const id = num(_[1]);
        const channel = str(flags.channel);
        if (id == null || !channel) fail("deliver-ack <log_id> --channel <c>");
        out(deliverAck(db, id, channel, str(flags.by) ?? "agent"));
        break;
      }

      // -------------------- read models --------------------
      case "dashboard": out(core.dashboard(db, str(flags.day))); break;
      case "search": {
        const q = _[1];
        if (!q) fail("search needs a query");
        out(core.search(db, q, num(flags.limit)));
        break;
      }
      case "timeline": out(core.timeline(db, num(flags.days) ?? 14, str(flags.from))); break;
      case "counts": out(core.counts(db)); break;
      case "context": out(core.context(db, num(flags.company), num(flags.project))); break;
      case "meeting-prep": {
        const c = num(flags.company);
        if (c == null) fail("meeting-prep needs --company <id>");
        out(core.meetingPrep(db, c));
        break;
      }

      // -------------------- knowledge --------------------
      case "company": {
        if (_[1] === "add") {
          const name = _[2];
          if (!name) fail("company add needs a name");
          out(core.addCompany(db, name, str(flags.type), str(flags.summary)));
        } else if (_[1] === "list") {
          out(core.listCompanies(db, { type: str(flags.type), limit: num(flags.limit) }));
        } else fail("only: company add <name> | company list");
        break;
      }
      case "project": {
        if (_[1] === "add") {
          const name = _[2];
          if (!name) fail("project add needs a name");
          out(core.addProject(db, name, num(flags.company), str(flags.summary)));
        } else if (_[1] === "list") {
          out(core.listProjects(db, {
            company_id: num(flags.company),
            status: str(flags.status),
            limit: num(flags.limit),
          }));
        } else fail("only: project add <name> | project list");
        break;
      }
      case "note": {
        if (_[1] === "add") {
          const content = _[2];
          if (!content) fail("note add needs content");
          out(core.addNote(db, content, {
            company_id: num(flags.company),
            project_id: num(flags.project),
            kind: str(flags.kind),
            tags: str(flags.tags),
          }));
        } else if (_[1] === "list") {
          out(core.listNotes(db, {
            company_id: num(flags.company),
            project_id: num(flags.project),
            kind: str(flags.kind),
            limit: num(flags.limit),
          }));
        } else fail("only: note add <content> | note list");
        break;
      }
      case "capture": {
        if (_[1] === "list") {
          out(core.listCaptures(db, {
            kind: str(flags.kind),
            source: str(flags.source),
            status: str(flags.status),
            limit: num(flags.limit),
          }));
        } else {
          const text = _[1];
          if (!text) fail("capture needs text");
          out(core.capture(db, text, str(flags.kind), str(flags.source)));
        }
        break;
      }

      // -------------------- admin --------------------
      case "config": {
        const sub = _[1];
        if (sub === "get") out({ key: _[2], value: redactConfigValue(_[2], configGet(db, _[2])) });
        else if (sub === "set") { configSet(db, _[2], _.slice(3).join(" ")); out({ key: _[2], value: redactConfigValue(_[2], configGet(db, _[2])) }); }
        else if (sub === "list") out(redactConfigMap(configAll(db)));
        else fail("config get|set|list");
        break;
      }
      case "import-v1": {
        const from = str(flags.from);
        if (!from) fail("import-v1 --from <lifework.db>");
        const res = importV1(db, from, { force: !!flags.force });
        out({ imported: res, verify: verifyImport(db, { tasks: res.tasks, recurrence_rules: res.recurrence_rules }) });
        break;
      }
      case "doctor": out(await doctor(db, { checkChannel: !!flags["check-channel"] })); break;

      default:
        fail(`unknown command: ${cmd} (try: mira help)`);
    }
  } finally {
    db.close();
  }
}

main().catch((e) => fail(String(e?.stack ?? e)));
