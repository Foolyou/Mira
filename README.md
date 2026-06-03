# Mira (Bun + TypeScript)

Greenfield rewrite. The
job v1 lost when Hermes was unloaded — **到点 → 算出该提醒什么 → 真正送到 → 记下已送（恰好一次）** —
is rebuilt here, agent-agnostic and daemonless. The only clock is OS cron; the
only state is one SQLite file.

## Run

```bash
bun install
bun test                       # 24 tests: idempotency, recurrence, modes, retry, migration
bun run src/cli.ts help        # CLI (the contract)
bun run src/mcp.ts             # stdio MCP server (convenience layer)
bun build --compile src/cli.ts --outfile mira   # single binary for cron
```

No build step is required to run; `--compile` only exists to ship a deployment
binary as a fallback.

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
./mira install claude-code      # writes/merges project .mcp.json  (prints user-scope cmd too)
./mira install codex            # appends [mcp_servers.mira] to ~/.codex/config.toml
./mira install cron | crontab - # the only clock: 5-min sweep + 3 briefs + weekly
```

All three point at **one binary and one workspace** (`~/.mira/workspace`), so the
SQLite truth source is shared and exactly-once holds across every brain + cron.

- **Claude Code** connects over MCP: `mira mcp` (stdio). `install claude-code`
  drops `.mcp.json`; for a global install run the printed
  `claude mcp add mira --scope user -- mira mcp --workspace ~/.mira/workspace`.
- **Codex** can either shell out to the `mira` CLI (the contract — see
  [`AGENTS.md`](./AGENTS.md)) or connect to the same MCP server via
  `install codex`.

### Secondary path — npm / bunx (Bun-only)

If you already run Bun and prefer auto-updates over a binary, install from npm.
The package is **`mira-copilot`** and is **Bun-only** — it uses `bun:sqlite`, so
`npx`/`node` will not run it; use `bunx`/`bun`.

```bash
# one-shot, no install:
bunx mira-copilot mcp --workspace ~/.mira/workspace

# or install globally, then `mira …` is on PATH:
bun add -g mira-copilot
mira install claude-code --via bunx     # writes config that calls `bunx mira-copilot mcp`
mira install codex       --via global   # or --via global to call the `mira` on PATH
mira install cron        --via global | crontab -
```

`mira install … --via <binary|bunx|global>` picks how the generated config
launches Mira: `binary` (absolute path to the compiled file, the default),
`bunx` (`bunx mira-copilot …`), or `global` (the `mira` shim from `bun add -g`).

Releases ship both forms from one CI run (`.github/workflows/release.yml`):
cross-compiled binaries attached to the GitHub Release **and** `mira-copilot`
published to npm.

## Architecture (three layers, daemonless)

```
① clock   OS cron  →  mira sweep / mira brief   (one-shot, no daemon)
② brain   Claude Code (MCP) │ Codex (CLI) │ pure cron (no agent)   — pluggable
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
- `src/cli.ts` — the contract. `src/mcp.ts` — MCP SDK server wrapping the same core.

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

## Configure email (iCloud)

```bash
mira config set delivery.default_channel email
mira config set channel.email '{"smtp_host":"smtp.mail.me.com","smtp_port":587,"user":"you@icloud.com","app_password":"xxxx-xxxx-xxxx-xxxx","to":"you@icloud.com","from":"you@icloud.com"}'
mira doctor --check-channel
```

## Cron

`mira install cron | crontab -` emits the schedule (with absolute paths for this
machine): a `*/5` backstop sweep plus three daily briefs and a Sunday weekly.
Failures retry on the next tick.

## Migrate real v1 data

```bash
mira import-v1 --from data/lifework.db
mira doctor
```
Imports the knowledge layer + 27 tasks + 5 recurrence rules; only the 12 active
reminders become specs (4 done/cancelled are skipped); `cron_id` is dropped.
