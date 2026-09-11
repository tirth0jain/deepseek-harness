# Fork changes and added features

This is the running record of everything this fork adds on top of upstream DeepSeek Harness, written for whoever picks it up next. It covers what changed, why each change exists, how to rebuild and verify it, and what is still rough. Upstream's own history and docs remain authoritative for everything not listed here.

Sources of truth: the code and tests in this repository, `~/.dsh/settings.yaml` for this deployment's configuration, and the Agent Notes under `.agents/notes/`. Where a claim here can drift from the code, the code wins.

## Repository layout and current state

Two checkouts of the same history are kept side by side, and they are expected to stay byte-identical:

| Path | Role | Restart helper |
| --- | --- | --- |
| `/root/projects/dsh-new-upstream` | Primary checkout; the live GUI runs from here | `dshkill-new` / `dshstart` |
| `/root/projects/deepseek-harness` | Mirror checkout on an alternate port (3082) | `dshstart-old` |

Only one harness runs at a time: both share `~/.dsh`, and booting one re-points that profile's module symlinks at its own build. The sync direction is always **new → old**; the mirror is fast-forwarded and rebuilt, never edited independently. To confirm the two agree:

```bash
git -C /root/projects/deepseek-harness merge --ff-only origin/master
diff -r --brief /root/projects/dsh-new-upstream/packages /root/projects/deepseek-harness/packages \
  -x node_modules -x lib -x dist -x '*.tsbuildinfo'
```

## Deployment and access

**LAN and reverse-proxy binding.** Upstream's startup guard rejected `--host 0.0.0.0` even though the web runtime, LAN-trust sampling, and URL announcement already handled it. Commit `165591cce5` removes that guard, so `dsh web --host 0.0.0.0 --port 3080` serves behind a LAN reverse proxy. The `/api` browser-trust fence is unchanged: it still requires a loopback, sampled-LAN, or declared `--trusted-host` authority, so pair `0.0.0.0` with `--trusted-host` when browsers reach the server through a different host name. This is what the live instance runs:

```
node .../apps/cli/lib/bin.js web --host 0.0.0.0 --port 3080 --no-open
```

**Token handshake.** `dsh web` prints a tokenized URL; the browser exchanges the token for a signed session cookie and redirects to the clean root. The token is written to `~/.dsh/current-token.txt`. Hitting the server without it returns `401 dsh web authentication required`. In headless verification, fetch the tokenized URL once and let the cookie jar keep the session — a bare page reload without the cookie comes back as the 401 text page, so re-authenticate rather than reusing a stale tab.

**Editor access.** A code-server / VS Code route was scripted separately during setup: it installs `@deepseek-ai/dsh` and `@vscode/vsce` globally, patches the published bundle for LAN binding, and builds a VSIX. That script is kept at `/root/projects/dsh-vscode.md` and is not part of either repository.

## Web search providers

**Bright Data Web Unlocker** (`9712944bae`, `bbec969caa`, `71a4364138`) adds a fourth `ctx.web` search backend in `packages/web/web-search-brightdata`, alongside the shipped `exa`, `perplexity` and `deepseek` ones. It calls no vendor search endpoint: it asks a Web Unlocker zone for the DuckDuckGo HTML result page (`format: 'raw'`) and parses the organic results locally, so a search returns citeable `url`/`title`/`snippet` sources and never an invented answer or a publication date. It is selected like any other backend — `searchProvider: brightdata` — and the token resolves through `ctx.credentials` (whose local provider also reads the launch environment), or from the launch environment alone when that seam is absent.

Three quirks are worth knowing before choosing it: **availability ignores the token** (the plugin always supplies a credential resolver, so `available()` only checks a parseable endpoint and a non-empty zone — a tokenless deployment selects this provider and the *search* fails as `WEB_PROVIDER_ERROR` naming `BRIGHTDATA_API_TOKEN`, not `WEB_PROVIDER_UNAVAILABLE`); **`apiKeyEnv` takes a bare variable name** (`BRIGHTDATA_API_TOKEN`, not `$BRIGHTDATA_API_TOKEN` — the credential-reference grammar rejects the `$` form with a `TypeError`); and **every search spends one credit** from Bright Data's free tier, which is 5,000 credits/month drawn from a single shared pool across Web Unlocker, SERP API, Web Scraper API, Scraper Studio and MCP, with `maxResults` truncating only afterwards.

