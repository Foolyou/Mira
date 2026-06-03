# Mira — guidance for Claude Code

Mira is a family-first one-person-company operating copilot: a local
**Bun + TypeScript + SQLite** system that captures client/project/meeting/idea
material and surfaces tasks, reminders, briefs, and dashboards. It is daemonless
— the only clock is OS cron, the only state is one SQLite file. It is consumed
through the **CLI** (the contract); agents drive that CLI via a single
**`SKILL.md`** (the open Agent Skills standard) installed into Claude Code and
Codex alike.

## Architecture in one breath (three layers)

- **① clock** — OS cron runs `mira sweep` / `mira brief` as one-shot commands.
  No daemon.
- **② brain** — pluggable: Claude Code or Codex (both via the skill → CLI), or pure cron.
- **③ core** — the shared TypeScript under `src/`:
  - `src/db.ts` — workspace resolution, schema, additive migrations, config.
  - `src/time.ts` — local-naive time (`YYYY-MM-DD HH:MM`), ISO week, weekday (0=Mon).
  - `src/recurrence.ts` — the ONE resolver: `resolveOccurrences` + `isDueOn`.
  - `src/sweep.ts` — the heart: candidate → `INSERT OR IGNORE` → atomic claim → deliver.
  - `src/delivery/` — `Channel` port; `stdout` (dev/agent) and `email` (nodemailer/iCloud).
  - `src/core.ts` — task/reminder/recurrence CRUD + read-models (dashboard, search, timeline, context, meeting_prep).
  - `src/brief.ts` — daily/weekly HTML+text brief with delivery-backlog alerts.
  - `src/import.ts` — `import-v1` from `data/lifework.db`.
  - `src/doctor.ts` — config/channel/backlog self-check.
  - `src/cli.ts` — the contract (every capability is one `mira` command).
  - `src/skill.ts` — the canonical `SKILL.md` string, baked into the binary;
    `mira install <claude-code|codex>` writes it into the agent's skills dir.
- Add a capability once in `core.ts` (or the relevant core module), then expose
  it from `cli.ts`. The skill is guidance, not a second surface — it drives the
  same CLI, so a new command is reachable without touching `skill.ts` unless the
  workflow guidance itself changes.

## Conventions

- **Exactly-once delivery.** `delivery_log` has `UNIQUE(spec_id, occurrence_key)`.
  Each sweep does `INSERT OR IGNORE` then an atomic claim
  (`UPDATE … SET state='claimed' … RETURNING` inside `BEGIN IMMEDIATE`, WAL +
  busy_timeout). Delivered rows are never re-claimed; failures retry next sweep
  until `delivery.max_attempts`, then surface as backlog in `doctor`/`brief`.
- **Workspace** (default `~/.mira/workspace`) is resolved via, in order: the
  `--workspace` flag, `MIRA_WORKSPACE`, then the default. All brains + cron point
  at one workspace so the SQLite truth source is shared and exactly-once holds
  across them.
- **Migrations stay additive and ordered** in `db.ts`, guarded so re-runs are
  no-ops, with `PRAGMA user_version` as the schema baseline. Bumping the schema
  means updating the migration test.
- **Delivery modes** (`config set delivery.mode …`): `mira` (Mira sends), `agent`
  (Mira claims and emits payload as JSON, brain forwards and calls `deliver-ack`),
  `both`. Channel config lives only in the workspace DB, never in the agent.
- **Bun-only runtime.** Uses `bun:sqlite`; `npx`/`node` will not run it. The
  compiled single binary (`bun build --compile`) bakes everything in for cron.

## Common commands

```bash
bun install
bun test                    # idempotency, recurrence, modes, retry, migration
bun run typecheck           # tsc --noEmit
bun run src/cli.ts help     # CLI (the contract) — all commands print JSON
bun run src/cli.ts install claude-code   # write SKILL.md (or `install codex`; --user for global)
bun run compile             # -> ./mira single binary (bun run dist for all platforms)
```

## Documentation consistency rule

When behavior changes, update `README.md` and `AGENTS.md` (the shell-agent
command surface) in the same change when applicable. The agent skill
(`src/skill.ts`) defers to `mira help` for the command list, so it only needs
touching when the *workflow guidance* changes — but do update it then.
