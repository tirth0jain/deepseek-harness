# dsh web auto-start + VS Code sidebar

Replicates this deployment's harness web setup on another server (your work
office LXC), with the one thing that box is missing: **auto-start**.

## What was and wasn't there

On the reference box the sidebar extension only *discovers* the harness — it
reads `/root/.dsh/current-token.txt`, falls back to scraping the boot log for
the `?token=` line, probes each candidate, and renders the winner in an iframe.
It never starts anything. The harness itself was started by hand:

```
alias dshstart='/usr/local/bin/dsh-web-launch 3080 ~/.dsh/web.log <bin.js> >/dev/null 2>&1 &'
```

`dsh-web-launch` cannot be used under systemd: it `setsid`-backgrounds the
harness and exits as soon as the token is written, so systemd sees the service
stop immediately. This bundle therefore splits the two jobs.

## Contents

| file | role |
|---|---|
| `dsh-web.service` | systemd unit: starts the harness on boot, restarts on failure |
| `dsh-web-run` | foreground runner the unit calls; builds flags from `.env` |
| `dsh-token-writer` | `ExecStartPost`: records the boot token URL for the sidebar |
| `install-dsh-web.sh` | idempotent installer for all of the above + the extension |
| `dsh-sidebar/` | the VS Code extension (`custom.dsh-native-sidebar-1.1.0`) |

The extension is self-contained — `vscode` plus Node builtins only — so it
copies as-is.

## Install

```bash
# on the work server, from this directory
./install-dsh-web.sh                          # sidebar uses loopback :3080
./install-dsh-web.sh http://10.0.0.5:3080     # sidebar uses a reachable origin
```

Then:

```bash
vi /root/.dsh/.env            # API keys + WEBGUI_TRUSTED_HOSTS
systemctl start dsh-web
systemctl status dsh-web --no-pager
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/   # want 200
```

Reload the VS Code window afterwards so the new extension is picked up.

## The one thing to get right: the sidebar origin

The sidebar renders the GUI in an **iframe inside your browser**. So
`http://127.0.0.1:3080` means *your* machine, not the server.

- **VS Code desktop with port forwarding** → loopback works; run the installer
  with no argument.
- **Remote code-server in a browser** → pass the server's LAN IP or its proxy
  URL, and add that host to `WEBGUI_TRUSTED_HOSTS` in `/root/.dsh/.env`. An
  undeclared authority gets a read-only settings page and `403` on every
  `/api` request.

The reference box solves this with a public URL that is same-site with the
code-server host, so the auth cookie is shared. If you front the work server
with a reverse proxy, give dsh its own hostname there and pass that.

## Sizing

`DSH_WEB_HEAP_MB` in the unit (default 6144) bounds the **JS heap only** —
RSS runs above it. Leave headroom under the container limit: on the reference
box, RSS sat at 4.31 GB against a 4096 MB ceiling, and raising the ceiling
does not remove the growth, it only moves where the process dies (a visible
V8 abort becomes a silent kernel OOM kill). Tune it to the work server's RAM.

## Verify the auto-start actually survives

```bash
systemctl restart dsh-web && sleep 20 && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/
cat /root/.dsh/current-token.txt      # the sidebar's target
```
