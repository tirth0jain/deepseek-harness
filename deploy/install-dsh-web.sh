#!/usr/bin/env bash
# install-dsh-web.sh — install dsh web auto-start + the VS Code sidebar on a server.
#
# Idempotent: safe to re-run after pulling a new harness build. It installs the
# systemd unit that starts the harness on boot and restarts it on failure, the
# launcher pair the unit calls, and the sidebar extension that auto-discovers
# the harness token.
#
# Usage:
#   ./install-dsh-web.sh                       # sidebar uses loopback :3080
#   ./install-dsh-web.sh http://10.0.0.5:3080  # sidebar uses a reachable origin
#
# The origin matters: the sidebar renders the GUI in an iframe inside YOUR
# browser. 'http://127.0.0.1:3080' is only correct if the browser can reach the
# server's loopback (VS Code desktop with port forwarding). Browsing a remote
# code-server means 127.0.0.1 is your own laptop -- pass the server's LAN IP or
# its proxy URL instead, and add that host to WEBGUI_TRUSTED_HOSTS in
# /root/.dsh/.env so the harness accepts it.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
SIDEBAR_URL="${1:-}"
EXT_ID="custom.dsh-native-sidebar-1.1.0"
DSH_HOME="${DSH_HOME:-/root/.dsh}"

say() { printf '%s\n' "==> $*"; }

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

# ── 1. launcher pair ──────────────────────────────────────────────────────
say "installing launchers to /usr/local/bin"
install -m 0755 "$SRC/dsh-web-run" /usr/local/bin/dsh-web-run
install -m 0755 "$SRC/dsh-token-writer" /usr/local/bin/dsh-token-writer

# ── 2. systemd unit ───────────────────────────────────────────────────────
say "installing systemd unit"
install -m 0644 "$SRC/dsh-web.service" /etc/systemd/system/dsh-web.service
mkdir -p "$DSH_HOME"
systemctl daemon-reload
systemctl enable dsh-web.service >/dev/null
say "unit enabled — start it with: systemctl start dsh-web"

# ── 3. .env template ──────────────────────────────────────────────────────
if [ ! -f "$DSH_HOME/.env" ]; then
  say "writing $DSH_HOME/.env template (fill in your keys)"
  cat > "$DSH_HOME/.env" <<'EOF'
# Provider keys the harness reads. Use the work server's own credentials.
COMMANDCODE_API_KEY=
OPENCODE_GO_API_KEY=
BRIGHTDATA_API_TOKEN=

# --- dsh web deployment knobs (read by dsh-web-run; DSH_* names are refused
# by the harness's own boot .env loader) ---
# Extra /api fence authorities: the names browsers actually use. An undeclared
# authority gets a read-only settings page and 403 on every /api request.
WEBGUI_TRUSTED_HOSTS=
# 0 disables the launch-token handshake when something upstream (a reverse
# proxy with its own auth) already gates every visitor.
WEBGUI_BROWSER_AUTH=0
EOF
  chmod 600 "$DSH_HOME/.env"
else
  say "$DSH_HOME/.env already exists — left untouched"
fi

# ── 4. sidebar extension ──────────────────────────────────────────────────
EXT_ROOT=""
for candidate in /root/.vscode-server/extensions /root/.vscode/extensions \
                 /root/.local/share/code-server/extensions; do
  [ -d "$candidate" ] && { EXT_ROOT="$candidate"; break; }
done
if [ -z "$EXT_ROOT" ]; then
  EXT_ROOT=/root/.vscode-server/extensions
  say "no existing extensions dir found — creating $EXT_ROOT"
fi
mkdir -p "$EXT_ROOT"
rm -rf "${EXT_ROOT:?}/$EXT_ID"
cp -r "$SRC/dsh-sidebar" "$EXT_ROOT/$EXT_ID"
say "extension installed to $EXT_ROOT/$EXT_ID"

# ── 5. extension settings ─────────────────────────────────────────────────
DATA_ROOT="$(dirname "$EXT_ROOT")/data"
SETTINGS="$DATA_ROOT/Machine/settings.json"
mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"

node -e '
const fs = require("fs");
const [file, url] = process.argv.slice(1);
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
cfg["dsh.loopbackPort"] = 3080;
cfg["dsh.bootLog"] = "/root/.dsh/web.log";
cfg["dsh.tokenFile"] = "/root/.dsh/current-token.txt";
if (url) { cfg["dsh.serverMode"] = "public"; cfg["dsh.publicUrl"] = url; }
else { cfg["dsh.serverMode"] = "auto"; delete cfg["dsh.publicUrl"]; }
fs.writeFileSync(file, JSON.stringify(cfg, null, 4) + "\n");
console.log("==> sidebar settings written to " + file);
' "$SETTINGS" "$SIDEBAR_URL"

# ── 6. shell aliases ──────────────────────────────────────────────────────
if ! grep -q 'dsh-web.service' /root/.bashrc 2>/dev/null; then
  say "adding shell aliases to /root/.bashrc"
  cat >> /root/.bashrc <<'EOF'

# --- dsh web (systemd-managed) ---
alias dshstart='systemctl start dsh-web'
alias dshstop='systemctl stop dsh-web'
alias dshrestart='systemctl restart dsh-web'
alias dshstatus='systemctl status dsh-web --no-pager'
alias dshlogs='journalctl -u dsh-web -f --no-pager'
alias dshurl='cat /root/.dsh/current-token.txt'
EOF
else
  say "shell aliases already present — skipped"
fi

say "done."
echo
echo "Next:"
echo "  1. Edit $DSH_HOME/.env — set your API keys and WEBGUI_TRUSTED_HOSTS."
echo "  2. systemctl start dsh-web && systemctl status dsh-web --no-pager"
echo "  3. curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3080/   # want 200"
echo "  4. Reload the VS Code window so it picks up the new extension."
