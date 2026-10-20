# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="fork-additions"></a>

## 本 fork 的新增功能

本仓库是 DeepSeek Harness 的 fork：在上游全部能力之上，额外提供下列功能。每一项的动机、引入它的提交以及已知限制，都记录在 [CHANGES-AND-FEATURES.md](CHANGES-AND-FEATURES.md) 中；本节是使用这些功能的速查手册。

快速跳转：[访问与部署](#access-and-deployment) · [模型与目录](#models-and-catalogs) · [费用与用量](#cost-and-usage) · [对话](#chat) · [会话与内存](#sessions-and-memory) · [多用户隔离](#multi-user-scoping) · [网页搜索](#web-search)

### 一览

| 功能 | 你能得到什么 | 如何启用 |
| --- | --- | --- |
| [LAN 绑定](#lan-binding) | 接受 `--host 0.0.0.0`，并为信任围栏推导出它暴露的 LAN 地址 | `dsh web --host 0.0.0.0` |
| [声明的可信主机](#trusted-hosts) | 用围栏推导不出的名字访问，并能在该页面编辑设置 | `--trusted-host dsh.example.com` |
| [无 token 模式](#tokenless-mode) | 当已有其他环节负责认证时，跳过启动 token 握手 | `--no-browser-auth` |
| [部署包](#deployment-bundle) | systemd 自启动、token 写入器、安装脚本，以及一步完成重建与重启的脚本 | `deploy/install-dsh-web.sh`、`deploy/rebuild-dsh-web.sh` |
| [目录自动刷新](#catalog-refresh) | 每次页面加载都重读网关的 `GET /models` 列表；已下架模型自动移除 | `autoRefresh: true` |
| [models.dev 补全](#models-dev-enrichment) | 为不公布任何信息的网关补上上下文窗口、模态与价格 | `enrichFrom: models.dev` |
| [模型排除](#model-exclusions) | 双向拒绝某个模型，从而把它交给另一条 API 路由 | `excludeModels: [id]` |
| [按会话的 session header](#per-conversation-session-header) | 用网关指定的 header 名发送真实会话 id | `sessionHeader: x-opencode-session` |
| [reasoning-content 兼容](#reasoning-content-compatibility) | 通过不是以 DeepSeek 命名的网关回传 DeepSeek 思考轮次 | `compat: { requiresReasoningContentOnAssistantMessages: true }` |
| [公开价格与费用估算](#published-rates-and-estimated-spend) | 每个模型的目录价、按尝试计价的峰值时段，以及字数条与检查器里的金额 | 模型上的 `cost:`，或 `llm.cost` |
| [每轮吞吐](#per-turn-throughput) | 每个 Turn 运行时间旁的 `tok/s`，刷新页面后依然存在 | 无需配置，始终开启 |
| [Turn 加载控件](#turn-loading-control) | 长对话每次向回加载一个完整 Turn | 无需配置，窗口不完整时出现 |
| [文件下载](#file-downloads) | 保存上传的和已交付的文件，而不只是查看 | `?download=1`、`/api/attachment.download` |
| [持久化草稿](#durable-composer-drafts) | 输入未发送的提示词能跨重启保留，发送失败也绝不丢失 | 无需配置，自动生效 |
| [在新对话中继续](#continue-in-a-new-chat) | 把一个大 Session 压缩进新会话，并归档源会话 | 会话行菜单 |
| [作为真实会话的续接](#continuations-that-are-real-sessions) | 续接会话从创建那一刻起就可列出、可搜索、可持久 | 无需配置，自动生效 |
| [归档释放内存](#archiving-releases-memory) | 归档 Session 即释放其 Agent、事件图与日志，无需重启 | 会话行菜单 → Archive |
| [有界会话内存](#bounded-session-memory) | 窗口化读取、冷日志 memo 的字节预算、有界观察缓存 | profile patch（见下文） |
| [多用户会话隔离](#multi-user-session-scoping) | 一套 harness，每个身份各自一份会话列表，按拥有的目录强制执行 | `@deepseek-ai/dsh-session-scope` |
| [身份准入](#identity-admission) | 每个被准入的身份拥有自己的 Peer，流式连接也保持归属 | `setIdentityResolver` |
| [Bright Data 网页搜索](#bright-data-web-search) | 通过 Web Unlocker zone 搜索，消耗 Bright Data 的免费共享额度 | `searchProvider: brightdata` |

<a id="access-and-deployment"></a>

### 访问与部署

<a id="lan-binding"></a>

#### LAN 绑定

上游拒绝对所有接口做绑定；本 fork 移除了该限制，因此 harness 可以直接服务局域网，或放在反向代理后面，无需 SSH 隧道。

**用法：** 局域网或反向代理部署需要的正是通配绑定。

```sh
dsh web --host 0.0.0.0 --port 3080 --no-open
```

<details>
<summary>细节</summary>

`/api` 信任围栏没有改变：请求仍需要 loopback 授权、启动时为通配绑定推导出的地址，或显式声明的 `--trusted-host`。对 `0.0.0.0`，启动过程会为每个非内部接口推导一个不带端口的 IPv4 字面量，因此机器的 LAN 地址无需额外参数即可通过。

绑定所有接口不等于关闭认证。除非传入 `--no-browser-auth`，启动 token 握手仍会执行；静态资源保持公开，而 `/api` 仍然受围栏保护。

</details>

<a id="trusted-hosts"></a>

#### 声明可信主机，以及设置写权限

声明你实际用于访问的名字。同一个声明还会让该页面的设置页面可写，而不是灰显为只读。

**用法：** `--trusted-host` 可重复，条目不带端口，因此一条覆盖所有端口。

```sh
dsh web --host 0.0.0.0 --port 3080 --no-open \
  --trusted-host dsh.example.com --trusted-host codeserver
```

<details>
<summary>细节</summary>

围栏判断的是浏览器自身页面的 authority，也就是地址栏里的名字，而不是它解析到的地址。若反向代理把转发的 `Host` 改写成上游地址，仍然必须声明浏览器使用的名字，因为浏览器侧比较的是 `location.host`。

失败表现值得记住：未声明的名字能加载页面（静态资源是公开的），但每个 `/api` 请求都返回 403，于是 `ui-settings` 退回内存作用域，所有设置界面灰显并显示 "Settings are read-only."。插件故障不会连目录一起坏掉；403 才是证据。

上游用 `isLoopback` 控制设置文档，因此 authority 不是 `localhost` 或 `127.x.x.x` 的页面都在内存模式下运行：不读 describe，也不能写。本 fork 让浏览器侧与围栏得出同一结论——loopback 页面、authority 匹配已声明条目的页面，或拥有 Host 的 worker-local 传输——因此只能通过局域网访问的 headless Host 也能编辑自己的设置。`isLoopback` 对「在原生编辑器中打开设置文档」这一操作保持原义，因为它作用于 Host 机器。围栏本身没有改变：页面仍需可信 authority 和有效会话 cookie 才能发出任何 `/api` 调用，所以这扩大的是哪些浏览器可以写设置，而不是谁能访问服务器。

</details>

<a id="tokenless-mode"></a>

#### 无 token 模式

当已有上游环节对每个访客做认证时，每进程的启动 token 只是多余的摩擦。

**用法：**

```sh
dsh web --host 0.0.0.0 --port 3080 --no-browser-auth
```

<details>
<summary>细节</summary>

`--no-browser-auth` 让 browser-auth 接缝以开放模式挂载，而不是挂载签名密钥持有者：围栏准入的每个请求都视为已授权，`GET /` 直接返回而不经过 token 交换，不读取也不创建浏览器会话密钥，打印的 URL 不带 token。插件会在加载时向 stderr 输出警告，因此该状态不会悄无声息。

信任围栏没有改变。未声明的 authority 仍然 403；围栏放行之后，可达性本身就成了全部访问策略，因此只应在前置入口确实认证访客时使用该参数。

VS Code 侧边栏通过在 harness 记录的 URL 中匹配 `?token=` 来发现目标。关闭握手的部署应记录不带 token 的干净 URL；harness 会忽略的值不会与真实 token 冲突，因为真实 token 每个进程随机生成。

</details>

<a id="deployment-bundle"></a>

#### 部署包与一步重建

仓库自带本 fork 所使用的部署方式，另一台服务器可以按同样方式启动。

**用法：**

```sh
cd deploy
./install-dsh-web.sh
```

随后以分离进程的方式一步完成重建与重启——更新时执行的就是这一步：

```sh
setsid nohup /path/to/repo/deploy/rebuild-dsh-web.sh \
  >/root/.dsh/rebuild.log 2>&1 < /dev/null &
```

<details>
<summary>细节</summary>

`install-dsh-web.sh` 是幂等的。它安装 [`deploy/dsh-web.service`](deploy/dsh-web.service)（systemd 单元：开机启动、失败重启）、[`deploy/dsh-web-run`](deploy/dsh-web-run)（单元调用的前台运行器，从 `.env` 组装参数）、[`deploy/dsh-token-writer`](deploy/dsh-token-writer)（`ExecStartPost`，为侧边栏记录启动 token URL），以及 `deploy/dsh-sidebar/` 中自包含的 VS Code 侧边栏扩展。安装脚本还可选接收一个侧边栏使用的可达 origin 作为参数。

`rebuild-dsh-web.sh` 之所以是一次操作，是因为 Host 进程和它提供的 client bundle 属于同一次构建的两半：先停止正是让重建安全的关键。它停止单元，执行 `pnpm run clean`（该步骤防的是残留 `lib/` 产物）、`pnpm install`、`pnpm run build:lib`、`pnpm run build:web`，启动单元，并对 `http://127.0.0.1:3080/` 做 30 秒健康检查。构建失败时它拒绝启动：失败的构建会让服务保持停止、日志指明出错的步骤，这可以恢复；若强行启动，则会提供写了一半的产物，那无法恢复。`DSH_REPO`、`DSH_UNIT`、`DSH_HEALTH_URL` 可覆盖默认值。

第二个 checkout 可以与主实例并行服务，但必须处于同一提交：每次启动都会把 harness home 的 profile 模块符号链接重新指向自己的安装，因此漂移的镜像会静默改变另一个实例解析到的内容。请使用不同端口和更低的内存上限，并且绝不要在另一个实例正在服务时重建其中一个。

</details>

<a id="models-and-catalogs"></a>

### 模型与目录

<a id="catalog-refresh"></a>

#### 目录自动刷新

网关自己的模型列表成为「存在哪些模型」的事实来源，并在每次页面加载时刷新。

**用法：** 在 profile patch 层的 provider 路由上设置 `autoRefresh: true`。

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
<summary>细节</summary>

刷新会重新请求 `GET {baseURL}/models`，并把结果合并进 `llm-pi-ai` 的用户设置区，因此网关新增或下架模型时无需手工编辑。

合并刻意保守：列表中已有的条目保留每个已存字段，只有列表真正披露的容量才会替换已存值。已存模型若列表不再包含，会在下次刷新时删除——下架是网关的决定，刷新永远不会复活已下架的模型。

成功但为空的列表被视为歧义，而不是「所有模型都已下架」，因此网关的瞬时抖动不会清空已存目录；刷新把该结果报告为 `empty`，编排层会给出警告。

reasoning efforts 永远不会被自动添加。两个网关都不披露每模型的支持档位，因此自动新增的模型只携带列表披露的字段，档位按模型单独设置。

自动刷新会写入设置，因此需要可写的设置作用域；在设置页面被设计为只读的部署中，它不会产生任何效果。

顺序即选择器的顺序：刷新会保留部署精心排定的列表在前，只追加列表新增的 id，因此精心安排的位置能在每次页面加载后保留。若某个网关用两个 id 提供同一个模型，未声明的别名仍会以一条额外的裸行出现——那是端点在说话，而不是整理失败。

</details>

<a id="models-dev-enrichment"></a>

#### models.dev 补全

列表端点最多给出 id 和容量。补全会从公开的 [models.dev](https://models.dev) 目录填入上下文窗口、模态与价格，并且永不覆盖部署自己声明的值。

**用法：** 在同一条路由上添加 `enrichFrom: models.dev`。

```yaml
        autoRefresh: true
        enrichFrom: models.dev
```

<details>
<summary>细节</summary>

该目录被当作第三方对待，这正是整个设计。它只填部署未声明的内容：已声明的资费、已声明的模态主张和已声明的 reasoning efforts 都是意图，与意图冲突的第三方文档永远不会胜出。成员资格仍由端点决定：补全只装饰网关真正提供的 id，目录列出但网关不提供的模型永远不会被添加。列表自身对容量的披露仍然压过两者。

失败被限制在局部：文档不可达或结构变化时，已存配置保持原样，而不是让搭载它的页面加载失败，并且失败不会被缓存，下次加载会重试。该文档每进程最多每六小时抓取一次，并由所有启用的路由共享。

reasoning efforts 保持选择性开启（`enrichReasoning` 默认为 `false`）：目录提供的档位并不能证明网关接受它。上下文窗口、模态与价格默认采信。

该目录没有 `commandcode` provider，因此那条路由的价格仍留在下文的 `llm.cost` patch 层。若路由自己的 key 与目录的 provider id 不同，用 `modelsDevProvider` 指明目录中的 id；任何别名都不做猜测。

</details>

<a id="model-exclusions"></a>

#### 模型排除

有些网关在同一个 base URL 下、用不同 API 提供不同模型。`excludeModels` 可以把某个模型从一条路由上移走，而不会被自动刷新拉回来。

**用法：**

```yaml
        excludeModels:
          - grok-4.7
          - minimax-m2.7
```

<details>
<summary>细节</summary>

这里列出的 id 会被双向拒绝：既不会从列表中添加，也会从已存列表中删除。除此之外，成员资格完全由端点决定，而列表不会说明某个模型响应哪种 API——这正是排除项必须存在的原因。

声明了却什么都没拒绝的排除项会被报告，而不是被忽略，因为那里的拼写错误否则完全静默，路由会继续提供部署本打算移走的模型。

典型用法是网关的每模型端点不同：需要 `/v1/responses` 或 `/v1/messages` 的模型无法由协议为 `/chat/completions` 的路由提供，于是把它移到会说自己 API 的第二条路由。

</details>

<a id="per-conversation-session-header"></a>

#### 按会话的 session header

有些网关要求在其自选的 header 中携带稳定的会话 id，缺少就拒绝请求。

**用法：** 指定 header 名；harness 会把真实会话 id 放在该 header 下，每个会话一个。

```yaml
        sessionHeader: x-opencode-session
```

<details>
<summary>细节</summary>

静态 `headers` 条目满足了这类要求的字面，却让每个会话拿到同一个 id，而这正是网关所反对的：按会话的值才让它路由与缓存。把 header 名写进 `sessionHeader` 会发送真实会话 id，并优先于同名的静态条目；后者保留下来，作为请求没有会话 id 时的回退。

OpenCode Go 是现成例子：它要求 `x-opencode-session`，缺少时返回 `400 MissingSessionID`。`pi-ai` 的会话亲和 compat 发送自己的名字（`x-client-request-id`、`x-session-affinity`），因此网关指定了其他名字时无法只靠 compat 满足。

</details>

<a id="reasoning-content-compatibility"></a>

#### reasoning-content 兼容

DeepSeek 在思考模式下要求把上一轮 assistant 的 `reasoning_content` 回传。经由不以 DeepSeek 命名的网关时，客户端的自动探测识别不到它，请求就会以 `400` 失败。

**用法：** 在路由上显式声明。

```yaml
        compat:
          requiresReasoningContentOnAssistantMessages: true
```

<details>
<summary>细节</summary>

只有开启该 compat 标志时，`pi-ai` 才会在 assistant 消息上设置该字段，而自动探测依赖 `isDeepSeek`——对于命名为 `opencode-go`、指向 `opencode.ai`、背后却由 DeepSeek 模型作答的路由，这项判定会失败。

这是「网关代理他人模型」的通用风险：客户端里每一处按 provider 形状做的启发式判断，都依赖一个已不再描述实际应答者的名字或 URL。需要哪种 compat 就显式声明，不要依赖名字。

</details>

<a id="cost-and-usage"></a>

### 费用与用量

<a id="published-rates-and-estimated-spend"></a>

#### 公开价格与费用估算

用量界面除了 token 也显示金额，按运营方公开的目录价计算，DeepSeek 的峰值时段按每个请求实际运行的时刻定价。

**用法：** 为模型声明价格（或由目录／补全提供），并在适配器不报告价格的路由上使用 `llm.cost`。

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
<summary>细节</summary>

`LlmModelCost` 是公开目录价，不是账单记录，单位为 USD / 百万 token。`input` 与 `output` 必须同时给出；只给一半会被拒绝，而不会把缺失的桶当作零计价。缺席的桶保持缺席：未定价的模型完全不显示金额，而不是 `$0.00`，因为「没有公开价格」与「免费」是不同的事实。

峰值时段只声明一次，形式为倍数加时间窗，因为运营方公布的就是倍率。时间窗用三位小写星期缩写和零填充的 `HH:MM` UTC 表示，因此字典序即时间序。格式错误的时段——倍率非正、没有时间窗、没有星期、时间无法定位、结束早于开始——会在写入处被拒绝，而读取侧封住了时间窗无法定位的所有情形，因此坏规则按基础时段计价，而不是把每个估算翻倍。

计价按「尝试」而不是按 Turn：当模型在一轮中途切换，或时段边界在轮次运行中打开时，一个 Turn 的汇总桶无法用单一费率相乘。每个计费尝试按它自己的结束时刻所在的时段计价，再求和。时段来自持久记录，绝不来自渲染时的时钟，因此周一打开的对话不会重新按周一的峰值价格计算周六的轮次。

金额出现的位置：`/model` 弹窗和输入区席位中的每一行模型都显示 `$in / $out · cache hit $cacheRead`；Turn 的时钟徽章在运行时间与吞吐之后显示估算（`Ran for 2m 18s · 63 tok/s · $0.012345`），Turn 用量对话框以 `Estimated cost (list price)` 行重复该金额，并在时段有意义时附上 `(peak)` / `(off-peak)` 注记；Trajectory 用量检查器显示每个请求的金额和会话累计。

`llm.cost` 属于 profile 的 patch 层，而不是 `settings.yaml`：settings 服务是命名空间注册表，核心 `llm` 服务并未在那里注册 schema，因此 `settings.yaml` 中的 `llm:` 键会正常加载却毫无作用。

按上下文分档的费率卡仍只记录基础档，因为档位取决于请求大小而非时钟，所以这些估算是下限。

</details>

<a id="per-turn-throughput"></a>

#### 每轮吞吐

每个 Turn 的时钟徽章在运行时间旁显示自己的 `tok/s`，刷新页面后仍然存在。

**用法：** 无需配置，始终计算。当显示偏好 `performanceUsage` 为 `compact` 时隐藏，此时不显示每轮读数，但输入区底栏的读数仍在。

<details>
<summary>细节</summary>

该速率用 Turn 的汇总输出 token 除以各步骤的 LLM 时间跨度之和（`completedTime − stepStartTime`）。两个边界都是持久化事件，因此刷新后仍然可用；该跨度也排除了步骤之间的工具执行时间，那并非生成时间。

该跨度包含每个步骤的首 token 时间，因此长时间思考的 Turn 报出的速率会比仅按解码窗口计算略低——这是「每秒 LLM 时间内的 token 数」的诚实数字。没有生成 token 的步骤（纯工具调用）不贡献速率；没有采样生成的 Turn 保持纯时长，不留下悬空分隔符。

首 token 时间仍然只在实时流中可得：它需要 `firstTokenTime`，而会话格式不持久化任何时间信息。因此页面未自行流式接收的 Turn 会显示速率行而没有 TTFT 行。

</details>

<a id="chat"></a>

### 对话

<a id="turn-loading-control"></a>

#### Turn 加载控件

分页窗口只持有长会话的一部分，因此窗口从中间进入的 Turn 没有 token 汇总。该控件每次向回加载一个完整 Turn。

**用法：** 打开长对话，按输入区底栏统计行中、用量徽章之后的 **Load turn N**。每次按下都会带入标签所指的完整 Turn——从读者消息到模型响应结束——随后标签前移一个 Turn。没有可加载内容时控件隐藏。

<details>
<summary>细节</summary>

控件定位 `turn/start` 的 seq，循环会在 Turn 的提示词和步骤之前记录它，因此一次按下恢复的是完整 Turn 而不是片段。当窗口从某个 Turn 中间开始时，第一次按下先补完该 Turn，再往更早走；一旦窗口正好从 Turn 开始处开始，它就定位前一个 Turn。

区分完整 Turn 与部分持有需要窗口最旧事件的 seq：`SessionSnapshot.baseSeq` 暴露它，精确判据是 `baseSeq <= turn/start`。Turn 的第一个可见节点位于其 `turn/start` 之后，因此头节点的锚点无法做出这一区分。

</details>

<a id="file-downloads"></a>

#### 文件下载

到达 harness 的文件——无论是上传的，还是 agent 写出的——都可以保存，而不只是查看。上传附件是更糟的一半：上传存放在内容寻址存储里，只有不透明 id、没有文件系统路径，因此没有这条路由时，卡片一旦消失字节就不可达。

**用法：** 在界面中打开已交付文件卡片的菜单并选择 **Download**，使用工作区文件树中悬停出现的保存控件，或点击对话中已发送的文件。通过 HTTP：

```sh
GET /api/file?path=/absolute/path&download=1&name=report.pdf
GET /api/attachment.download?sessionId=<session>&attachmentId=<id>
```

<details>
<summary>细节</summary>

`download` 参数的存在本身就是请求，因此手写 `?download` 也有效，只有显式的否定值 `0` 与 `false` 表示退出。它会添加 `Content-Disposition: attachment`，并可用 `name` 覆盖保存的文件名；路径读取不变，因此同一路由既提供预览也提供保存。

`/api/attachment.download` 接收 `sessionId` 与 `attachmentId`，证明该附件可从该 Session 的日志到达（与图片路由相同的授权，只是推广到 file 与 image 块），并把存储中的字节直接流式写入 socket——上传内容在出去的路上不会落入 harness 进程的堆。

一个诚实的限制：声明式文件通过其工作区根定位，因此 Session 根未知且路径为相对路径的卡片完全不提供保存；该菜单项被禁用，而不是指向无法解析的 URL。侧边栏文档预览没有自己的保存控件——相同文件可从文件树与已交付文件卡片到达。上传的图片走附件路由下载，但灯箱目前没有保存手势。

</details>

<a id="durable-composer-drafts"></a>

#### 持久化输入草稿

输入了但未发送的提示词过去只存在于浏览器，因此 harness 重启时发送失败会丢失文本，服务端没有任何副本。

**用法：** 无需配置，自动生效。在某个 Session 中输入，刷新页面或重启服务后，草稿会随该 Session 一起回来。

<details>
<summary>细节</summary>

草稿在 Session 日志之外拥有按会话持久的归宿：session controller 通过 `composer_drafts` 存储域暴露 `session/composerDraft` 与 `session/setComposerDraft`。只有当浏览器没有草稿时，输入区才播种已归档草稿；随后在静默期之后把变更写回。

每个操作都是 fail-soft 的，因此没有存储的部署行为与之前完全一致。

发送失败路径不再把失败的提示词一直停放直到输入区为空：失败内容总会被恢复，追加在读者自上次恢复以来输入的内容之后，因此飞行期间输入的文本得以保留，失败的提示词仍然可见、可重发。

</details>

<a id="sessions-and-memory"></a>

### 会话与内存

<a id="continue-in-a-new-chat"></a>

#### 在新对话中继续

长 Session 在进程生命周期内被完整保留，而按契约 `/compact` 不会缩小日志。真正能缩小工作集的只有日志本身很小的 Session，因此会话行菜单提供把当前会话压缩进一个新会话。

**用法：** 打开会话行菜单，选择 **Continue in a new chat (condense this one)**。该操作会压缩源会话，把压缩结果作为新 Session 的完整历史带入，打开它，并归档源会话。Session 正在运行时该项被禁用。

<details>
<summary>细节</summary>

摘要是压缩后端自己的输出，而不是第二个摘要器，因此续接的压缩方式与原地 `/compact` 完全一致。该操作通过为 Agent 执行 `/compact` 到达后端，因为只有该上下文能看到预设被隔离的后端。

携带的历史是压缩后的对话，而不是摘要声明：压缩会原样保留最近的尾部（`retainRatio` 默认为上下文窗口的 0.16），而续接正是从这段尾部继续。开场消息为每个携带的轮次加标签（`User`、`Assistant`，检查点则为 `Condensed history`），且只携带文本块——工具调用及其结果是管道，其有用输出已被压缩保留。

续接是新对话，而不是被播种的对话：以未播种方式创建，唯一一条开场消息归属于 handoff 而不是读者，并被 steer 到它的 Agent 上，使第一步写入系统提示并把这段回顾作为它所引导的批次认领。这每个 handoff 花费一个模型轮次，换来一个从存在那一刻起历史就持久、可见、可搜索的续接。

每种拒绝都指明其前提：`session/handoff-unavailable` 携带稳定的 `reason`——`no-command-registry`、`no-compaction-command`、`compaction-refused`、`nothing-to-carry`——被拒绝的 handoff 会显示在全帧通知中，而不是让点击看起来像毫无反应。归档最后执行，其失败在结果中报告（`archived: false`）而不是抛出，因为打不开续接的调用方已经失去了生成它的工作。

</details>

<a id="continuations-that-are-real-sessions"></a>

#### 作为真实会话的续接

续接持有一段对话却没有运行过 Turn，这使它读起来像「空白」：因为未被选中而从会话树中隐藏，也被排除在搜索之外。

**用法：** 无需配置——续接从存在那一刻起就可列出、打开、重命名和搜索，并且永远不会被当作某人的 New Session 复用。

<details>
<summary>细节</summary>

列表元数据折叠会在 `agent/inbox/spliced` 的插入消息归属为 `kind: 'handoff'` 时清除 `blank`，这正是 handoff 自己写入的形状。投影的 `stateVersion` 升到 2，因此按旧版本折叠过的行会被重新折叠而不是复用，这也修复了规则存在之前创建的续接。

续接还继承生效目录，而不是原始项目目录，因此它的文件与工具在源对话实际运行的位置解析。

</details>

<a id="archiving-releases-memory"></a>

#### 归档释放内存

在此变更之前，归档集合只是一个持久标志：Session 的 Agent 保持存活，解析后的日志留在观察缓存中，解码后的日志可能仍在 memo 里，全都维持到进程结束。这正是「退役一个大对话」需要两次重启的原因。

**用法：** 在会话行菜单中选择 **Archive**，然后继续工作——无需重启。

<details>
<summary>细节</summary>

同一 Session 被三层分别持有，归档时依次被要求释放。工作区注册表以 `workspace/session-archived` 宣布一次持久归档（在状态写入之后，且仅当确实写入时），session controller 监听并释放：

- **Agent**，通过 controller 保留的句柄（它自己变为存活的 Agent 会被释放；本已存活的属于使用者，保持不动；不处于 idle 的也不动，因为中途停止循环会丢弃工作）；
- **解析后的冷事件图**，通过 `sessionQuery.releaseSession`（带有活跃租约的钉住条目会被刻意保留）；
- **解码后的日志**，通过 `SessionPersistence.release`，由 JSONL 后端覆盖以丢弃其字节有界 memo。

读取状态先于 Agent 释放，因此观察到 Agent 已消失的调用方可确信事件图也已消失。一切都是尽力而为且幂等的，失败会记日志而不是抛出：归档成功不应因为某个缓存无法丢弃而失败。

重新打开已归档 Session 会再次读取，代价与以往相同：释放是停止付费的方式，而不是免费查看的方式。剩余的副本是存活的 `Session.log` 本身，在进程重启前没有任何东西释放它。

</details>

<a id="bounded-session-memory"></a>

#### 有界会话内存

长对话在内存中被完整持有，一个 Session 就可能主导整个进程。这些开关把保留集合变成预算，而不是「看过多少对话」的函数。

**用法：** 配置位于 profile 的 patch 层，因为它们是部署策略而不是用户设置。

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
<summary>细节</summary>

`SessionHandle.read(offset, length)` 现在只保留请求的窗口，而不是先解码整个世代再切片：窗口被传递到真正保留事件的位置，而每一行仍会交给解码器，因此窗口外损坏的行仍会拒绝读取。完全落在窗口外的 compact 记录按其声明的 `eventCount` 计数且永不展开，长日志的体量正在那里。窗口化解码永不进入 memo，因为 memo 只按会话 id 索引，部分列表会被后续完整读取当作完整日志。这限制的是保留量而不是工作量：扫描仍会解码每一行，因此它不是延迟优化，`open` 仍执行自己的完整校验解码。

`coldLogMemoMaxBytes` 按解码后的 JSONL 字节而不是条目数限制 handoff memo，因为两个条目可能是两千兆字节。超出整个预算的日志根本不会进入 memo：handoff 宁可多解码一次，也不持有事件图。默认 64 MiB。

`preparedSessionCacheSize` 限制观察缓存，它为每个冷 Session 保留一份完全物化的事件图。出厂上限 5 是条目数上限，当一个条目可能是一千兆字节时它什么也限制不了；2 足以覆盖缓存存在的「先打开再翻页」场景。被活跃观察租约钉住的条目按设计豁免，因此这限制的是浏览，而不是并发工作。它在下次 harness 启动时生效。

`promoteOnHistoryOpen`（默认 `true`）决定打开 Session 是否恢复一个存活的 Agent。设为 `false` 让打开对话保持为读取：内存不再随「看过多少对话」增长，而是随「在用多少对话」增长，代价是在本进程尚未恢复的对话中首次提示时多做一次完整解码。提示仍然可用——每个真正需要 Agent 的操作都会按需解析一个——而归档会把事件图还回来。

</details>

<a id="multi-user-scoping"></a>

### 多用户隔离

<a id="multi-user-session-scoping"></a>

#### 多用户会话隔离

一套 harness 可以服务多个人而不共享同一份会话列表。认证访客的反向代理会断言每个请求属于谁；`session-scope` 插件把该身份映射到它拥有的目录，所有枚举会话或工作区的层都会应用它。

**用法：** 挂载该插件（它是本仓库中的包，bundle 或 profile 都可以声明它）并配置身份 header。

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
<summary>细节</summary>

`users` 把身份映射到它拥有的目录；`provisionRoot` 在该父目录下为未知身份铸造目录；`admin` 列出可见一切的 身份。`requireIdentity` 拒绝没有身份 header 的已准入请求，而不是回退到共享视图——当部署的可达性本身不是访问策略时，应使用该设置。

在没有 `admin`、没有 `users`、也没有 `provisionRoot` 的情况下加载该插件不会约束任何人：它对每个调用方都回答 `undefined`，harness 的行为与未安装该插件时完全一致。

执行依据是目录所有权，插件以辅助函数的形式把它开放给负责会话的层：`callVisibility` / `peerVisibility` 回答某个 `cwd` 对 Remote 方法调用方是否可见，`callRoots` 回答调用方拥有哪些目录（供选择器决定在哪里打开），`assertVisibility` 以 `session-scope/forbidden` 拒绝其外的路径。没有 `cwd` 的会话对受约束的调用方不可见，按 id 寻址的入口（`session.page`、`session.fork`、`session.export`）会被拒绝，而不只是从列表中过滤。

身份必须放在代理设置、客户端无法伪造的 header 里。这是部署属性而非插件属性：在 harness 之前终止认证并让代理注入 header，不要把 harness 端口直接暴露出去。

该插件需要 Connection 的身份准入（下一节）来归属请求。没有安装 resolver 时它仍按 Peer 回答，但每个请求都会共享浏览器 Peer，因此真正实现隔离的是这一对组合。

</details>

<a id="identity-admission"></a>

#### 身份准入

Connection 把每个请求准入为一个 Peer，而每个 Remote 调用已经把它的 Peer 作为 `invocation.peer` 接收。本 fork 增加了一个可选策略，使服务多用户的部署把每个身份准入为自己的 Peer，而不是共享的那个。

**用法：** 安装一个 `RequestIdentityResolver`。部署通常从 `session-scope` 插件获得它；自定义策略实现三个成员——`identityFromHeaders`、`requiresIdentity`、`remember(peer, identity)`——并用 `connection.setIdentityResolver(resolver)` 安装自己。

```ts
const restore = connection.setIdentityResolver(resolver)
restore()
```

<details>
<summary>细节</summary>

把身份放在 Peer 上而不是请求作用域的载体里，才能让流式连接正常工作：`session.follow` 与 `workspace.follow` 比打开它们的请求活得更久，而 Peer 是唯一随之存活的载体。没有任何签名需要新增参数，`PeerScope` 仍不记录 Peer 是谁——映射由 resolver 持有，这正是协议自身契约的要求。

策略是交给 Connection 的，而不是由它导入，因此 Connection 仍然对用户一无所知。未安装 resolver 时一切不变：每个已准入请求都代表其载体认证过的 Peer。安装后，每个身份铸造自己的 Peer，跨请求复用，并随服务一起销毁。

声明没有身份的请求在 `requiresIdentity` 为 false 时按共享 Peer 准入，为 true 时以 403 拒绝——失败关闭，而不是静默回退到可见一切的视图。

</details>

<a id="web-search"></a>

### 网页搜索

<a id="bright-data-web-search"></a>

#### Bright Data 网页搜索

第四个 `ctx.web` 搜索后端，与自带的 `exa`、`perplexity`、`deepseek` 并列。它不调用任何厂商搜索端点：它向 Bright Data Web Unlocker zone 请求 DuckDuckGo HTML 结果页并在本地解析自然结果，因此搜索返回可引用的 `url`/`title`/`snippet` 来源，永远不会编造答案或发布日期。

**用法：** 把该 provider 与 web 服务一起挂载；若有多个可用后端，固定选择。

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
<summary>细节</summary>

token 通过 harness 凭据存储解析（其本地 provider 也会读取启动环境），当该接缝不存在时仅从启动环境解析。

选择它之前值得了解三个怪癖。可用性判断不看 token：插件总是提供凭据解析器，因此它只检查端点可解析且 zone 非空——没有 token 的部署也会选中该 provider，而「搜索」会以 `WEB_PROVIDER_ERROR` 失败并指向 `BRIGHTDATA_API_TOKEN`，而不是 `WEB_PROVIDER_UNAVAILABLE`。`apiKeyEnv` 接受裸变量名；凭据引用语法拒绝 `$` 形式。每次搜索消耗 Bright Data 免费额度中的一个 credit，而免费额度是每月 5000 credits，由 Web Unlocker、SERP API、Web Scraper API、Scraper Studio 与 MCP 共享同一池子，`maxResults` 只在之后截断。

当部署需要生成式答案、发布日期或上游搜索控制项时，请选择其他后端。

</details>

[↑ 返回新增功能](#fork-additions)

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群！扫描下方二维码填写入群问卷，小助手会定期发送入群邀请。

<table>
  <thead>
    <tr>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

`pnpm run dev:web` 会在一个终端里完成构建、启动，并在源码修改时重建 client bundle；`make help` 列出 Web 与 Desktop 对应的 Make target。完整表格见开发指南的「应用命令」一节。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
