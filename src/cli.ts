#!/usr/bin/env bun
// cli.ts — the contract. Everything a reminder needs is reachable here so that
// every brain (Claude Code, Codex, cron) drives Mira the same way: one `mira`
// command per capability. The agent skill in skill.ts just guides this surface.
import { openDb, resolveWorkspace, configGet, configSet, configAll } from "./db.ts";
import { redactConfigValue, redactConfigMap } from "./secret.ts";
import { installSkill, cronLines, NPM_PKG, type Invoker } from "./install.ts";
import * as core from "./core.ts";
import { sweep, deliverAck } from "./sweep.ts";
import { sendTest } from "./delivery/index.ts";
import { sendBrief, buildBrief } from "./brief.ts";
import { importV1 } from "./import.ts";
import { doctor, verifyImport } from "./doctor.ts";

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
  recur add <title> --pattern-type <t> --pattern-config '<json>' [--remind-time HH:MM --area a --duration N]
  recur list
  reminder list [--all]

DELIVERY LOOP (the heart)
  sweep [--now "YYYY-MM-DD HH:MM"] [--dry-run]
  brief [--send] [--weekly] [--day YYYY-MM-DD]
  send-test [--channel <c>]                            actually deliver a test message (default channel)
  deliver-ack <log_id> --channel <c> [--by name]

READ MODELS
  dashboard [--day YYYY-MM-DD] | search <q> | timeline [--days N] | counts
  context [--company N --project N] | meeting-prep --company N

KNOWLEDGE
  company add <name> [--type t --summary s]
  project add <name> [--company N --summary s]
  note add <content> [--company N --kind k]
  capture <text>

ADMIN
  config get <key> | config set <key> <value> | config list
  import-v1 --from <lifework.db> [--force]
  doctor [--check-channel]
  install claude-code|codex [--user]                 install the Mira skill (project, or --user/global)
  install cron [--via binary|bunx|global] [--bin path --workspace dir] | crontab -

GLOBAL FLAGS
  --workspace <dir> | --demo | --db <path>
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
      out(installSkill(target, flags.user ? "user" : "project"));
    } else if (target === "cron") {
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

  const db = openDb({
    demo: !!flags.demo,
    path: str(flags.db) ?? (str(flags.workspace) ? `${str(flags.workspace)}/mira.db` : undefined),
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
        if (_[1] === "add") out(core.addCompany(db, _[2], str(flags.type), str(flags.summary)));
        else fail("only: company add <name>");
        break;
      }
      case "project": {
        if (_[1] === "add") out(core.addProject(db, _[2], num(flags.company), str(flags.summary)));
        else fail("only: project add <name>");
        break;
      }
      case "note": {
        if (_[1] === "add") out(core.addNote(db, _[2], { company_id: num(flags.company), kind: str(flags.kind), tags: str(flags.tags) }));
        else fail("only: note add <content>");
        break;
      }
      case "capture": out(core.capture(db, _[1])); break;

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