The package shipped without a README, which the doc gates caught; it now carries a full `package-reference` README pair (`.md`, `.zh.md`, `.i18n.yaml`) and the `indirect` Model Experience registration that its sibling provider backends use. The provider's own behavior did not change — only its documentation, its package version, and the JSDoc on three exported helpers.

## Model catalog management

Two gateway providers are configured in `~/.dsh/settings.yaml` — `commandcode` (69 models) and `opencode-go` (36 declared; the gateway serves 37, and the difference is the undeclared V4.1 Flash alias explained below). Three behaviours were added on top of upstream's catalog handling, all in `packages/llm/llm-pi-ai`:

**Auto-refresh on every web page load** (`8269a9f757`). A provider route with `autoRefresh: true` is re-interrogated at its own `GET {baseURL}/models` on each web page load, and the merged result is written back into the `llm-pi-ai` user settings section. A gateway that gains or retires models, or corrects a context window, therefore shows up in `settings.yaml` without hand-editing. The merge is deliberately conservative: listed entries keep every stored field and only a capacity the listing actually discloses replaces the stored one, and nothing is ever read from pi-ai's installed catalog — the endpoint is the only truth consulted.

**Retired models are dropped, empty listings are refused** (`1d6fa0c310`). A stored model the listing no longer carries is removed on the next refresh; retirement is the gateway's call and a refresh never resurrects a retired model. An empty successful listing is treated as ambiguous rather than as "every model retired", so a transient gateway hiccup cannot erase the stored catalog — the refresh reports that outcome as `empty` and the orchestrator warns.

**Reasoning efforts are never auto-added** (`a91cf74b9d`). Neither gateway discloses per-model reasoning efforts, so stamping a uniform map onto every model a refresh adds would misrepresent models whose real support differs. Auto-added models carry exactly the fields the listing discloses — id, display name, capacities — and efforts are set per model. The route-level `defaultReasoningEfforts` profile field was removed entirely.

