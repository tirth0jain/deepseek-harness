---
description: "ctx.web 的 Bright Data 搜索提供方：部署方如何挂载 Web Unlocker 搜索，通过 Bright Data 的免费共享额度读取 DuckDuckGo 结果页。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-brightdata

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-brightdata`，harness 可以通过 Bright Data Web Unlocker zone 搜索 web：该 zone 抓取 DuckDuckGo HTML 结果页，产出带标题与可选 snippet 的可引用来源。当部署持有 Bright Data API token，并希望每次搜索从 Bright Data 的免费共享额度（5,000 次请求／月）中消耗一个 credit 时选择它。结果不携带生成式 `content`、不携带发布日期，请求也不携带线上结果数量控制，因此服务随后按 `maxResults` 截断；目标地址无法解析的结果会被丢弃。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务的组合中挂载本提供方；它以 `brightdata` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: brightdata` 固定。

### 何时选择

当部署持有 Bright Data API token，并希望公开 web 搜索的成本来自 Bright Data 的免费共享额度（5,000 次请求／月，涵盖 Web Unlocker、SERP API、Web Scraper、Scraper Studio 与 MCP）时，选择此后端。该提供方不打开浏览器，也不调用厂商搜索端点：它让 Web Unlocker zone 返回 DuckDuckGo HTML 结果页，并在本地解析自然结果。当部署需要生成答案、发布日期或上游搜索控制项时，选择其他后端（`dsh-web-search-exa`、`dsh-web-search-perplexity`、`dsh-web-search-deepseek`）。只有当 `baseURL` 无法解析或 `zone` 为空时，提供方才不可用——此时每次搜索都以结构化选择错误失败。缺少 token 不影响可用性，因为插件总会提供凭据解析器；此时搜索本身以 `WEB_PROVIDER_ERROR` 失败，消息中指明 `BRIGHTDATA_API_TOKEN`。

### 最小配置

加载 web 服务与本提供方；token 通过 `ctx.credentials` 解析（其本地提供方也会读取启动环境），在该 seam 缺席时则只从启动环境解析，其余设置都有默认值。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-brightdata'
  config:
    apiKeyEnv: BRIGHTDATA_API_TOKEN
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | 未设置 | Bright Data API token 字面值；优先使用 `apiKeyEnv`，避免密钥进入配置。非空字面值优先 |
| `apiKeyEnv` | `$BRIGHTDATA_API_TOKEN` | 每次搜索解析的凭据引用；写裸变量名如 `BRIGHTDATA_API_TOKEN`，绝不要带 `$` 前缀 |
| `baseURL` | `$BRIGHTDATA_BASE_URL`，否则 `https://api.brightdata.com` | 端点基址；追加 `/request`。无法解析时提供方不可用 |
| `zone` | `mcp_unlocker` | 请求中发送的 Bright Data zone 名称；为空时提供方不可用 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-brightdata)是每个受支持字段及其 JSDoc 的穷尽式真源。上面的条目是提供方 Settings 段的 base 层；叠加其上的用户层会作用于下一次搜索，因为提供方是按次投影该段，而不是在注册时固化它。

### 搜索返回什么

每个解析出的 DuckDuckGo 结果映射为一个 `WebSearchSource`：`url`（重定向包装已解析）、`title`，以及仅在页面确实携带时才有的 `snippet`；`publishedAt` 从不设置。`content` 始终省略，因为页面不携带生成答案。提供方报告 `truncated: false`——它不发送结果数量控制，返回页面上有的内容——服务则通过截断并标记来强制执行 `maxResults`。目标 URL 无法解析、或标题在剥离标签后为空的结果会被丢弃，因此返回来源可能少于请求数量。

### 失败与恢复

失败抛出带机器可路由错误码的 `WebError`：调用方取消为 `WEB_ABORTED`，提供方或传输失败为 `WEB_PROVIDER_ERROR`。缺少 token 时失败消息会指明 `BRIGHTDATA_API_TOKEN`、凭据存储以及 `apiKey`／`apiKeyEnv` 字段；非 2xx 响应使用 Bright Data 自己的 `error`／`error_code` 文本及其 `details[].message` 提示，响应体不是 JSON 时为 `Bright Data API error (HTTP <status>)`；网络请求被拒绝或发生重定向时报告 `Bright Data search request failed: <error>`；响应体无法读取时报告 `Bright Data returned an unprocessable response body: <error>`。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝。面向模型的 `web_search` 工具会在自己的错误包装层内呈现这些文本。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方是 Bright Data Web Unlocker 端点之上的薄适配器，遵循三条刻意的规则：

