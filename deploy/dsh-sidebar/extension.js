'use strict';
// DeepSeek Harness Web — VS Code sidebar
//
// The dsh web harness authenticates every browser session with a per-process
// launch token: on each boot it prints
//     dsh web: http://127.0.0.1:3080/?token=<random> (LAN: ...)
// to its boot log. Visiting that URL once mints an authority-bound,
// HttpOnly, SameSite=Strict cookie.
//
// This extension discovers the CURRENT harness's token URL from the boot log
// and shows the GUI in the sidebar. It supports two origins:
//   * public  — https://dsh.993051.xyz/?token=...  (same-site with the
//               code.993051.xyz code-server top level, so Chrome permits the
//               Strict cookie; Caddy already whitelists framing and forwards
//               Host/Origin to the harness)
//   * loopback — http://127.0.0.1:3080/?token=... (desktop VS Code / direct)
//
// The webview's iframe performs the token -> Set-Cookie exchange itself by
// navigating to the token URL first; subsequent loads on the same origin send
// the cookie.

const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const DEFAULT_PUBLIC = 'https://dsh.993051.xyz';
const DEFAULT_PORT = 3080;
const TOKEN_RE = /(https?:\/\/[^\s"']+\/\?token=[A-Za-z0-9_-]+)/g;

/** Read a token URL straight from the dedicated token file, if present. */
function tokenFromFile(filePath) {
  if (!filePath) return null;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const m = /(https?:\/\/[^\s"']+\/\?token=[A-Za-z0-9_-]+)/.exec(text);
    return m ? m[1] : null;
  } catch { return null; }
}

function loopbackHost(u) {
  return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
}
/** Resolve the most recent token URL from a boot log for the given port. */
function tokenFromLog(logPath, port) {
  if (!logPath) return null;
  let text;
  try { text = fs.readFileSync(logPath, 'utf8'); } catch { return null; }
  let match; const hits = [];
  while ((match = TOKEN_RE.exec(text)) !== null) hits.push(match[1]);
  if (hits.length === 0) return null;
  // Filter to hits for the requested port, newest first; prefer a loopback
  // host (the native cookie authority) over the LAN literal on the same line.
  const scoped = [];
  for (let i = hits.length - 1; i >= 0; i--) {
    try {
      const u = new URL(hits[i]);
      const okPort = !port || u.port === String(port) || (u.port === '' && port === 80);
      if (!okPort) continue;
      scoped.push({ raw: hits[i], lb: loopbackHost(u) });
    } catch { /* ignore */ }
  }
  if (scoped.length) {
    const lb = scoped.find((x) => x.lb);
    return (lb || scoped[0]).raw;
  }
  // No hit for the requested port: fall back to the newest overall.
  return hits[hits.length - 1];
}
/**
 * Probe the public origin with a token. Tri-state so the caller can tell a
 * definitive rejection (401 — wrong token/process) from a network problem
 * (this server may not reach the public name even though the user's browser
 * can, via internal DNS).
 * @returns 'ok' | 'rejected' | 'unreachable'
 */
function probePublic(pubUrl, token) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(pubUrl); } catch { return resolve('unreachable'); }
    const mod = u.protocol === 'https:' ? require('https') : http;
    const port = u.port || (u.protocol === 'https:' ? 443 : 80);
    const tryOnce = (host) => {
      const req = mod.get({
        hostname: host, port,
        path: '/?token=' + encodeURIComponent(token),
        headers: { 'User-Agent': 'dsh-sidebar/1.1', Host: u.host },
      }, (res) => {
        res.resume();
        res.on('end', () => {
          if (res.statusCode === 303 || res.statusCode === 200) resolve('ok');
          else if (res.statusCode === 401) resolve('rejected');
          else resolve('unreachable');
        });
      });
      req.on('error', () => resolve('unreachable'));
      req.setTimeout(6000, () => { req.destroy(); resolve('unreachable'); });
    };
    tryOnce(u.hostname);
  });
}

/** Probe whether a loopback token URL actually mints (303) right now. */
function probeToken(port, token) {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/?token=' + encodeURIComponent(token),
      headers: { 'User-Agent': 'dsh-sidebar/1.1' },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 303 || res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
  });
}

/**
 * Find the token that actually authenticates right now.
 * Order: configured token file > primary log > alt log; probe each candidate
 * against its loopback port and return the first that mints.
 */
