#!/bin/sh
# Mira installer — fetches the right self-contained binary, drops it in
# ~/.mira/bin, and prints how to wire it into Claude Code / Codex / cron.
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/mira/main/install.sh | sh
#
# Override the source:  MIRA_REPO=owner/mira  MIRA_VERSION=v2.0.0  sh install.sh
set -eu

REPO="${MIRA_REPO:-chenan/mira}"
VERSION="${MIRA_VERSION:-latest}"
BIN_DIR="${MIRA_BIN_DIR:-$HOME/.mira/bin}"

os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Linux)  o="linux" ;;
  Darwin) o="darwin" ;;
  *) echo "unsupported OS: $os" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) a="x64" ;;
  arm64|aarch64) a="arm64" ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac
asset="mira-${o}-${a}"

if [ "$VERSION" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
else
  url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
fi

mkdir -p "$BIN_DIR"
echo "↓ $url"
curl -fSL "$url" -o "$BIN_DIR/mira"
chmod +x "$BIN_DIR/mira"

echo "✓ installed: $BIN_DIR/mira"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "  add to PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

cat <<EOF

Next (run these from the directory where you want ./.mira to live):
  mira init --agent claude-code --agent codex   # init ./.mira + project skills
  mira doctor
  mira import-v1 --from /path/to/lifework.db      # bring v1 data over
  mira install claude-code --user                  # optional global skill
  mira install codex       --user                  # optional global skill
  mira install cron | crontab -                    # generated lines cd back here

Email delivery (iCloud):
  mira config set delivery.default_channel email
  mira config set channel.email '{"smtp_host":"smtp.mail.me.com","smtp_port":587,"user":"you@icloud.com","app_password":"xxxx-xxxx-xxxx-xxxx","to":"you@icloud.com"}'
  mira doctor --check-channel
EOF