**Curated ordering and DeepSeek V4.1 Flash.** The provider `models` list order is the model selector's order, so the curated list is what decides what a reader sees first. `deepseek/deepseek-v4.1-flash` sits directly above `deepseek/deepseek-v4-flash`, with a 1M context window, 384K max output, efforts `off / low / high / max`, and the live Flash tariff. The OpenCode Go route is ordered the same way: its V4.1 Flash is declared first in that provider's `models` list, directly above `deepseek-v4-flash`. A refresh cannot undo that — `mergeRefreshedModels` puts stored order first and appends only what the listing adds — so the curated position survives every page-load refresh. Note that DeepSeek retired the older Flash models on 2026-09-10: `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are now legacy aliases served by the V4.1 Flash model and billed at Flash prices, and `deepseek-v4-pro` follows on September 14. V4.1 Flash and V4 Flash therefore cost the *same* — the cheaper rows are the retired aliases, not a discount on the new model.

**Which OpenCode id V4.1 Flash is declared under.** OpenCode Go serves this model under two ids — `deepseek-flash` and `deepseek-v4.1-flash` — and both answer a request. Only the second appears on the operator's rate card and endpoint table, so the declaration names `deepseek-v4.1-flash` and the retired alias stays undeclared. That choice has one visible consequence worth knowing: the refresh appends every *served* id the route does not declare, so the undeclared alias comes back as a bare, unpriced row at the bottom of the OpenCode group. Duplicate ids cannot both be suppressed by declaration — declare one and the other is appended, so exactly one extra alias row exists either way. The row is harmless (same model, same price when priced) but it is not evidence the curated list failed; `mergeListedIntoConfigured` only ever appends ids the endpoint actually returned.

## Published rates and estimated spend

Before this work, every usage surface reported tokens and nothing else, so comparing a cheap Flash route against a flagship meant looking rates up by hand — even though `catalog.ts` was already reading the installed catalog's `cost` field and discarding it behind an all-zero sentinel.

**`LlmModelCost` is a published list price, not a billing record** (`c30df9864e`). It lives in `packages/llm/llm/src/types.ts`, travels on `LlmResolvedModelInfo.cost`, and reaches the browser through `buildModelCatalog` as `ModelCatalogModel.cost`, in USD per million tokens. `PiAiModelProfile.cost` lets a deployment state a rate the installed catalog does not carry — necessary here, because neither gateway publishes prices on its model endpoint. `input` and `output` must be stated together; a half-stated pair throws `PiAiCatalogError` rather than silently billing the missing bucket at nothing. An absent bucket stays absent: an unpriced model surfaces no amount at all rather than `$0.00`, because "no published rate" and "free" are different facts.

**One fold, refusing dishonest totals.** `estimateUsageCost` in `packages/llm/token-meter/src/usage-cost.ts` multiplies each carrying bucket by its per-million rate. It returns `undefined` — not a partial sum — when a bucket carries tokens the rate does not price.

**Peak hours are priced at the moment each request ran.** DeepSeek bills two bands: the rates above, and a band that is exactly double inside `01:00–04:00` and `06:00–10:00` UTC **on weekdays only** — weekends are entirely off-peak, and the card says so in as many words ("Peak runs Monday to Friday only, so it is never charged at the weekend"). `LlmModelCost.peak` states that rule as a multiplier plus its windows, since a ratio is what the card publishes and a second table of prices would be four more numbers per model to drift out of step. Windows name weekdays in lowercase three-letter form and times as zero-padded `HH:MM` UTC, so lexicographic order is clock order. A malformed band — non-positive factor, no window, no weekday, unplaceable clock, or an end that does not follow its start — is refused where it is written (`INVALID_MODEL_COST` in the core, `PiAiCatalogError` on the config side), and every way a window can fail to place is closed in the reader, so a bad rule prices at the base band rather than doubling every estimate.

**Pricing moved from per-turn to per-attempt.** A turn's summed buckets cannot be multiplied by one rate when the model changed mid-turn *or* when a band boundary opened while the turn was running. `deriveTurnTokenUsage` now also publishes `attempts`: each billed attempt's own buckets, its route, and `at` — the epoch-ms of the event that closed it (the completion itself, or the retry or step end that closed an attempt having none). `turn-cost.ts` prices each attempt at the band its *own* instant falls in and sums the amounts, and reports nothing only when a route is unrecorded or unpriced, or a rate cannot price a bucket that attempt carried. Measured against this deployment's largest session (226 turns carrying attempt records): **5 turns genuinely straddle a band boundary** and previously could not be priced honestly; **1 turn billed more than one route** and previously got no amount at all. Across that whole session the per-attempt bands total **$19.4952** against **$19.3715** if each turn were priced at its first attempt's band — small in total, but concentrated in exactly the long turns a reader is inspecting.

**A flat tariff names no band.** GLM, Kimi and the rest of these gateways publish one rate that never moves, so their rows show the amount alone — "off-peak" is not a synonym for "flat", and labelling them would report a distinction their operator never published. The band note appears only when the route's own catalog carries a `peak` band, which makes it evidence: seeing `(peak)` or `(off-peak)` proves the deployment's settings supplied the rule, and seeing nothing proves they did not.

**The band comes from the record, never from the clock at render time.** A transcript is a record: a turn that ran on Saturday must not re-price at Monday's peak rate because the reader opened it on Monday. Every surface takes the instant from the durable event that closed the attempt, and falls back to the base band when none was recorded — the direction that understates rather than invents. The rule itself lives once, in `packages/llm/token-meter/src/rate-schedule.ts`, so the transcript and the ledger cannot disagree about the same request.

**Where the amounts appear.** The Chat turn-usage dialog shows an `Estimated cost (list price)` row at six decimals (a single turn is routinely under a cent), followed by `(peak)`, `(off-peak)` or `(peak and off-peak)` when that turn's own requests straddled the boundary — an amount that is double the off-peak one for the same tokens has to say why. The Trajectory Usage inspector shows both the per-request amount and the running session cumulative, each with the same band note. Both read the model selector's own per-session directory and load it themselves, so a rate edited in Settings prices the next turn without a reload. Every model row in both the `/model` popup and the composer seat shows the rate as `$in / $out · cache hit $cacheRead`, rendered by one shared `formatRate` in `packages/client/ui-model-selection/src/client/rates.ts` (`943c10eb61` fixed a bug where the live `$0.60` output rate rendered as `$0.6`).

The cache-hit rate earns its place in the row: on a long agent conversation most prompt tokens are cache reads, so that rate — not the headline pair — is what actually sets the bill.

**Rate provenance matters.** The bundled pi-ai catalog ages, and it still carried the pre-2026-09-10 Flash tariff. Deriving gateway rates from it would have priced a route at `$0.22/$0.66` whose live CommandCode and OpenCode Go rate cards both say `$0.15/$0.60` — wrong by half again, while still looking authoritative. The rates in `settings.yaml` were transcribed from the operators' live rate cards instead: [CommandCode](https://commandcode.ai/models), [OpenCode Go](https://opencode.ai/docs/go/), and [DeepSeek's own pricing page](https://api-docs.deepseek.com/quick_start/pricing/). Seven DeepSeek-backed entries carry a peak band — `commandcode/deepseek-v4.1-flash`, `.../deepseek-v4-flash`, `.../deepseek-v4-flash-vision-exp`, `.../deepseek-v4-pro`, and the OpenCode Go rows `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `deepseek-flash`.

