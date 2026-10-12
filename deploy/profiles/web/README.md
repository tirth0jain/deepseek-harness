# DSH web profile — office deployment

The user layer for this box's `web` profile, captured so the deployment can be
reproduced without reverse-engineering `/root/.dsh`.

## Contents

| file | role |
|---|---|
| `cordis.patch.yml` | profile patch: the OpenCode Go routes and the default model |
| `package.json` | profile identity and bundle list (pins `dsh-opencode-go`) |

## Install

```bash
# on the target box, with DSH_HOME=/root/.dsh
mkdir -p "$DSH_HOME/profiles/web"
cp cordis.patch.yml package.json "$DSH_HOME/profiles/web/"
dsh plugin --profile web install        # resolve the bundles package.json names
vi "$DSH_HOME/.env"                     # add OPENCODE_GO_API_KEY (never committed)
systemctl restart dsh-web
```

`apiKeyEnv` in the patch names an environment variable; the value belongs in
`$DSH_HOME/.env`, which is not part of this repository.

## Why the OpenCode Go config has three routes

OpenCode Go fronts three APIs behind one base URL (`https://opencode.ai/zen/go/v1`),
and a model answers on exactly one of them. Reaching a model on the wrong
endpoint fails with `400 "Model does not support this protocol."`, or `503` for
the retired `/chat/completions` spellings.

`pi-ai`'s protocol is a property of the **route**, not of a model, and the
gateway's `GET /models` listing returns every id regardless of protocol — so the
split cannot be derived from the listing and has to be declared:

| route | protocol | carries |
|---|---|---|
| `opencode-go` | `openai-completions` | most models; `autoRefresh` + `enrichFrom: models.dev` |
| `opencode-go-responses` | `openai-responses` | Grok 4.6/4.7, GPT-5.6 Luna, GPT-6 Luna, Muse Spark |
| `opencode-go-messages` | `anthropic-messages` | Claude Haiku 5.5, MiniMax-M2.7 |

The two hand-declared routes deliberately omit `autoRefresh`: the shared
listing would pull in ids that cannot answer on that endpoint. `excludeModels`
on the completions route is the other half of the same split — an id named
there is neither added from the listing nor kept from the stored list.

The dedicated `dsh-opencode-go` adapter is mounted alongside the `llm-pi-ai`
routes under its own provider id (`dsh-opencode-go`, shown as *DSH OpenCode
Go*). It derives each model's protocol from models.dev and needs no hand
declaration; it defaults to `OPENCODE_API_KEY`, which this deployment does not
set, so the patch points it at `OPENCODE_GO_API_KEY` instead.

Claude Haiku 5.5 is the only Claude model this gateway serves on the Go plan.
The other Claude ids in the plain `opencode` Zen catalog (Opus, Sonnet) answer
`"Model is unavailable"` through this credential.

## Provenance

Endpoint membership and per-model protocol probed against the live gateway on
2026-10-12; capacities, modalities and rates taken from
[models.dev](https://models.dev/api.json)'s `opencode-go` provider.
