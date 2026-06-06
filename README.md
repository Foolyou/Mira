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

A Mira workspace is a `.mira` directory — there is **no global/home workspace**.
Mira works only against `./.mira` in the current working directory; there is no
`--workspace` flag, `MIRA_WORKSPACE`, or DB-path override in the CLI. The
workspace must be created explicitly:

```bash
mira init          # create ./.mira here (required before any data command)
mira init --agent codex --agent claude-code
# create ./.mira and install both project agent skills
```

Until it exists, data commands error and point you at `mira init`, so running
from the wrong directory never silently spawns a second, empty database. A
`mira init --agent ...` can install one or more project skills during
initialization. `mira install claude-code|codex` remains available for reinstalling
a single skill later; `--user` installs the skill globally with the same cwd
rule. Agents and cron must run Mira from the intended initialized directory.

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
cd ~/assistant
./mira init --agent claude-code --agent codex # create ./.mira and project skills
./mira install cron | crontab - # the only clock; generated lines cd back here
```

All of them should run from **one initialized directory**, so the SQLite truth
source (`./.mira/mira.db`) is shared and exactly-once holds across every brain +
cron.

- **Both brains drive the `mira` CLI** — the contract (see [`AGENTS.md`](./AGENTS.md)).
  `install claude-code`/`install codex` drop the **same** [`SKILL.md`](https://developers.openai.com/codex/skills)
  (the open Agent Skills standard) into the agent's skills directory, so it picks
  Mira up by description and knows how to sequence the commands. Default scope is
  the project (`.claude/skills/` · `.codex/skills/`); add `--user` to install
  globally (`~/.claude/skills/` · `$CODEX_HOME/skills/`). The skill never bakes a
  workspace path; it tells the agent to run Mira from the intended directory and
  use `mira init` there if needed. During first setup, `mira init --agent
  claude-code --agent codex` writes both project skills in one command.

### Secondary path — npm / bunx (Bun-only)

If you already run Bun and prefer auto-updates over a binary, install from npm.
The package is **`mira-copilot`** and is **Bun-only** — it uses `bun:sqlite`, so
`npx`/`node` will not run it; use `bunx`/`bun`.

```bash
# one-shot, no install:
bunx mira-copilot help

# or install globally, then `mira …` is on PATH:
bun add -g mira-copilot
cd ~/assistant
mira init --agent claude-code --agent codex # create ./.mira and project skills
mira install cron        --via global | crontab -
```

The skill assumes `mira` is on PATH (true after `bun add -g` or the binary
install); if it isn't, the skill falls back to `bunx mira-copilot …`. For cron,
`mira install cron --via <binary|bunx|global>` picks how the emitted crontab
launches Mira: `binary` (absolute path to the compiled file, the default),
`bunx` (`bunx mira-copilot …`), or `global` (the `mira` shim from `bun add -g`).
Run it from the initialized Mira directory; the emitted crontab lines `cd` back
to that directory before invoking Mira.

Releases ship both forms from one CI run (`.github/workflows/release.yml`):
cross-compiled binaries attached to the GitHub Release **and** `mira-copilot`
published to npm.

## Architecture (three layers, daemonless)

```
① clock   OS cron  →  mira sweep / mira brief   (one-shot, no daemon)
② brain   Claude Code (skill→CLI) │ Codex (skill→CLI) │ pure cron (no agent)   — pluggable
③ core    recurrence resolver · occurrence materialization · idempotent claim
          delivery ports (email/discord/stdout/…) · read-models · CRUD
                                   ↓
                         SQLite (single file, sole source of truth)