One wrinkle in those cards worth knowing: CommandCode's page for DeepSeek V4 Flash Vision (exp) prints the peak cache-read cell as `$0.01` when every other cell on the page is exactly double. The band is stated as a factor of 2, so that row follows the arithmetic (`$0.014`) rather than the rounded cell. Context-tiered cards (Grok 4.6, Qwen3.7/3.6 Plus, GPT 5.6 Luna, Grok 4.6) still record only their base tier, since tier is a property of the request's size rather than of the clock — so those estimates remain a floor.

## Turn loading control

A paged window holds only part of a long session, and a Turn the window enters midway reports no token aggregate — so its cost cannot be shown until the Turn is whole. Two changes address that.

**Where it lives.** The control sits in the composer dock's stats row, immediately after the usage pill and just above the composer (`b0156a62f8`). It began life inside the turn rail's hover card, which a reader only finds by hunting a dot on a thin rail, and was moved after it proved effectively invisible.

**What one press loads.** It pages through the targeted Turn's `turn/start` seq, which the loop logs *before* the Turn's prompt and steps, so a press brings in the whole Turn — the reader's message through the end of the model's response — rather than a fragment.

**It walks back through history.** The control targets the Turn the window's head sits inside when the window started midway through one (that Turn must be finished before reaching past it); once the window begins exactly at a Turn's start, it targets the Turn immediately before — the next Turn the window does not hold. Repeating it therefore walks backwards one Turn at a time through the whole session, and the label always names the Turn a press will bring in. It is hidden once the pager has nothing left.

**Why `SessionSnapshot.baseSeq` was added.** Telling a Turn held whole from one the window enters midway needs the seq of the window's oldest *event*. The head *node*'s anchor cannot do it: a Turn's `turn/start` precedes its first visible node, so that node's anchor sits after the Turn's own seq whether or not the window covers the Turn's start. `SessionSnapshot.baseSeq` now exposes it, and the exact test is `baseSeq <= turn/start`. Without it the control stuck on the newest Turn and could not reach the ones before it.

The dock sits outside the Chat view, so its registration injects `loadThrough` from the Session binding rather than inheriting the view's prop. The rail's hover card went back to a read-only tooltip.

## Upstream sync

The fork tracks upstream and merges rather than rebasing, so local commits keep their identity. Two syncs have happened, both onto an identical pair of checkouts:

