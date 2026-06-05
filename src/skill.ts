// skill.ts — the single source of truth for Mira's Agent Skill. Baked into the
// compiled binary so `mira install <agent>` can write it out anywhere, with no
// external asset to locate. One SKILL.md, the open Agent Skills standard, serves
// Claude Code (.claude/skills/) and Codex (.codex/skills/) identically.
//
// This is the JUDGMENT layer: when to reach for Mira and how to sequence its
// commands. The exhaustive command list is NOT duplicated here — `mira help` is
// the contract and stays authoritative. Keep this in sync with cli.ts/AGENTS.md
// only where workflow guidance changes.

export const SKILL_NAME = "mira";

export const SKILL_DESCRIPTION =
  "Drive Mira — a daemonless personal/family operating copilot — through its `mira` CLI. " +
  "Use when the user wants to capture a task, set a reminder or recurring reminder, run the " +
  "delivery sweep, build a daily/weekly brief, prep for a client or family meeting, or review " +
  "what is overdue/due-today. All state is one shared SQLite workspace; every command prints JSON. " +
  "Do NOT use for unrelated coding tasks or for editing the SQLite file directly.";

function workspaceGuidance(workspace?: string): string {
  if (workspace) {
    return `## Workspace binding

Use this exact workspace for every Mira command unless the user explicitly asks
for another one:

\`\`\`bash
--workspace ${workspace}
\`\`\`

This keeps all agent calls, cron jobs, and ad-hoc CLI calls on the same SQLite
truth source even when the agent's current working directory changes. It was
created at install time; if a command reports it is not initialized, run
\`mira init --workspace ${workspace}\` once.`;
  }

  return `## Workspace binding

A Mira workspace is a \`.mira\` directory; there is **no global/home workspace**.
By default every command works against \`<cwd>/.mira\`, and a workspace must be
created explicitly — data commands error until it exists.

**Before using Mira in a working directory, initialize it once:**

\`\`\`bash
mira init                 # creates ./.mira in the current directory
\`\`\`

Then either run subsequent commands from that same directory, or pass
\`--workspace <dir>\` (or set \`MIRA_WORKSPACE\`) so calls don't drift to a
different \`.mira\` when the working directory changes. Running from the wrong
directory no longer silently creates a second, empty workspace — it errors and
points you at \`mira init\`.`;
}

