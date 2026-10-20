---
description: "Per-user session scoping for shared harness deployments: maps a reverse-proxy identity to the directories it owns, so one office can share one harness without sharing a session list."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-scope

English | [中文](README.zh.md)

## Summary

One office, one harness, several people. Without this plugin every user sees every workspace and every session in the sidebar; with it, a user sees only the workspaces and sessions beneath the root they own, an administrator sees everything, and a first-time user is handed a working directory of their own. Ownership is a path prefix, identity arrives in a header a reverse proxy injects, and enforcement rides on the Peer each request was admitted as. This is a **decluttering and privacy-between-colleagues** feature, not a security boundary — [What this is not](#what-this-is-not) says why.

## Table of Contents

- [The model](#the-model)
- [How identity reaches enforcement](#how-identity-reaches-enforcement)
- [Enforcement points](#enforcement-points)
- [Provisioning](#provisioning)
- [Configuration](#configuration)
- [Skills stay shared](#skills-stay-shared)
- [What this is not](#what-this-is-not)
- [Dev Note](#dev-note)

-----

<a id="the-model"></a>
## The model

Ownership is a **path prefix**, not a fixed directory. A deployment declares a root per identity, and a session or workspace belongs to whoever's root contains its `cwd`:

```
/root/punit              → punit@rubysteels.com
/root/punit/site-survey  → punit@rubysteels.com   (a second workspace, same owner)
/root/ruby               → the administrator
```

So one user owns as many workspaces as they like, anywhere beneath their root. Adding a workspace needs no new configuration: creating a directory under your own root is the whole gesture.

The prefix test is separator-aware, so `/root/punit2` does **not** belong to the owner of `/root/punit`, and `..` is resolved before the comparison, so a crafted `cwd` cannot climb out of its root. Both cases are covered in `tests/policy.spec.ts`.

<a id="how-identity-reaches-enforcement"></a>
## How identity reaches enforcement

The identity already arrives. Caddy's `forward_auth` runs `copy_headers X-Auth-Request-User X-Auth-Request-Email`, so every request that reaches the harness carries the authenticated address. Nothing in the harness read it before this plugin.

The mechanism is deliberately chosen to need **no new plumbing**:

1. `HostConnectionService.admit()` is the single point every request passes — HTTP RPC, exact Fetch routes, and the WebSocket mux upgrade all call it.
2. This plugin implements Connection's `RequestIdentityResolver` and installs it with `connection.setIdentityResolver(this)`. From then on `admit()` reads the header and returns a **distinct Peer per identity** instead of the shared browser Peer.
3. Every Remote call already carries its Peer as `this.ctx.invocation.peer`, and every stream carries the Peer it was admitted as. Streams outlive any request-scoped context, which is why identity rides on the Peer rather than in an `AsyncLocalStorage`.
4. Enforcement asks `ctx.sessionScope.scopeOfPeer(this.ctx.invocation.peer)`.

`PeerScope` still records nothing about who the Peer is — the plugin keeps the Peer-to-identity map itself, which is what the protocol's own documentation asks for.

<a id="enforcement-points"></a>
## Enforcement points

The list path is not the only way to reach a session; roughly a dozen RPCs take a raw session id and bypass any list filter. All of them are in scope:

| Surface | Where |
|---|---|
| Session list | `packages/api/session-controller/src/list.ts` (`ApiSessionList.list`) |
| Content search | `packages/api/session-controller/src/list.ts` (`search`) |
| Workspace list and `follow` | `packages/workspace/workspace` (registry `list`, header index) |
| Session page / follow / rename / fork / prompt / attachments | `packages/api/session-controller/src/{history,commands}.ts` |
| Goals | `packages/goal/goal` (`goals.*` take a raw session id) |
| Schedules | `packages/schedule/schedule` — `catalog` enumerates **every** session's reminders |
| Session export | `GET /api/session.export` |
| Composer drafts | `packages/api/session-controller/src/composer-draft.ts` |
| Workspace create / archive / pin | `packages/api/workspace-controller` |

Two clamps are load-bearing rather than cosmetic:

- `session.create` accepts an arbitrary `cwd`, so a user could otherwise point a session at someone else's directory and read it through their own agent.
- `workspace.create` accepts an arbitrary path, with the same consequence.

<a id="provisioning"></a>
## Provisioning

With `provisionRoot` set, an identity that has no `users` entry is minted a root at `<provisionRoot>/<slug>`, where the slug is the local part of the address with everything outside `[a-z0-9._-]` collapsed. The slug can never be `.`, `..`, or a dotfile. The root counts as owned immediately — before it exists on disk — so a first-time user can create their first workspace without a second round trip.

<a id="configuration"></a>
## Configuration

Off by default. Loaded with no `admin`, no `users` and no `provisionRoot`, the plugin constrains nobody and the harness behaves exactly as it does without it.

The plugin has no settings namespace, so it is configured on the plugin entry itself — in a bundle's patch list, or inserted from the profile's patch layer:

```yaml
- insert:
    - id: session-scope
      name: '@deepseek-ai/dsh-session-scope'
      config:
        header: x-auth-request-email
        admin: ['main.pastrami903@passfwd.com']
        users:
          punit@rubysteels.com: /root/punit
          Sunn@rubysteels.com: /root/sunny
          Aji@rubysteels.com: /root/ajit
        provisionRoot: /root
        requireIdentity: true
```

`requireIdentity: true` is what makes the header trustworthy. The server binds `0.0.0.0`, and a LAN literal is auto-admitted by the `/api` fence, so without it anyone who can reach port 3080 could forge the header. The proxy must also strip client-supplied copies before `forward_auth` re-injects them — the `request_header -X-Auth-Request-Email` lines the office Caddyfile already uses for the wg-easy route.

<a id="skills-stay-shared"></a>
## Skills stay shared

Skills live under `$DSH_HOME/skills`, outside every user root, and are not scoped. Everyone sees the same skill catalog. The same is true of the model catalog, the plugin list, and the settings document.

<a id="what-this-is-not"></a>
## What this is not

Sessions run as **root**, in one process, on one filesystem, with a shell tool. A user who wants to read another user's transcript can ask their own agent to read it. Session logs are mode 600, but every session is the same root.

So this stops people *stumbling into* each other's chats. It does not stop anyone who goes looking. For ten trusted colleagues who want a quiet sidebar, that is the right trade. Real isolation needs a harness instance per person — separate `$DSH_HOME`, separate OS user, separate port, routed by the same identity header — which is a deployment change, not a code change, and composes with this plugin rather than replacing it.

<a id="dev-note"></a>
## Dev Note

`tests/policy.spec.ts` covers the prefix, sibling-prefix and `..` cases. `tests/service.spec.ts` covers peer-to-identity mapping, provisioning, visibility and refusal.

Identity attribution lives in `packages/client/connection`: `RequestIdentityResolver` is the policy contract and `HostConnectionService.setIdentityResolver` installs it, minting one Peer per identity and disposing them with the service. The plugin itself owns only the Peer-to-identity map and the policy tables.