async function findLiveToken(cfg, preferPort) {
  const primaryLog = cfg.get('dsh.bootLog') || path.join(DSH_HOME, 'web.log');
  const altLog = cfg.get('dsh.oldBootLog') || path.join(DSH_HOME, 'old-3082.log');
  const tokenFile = cfg.get('dsh.tokenFile') || path.join(DSH_HOME, 'current-token.txt');
  const port = Number(cfg.get('dsh.loopbackPort') || DEFAULT_PORT);
  // Gather unique candidate URLs from every source, newest first, and the
  // ports they might serve on (their own + the configured one).
  const seen = new Set();
  const candidates = [];
  const push = (url, hintPort) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, hintPort });
  };
  push(tokenFromFile(tokenFile), port);
  push(tokenFromLog(primaryLog, port), port);
  push(tokenFromLog(primaryLog, null), port);
  push(tokenFromLog(altLog, null), null);
  // Probe each candidate on its own port, then on the configured/preferred one.
  // Candidates on the preferred port are tried first so a public target (which
  // fronts the preferred port) gets a token that will actually be accepted.
  const order = [];
  for (const c of candidates) {
    const u = new URL(c.url);
    const own = Number(u.port || DEFAULT_PORT);
    if (preferPort && own === preferPort) order.unshift(c);
    else order.push(c);
  }
  for (const c of order) {
    const u = new URL(c.url);
    const tk = u.searchParams.get('token');
    if (!tk) continue;
    const own = Number(u.port || DEFAULT_PORT);
    for (const p of [own, c.hintPort].filter((x, i, a) => x && a.indexOf(x) === i)) {
      if (await probeToken(p, tk)) return { url: c.url, port: p, token: tk };
    }
  }
  // None mints; still surface the newest candidate so the panel shows
  // something (it will display the app's own auth page).
  for (const c of candidates) {
    if (c.url) {
      const u = new URL(c.url);
      return { url: c.url, port: Number(u.port || DEFAULT_PORT), token: u.searchParams.get('token') };
    }
  }
  return null;
}


/** Detect whether this VS Code session is the code.993051.xyz web client. */
function isWebCodeServer() {
  const a = (vscode.env.appName || '').toLowerCase();
  // code-server names itself "code-server"; VS Code for Web reports
  // "vscode-web". Treat remote web UIs conservatively as same-site public so
  // the cookie works; desktop builds fall back to loopback.
  const remote = vscode.env.remoteName || '';
  return a.includes('code-server') || a.includes('vscode-web') || remote === 'codeserver';
}

function html(state) {
  const modeName = state.public ? 'public' : 'loopback';
  const status = state.url
    ? '<span style="color:#89d185">● ' + modeName + '</span>'
    : '<span style="color:#f14c4c">● off</span>';
  const offCard = state.whyPublic
    ? '<p><b>DeepSeek Harness (public) isn\'t accepting the running token.</b></p>'
      + '<p style="font-size:12px;max-width:360px">The public URL fronts the NEW harness on :3080. '
      + 'Restart it so the sidebar can use its fresh token: <code>dshkill-new && dshstart</code>, then press <b>⟳</b>.</p>'
      + '<p style="font-size:11px;color:#888">You can also switch <code>dsh.serverMode</code> to <code>loopback</code> '
      + 'if your VS Code runs on the same machine as the harness.</p>'
    : '<p><b>DeepSeek Harness isn\'t reachable.</b></p>'
      + '<p style="font-size:12px;max-width:340px">Start it with <code>dshstart</code> (NEW :3080) or '
      + '<code>dshstart-old</code> (:3082), then press <b>⟳</b>. The sidebar discovers the per-boot token '
      + 'automatically (token file or boot log).</p>';
  const csp =
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; " +
    "frame-src https://dsh.993051.xyz http://127.0.0.1:* http://localhost:*; " +
    "connect-src https://dsh.993051.xyz http://127.0.0.1:* http://localhost:*; " +
    "script-src 'unsafe-inline'";
  return `<!DOCTYPE html>
<html lang="en" style="width:100%;height:100%;margin:0">
<head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html,body{width:100%;height:100%;margin:0;padding:0;overflow:hidden;background:#1e1e1e;font-family:var(--vscode-font-family,system-ui);}
  #bar{display:flex;align-items:center;gap:8px;padding:3px 10px;font-size:11px;color:var(--vscode-descriptionForeground,#bbb);border-bottom:1px solid #2a2a2a;box-sizing:border-box;height:30px;}
  #bar .grow{flex:1}
  #bar a{color:#4daafc;text-decoration:none}
  #wrap{position:absolute;top:30px;left:0;right:0;bottom:0}
  iframe{width:100%;height:100%;border:0;display:block}
  #off{position:absolute;top:30px;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;box-sizing:border-box}
  #off code{background:#2a2a2a;padding:1px 5px;border-radius:3px}
</style></head>
<body>
  <div id="bar"><span>DSH</span> <span id="status">${status}</span><div class="grow"></div>
    <a href="#" id="reload">⟳</a> <a href="#" id="copy">copy</a> <a href="#" id="ext">browser</a>
  </div>
  <div id="wrap"></div>
  <div id="off" style="display:none">
    <div>${offCard}</div>
  </div>
<script>
(function(){
  const vscode=acquireVsCodeApi();
  const wrap=document.getElementById('wrap'), off=document.getElementById('off');
  function render(m){
    const url=m&&m.url;
    off.style.display=url?'none':'flex';
    if(url){ wrap.innerHTML=''; const f=document.createElement('iframe');
      f.src=url; f.setAttribute('allow','clipboard-read; clipboard-write'); wrap.appendChild(f);
      document.getElementById('status').innerHTML='<span style="color:#89d185">● '+(m.public?'public':'loopback')+'</span>';
    }
  }
  document.getElementById('reload').onclick=e=>{e.preventDefault();vscode.postMessage({type:'reload'})};
  document.getElementById('copy').onclick=e=>{e.preventDefault();vscode.postMessage({type:'copy'})};
  document.getElementById('ext').onclick=e=>{e.preventDefault();vscode.postMessage({type:'external'})};
  window.addEventListener('message',e=>{if(e.data&&e.data.type==='state')render(e.data)});
  vscode.postMessage({type:'ready'});
})();
</script>
</body></html>`;
}

