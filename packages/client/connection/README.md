---
description: "Browser-host wire layer for the web GUI: Remote RPC, event-stream delivery with reconnect, exact Fetch routes, the /api HTTP bridge, and the browser-trust fence."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-connection

English | [中文](README.zh.md)

## Summary

The package carries browser-to-Host Remote calls, exact Fetch responses, and connection generations. The Client plugin mounts `ctx.connection` with current-page loopback state, a generic RPC carrier, the active generation and its Host facts, observable recovery state, an immediate reconnect command, and the registration point for one generation source. A generation becomes visible when its source reports ready; source completion, failure, withdrawal, or an explicit stop clears it before `ConnectionController` applies its retry policy.

## Table of Contents

- [Use this package](#use-this-package)
- [Request trust without browser authentication](#request-trust-without-browser-authentication)
- [Connection generation](#connection-generation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The browser uses HTTP POST for Remote unary calls. API Gateway owns the `/api/remote.mux` WebSocket and its logical streams; in-process compositions provide equivalent Remote streams through `connection.rpc.open` without opening a WebSocket. The Host half owns the sole `/api` route, Fetch bridge, Host/Origin checks, and exact `GET`/`HEAD` route registry. Typert Gateway claims generated Remote endpoints, feature packages register non-JSON responses such as Session-log downloads, and unclaimed requests return 404. Loopback hostname classification remains package-internal to the browser-facing Client state.

-----

<a id="request-trust-without-browser-authentication"></a>
## Request trust without browser authentication

This fork ships with browser-session authentication **disabled**: there is no launch token, no persistent cookie, and no 401 gate. `authenticatedUrl` returns the URL unchanged, `authorizeIndex` always admits the index, and every trusted request is served without a credential. `dsh-web-app` prints and opens the clean root URL directly; `frontend-static` serves root and index requests through `ctx.connection.authorizeIndex`, which is a no-op. Static assets and the index are public.

What remains is the request-trust fence in `src/api-request-trust.ts`, applied to every request before dispatch. Its `Host` must be loopback or match a `trustedHosts` entry: exact on `host:port`, any port on port-less entries, both sides WHATWG-normalized. An attached `Origin` must equal that Host and `sec-fetch-site: cross-site` is refused. Malformed configured authorities fail plugin load. These checks defend DNS rebinding and cross-site browser requests; they never establish identity. A failed Host/Origin check returns 403, and a trusted request is always served. `dsh web --host 0.0.0.0` is supported: bind all interfaces to serve the LAN, and the Host fence admits loopback plus the derived LAN literals and any `--trusted-host` entries. Decision record: [browser request trust](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md).

<a id="connection-generation"></a>
## Connection generation

API Gateway Client registers the internal `$events` logical stream as the sole generation source, independently of whether any `$on` listener exists. The Host attaches all incremental listeners in the API Remotes source factory, then sends one `{ type: 'ready', clientId, host: { home } }` item before events. `ConnectionController` publishes that generation and calls `onConnected` only after the ready item arrives, so baseline acquisition cannot race ahead of incremental observation.

An ended `$events` stream, a Remote stream error, a non-ready opening item, or a malformed event item invalidates the current generation. While the browser reports network availability, the controller publishes `connecting` and retries with 50%–100% jitter under caps of 500ms, 1s, 2s, 4s, 8s, and 10s. It logs each attempt, asks Gateway to replace the physical WebSocket, and reopens `$events`; failure in the 10s tier publishes terminal `disconnected`. `ctx.connection.reconnect()` interrupts active work, resets the sequence, and starts retry 1 immediately. Browser `offline` aborts active work, publishes `disconnected`, and suspends automatic attempts; the next `online` transition resets the sequence and starts at the 500ms tier. A ready item publishes `connected`. The Gateway mux performs one physical connection attempt per request rather than running an independent retry schedule. The [connection recovery decision](../../../.agents/notes/implemented/feature/2026-08-28-web-connection-recovery-control.md) owns the cadence and manual recovery behavior.

<a id="model-experience"></a>
## Model Experience

None, as the wire consumer layer moves already-composed messages between browser and host; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The `/api` bridge buffers each request body in memory** — `maxRequestBodyBytes` (default 300 MiB, sized for the default 200 MiB aggregate image limit after base64 expansion plus envelope headroom) is therefore also the per-request resident bound; a streaming body path would be needed to lower it without shrinking the image limits.
- **No browser authentication** — this fork serves every trusted request without a login gate; the Host/Origin fence is rebinding/cross-site defense, not identity, so a network-reachable (`0.0.0.0`) deployment should stay on a trusted network.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
