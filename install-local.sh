#!/bin/sh
# Mira local installer — builds the self-contained binary from THIS checkout and
# drops it in ~/.mira/bin. Use this when installing from source (development or
# an unreleased tree); for a published GitHub Release binary use install.sh.
#
#   ./install-local.sh
#
# Override:  MIRA_BIN_DIR=~/.local/bin  ./install-local.sh
set -eu

SRC_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BIN_DIR="${MIRA_BIN_DIR:-$HOME/.mira/bin}"

command -v bun >/dev/null 2>&1 || {
  echo "bun is required to build Mira (https://bun.sh) — not found on PATH" >&2
  exit 1
}

cd "$SRC_DIR"
echo "↻ installing deps…"
bun install --frozen-lockfile

echo "↻ compiling self-contained binary…"
bun build --compile src/cli.ts --outfile "$SRC_DIR/mira"

mkdir -p "$BIN_DIR"
cp "$SRC_DIR/mira" "$BIN_DIR/mira"
chmod +x "$BIN_DIR/mira"

echo "✓ installed: $BIN_DIR/mira"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "  add to PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

cat <<EOF

Next (run these from the directory where you want ./.mira to live):
  $BIN_DIR/mira init --agent claude-code --agent codex # init ./.mira + project skills
  $BIN_DIR/mira doctor
  $BIN_DIR/mira import-v1 --from /path/to/lifework.db   # bring v1 data over
  $BIN_DIR/mira install claude-code --user               # optional global skill
  $BIN_DIR/mira install codex       --user               # optional global skill
  $BIN_DIR/mira install cron | crontab -                  # generated lines cd back here

Email delivery (iCloud):
  $BIN_DIR/mira config set delivery.default_channel email
  $BIN_DIR/mira config set channel.email '{"smtp_host":"smtp.mail.me.com","smtp_port":587,"user":"you@icloud.com","app_password":"xxxx-xxxx-xxxx-xxxx","to":"you@icloud.com"}'
  $BIN_DIR/mira doctor --check-channel
EOF
