# DSH web profile — 办公部署

[English](README.md) | 中文

本机 `web` profile 的用户层，记录下来后即可复刻该部署，无需逆向 `/root/.dsh`。

## 内容

| 文件 | 作用 |
|---|---|
| `cordis.patch.yml` | profile 补丁：OpenCode Go 路由与默认模型 |
| `package.json` | profile 标识与 bundle 列表（固定 `dsh-opencode-go`） |

## 安装

```bash
# on the target box, with DSH_HOME=/root/.dsh
mkdir -p "$DSH_HOME/profiles/web"
cp cordis.patch.yml package.json "$DSH_HOME/profiles/web/"
dsh plugin --profile web install        # resolve the bundles package.json names
vi "$DSH_HOME/.env"                     # add OPENCODE_GO_API_KEY (never committed)
systemctl restart dsh-web
```

补丁中的 `apiKeyEnv` 指定一个环境变量；其值应写入 `$DSH_HOME/.env`，该文件不属于本仓库。

## 为什么 OpenCode Go 配置有三条路由

OpenCode Go 在一个 base URL（`https://opencode.ai/zen/go/v1`）之后前置三个 API，而一个模型只会在其中一个上应答。用错误的端点访问模型会失败并返回 `400 "Model does not support this protocol."`，已废弃的 `/chat/completions` 拼写则返回 `503`。

`pi-ai` 的协议是**路由**的属性，而不是模型的属性；网关的 `GET /models` 列表无论协议如何都会返回每个 id —— 因此这一划分无法从列表推导，必须显式声明：

| 路由 | 协议 | 承载 |
|---|---|---|
| `opencode-go` | `openai-completions` | 大多数模型；`autoRefresh` + `enrichFrom: models.dev` |
| `opencode-go-responses` | `openai-responses` | Grok 4.6/4.7、GPT-5.6 Luna、GPT-6 Luna、Muse Spark |
| `opencode-go-messages` | `anthropic-messages` | Claude Haiku 5.5、MiniMax-M2.7 |

两条手工声明的路由刻意省略 `autoRefresh`：共享列表会引入无法在该端点应答的 id。completions 路由上的 `excludeModels` 是同一划分的另一半 —— 在此列出的 id 既不会从列表加入，也不会从已存列表保留。

专用的 `dsh-opencode-go` 适配器与 `llm-pi-ai` 路由一同挂载，位于自己的 provider id（`dsh-opencode-go`，显示为 *DSH OpenCode Go*）之下。它从 models.dev 推导每个模型的协议，无需手工声明；它默认使用 `OPENCODE_API_KEY`，而本部署并未设置该变量，因此补丁将其指向 `OPENCODE_GO_API_KEY`。

Claude Haiku 5.5 是该网关在 Go 套餐下提供的唯一 Claude 模型。普通 `opencode` Zen 目录中的其他 Claude id（Opus、Sonnet）通过该凭据应答 `"Model is unavailable"`。

## 来源

端点归属与逐模型协议于 2026-10-12 对实时网关探测得出；容量、模态与费率取自 [models.dev](https://models.dev/api.json) 的 `opencode-go` 提供方。