export function skillMarkdown(workspace?: string): string {
  return `---
name: ${SKILL_NAME}
description: ${SKILL_DESCRIPTION}
---

# Mira

Mira is a daemonless personal/family operating copilot. **The \`mira\` CLI is the
contract** — every capability is one \`mira <command>\`, and every command prints
JSON to stdout. You drive it the exact same way cron and the other brains do,
against **one shared SQLite workspace**, so nothing drifts and reminders fire
exactly once.

${workspaceGuidance(workspace)}

## Golden rules

1. **Never edit the SQLite file directly.** Go through \`mira\`. The atomic
   claim + \`UNIQUE(spec_id, occurrence_key)\` is what guarantees exactly-once;
   raw writes break it.
2. **Initialize, then stay on one workspace.** A workspace is a \`.mira\`
   directory created by \`mira init\`; there is no global one. Pass an explicit
   \`--workspace <dir>\` with every \`mira\` command when one is listed above (or
   rely on \`MIRA_WORKSPACE\`) so you read/write the one true DB. If a command
   says the workspace is not initialized, run \`mira init\` (optionally
   \`--workspace <dir>\`) — never work around it by switching directories.
3. **\`mira help\` is authoritative.** Run it for the full, current command
   surface and flags rather than guessing. This skill covers *when* and *in what
   order*; \`mira help\` covers *what exists*.
4. **Every command returns JSON.** Parse it; surface the human-meaningful part to
   the user. Don't echo raw blobs.

## When to reach for Mira

- "Remind me to …", "every month on the 26th …", "don't let me forget …" → a
  task + reminder/recurrence.
- "What's on today / overdue / this week?" → \`dashboard\` / \`timeline\`.
- "I have a call with <client> — prep me." → \`meeting-prep\` / \`context\`.
- "Send me my brief", "what got missed?" → \`brief\`, and check delivery backlog.

## Capture: free text → structured

When the user dumps a sentence, decide the shape before writing:

- A **one-off** with a fixed datetime → \`task add\` then \`reminder add --task <id> --at "YYYY-MM-DD HH:MM"\`.
- A **repeating** obligation → \`recur add\` with a \`--pattern-type\` and
  \`--pattern-config\` (json). Patterns: \`daily\`, \`weekly\` \`{"weekdays":[0]}\`
  (0=Mon), \`monthly\` \`{"day":26}\` or \`{"day":"last"}\`, \`yearly_dates\`
  \`{"dates":["03-15"]}\`, \`yearly_weeks\` \`{"weeks":[14,15,16]}\`.
- Pure note / knowledge → \`note add\`, \`company add\`, \`project add\`, or the
  quick \`capture "<text>"\`.

Prefer attaching a \`--company\`/\`--project\` id and an \`--area\`
(family|client|work|personal) when the user implies one — it makes dashboards and
meeting-prep useful later.

## Meeting prep (a sequence, not one call)

1. \`mira context --company <id>\` (or \`--project\`) for the bundle.
2. \`mira meeting-prep --company <id>\` for the prep pack.
3. \`mira timeline --days 14\` to catch anything firing around the meeting.

Then summarize in plain language — open items, recent notes, what's due.

## The delivery loop

- \`mira sweep --dry-run\` shows what's due without sending. \`mira sweep\` fires
  it (cron also runs this every 5 min — you rarely need to).
- **Agent delivery mode** (\`config get delivery.mode\` → \`agent\` or \`both\`):
  \`mira sweep\` *claims* due reminders and prints their payloads as JSON instead
  of sending. For each \`payloads[].log_id\`, deliver it yourself through the
  channel, then **must** call \`mira deliver-ack <log_id> --channel <c> --by <you>\`.
  Unacked rows are re-emitted next sweep — so always ack what you send, and never
  ack what you didn't.
- \`mira brief [--weekly] [--send]\` builds (and optionally sends) the brief.

## Agent-authored notifications

When the user asks you to send an update, or a Mira workflow needs a
human-readable message that is not a reminder/brief, use Mira's dedicated send
commands so channel credentials stay inside the workspace config:

\`\`\`bash
mira mail send --workspace <dir> --subject "Subject" --html-file /path/to/message.html --text-file /path/to/message.txt
mira discord send --workspace <dir> --subject "Subject" --text "Short notification"
mira feishu send --workspace <dir> --subject "Subject" --text "Short notification"
\`\`\`

For email, prefer \`--html-file\`/\`--text-file\` for substantial content; it uses
\`channel.email\`'s configured recipient by default. Discord is send-only for
short notifications (text only — any HTML is flattened); depending on how
\`channel.discord\` is configured it either posts to a channel (webhook) or DMs a
user (bot token). Feishu sends to the user's own account through the already
authenticated local \`lark-cli\`; Mira stores no Feishu bot credentials. Do not
ask for or print channel secrets. Use \`--channel stdout\` only for local
dry/demo checks.

## Health & backlog

\`mira doctor [--check-channel]\` self-checks config, channel login, and delivery
backlog. If \`brief\`/\`doctor\` reports a **backlog** (deliveries that retried up
to \`delivery.max_attempts\` and failed), treat it as the priority signal: inspect
the channel config, fix the cause, and tell the user — a silently stuck reminder
is the one failure mode Mira exists to prevent.

## Cron (the clock)

Mira is daemonless — OS cron is the only clock. \`mira install cron --workspace
<dir> | crontab -\` installs the sweep/brief schedule (always bind the same
workspace so exactly-once holds). To remove it, \`mira install cron --uninstall |
crontab -\` prints the crontab with Mira's lines stripped for the user to apply.
Never hand-edit the crontab block.

## Secrets

\`channel.*\` config may store a credential as \`file:<path>\` or \`env:<VAR>\`
instead of a literal; it's resolved in-process at send time. \`config\`
get/set/list redact literal secret fields as \`***\` (references stay visible), so
reading config never surfaces the value. Don't try to print or exfiltrate it.

## If \`mira\` isn't on PATH

Most setups expose \`mira\` directly. If not, the Bun package equivalent is
\`bunx mira-copilot <command>\` (Bun-only — \`npx\`/\`node\` won't run it).
`;
}

export const SKILL_MD = skillMarkdown();