- **不使用浏览器，也不调用厂商搜索 API。** unlocker 原样返回 DuckDuckGo HTML 页面（`format: 'raw'`），因此提供方解析的就是读者会看到的同一份标记，绝不虚构生成答案。
- **每次搜索一个 credit。** 每次 `/request` 调用都消耗免费共享额度，且请求不携带结果数量或检索模式；`maxResults` 只是事后的 seam 上限，而不是成本控制。
- **未知实体原样保留。** 数字与十六进制字符引用会解码，但无法识别的命名实体会按原样保留——错误猜测会捏造 snippet 文本。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、凭据与端点解析、Settings 段、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `BrightDataSearchProvider`：请求分发、中止分类、DuckDuckGo 解析、结果映射 |
| [`src/types.ts`](src/types.ts) | Bright Data 协议类型：`BrightDataUnlockerRequest`、`BrightDataError`、`ParsedSearchHit` |
| — | 不发布运行时不变量配套入口；除所属 seam 强制执行的约定外，本包没有独立的事件序列或可变数据关系。 |

### 请求与映射流程

`search()` 把 `{ zone, url: "https://html.duckduckgo.com/html/?q=<encoded query>", format: 'raw' }` 以 bearer token、`redirect: 'error'` 与 `deepseek-harness` user agent POST 到 `{baseURL}/request`。返回页面逐锚点解析：每个 `result__a` 锚点开启一项结果，其 `uddg` 重定向包装解析为目标地址，该结果片段中第一个 `result__snippet` 锚点提供 snippet。没有可解析目标地址或标题为空的结果会被丢弃。中止——名为 `AbortError` 的 `DOMException`——变为 `WEB_ABORTED`；其余情况变为 `WEB_PROVIDER_ERROR`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与设计依据。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的搜索请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——web 包家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方来源的面向模型 `web_search` 工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-brightdata)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-web` 间接影响模型体验。该工具保留本提供方经 `maxResults` 限制的 DuckDuckGo 结果 URL、标题与可选 snippet；如果发生失败，则会在消费方的错误包装层内保留原样错误消息 `Bright Data search aborted`、`Bright Data search request failed: <error>` 和 `Bright Data returned an unprocessable response body: <error>`。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方在哪些情况下不合适。它们是当前包约束。

- **可用性检查忽略 token**——插件总会提供凭据解析器，因此 `available()` 只反映端点可解析且 zone 非空；没有 token 的部署仍会选中本提供方，搜索以 `WEB_PROVIDER_ERROR` 失败，而不是 `WEB_PROVIDER_UNAVAILABLE`。
- **每次搜索都消耗一个 credit，无论返回什么**——免费共享额度按 `/request` 调用消耗，包括没有解析出任何结果的调用，而 `maxResults` 只在事后截断。
- **来源不携带生成答案，也不携带发布日期**——解析出的页面只提供 `url`、`title`，有时提供 `snippet`；目标地址无法解析或标题为空的结果会被丢弃。
- **`apiKeyEnv` 只接受裸变量名**——凭据引用语法会在任何搜索运行之前以 `TypeError` 拒绝带 `$` 前缀的值，因此配置 `BRIGHTDATA_API_TOKEN`，而不是 `$BRIGHTDATA_API_TOKEN`。
- **按错误形状分类中止**——只有名为 `AbortError` 的 `DOMException` 才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）呈现为 `WEB_PROVIDER_ERROR`。
- **默认 zone 假定使用 Bright Data 的免费 MCP provisioning**——除非 `zone` 指定部署自己的 zone，否则使用 `mcp_unlocker`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和相关 Agent Note 为准。

#### 未来：提供方无关的搜索控制项

Bright Data 的 SERP API、国家与语言定向以及任何结果数量控制仍未公开。公开它们需要先有提供方无关的服务字段，让家族以一个协调一致的控制项、而非厂商专有参数的方式新增。

#### 开放问题：解析器的耐久性

提供方解析 DuckDuckGo 的类名，因此标记变化可能悄悄减少结果数量。记录页面 fixture 能让这种回归可见；目前还没有这样的 fixture。

</details>
