# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

<a id="fork-additions"></a>

## Fork additions

This repository is a fork of DeepSeek Harness: everything upstream ships, plus the additions below. Each one is documented with its rationale, the commit that introduced it, and its known limits in [CHANGES-AND-FEATURES.md](CHANGES-AND-FEATURES.md); this section is the quick reference for using them.

Jump to: [Access and deployment](#access-and-deployment) · [Models and catalogs](#models-and-catalogs) · [Cost and usage](#cost-and-usage) · [Chat](#chat) · [Sessions and memory](#sessions-and-memory) · [Multi-user scoping](#multi-user-scoping) · [Web search](#web-search)

### At a glance

| Feature | What you get | Turn it on |
| --- | --- | --- |
| [LAN binding](#lan-binding) | `--host 0.0.0.0` is accepted, and the LAN addresses it exposes are derived for the trust fence | `dsh web --host 0.0.0.0` |
| [Declared trusted hosts](#trusted-hosts) | Browse through a name the fence does not derive, and edit settings from that page | `--trusted-host dsh.example.com` |
| [Tokenless mode](#tokenless-mode) | No launch-token handshake when something else already authenticates | `--no-browser-auth` |
| [Deployment bundle](#deployment-bundle) | systemd auto-start, a token writer, an installer, and a one-step rebuild-and-restart script | `deploy/install-dsh-web.sh`, `deploy/rebuild-dsh-web.sh` |
| [Catalog auto-refresh](#catalog-refresh) | A gateway's `GET /models` listing is re-read on every page load; retired models drop out | `autoRefresh: true` |
| [models.dev enrichment](#models-dev-enrichment) | Context windows, modalities and rates filled in for gateways that publish none | `enrichFrom: models.dev` |
| [Model exclusions](#model-exclusions) | A model is refused in both directions, so a route can hand it to another API | `excludeModels: [id]` |
| [Per-conversation session header](#per-conversation-session-header) | The real session id is sent under a gateway's own header name | `sessionHeader: x-opencode-session` |
| [Reasoning-content compatibility](#reasoning-content-compatibility) | DeepSeek thinking turns echoed back through a gateway that is not named DeepSeek | `compat: { requiresReasoningContentOnAssistantMessages: true }` |
| [Published rates and estimated spend](#published-rates-and-estimated-spend) | Per-model list prices, peak bands priced per attempt, amounts on the pill and in the inspectors | `cost:` on a model, or `llm.cost` |
| [Per-turn throughput](#per-turn-throughput) | `tok/s` for each Turn beside its run time, surviving a reload | nothing — always on |
| [Turn loading control](#turn-loading-control) | Page a long transcript back one whole Turn at a time | nothing — appears when a window is partial |
| [File downloads](#file-downloads) | Save uploaded and delivered files, not just look at them | `?download=1`, `/api/attachment.download` |
| [Durable composer drafts](#durable-composer-drafts) | A typed prompt survives a restart, and a failed send is never lost | nothing — automatic |
| [Continue in a new chat](#continue-in-a-new-chat) | Condense a large Session into a fresh one and archive the source | session row menu |
| [Continuations that are real sessions](#continuations-that-are-real-sessions) | A continuation is listed, searchable, and durable from the moment it exists | nothing — automatic |
| [Archiving releases memory](#archiving-releases-memory) | Archive a Session and get its Agent, graph and log back without a restart | session row menu → Archive |
| [Bounded session memory](#bounded-session-memory) | Windowed reads, a byte budget for the cold-log memo, a bounded observation cache | profile patch (see below) |
| [Multi-user session scoping](#multi-user-session-scoping) | One harness, one session list per identity, enforced by owned directories | `@deepseek-ai/dsh-session-scope` |
| [Identity admission](#identity-admission) | Each admitted identity is its own Peer, so streams stay attributed | `setIdentityResolver` |
| [Bright Data web search](#bright-data-web-search) | Web search through a Web Unlocker zone, spending Bright Data's free shared pool | `searchProvider: brightdata` |

<a id="access-and-deployment"></a>

### Access and deployment

<a id="lan-binding"></a>

#### LAN binding

Upstream refuses to bind all interfaces; this fork removes that refusal, so the harness can serve a LAN or sit behind a reverse proxy without an SSH tunnel.

**How to use it:** start with a wildcard bind, which is what a LAN or reverse-proxy deployment needs.

```sh
dsh web --host 0.0.0.0 --port 3080 --no-open
```

<details>
<summary>Details</summary>

The `/api` trust fence is unchanged: a request still needs a loopback authority, an address the startup derives for a wildcard bind, or a declared `--trusted-host`. For `0.0.0.0` the startup derives one port-less IPv4 literal per non-internal interface, so the machine's LAN address is admitted without extra flags.

Binding all interfaces does not turn authentication off. The launch-token handshake still runs unless you pass `--no-browser-auth`, and static assets remain public while `/api` stays fenced.

</details>

<a id="trusted-hosts"></a>

#### Declared trusted hosts, and settings write access

Declare the name you actually browse with. The same declaration also makes the settings pages writable from that page instead of greyed out as read-only.

**How to use it:** `--trusted-host` is repeatable, and entries are port-less, so one entry covers every port.

```sh
dsh web --host 0.0.0.0 --port 3080 --no-open \
  --trusted-host dsh.example.com --trusted-host codeserver
```

<details>
<summary>Details</summary>

The fence judges the browser's own page authority, which is the name in the address bar, not the address it resolves to. A reverse proxy that rewrites the forwarded `Host` to the upstream address still needs the browsed name declared, because the browser half compares against `location.host`.

The failure mode is worth recognising: an undeclared name loads the page (static assets are public) but every `/api` request answers 403, so `ui-settings` falls back to its memory scope and every settings surface greys out with a "Settings are read-only." banner. A plugin fault would not break the catalog too; the 403 is what proves it.

Upstream gated the settings document on `isLoopback`, so any page whose authority was not `localhost` or `127.x.x.x` ran its settings scope in memory mode: no describe read, no write. This fork has the browser half reach the same verdict as the fence — a loopback page, a page whose authority matches a declared entry, or a worker-local transport that owns the Host — so a headless Host reached only over the LAN can edit its own settings. `isLoopback` keeps its meaning for the "open the settings document in a native editor" affordance, which acts on the Host machine. The fence itself is unchanged: a page still needs a trusted authority and a valid session cookie before any `/api` call lands, so this widens which browsers may write settings, not who may reach the server.

</details>

<a id="tokenless-mode"></a>

#### Tokenless mode

Where something upstream already authenticates every visitor, the per-process launch token is redundant friction.

**How to use it:**

```sh
dsh web --host 0.0.0.0 --port 3080 --no-browser-auth
```

<details>
<summary>Details</summary>

`--no-browser-auth` mounts the browser-auth seam open instead of the signing-secret owner: every request the fence admits is authorized, `GET /` is served directly instead of redirecting through a token exchange, no browser-session secret is read or created, and the printed URL carries no token. The plugin warns on stderr at load so the state is never silent.

The trust fence is untouched. An undeclared authority is still 403; reachability simply becomes the whole access policy once the fence has spoken, so only pair this flag with a front door that really does authenticate visitors.

The VS Code sidebar discovers its target by matching `?token=` in the harness's recorded URL. A deployment with the handshake off should record a tokenless clean URL; a value the harness ignores cannot collide with a real token, which is random per process.

</details>

<a id="deployment-bundle"></a>

#### Deployment bundle and one-step rebuild

The repository carries the deployment this fork runs on, so another server can be brought up the same way.

**How to use it:**

```sh
cd deploy
./install-dsh-web.sh
```

Then rebuild and restart in one detached step — this is what an update runs:

```sh
setsid nohup /path/to/repo/deploy/rebuild-dsh-web.sh \
  >/root/.dsh/rebuild.log 2>&1 < /dev/null &
```

<details>
<summary>Details</summary>

`install-dsh-web.sh` is idempotent. It installs [`deploy/dsh-web.service`](deploy/dsh-web.service) (systemd unit: start on boot, restart on failure), [`deploy/dsh-web-run`](deploy/dsh-web-run) (foreground runner the unit calls, which builds the flags from `.env`), [`deploy/dsh-token-writer`](deploy/dsh-token-writer) (an `ExecStartPost` that records the boot token URL for the sidebar), and the self-contained VS Code sidebar extension in `deploy/dsh-sidebar/`.

`rebuild-dsh-web.sh` is one operation because the Host process and the client bundles it serves are two halves of one build: stopping first is what makes the rebuild safe. It stops the unit, runs `pnpm run clean` (stale `lib/` output is the failure that step guards against), `pnpm install`, `pnpm run build:lib`, `pnpm run build:web`, starts the unit, and health-checks `http://127.0.0.1:3080/` for 30 seconds. It refuses to start a build that failed: a failed build leaves the service stopped and the log naming the step, which is recoverable; starting it would serve a half-written tree, which is not. `DSH_REPO`, `DSH_UNIT` and `DSH_HEALTH_URL` override the defaults.

A second checkout can serve beside the primary one, but only on the same commit: every boot re-points the harness home's profile module symlinks at its own install, so a drifted mirror silently changes what the other instance resolves. Use a separate port and a lower heap cap, and never rebuild one while the other is serving.

</details>

<a id="models-and-catalogs"></a>

### Models and catalogs

<a id="catalog-refresh"></a>

#### Catalog auto-refresh

A gateway's own model listing becomes the truth about which models exist, refreshed on every web page load.

**How to use it:** set `autoRefresh: true` on the provider route in the profile patch layer.

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-go:
        displayName: OpenCode
        api: openai-completions
        baseURL: https://opencode.ai/zen/go/v1
        apiKeyEnv: OPENCODE_GO_API_KEY
        autoRefresh: true
```

<details>
<summary>Details</summary>

The refresh re-interrogates `GET {baseURL}/models` at its own endpoint and merges the result into the `llm-pi-ai` user settings section, so a gateway that gains or retires models shows up without hand-editing.

The merge is deliberately conservative: listed entries keep every stored field and only a capacity the listing actually discloses replaces the stored one. A stored model the listing no longer carries is removed on the next refresh — retirement is the gateway's call, and a refresh never resurrects a retired model.

An empty successful listing is treated as ambiguous rather than as "every model retired", so a transient gateway hiccup cannot erase the stored catalog; the refresh reports that outcome as `empty` and the orchestrator warns.

Reasoning efforts are never auto-added. Neither gateway discloses per-model efforts, so auto-added models carry exactly the fields the listing discloses and efforts are set per model.

Automatic refresh writes settings, so it needs a settings scope that can write; it is a no-op on a deployment whose settings page is read-only by design.

Stored order is the selector's order: a refresh keeps the deployment's curated list first and appends only ids the listing adds, so a curated position survives every page load. A gateway that serves one model under two ids still surfaces the undeclared alias as an extra bare row — that is the endpoint speaking, not a failed curation.

</details>

<a id="models-dev-enrichment"></a>

#### models.dev enrichment

A listing endpoint answers with ids and, at best, capacities. Enrichment fills the context window, the modalities and the rates from the public [models.dev](https://models.dev) catalog, and never overrides what the deployment stated.

**How to use it:** add `enrichFrom: models.dev` to the same route.

```yaml
        autoRefresh: true
        enrichFrom: models.dev
```

<details>
<summary>Details</summary>

The catalog is treated as a third party, which is the whole design. It fills only what the deployment left unstated: a stated tariff, a stated modality claim or stated reasoning efforts are intent, and a third-party document disagreeing with intent never wins. Membership stays the endpoint's: enrichment decorates ids the gateway actually serves, and a model the catalog lists that the gateway does not serve is never added. A listing's own capacity disclosure still outranks both.

A failure is contained: an unreachable or reshaped document leaves the stored configuration untouched rather than failing the page load it rode in on, and the failure is not cached, so the next load retries. The document is fetched at most once every six hours per process and shared by every opted-in route.

Reasoning efforts stay opt-in (`enrichReasoning: false` by default): a level a catalog offers is not proof the gateway accepts it. Context windows, modalities and rates are taken by default.

The catalog publishes no `commandcode` provider, so that route's rates stay in the `llm.cost` patch layer described below. A route whose own key differs from the catalog's provider id names the catalog's id in `modelsDevProvider`; nothing guesses at an alias.

</details>

<a id="model-exclusions"></a>

#### Model exclusions

Some gateways serve different models on different APIs under one base URL. `excludeModels` moves a model off a route without the automatic refresh pulling it back.

**How to use it:**

```yaml
        excludeModels:
          - grok-4.7
          - minimax-m2.7
```

<details>
<summary>Details</summary>

An id named here is refused in both directions: never added from a listing, and dropped from the stored list. Membership is otherwise entirely the endpoint's call, and a listing says nothing about which API a model answers on, which is exactly why the exclusion has to exist.

A declared exclusion that refuses nothing is reported rather than ignored, because a typo there is otherwise silent and the route simply keeps serving a model the deployment meant to move.

The typical use is a gateway whose per-model endpoint differs — a model that needs `/v1/responses` or `/v1/messages` cannot be served by a route whose protocol is `/chat/completions`, so it moves to a second route that speaks its API.

</details>

<a id="per-conversation-session-header"></a>

#### Per-conversation session header

Some gateways require a stable conversation id in a header of their own choosing, and refuse a request without it.

**How to use it:** name the header; the harness sends the real session id under it, once per conversation.

```yaml
        sessionHeader: x-opencode-session
```

<details>
<summary>Details</summary>

A static `headers` entry satisfies the letter of such a requirement while giving every conversation the same id, which is precisely what the gateway asks against: the per-conversation value is what lets it route and cache. Naming the header in `sessionHeader` sends the real session id, winning a static entry of the same name, which stays as the fallback for a request that carries no session id.

OpenCode Go is the worked example: it requires `x-opencode-session` and answers `400 MissingSessionID` without it. The `pi-ai` session-affinity compat sends its own names (`x-client-request-id`, `x-session-affinity`), so a gateway naming a different one cannot be satisfied by compat alone.

</details>

<a id="reasoning-content-compatibility"></a>

#### Reasoning-content compatibility

DeepSeek in thinking mode demands the previous assistant turn's `reasoning_content` echoed back. Behind a gateway that is not named DeepSeek, the client's auto-detection misses it and the request fails with `400`.

**How to use it:** state it on the route.

```yaml
        compat:
          requiresReasoningContentOnAssistantMessages: true
```

<details>
<summary>Details</summary>

`pi-ai` sets that field on assistant messages only when this compat flag is on, and auto-detects it from `isDeepSeek` — a test a route named `opencode-go` and pointing at `opencode.ai` fails even though a DeepSeek model answers behind it.

This is the general hazard of a gateway that fronts someone else's models: every provider-shaped heuristic in the client is keyed off a name or a URL that no longer describes what is answering. State the compat that matters rather than relying on the name.

</details>

<a id="cost-and-usage"></a>

### Cost and usage

<a id="published-rates-and-estimated-spend"></a>

#### Published rates and estimated spend

Usage surfaces report money as well as tokens, at the operator's published list price, with DeepSeek's peak bands priced at the instant each request ran.

**How to use it:** state rates per model (or let a catalog/enrichment supply them), and use `llm.cost` for a route whose adapter reports no rate.

```yaml
        models:
          - id: deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash
            cost:
              input: 0.15
              output: 0.6
              cacheRead: 0.003
              peak:
                multiplier: 2
                windows:
                  - days: [mon, tue, wed, thu, fri]
                    start: '01:00'
                    end: '04:00'
```

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm'
  config:
    cost:
      commandcode:
        deepseek/deepseek-v4.1-flash:
          input: 0.15
          output: 0.6
          cacheRead: 0.003
```

<details>
<summary>Details</summary>

`LlmModelCost` is a published list price, not a billing record, in USD per million tokens. `input` and `output` must be stated together; a half-stated pair is refused rather than billing the missing bucket at nothing. An absent bucket stays absent: an unpriced model surfaces no amount at all rather than `$0.00`, because "no published rate" and "free" are different facts.

Peak bands are stated once, as a multiplier plus windows, because a ratio is what operators publish. Windows name weekdays in lowercase three-letter form and times as zero-padded `HH:MM` UTC, so lexicographic order is clock order. A malformed band — non-positive factor, no window, no weekday, unplaceable clock, or an end that does not follow its start — is refused where it is written, and every way a window can fail to place is closed in the reader, so a bad rule prices at the base band rather than doubling every estimate.

Pricing is per attempt, not per turn: a turn's summed buckets cannot be multiplied by one rate when the model changed mid-turn or when a band boundary opened while the turn was running. Each billed attempt is priced at the band its own closing instant falls in, and the amounts are summed. The band comes from the durable record, never from the clock at render time, so a transcript opened on Monday does not re-price Saturday's turn.

Where the amounts appear: every model row in the `/model` popup and in the composer seat shows `$in / $out · cache hit $cacheRead`; the Turn's clock pill carries the estimate after the run time and the throughput (`Ran for 2m 18s · 63 tok/s · $0.012345`), and the Turn-usage dialog repeats it as an `Estimated cost (list price)` row with a `(peak)` / `(off-peak)` note when the band matters; the Trajectory Usage inspector shows the per-request amount and the running session total.

`llm.cost` belongs in the profile's patch layer, not in `settings.yaml`: the settings service is a namespace registry, and the core `llm` service registers no schema there, so a `llm:` key in `settings.yaml` loads without complaint and changes nothing.

Context-tiered rate cards still record only their base tier, because tier is a property of the request's size rather than of the clock, so those estimates are a floor.

</details>

<a id="per-turn-throughput"></a>

#### Per-turn throughput

Each Turn's clock pill carries its own `tok/s` beside the run time, and the figure survives a page reload.

**How to use it:** nothing — it is always computed. It is hidden when the `performanceUsage` display preference is `compact`, which hides the per-turn readout but keeps the composer dock's own figure.

<details>
<summary>Details</summary>

The rate divides the Turn's summed output tokens by the summed LLM span of its steps (`completedTime − stepStartTime`). Both boundaries are persisted events, which is why the figure survives a reload; the span also excludes the tool execution between steps, which is not generation time.

The span does include each step's time-to-first-token, so a Turn with a long think reports a slightly lower rate than a decode-only figure would — the honest number for "tokens per second of LLM time". A step that generated no tokens (a pure tool call) contributes no rate at all, and a Turn with no sampled generation keeps the plain duration with no dangling separator.

Time to first token is still live-only: it needs `firstTokenTime`, which only live stream deltas supply, and the session format persists no timing. A Turn the page did not stream itself therefore shows a speed row and no TTFT row.

</details>

<a id="chat"></a>

### Chat

<a id="turn-loading-control"></a>

#### Turn loading control

A paged window holds only part of a long session, so a Turn the window enters midway has no token aggregate. The control pages history back one whole Turn at a time.

**How to use it:** open a long chat and press **Load turn N** in the composer dock's stats row, immediately after the usage pill. Each press brings in the whole Turn the label names — the reader's message through the end of the model's response — then the label moves one Turn earlier. It is hidden once there is nothing left to load.

<details>
<summary>Details</summary>

The control targets the `turn/start` seq, which the loop logs before the Turn's prompt and steps, so one press restores a complete Turn rather than a fragment. When the window begins midway through a Turn, the first press finishes that Turn before reaching past it; once the window begins exactly at a Turn start, it targets the Turn immediately before.

Telling a whole Turn from a partially held one needs the seq of the window's oldest event: `SessionSnapshot.baseSeq` exposes it, and the exact test is `baseSeq <= turn/start`. A Turn's first visible node sits after its own `turn/start`, so the head node's anchor cannot make that distinction.

</details>

<a id="file-downloads"></a>

#### File downloads

A file that reached the harness — uploaded, or written by the agent — can be saved, not only looked at. Uploaded attachments were the worse half: an upload lives in content-addressed storage under an opaque id with no filesystem path, so without this route the bytes were unreachable once the card was gone.

**How to use it:** in the UI, open the delivered-file card's menu and choose **Download**, use the save control that appears on hover in the workspace file tree, or click a sent file in the conversation. Over HTTP:

```sh
GET /api/file?path=/absolute/path&download=1&name=report.pdf
GET /api/attachment.download?sessionId=<session>&attachmentId=<id>
```

<details>
<summary>Details</summary>

The `download` parameter's presence is the request, so a hand-written `?download` works, and only the explicit negatives `0` and `false` opt back out. It adds `Content-Disposition: attachment` and an optional `name` override for the saved filename; the path read is unchanged, so the same route serves a preview and a save.

`/api/attachment.download` takes `sessionId` and `attachmentId`, proves the attachment is reachable from that Session's log (the same authorization the image route performs, generalized over file and image blocks), and streams the stored bytes straight to the socket — an upload never lands in the harness process's heap on the way out.

One honest limit: a declared file is addressed through its workspace root, so a card whose Session root is unknown and whose path is relative offers no save at all; the item is disabled rather than pointing at a URL that cannot resolve. The sidebar document preview has no save control of its own — the same files are reachable from the file tree and the delivered-file card. Uploaded images download through the attachment route, but the lightbox offers no save gesture yet.

</details>

<a id="durable-composer-drafts"></a>

#### Durable composer drafts

A prompt typed but not sent used to live only in the browser, so a send that failed while the harness was restarting lost its text with no server-side copy.

**How to use it:** nothing — it is automatic. Type in a Session, reload or restart, and the draft comes back with that Session.

<details>
<summary>Details</summary>

Drafts have a durable per-Session home outside the Session log: the session controller exposes `session/composerDraft` and `session/setComposerDraft` over a `composer_drafts` storage domain. The composer seeds an archived draft only when the browser holds none, then writes changes back after a quiet period.

Every operation is fail-soft, so a deployment without storage behaves exactly as before.

The send-failure path no longer parks a failed prompt until the composer is empty: the failure is always restored, appended after whatever the reader typed since the last restoration, so text typed during the flight survives and the failed prompt stays visible and resendable.

</details>

<a id="sessions-and-memory"></a>

### Sessions and memory

<a id="continue-in-a-new-chat"></a>

#### Continue in a new chat

A long Session is retained in full for the life of the process, and `/compact` does not shrink the log by contract. The only thing that actually shrinks the working set is a Session whose log is small, so a Session row's menu offers to condense this one into a fresh one.

**How to use it:** open the Session row's menu and choose **Continue in a new chat (condense this one)**. The operation condenses the source, carries the condensation into a new Session as its entire history, opens it, and archives the source. The item is disabled while the Session is running.

<details>
<summary>Details</summary>

The summary is the compaction backend's own output, not a second summarizer, so a continuation is condensed exactly the way an in-place `/compact` would condense it. The operation reaches the backend by executing `/compact` for the Agent, which is the only context that can see a preset's isolated backend.

The carried history is the condensed conversation, not the summary declaration: compaction keeps a recent tail verbatim (`retainRatio` defaults to 0.16 of the context window), and that tail is exactly what a continuation is continued from. The opening message labels each carried turn (`User`, `Assistant`, and `Condensed history` for the checkpoint) and carries text blocks only — tool calls and their results are plumbing whose useful output the condensation already keeps.

The continuation is a new conversation, not a seeded one: created unseeded, its one opening message attributed to the handoff rather than to the reader, and steered onto its Agent so the first step writes the system prompt and claims the recap as the batch it leads. That costs one model turn per handoff, and it buys a continuation whose history is durable, visible and searchable from the moment it exists.

Every refusal names its precondition: `session/handoff-unavailable` carries a stable `reason` — `no-command-registry`, `no-compaction-command`, `compaction-refused`, `nothing-to-carry` — and a refused handoff is surfaced in a frame-wide notice rather than leaving the click looking dead. Archiving runs last and its failure is reported in the result (`archived: false`) rather than thrown, because a caller that cannot open the continuation has lost the work of producing it.

</details>

<a id="continuations-that-are-real-sessions"></a>

#### Continuations that are real sessions

A continuation holds a conversation without having run a turn, which made it read as "blank": hidden from the Session tree because it was not selected, and excluded from search.

**How to use it:** nothing — a continuation is listed, openable, renamable and searchable from the moment it exists, and is never eligible for reuse as someone's New Session.

<details>
<summary>Details</summary>

The list-metadata fold clears `blank` on an `agent/inbox/spliced` whose inserted message is attributed `kind: 'handoff'`, which is the shape the handoff itself writes. The projection's `stateVersion` moved to 2 so rows folded by the earlier version are refolded rather than reused, which also heals continuations created before the rule existed.

A continuation also inherits the effective directory rather than the original project, so its files and tools resolve where the source chat actually ran.

</details>

<a id="archiving-releases-memory"></a>

#### Archiving releases memory

Until this change the archive set was a durable flag and nothing more: the Session's Agent stayed live, its parsed log stayed in the observation cache, and a decoded log could stay memoized, all for the life of the process. That is what made "retire a big chat" a two-restart operation.

**How to use it:** **Archive** the Session from its row menu, then keep working — no restart is needed.

<details>
<summary>Details</summary>

Three layers each hold the same Session, and each is asked in turn when one is archived. The workspace registry announces a durable archive as `workspace/session-archived` (after the state write, and only when it actually wrote), and the session controller listens and releases:

- the **Agent**, through the handle the controller kept (an Agent it made live is released; one that was already live belongs to whoever was using it and is left alone, and so is one that is not idle, because stopping a loop mid-turn discards work);
- the **parsed cold graph**, through `sessionQuery.releaseSession` (a pinned entry with an active lease is deliberately left alone);
- the **decoded log**, through `SessionPersistence.release`, overridden by the JSONL backend to drop its byte-bounded memo.

Read state is released before the Agent, so a caller that observes the Agent gone can rely on the graph being gone too. Everything is best-effort and idempotent, and a failure is logged rather than thrown: an archive that succeeds must not fail because a cache could not be dropped.

Re-opening an archived Session reads it again and costs what it always cost: the release is a way to stop paying, not a way to look for free. The remaining copy is the live `Session.log` itself, which nothing releases until the process restarts.

</details>

<a id="bounded-session-memory"></a>

#### Bounded session memory

A long conversation is held in memory in full, and one Session can dominate the process. These knobs make the retained set a budget instead of a function of how many chats have been looked at.

**How to use it:** the settings live in the profile's patch layer, because they are deployment policy rather than user settings.

```yaml
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    coldLogMemoMaxBytes: 67108864
- id: session-query
  name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    preparedSessionCacheSize: 2
- id: session-controller
  name: '@deepseek-ai/dsh-api-session-controller'
  config:
    promoteOnHistoryOpen: false
```

<details>
<summary>Details</summary>

`SessionHandle.read(offset, length)` now retains only the requested window instead of decoding and then slicing the whole generation: the window is threaded to where events are actually retained, while every row is still offered to the decoder, so a damaged row outside the window still refuses the read. A compact run lying wholly outside the window is counted from its declared `eventCount` and never expanded, which is where a long log's bulk sits. A windowed decode is never memoized, because the memo is keyed by session id alone and a partial list would be served to a later full read. This bounds retention, not work: the scan still decodes every row, so it is not a latency win, and `open` still performs its own complete validating decode.

`coldLogMemoMaxBytes` bounds the handoff memo by decoded JSONL bytes rather than entries, because two entries can be two gigabytes. A log past the whole budget is not memoized at all: the handoff pays a second decode instead of holding the graph. Default 64 MiB.

`preparedSessionCacheSize` bounds the observation cache, which retains one fully materialized event graph per cold Session. The shipped bound of 5 is a bound on entries, which bounds nothing when one entry can be a gigabyte; two covers the open-then-page handoff the cache exists for. Entries pinned by an active observation lease are exempt by design, so this bounds browsing, not concurrent work. It takes effect on the next harness start.

`promoteOnHistoryOpen` (default `true`) selects whether opening a Session resumes a live Agent. Setting it `false` keeps opening a chat a read: memory stops scaling with how many chats have been *looked at* and starts scaling with how many are *in use*, at the cost of one full decode on the first prompt in a chat this process has not resumed. Prompting still works — every operation that genuinely needs an Agent resolves one on demand — and archiving gives the graph back.

</details>

<a id="multi-user-scoping"></a>

### Multi-user scoping

<a id="multi-user-session-scoping"></a>

#### Multi-user session scoping

One harness can serve several people without one shared session list. A reverse proxy that authenticates visitors asserts who each request belongs to; the `session-scope` plugin maps that identity to the directories it owns, and every layer that enumerates sessions or workspaces applies it.

**How to use it:** mount the plugin (it is a package in this repository, so a bundle or the profile can declare it) and configure the identity header.

```yaml
- insert:
    - id: session-scope
      name: '@deepseek-ai/dsh-session-scope'
      config:
        header: x-auth-request-email
        admin:
          - admin@example.com
        users:
          alice@example.com: /home/alice
          bob@example.com: /home/bob
        provisionRoot: /home
        requireIdentity: true
```

<details>
<summary>Details</summary>

`users` maps an identity to the directory it owns; `provisionRoot` mints a directory per unknown identity under that parent; `admin` lists identities that see everything. `requireIdentity` refuses an admitted request that carries no identity header instead of falling back to the shared view — the setting to use when the deployment's reachability is not itself the access policy.

Loading the plugin with no `admin`, no `users` and no `provisionRoot` constrains nobody: it answers `undefined` for every caller and the harness behaves exactly as it does without the plugin.

Enforcement is by directory ownership, and the plugin exposes it as helpers the Session-owning layers call: `callVisibility` / `peerVisibility` answer whether one `cwd` is visible to the caller of a Remote method, `callRoots` answers which directories the caller owns (for a picker choosing where to open), and `assertVisibility` refuses a path outside them with `session-scope/forbidden`. A session with no `cwd` is not visible to a constrained caller, and id-addressed entry points (`session.page`, `session.fork`, `session.export`) are refused rather than merely filtered from the list.

The identity must arrive in a header the proxy sets and the client cannot forge. That is a deployment property, not a plugin one: terminate authentication in front of the harness and have the proxy inject the header, and do not expose the harness port directly.

The plugin needs Connection's identity admission (next section) to attribute requests. Without a resolver installed it still answers by Peer, but every request would share the browser Peer, so it is the pair that scopes anything.

</details>

<a id="identity-admission"></a>

#### Identity admission

Connection admits every request as a Peer, and every Remote call already receives its Peer as `invocation.peer`. This fork adds an optional policy so a deployment that fronts several users admits each identity as its own Peer instead of the shared one.

**How to use it:** install a `RequestIdentityResolver`. Deployments normally get one from the `session-scope` plugin; a custom policy implements three members — `identityFromHeaders`, `requiresIdentity`, `remember(peer, identity)` — and installs itself with `connection.setIdentityResolver(resolver)`.

```ts
const restore = connection.setIdentityResolver(resolver)
restore()
```

<details>
<summary>Details</summary>

Riding identity on the Peer rather than a request-scoped carrier is what makes streams work: `session.follow` and `workspace.follow` outlive the request that opened them, and the Peer is the one thing that survives with them. Nothing new is threaded through any signature, and `PeerScope` still records nothing about who a Peer is — the resolver owns the map, which is what the protocol's own contract asks for.

The policy is handed to Connection rather than imported by it, so Connection keeps knowing nothing about users. With no resolver installed nothing changes: every admitted request speaks for the Peer its carrier authenticated. With one, each identity is minted its own Peer, reused across requests, and disposed with the service.

A request that asserts no identity is admitted as the shared Peer when `requiresIdentity` is false, and refused with 403 when it is true — failing closed rather than silently falling back to the view that sees everything.

</details>

<a id="web-search"></a>

### Web search

<a id="bright-data-web-search"></a>

#### Bright Data web search

A fourth `ctx.web` search backend, alongside the shipped `exa`, `perplexity` and `deepseek` ones. It calls no vendor search endpoint: it asks a Bright Data Web Unlocker zone for the DuckDuckGo HTML result page and parses the organic results locally, so a search returns citeable `url`/`title`/`snippet` sources and never an invented answer or a publication date.

**How to use it:** mount the provider beside the web service and, if more than one backend is usable, pin the selection.

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: brightdata
- name: '@deepseek-ai/dsh-web-search-brightdata'
  config:
    apiKeyEnv: BRIGHTDATA_API_TOKEN
    zone: mcp_unlocker
```

<details>
<summary>Details</summary>

The token resolves through the harness credential store (whose local provider also reads the launch environment), or from the launch environment alone when that seam is absent.

Three quirks are worth knowing before choosing it. Availability ignores the token: the plugin always supplies a credential resolver, so it only checks a parseable endpoint and a non-empty zone — a tokenless deployment selects this provider and the *search* fails as `WEB_PROVIDER_ERROR` naming `BRIGHTDATA_API_TOKEN`, not `WEB_PROVIDER_UNAVAILABLE`. `apiKeyEnv` takes a bare variable name; the credential-reference grammar rejects the `$` form. And every search spends one credit from Bright Data's free tier, which is 5,000 credits/month drawn from a single shared pool across Web Unlocker, SERP API, Web Scraper API, Scraper Studio and MCP, with `maxResults` truncating only afterwards.

Choose another backend when the deployment needs a generated answer, publication dates, or upstream search controls.

</details>

[↑ Back to the fork additions](#fork-additions)

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/4MrtZUhpxg">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

`pnpm run dev:web` builds, serves, and rebuilds client bundles on source edits in one terminal, and `make help` lists the matching Make targets for Web and Desktop; the guide's application commands section owns the full table.

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