**288 commits, `aa8262ec09`** (0.1.5-rc.1), kept every local feature through four conflicts: `llm-pi-ai/src/index.ts` (kept both upstream's `registering` flag and the local `settingsProvider`), `bundle/web-app/README.zh.md` (kept the local `--host 0.0.0.0` paragraph), `llm-pi-ai/README.i18n.yaml` (took upstream hashes and re-recorded), and `docs/config-catalog.md` (took upstream, then regenerated).

**134 commits, `c291e7961a`** (0.1.5-rc.2). Three conflicts, all in `ui-chat` and all additive on *both* sides, resolved by keeping both: `apply.ts` (upstream's `input-trigger` declaration merge is unrelated to the local `ui-model-selection` one), and `ChatNodeSeat.tsx` / `ChatView.tsx` (upstream threads a new `openSkill` owner prop while the local work carries `costOf` and `useModelCosts`; the destructures and memo dependency lists now name both). No local feature needed a semantic change — upstream did not touch a single file in `llm-pi-ai/src` or `token-meter/src`, and the only edits inside those packages were version strings.

Gates that went stale in that merge and were regenerated: `docs/config-catalog.md` (+ its `.i18n.yaml` pairing), `docs/module-graph.*`, `docs/event-producer-consumer.md`, and `extensions/cordis-client-runner/src/client/slot-catalog.ts`. Three unrelated gate failures were also repaired because the fork had introduced them: the missing `packages/web/web-search-brightdata/README.{md,zh.md,i18n.yaml}`, its package version (the root-version rule in `scripts/check-workspace-constraints.ts` requires every dsh-family manifest to match `0.1.5-rc.2`), and `@deepseek-ai/dsh-token-meter` missing from `ui-trajectory`'s devDependencies. Two further failures are upstream's own and were left alone: `verify-client-domain-graph` reports pre-existing layering violations in `ui-sidebar-documentpreview` (a package neither side edited), and `verify-doc-site-fragments` needs `website/.dist`, which only `docs:build` produces.

Derived artifacts must be regenerated after any merge that touches their sources; they are freshness-gated, so a stale one fails `doc-sync`:

```bash
pnpm run gen-config-catalog            # docs/config-catalog.md + .zh.md
pnpm run gen-cordis-inspect-catalog    # cordis_inspect API catalog
pnpm run gen-module-graph              # docs/module-graph.md/.zh.md/.i18n.yaml
pnpm run gen-doc-graphs                # docs/event-producer-consumer.md + siblings
pnpm run gen-client-catalog            # cordis-client-runner slot catalog
node_modules/.bin/tsx scripts/gen-third-party-notices.ts
pnpm run verify-translation-pairing --write <changed EN docs>
```

`gen-doc-graphs` rewrites only the English side of `event-producer-consumer.md`; the Chinese counterpart keeps translated prose but must take the regenerated tables' line numbers, or `verify-translation-pairing` fails on the pair.

## Building, testing, restarting

The pipeline, in the order that works:

```bash
pnpm install --frozen-lockfile --config.confirmModulesPurge=false
pnpm run build:lib:host      # tsc -b tsconfig.host.json + tsdown
pnpm run build:lib:client
pnpm run build:web
pnpm run typecheck           # host + typecheck:contracts-ready (tsc -b tsconfig.client.json)
```

Client-plugin edits (anything under `packages/client/*/src/client`) reach the live page from `packages/client/*/lib/client.js` on a page refresh once `build:lib:client` has run; no server restart is needed. Host-side edits require the harness to be restarted by the operator.

The gates a change must pass before it is committed, all of which the git hooks or CI will run anyway:

```bash
pnpm exec vitest run <paths>
node_modules/.bin/tsx scripts/run-oxlint.ts --config .oxlintrc.staged.json <files>
pnpm run verify-translation-pairing     # EN/zh pairs
pnpm run verify-type-equiv              # documented type blocks
pnpm run verify-doc-budgets
pnpm run verify-md-wrap
pnpm run verify-cordis-inspect-catalog
```

Two conventions that bite: client-side test files under `packages/client` must use the `.client.spec.ts` suffix or the host tsconfig rejects them, and non-null assertions are lint errors in this repository.

## Verified behaviour and test inventory

- `packages/llm/token-meter/tests/usage-cost.spec.ts` — the scaled sum, sub-million amounts, skipped empty buckets, the unpriceable-bucket refusal.
- `packages/llm/token-meter/tests/rate-schedule.spec.ts` — both window bounds and the exclusive end, the weekend rule at the same clock times that peak on a weekday, a window naming only other days, six unplaceable windows (all failing closed to the base band), an unplaceable instant, and the scaled bands.
- `packages/llm/token-meter/tests/turn-usage.spec.ts` — each attempt's buckets, route and closing instant, including an attempt closed by a retry and one the provider never attributed.
- `packages/llm/llm-pi-ai/tests/model-cost.spec.ts` — a declared rate through the real profile resolver, a catalog rate, an unpriced gateway model, a half-stated pair, a declared peak band, a band applied over a catalog rate, and seven refused bands.
- `packages/llm/llm/tests/service.spec.ts` — the core's own detached-band validation and its refusal of a band it cannot place.
- `packages/client/ui-chat/tests/turn-cost.client.spec.ts` — one routed attempt, cache buckets, a peak-band attempt, a turn straddling the boundary at both bands, a model switched mid-turn priced per route, an unpriced route, an unrecorded route, an absent per-attempt record, and a rate missing a billed bucket.
- `packages/client/ui-chat/tests/turn-usage-panel.client.spec.tsx` — the amount at six decimals with each band note, including the straddling case.
- `packages/client/ui-trajectory/tests/table.client.spec.tsx` — the per-request and cumulative amounts, their band notes, and the straddling prefix.
- `packages/client/ui-model-selection/tests/rates.client.spec.ts` — cell formatting: two decimals kept, sub-cent precision kept, whole numbers trimmed, an absent cache rate omitted rather than shown as `$0.00`.
- `packages/client/ui-chat/tests/chat-stats.client.spec.tsx` — the load control: targeting the Turn the window entered midway, walking back one Turn when the window begins at a Turn start, paging through the right `turn/start` seq, hiding when history is exhausted, the busy state, and keeping the row alive when the only thing to show is an incomplete Turn.

Live confirmation used a real 97-Turn session: the control rendered `Load turn 100` beside `965M tok · Cache hit 99%`, and the target seq matched the session log (`turn/start` for turn 100 at seq 25703, window head at 26180 — genuinely partial).

## Known limitations

- **A headless client can lose its remote channel.** Verification browsers occasionally showed `Reconnect now` with the websocket failing (`HTTP Authentication failed`), which makes *every* paging action — including the pre-existing "Load earlier" — a no-op. Confirm the channel is alive before concluding that a load control is broken.
- **Context-tiered rates are floors.** DeepSeek's peak band is now modelled and priced per request, but pricing that varies with request *size* (Grok 4.6, Qwen3.7/3.6 Plus, GPT 5.6 Luna) still records its base tier only — the tier is not a function of the clock, and the transcript does not carry the token count the provider tiered on.
- **Only curated models have rates.** The rest of the CommandCode card was filled from its published table, but any model whose operator publishes nothing shows no amount rather than a guess.
- **`opencode-go` serves a different V4.1 Flash id.** Its production name is `deepseek-flash`, declared explicitly because the bundled catalog has no entry for it. The same API key also authenticates against OpenCode **Zen** (`https://opencode.ai/zen/v1`), but Zen does not serve V4.1 Flash at all — its listing has no such id and a request for `deepseek-flash` answers `401 "Model deepseek-flash is not supported"` — so V4.1 Flash is reachable only through Go (or DeepSeek directly, or CommandCode). Adding a Zen provider would be worth doing for its *other* DeepSeek rows, which are cheaper than Go's (`deepseek-v4-flash` at `$0.14/$0.28` against Go's `$0.15/$0.60`), but not for this model.
- **Pre-existing suite failure.** `packages/llm/plugin-package-inventory-deepseek/tests/inventory.spec.ts` fails on this machine because of a stray `/tmp/package.json` (`"name": "tmp"`); it fails on a pristine checkout too and is unrelated to these changes.

## Commit index

| Commit | Subject |
| --- | --- |
| `165591cce5` | web: allow `--host 0.0.0.0` for LAN and reverse-proxy access |
| `8269a9f757` | feat(llm-pi-ai): auto-refresh provider model catalogs on web page loads |
| `1d6fa0c310` | feat(llm-pi-ai): drop models the gateway retired from auto-refreshed catalogs |
| `a91cf74b9d` | feat(llm-pi-ai): never auto-add reasoning efforts to refreshed models |
| `c30df9864e` | feat(usage): price tokens at published model rates |
| `943c10eb61` | fix(ui-model-selection): keep two decimals in model rate cells |
| `b0156a62f8` | feat(ui-chat): move the turn loader beside the usage pill, show cache rates |
| `0b4e1333d9` | Merge remote-tracking branch `upstream/master` |
| `4329c8a4cb` | feat(ui-chat): walk the turn loader back through earlier turns |
| `35e16d23a1` | feat(usage): price each attempt at its own route and rate band |
| `6abf54ced1` | docs: record OpenCode V4.1 Flash ordering and the Zen availability limit |
| `24f40ec67d` | Merge remote-tracking branch `upstream/master` (0.1.5-rc.2, 134 commits) |
| (this change) | docs: complete the Bright Data package and re-point OpenCode's V4.1 Flash id |

Note that the Bright Data provider itself (`bbec969caa`, `71a4364138`, `9712944bae`) predates this index's first entry; the commits above are the ones a reader is most likely to want to find.

Related Agent Notes: `.agents/notes/implemented/feature/2026-09-10-published-model-rates-and-estimated-spend.md` (and its `.zh.md`).