function activate(context) {
  let current = null; // { url, public, tokenUrl }
  let views = new Set();

  async function refreshView(view) {
    const cfg = vscode.workspace.getConfiguration('dsh');
    const mode = cfg.get('dsh.serverMode') || 'auto';
    const pub = cfg.get('dsh.publicUrl') || DEFAULT_PUBLIC;
    const lbPort = Number(cfg.get('dsh.loopbackPort') || DEFAULT_PORT);
    const web = isWebCodeServer();
    // Discover a loopback token that mints right now (extension host is on the
    // same server as the harness in code-server).
    const live = await findLiveToken(cfg, lbPort);

    // Decide the URL to show.
    let target;
    if (mode === 'loopback' || (!web && mode !== 'public')) {
      // Loopback family: extension host AND webview are both local/forwarded.
      target = live ? {
        url: 'http://127.0.0.1:' + live.port + '/?token=' + encodeURIComponent(live.token),
        tokenUrl: live.url, public: false, port: live.port, pub,
      } : { url: null, tokenUrl: null, public: false, port: lbPort, pub };
    } else {
      // Public family (web client, or forced 'public'): the iframe renders in
      // the user's browser and must use the public origin, which Caddy fronts
      // to the loopbackPort harness only. Only a token minting on that exact
      // port can authenticate through the public route.
      if (live && live.port === lbPort) {
        const verdict = await probePublic(pub, live.token);
        if (verdict === 'ok' || verdict === 'unreachable') {
          // 'unreachable' from the extension host (DNS hairpin) is not a
          // rejection; the user's browser may still reach the public origin.
          target = { url: pub + '/?token=' + encodeURIComponent(live.token), tokenUrl: live.url, public: true, port: live.port, pub };
        } else {
          target = { url: null, tokenUrl: null, public: true, port: lbPort, pub, whyPublic: true };
        }
      } else {
        // Either no token anywhere, or the only live harness is on another
        // port (e.g. OLD :3082) that the public Caddy route does not front.
        target = { url: null, tokenUrl: null, public: true, port: lbPort, pub, whyPublic: true };
      }
    }
    current = target;
    view.webview.html = html(target);
    void view.webview.postMessage({ type: 'state', ...target });
  }

  const provider = {
    resolveWebviewView(webviewView) {
      webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
      views.add(webviewView);
      webviewView.webview.onDidReceiveMessage((msg) => {
        if (msg.type === 'ready' || msg.type === 'reload') refreshView(webviewView);
        else if (msg.type === 'copy') {
          const url = current && current.url ? current.url
            : (vscode.workspace.getConfiguration('dsh').get('dsh.publicUrl') || DEFAULT_PUBLIC);
          if (url) void vscode.env.clipboard.writeText(url);
        } else if (msg.type === 'external') {
          const url = current && current.url ? current.url
            : (vscode.workspace.getConfiguration('dsh').get('dsh.publicUrl') || DEFAULT_PUBLIC);
          if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
        }
      });
      webviewView.onDidDispose(() => views.delete(webviewView));
    },
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('dsh-web-view', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('dsh.reload', () => {
      for (const v of views) refreshView(v);
    }),
    vscode.commands.registerCommand('dsh.openInBrowser', () => {
      const url = current && current.url
        ? current.url
        : (vscode.workspace.getConfiguration('dsh').get('dsh.publicUrl') || DEFAULT_PUBLIC);
      void vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand('dsh.copyUrl', () => {
      if (current && current.url) void vscode.env.clipboard.writeText(current.url);
    }),
    // Refresh when the user changes settings (e.g. mode/port/log).
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dsh')) {
        for (const v of views) refreshView(v);
      }
    }),
    // Periodic refresh: a freshly booted harness prints a new token, so re-read
    // the token file/log and keep the panel live without a manual click.
    (() => {
      const t = setInterval(() => { for (const v of views) refreshView(v); }, 15000);
      return { dispose: () => clearInterval(t) };
    })(),
  );
}

exports.activate = activate;
exports.deactivate = function () {};
