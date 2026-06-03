# Mira (Bun + TypeScript)

Greenfield rewrite. The
job v1 lost when Hermes was unloaded — **到点 → 算出该提醒什么 → 真正送到 → 记下已送（恰好一次）** —
is rebuilt here, agent-agnostic and daemonless. The only clock is OS cron; the
only state is one SQLite file.

## Run

```bash
bun install
bun test                       # idempotency, recurrence, modes, retry, migration
bun run src/cli.ts help        # CLI (the contract)
bun run src/cli.ts install claude-code   # install the Mira skill (Claude Code / Codex)
bun build --compile src/cli.ts --outfile mira   # single binary for cron
```

No build step is required to run; `--compile` only exists to ship a deployment
binary as a fallback.

By default, Mira stores its SQLite workspace under the current working directory:
`./.mira/workspace`. `--workspace <dir>` and `MIRA_WORKSPACE` override that. A
project skill installed with `mira install claude-code|codex` binds to that
project-local workspace; `--user` binds the skill to `~/.mira/workspace`, and an
explicit `--workspace` during install wins over both defaults.

## Install (single binary — the recommended form)

Mira ships as a **self-contained compiled binary** (zero runtime deps — `bun:sqlite`
is baked in), so the same file serves cron, Claude Code, and Codex.

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/mira/main/install.sh | sh
```

Or, from a source checkout, build and install in one shot with the local
installer (compiles the binary and drops it in `~/.mira/bin`):

```bash
./install-local.sh              # build from this tree -> ~/.mira/bin/mira
```

Either way you can then build it yourself and register it everywhere:

```bash
bun run compile                 # -> ./mira   (or `bun run dist` for all platforms)
./mira install claude-code      # write the Mira skill to .claude/skills/mira/ (--user for ~/.claude)
./mira install codex            # write the Mira skill to .codex/skills/mira/  (--user for ~/.codex)
./mira install cron --workspace ~/.mira/workspace | crontab - # the only clock
```

All of them should point at **one binary and one workspace**, so the SQLite truth
source is shared and exactly-once holds across every brain + cron.

- **Both brains drive the `mira` CLI** — the contract (see [`AGENTS.md`](./AGENTS.md)).
  `install claude-code`/`install codex` drop the **same** [`SKILL.md`](https://developers.openai.com/codex/skills)
  (the open Agent Skills standard) into the agent's skills directory, so it picks
  Mira up by description and knows how to sequence the commands. Default scope is
  the project (`.claude/skills/` · `.codex/skills/`) and binds to
  `./.mira/workspace`; add `--user` to install globally
  (`~/.claude/skills/` · `$CODEX_HOME/skills/`) and bind to `~/.mira/workspace`.
  Add `--workspace <dir>` during install to bind the skill to a different
  workspace.

### Secondary path — npm / bunx (Bun-only)

If you already run Bun and prefer auto-updates over a binary, install from npm.
The package is **`mira-copilot`** and is **Bun-only** — it uses `bun:sqlite`, so
`npx`/`node` will not run it; use `bunx`/`bun`.

```bash
# one-shot, no install:
bunx mira-copilot help

# or install globally, then `mira …` is on PATH:
bun add -g mira-copilot
mira install claude-code --user          # write the skill to ~/.claude/skills/mira/
mira install codex       --user          # write the skill to $CODEX_HOME/skills/mira/
mira install cron        --via global --workspace ~/.mira/workspace | crontab -
```

The skill assumes `mira` is on PATH (true after `bun add -g` or the binary
install); if it isn't, the skill falls back to `bunx mira-copilot …`. For cron,
`mira install cron --via <binary|bunx|global>` picks how the emitted crontab
launches Mira: `binary` (absolute path to the compiled file, the default),
`bunx` (`bunx mira-copilot …`), or `global` (the `mira` shim from `bun add -g`).
Pass `--workspace` for cron unless `MIRA_WORKSPACE` is already set in the cron
environment.

Releases ship both forms from one CI run (`.github/workflows/release.yml`):
cross-compiled binaries attached to the GitHub Release **and** `mira-copilot`
published to npm.

## Architecture (three layers, daemonless)

```
① clock   OS cron  →  mira sweep / mira brief   (one-shot, no daemon)
② brain   Claude Code (skill→CLI) │ Codex (skill→CLI) │ pure cron (no agent)   — pluggable
③ core    recurrence resolver · occurrence materialization · idempotent claim
          delivery ports (email/stdout/…) · read-models · CRUD
                                   ↓
                         SQLite (single file, sole source of truth)