```

- `src/db.ts` — workspace resolution, schema, additive migrations, config.
- `src/time.ts` — local-naive time (`YYYY-MM-DD HH:MM`), ISO week, weekday (0=Mon).
- `src/recurrence.ts` — the ONE resolver: `resolveOccurrences` + `isDueOn`.
- `src/sweep.ts` — the heart: candidate → `INSERT OR IGNORE` → atomic claim → deliver. `deliverAck` for B2.
- `src/delivery/` — `Channel` port; `stdout` (dev/agent), `email` (nodemailer/iCloud), `discord` (send-only webhook/bot DM), and `feishu` (local `lark-cli` self-DM).
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

Channel policy lives in Mira, never in the agent, so Claude Code and Codex
deliver byte-for-byte identically. Email/Discord credentials live in the
workspace DB; Feishu instead uses the user's already authenticated local
`lark-cli` profile and stores no Mira-side Feishu credentials.

Agents can also send explicit rich-text email through the same configured
channel when the user asks for it:

```bash
mira mail send --subject "Update" --html-file /tmp/message.html --text-file /tmp/message.txt
```

This uses `channel.email` by default, including its configured recipient, so SMTP
credentials and addressing policy stay inside Mira.

Discord has its own send-only command for ad-hoc notifications through the
configured webhook:

```bash
mira discord send --subject "Heads up" --text "Backup finished"
```

Feishu uses the local `lark-cli` user identity and sends a private message to
that same account. There is no Mira bot credential or recipient config:

```bash
mira config set delivery.default_channel feishu
mira doctor --check-channel        # checks local lark-cli user auth (sends nothing)
mira send-test                     # actually delivers a test message to yourself
mira feishu send --subject "Heads up" --text "Backup finished"
```

## Configure email (iCloud)

```bash
mira config set delivery.default_channel email
mira config set channel.email '{"smtp_host":"smtp.mail.me.com","smtp_port":587,"user":"you@icloud.com","app_password":"file:~/.secrets/mira-smtp","to":"you@icloud.com","from":"you@icloud.com"}'
mira doctor --check-channel        # verifies SMTP login (sends nothing)
mira send-test                     # actually delivers a test message
```

## Configure Discord (webhook)

Discord is a **send-only** channel: it posts to an incoming webhook, so there is
no bot, gateway, or polling — exactly what notification delivery needs. Create a
webhook in *Server Settings → Integrations → Webhooks*, then:

```bash
mira config set delivery.default_channel discord
mira config set channel.discord '{"webhook_url":"file:~/.secrets/mira-discord","username":"Mira"}'
mira doctor --check-channel        # GETs the webhook to validate it (posts nothing)
mira send-test                     # actually delivers a test message
mira discord send --subject "Heads up" --text "Ad-hoc notification"
```

The webhook URL *is* the credential (anyone holding it can post), so it accepts
the same `file:`/`env:` reference forms as the SMTP password below and is
redacted in `config` output. `username`/`avatar_url` are optional cosmetic
overrides for the posted message.

### Private DM via a bot (instead of a channel webhook)

The same `discord` channel can **private-message a user** instead of posting to a
channel — still send-only and daemonless (two REST calls, no gateway). Use a
bot-token config shape instead of a webhook one:

```bash
mira config set channel.discord '{"bot_token":"file:~/.secrets/mira-bot","user_id":"<your numeric Discord id>"}'
mira doctor --check-channel        # validates the bot token (sends nothing)
mira send-test
```

`bot_token` takes precedence if both shapes are present, and is redacted/resolved
just like the webhook URL. Discord requires that **the bot and the recipient
share at least one server** and that the user allows DMs from server members —
otherwise the send returns 403. Setup: create a bot at
<https://discord.com/developers>, copy its **Bot Token**, invite it to a server
you are in, and copy your **User ID** (Settings → Advanced → Developer Mode →
right-click yourself → Copy User ID).

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

From an initialized Mira directory, `mira install cron | crontab -` emits the
schedule (with absolute paths for this machine): a `*/5` backstop sweep plus
three daily briefs and a Sunday weekly. The generated lines `cd` back to that
directory before running Mira, so cron and the brains share one SQLite truth
source. Failures retry on the next tick.

To remove it later:

```bash
mira install cron --uninstall | crontab -   # removes this directory's Mira cron lines
```

`--uninstall` reads your current crontab, drops only the Mira-managed lines for
the current directory (including matching old `MIRA_WORKSPACE=<cwd>/.mira`
blocks), and prints the rest for you to apply — it never writes your crontab
itself.

## Migrate real v1 data

```bash
mira import-v1 --from data/lifework.db
mira doctor
```
Imports the knowledge layer + 27 tasks + 5 recurrence rules; only the 12 active
reminders become specs (4 done/cancelled are skipped); `cron_id` is dropped.
