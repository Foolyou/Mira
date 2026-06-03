# Mira — command surface for shell agents (Codex)

Mira is a daemonless personal operating copilot. The CLI is the contract: every
capability is reachable as `mira <command>`. You (a shell agent) drive it the
same way cron and Claude Code do, against the **same shared workspace** so
nothing drifts.

Default workspace resolution is project-local: `<current-working-directory>/.mira/workspace`.
When a skill or cron entry has a known workspace, always pass that explicit
`--workspace <dir>` (or rely on `MIRA_WORKSPACE`) so you read/write the one true
SQLite file. `mira install ... --user` uses `~/.mira/workspace`.

## Capture & tasks
```
mira task add "<title>" --area family|client|work|personal --priority high|medium|low \
  --due-at "YYYY-MM-DD HH:MM" --due-text "人话标签" --company <id> --project <id>
mira task list [--status todo --area family]
mira task done <id>
mira capture "<随手记>"
```

## Reminders (the whole point — never let one fail silently)
```
mira reminder add --task <id> --at "YYYY-MM-DD HH:MM"          # one-time
mira recur add "<title>" --pattern-type monthly --pattern-config '{"day":26}' --remind-time 09:00
#   pattern-type: daily | weekly | monthly | yearly_dates | yearly_weeks
#   weekly  {"weekdays":[0]}  (0=Mon)   monthly {"day":26}|{"day":"last"}
#   yearly_dates {"dates":["03-15"]}    yearly_weeks {"weeks":[14,15,16]}
```

## Delivery loop
```
mira sweep --dry-run                 # see what's due, deliver nothing
mira sweep                           # fire due reminders (cron also does this every 5 min)
mira deliver-ack <log_id> --channel email --by codex   # B2: confirm YOU delivered it
mira brief [--weekly] [--send]
mira send-test [--channel email]     # actually deliver a test message (real send, not a config check)
mira mail send --subject "主题" --html-file /tmp/msg.html --text-file /tmp/msg.txt
```
If `delivery.mode=agent`, `mira sweep` prints claimed payloads as JSON and waits
for your `deliver-ack`. Read the `payloads[].log_id` and ack each after sending.
Use `mail send` for Agent-authored rich-text email; it sends to the configured
`channel.email.to` recipient and keeps SMTP secrets inside Mira.

## Read models
```
mira dashboard | mira timeline --days 14 | mira search "<q>"
mira context --company <id> | mira meeting-prep --company <id> | mira counts
mira company list | mira project list [--company <id>] | mira note list [--company <id>]
```

## Health
```
mira doctor [--check-channel]        # config / channel / delivery backlog (login only, no send)
```

All commands print JSON. Don't edit the SQLite file directly — go through `mira`.

Secrets: `channel.*` config can store a credential as `file:<path>` or
`env:<VAR>` instead of a literal; it is resolved in-process at send-time. `config
get`/`set`/`list` redact literal secret fields as `***` (references stay
visible), so reading config never surfaces the value.