```

- `src/db.ts` — workspace resolution, schema, additive migrations, config.
- `src/time.ts` — local-naive time (`YYYY-MM-DD HH:MM`), ISO week, weekday (0=Mon).
- `src/recurrence.ts` — the ONE resolver: `resolveOccurrences` + `isDueOn`.
- `src/sweep.ts` — the heart: candidate → `INSERT OR IGNORE` → atomic claim → deliver. `deliverAck` for B2.
- `src/delivery/` — `Channel` port; `stdout` (dev/agent) and `email` (nodemailer/iCloud).
- `src/core.ts` — task/reminder/recurrence CRUD + read-models (dashboard, search, timeline, context, meeting_prep).
- `src/brief.ts` — daily/weekly HTML+text brief, with delivery-backlog alerts.
- `src/import.ts` — `import-v1` from `data/lifework.db`.
- `src/doctor.ts` — config/channel/backlog self-check.
- `src/cli.ts` — the contract (every capability is one `mira` command).
- `src/skill.ts` — the canonical `SKILL.md`, baked into the binary; `mira install <agent>` writes it.

## Exactly-once

`delivery_log` has `UNIQUE(spec_id, occurrence_key)`. Each sweep does
`INSERT OR IGNORE` then an atomic `UPDATE … SET state='claimed' … RETURNING`
inside a `BEGIN IMMEDIATE` transaction (WAL + busy_timeout). Whichever brain
wins the write lock claims the row; the others see nothing to claim. Delivered
rows are never re-claimed; failures retry on the next sweep until
`delivery.max_attempts`, after which they surface as backlog in `doctor`/`brief`.

Verified by tests: same occurrence swept twice, **and** two concurrent brains on
one DB file, both yield exactly one `delivered` row.

## Delivery modes (`config set delivery.mode …`)

- `mira` (default) — Mira sends via `delivery.default_channel`; success → delivered.
- `agent` — Mira claims and emits the payload as JSON, does **not** send; the
  brain forwards and calls `deliver-ack <log_id> --channel x`. Unacked rows are
  re-emitted on the next sweep.
- `both` — send the backstop email **and** emit the payload for agent enrichment.

Channel config lives only in the workspace DB, never in the agent, so Claude
Code and Codex deliver byte-for-byte identically.

Agents can also send explicit rich-text email through the same configured
channel when the user asks for it:

```bash
mira mail send --subject "Update" --html-file /tmp/message.html --text-file /tmp/message.txt
```

This uses `channel.email` by default, including its configured recipient, so SMTP
credentials and addressing policy stay inside Mira.

## Configure email (iCloud)

```bash
mira config set delivery.default_channel email
mira config set channel.email '{"smtp_host":"smtp.mail.me.com","smtp_port":587,"user":"you@icloud.com","app_password":"file:~/.secrets/mira-smtp","to":"you@icloud.com","from":"you@icloud.com"}'
mira doctor --check-channel        # verifies SMTP login (sends nothing)
mira send-test                     # actually delivers a test message
```

### Keeping the credential out of harm's way

`app_password` accepts three forms — a literal, or a **reference** resolved at
send-time:

- `"file:~/.secrets/mira-smtp"` — read from a (chmod 600) file. The DB then holds
  only the pointer, so the SQLite truth source and any backup of it carry no
  secret.
- `"env:MIRA_SMTP_PASSWORD"` — read from an environment variable.
- a literal string — back-compat; discouraged.

Two guarantees make this robust against the credential leaking into a reading
agent's context:

1. **Redacted output.** `config get`/`config set`/`config list`
   mask literal secret fields as `***`. References (`file:`/`env:`) stay visible
   — they are pointers, not secrets. Triggering a send never surfaces the value:
   it is resolved inside the Mira process and never echoed.
2. **Resolution stays in-process.** `send-test`, `brief --send`, and the sweep
   read the credential only to hand it to SMTP.

Honest limit: a process running as your user (incl. an agent in a
bypass-permissions session) can still read the file directly. The only hard wall
is OS-level — put the secret in a file owned by a separate user and run the
sending cron as that user, so your everyday user cannot read it. This is
optional; the reference + redaction above already closes the *accidental*
exposure path (a routine command echoing the secret).

## Cron

`mira install cron --workspace <dir> | crontab -` emits the schedule (with
absolute paths for this machine): a `*/5` backstop sweep plus three daily briefs
and a Sunday weekly. Failures retry on the next tick.

## Migrate real v1 data

```bash
mira import-v1 --from data/lifework.db
mira doctor
```
Imports the knowledge layer + 27 tasks + 5 recurrence rules; only the 12 active
reminders become specs (4 done/cancelled are skipped); `cron_id` is dropped.
