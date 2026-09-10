# Agent Note：公开模型费率与预估花费

Status: implemented

[English](2026-09-10-published-model-rates-and-estimated-spend.md) | 中文

## Problem

harness 的每个用量界面此前只报告 token。读者能看到某一轮消耗了 15.8K token，却看不到这一轮要花多少钱，于是比较两条路由——便宜的 flash 模型与旗舰模型——必须离开产品去手工查价。信息其实已经在进程里：已安装的 pi-ai 目录为其描述的模型标了价，而 `catalog.ts` 读到了那个 `cost` 字段，却因为没有任何消费方报告花费而把它藏在全零哨兵值后面丢弃了。

本部署实际服务的网关路由（CommandCode、OpenCode）在各自的模型端点上根本不发布价格：`/models` 只回答 id、名称和上下文长度，别无其他。两家运营方确实会在自家网站上公布费率表，但那是散文式页面而非机器可读字段，而且它们变化时已安装的目录不会跟随——内置的 pi-ai 目录仍然携带 2026-09-10 之前的 Flash 费率，而过期的目录会把每一轮 Flash 按错误费率计价，而不是拒绝计价。因此「为用量定价」需要两半——让部署能够声明目录没有携带的费率，以及一个把 token 桶折算成金额、并在没有费率时不凭空发明的折叠。

## Decision

**`LlmModelCost` 是公开标价，不是账单记录。** 该类型位于 [types.ts](../../../../packages/llm/llm/src/types.ts)，随 `LlmResolvedModelInfo.cost` 传递，经由 `normalizeModelInfo`（把每个声明的价格校验为有限非负数）贯穿，并由 `buildModelCatalog` 暴露给浏览器上的 `ModelCatalogModel.cost`。它的 JSDoc 写明了使它保持诚实的那条契约：部署实际支付什么属于部署自己的合同，所以这里是供展示的标价；而缺失的桶保持缺失，而不是默认为零——因为「这条路由不对缓存写入收费」与「没有人公布费率」是两件不同的事实，只有前者可以乘进总额。

**模型条目自行声明费率；只声明一半的价对会被拒绝。** [catalog.ts](../../../../packages/llm/llm-pi-ai/src/catalog.ts) 中的 `PiAiModelProfile.cost` 接受 `input`、`output`，以及可选的 `cacheRead` 与 `cacheWrite`——单位为美元/百万 token。`declaredCost` 要求 `input` 与 `output` 同时给出：只给出其一会让另一桶在该模型服务的每个请求上按零计费，而这恰好会在最需要准确的地方低估花费，因此它抛出 `PiAiCatalogError` 而不是接受。声明的费率优先于已安装目录的费率；未声明的条目保留目录的费率。全零的 `NO_COST` 哨兵值仍然表示「没有费率」，`pricedCost` 正是适配器在决定是否报告 `cost` 时区分两者的依据——未定价的模型什么也不暴露，而不是 `$0.00`，因此没有公开费率的路由显示为空，而不是显示为免费。

**花费由同一个折叠估算，并且它拒绝不诚实的总额。** [usage-cost.ts](../../../../packages/llm/token-meter/src/usage-cost.ts) 中的 `estimateUsageCost` 把每个承载 token 的桶乘以其每百万费率，最后统一缩放一次。当某个桶承载 token 而费率并未为其定价时，它返回 `undefined` 而不是部分和——因为一个默默把该桶按零计费的总额比没有总额更糟。`sumUsageCosts` 跨多次读数相加并跳过无法定价的那些，因此一个未定价的请求不会让同一会话中已定价的请求失效。

**两个界面消费它，且都把缺口留作缺口。** [turn-cost.ts](../../../../packages/client/ui-chat/src/client/chat/turn-cost.ts) 用 `deriveTurnTokenUsage` 已经推导出的桶为单轮定价，并在该轮计费跨多条路由时什么也不报告：中途换过模型的轮次所报告的桶无法用任何单一费率解释，而把它们全部按某条路由的费率计价就是编造数字。该金额以六位小数作为 `Estimated cost (list price)` 行出现在 Chat 的轮次用量对话框中——单轮花费常常不足一分钱，用两位小数会把读者正在查看的轮次打印成 `$0.00`。Trajectory 账本用每个请求自身请求视图记录的路由为其定价，把累计值作为 `cumulativeCost` 携带，并在其 Usage 检查器的 `This request` 与 `Session cumulative` 两块下分别显示两半。

两个视图读取的都是模型选择器自己的按会话目录（`ctx.modelDirectories`），而不是第二个目录，因此在设置中修改的费率无需刷新即可为下一轮定价；没有挂载该插件的部署会得到一个稳定的空数据源，从而不渲染任何金额。由于阅读对话的人可能从不打开选择器，每个视图会自行加载该目录；让它闲置就会什么都定不了价。

**只加载了一部分的轮次不报告任何金额，而 composer 停靠区可以把它补全。** 从一轮中间开始的窗口既不持有该轮的提示词，也不持有它的全部步骤，因此其合计无从得知；报告这个碎片会低估读者正在查看的那一轮。窗口头部会与宿主机整份日志的 `turnOutline` 投影中最新的一条比对——正是轨道跳转在重新分页前所跑的那个 `uncovered` 判定——只要头部更靠后，composer 停靠区的统计行就会在用量药丸旁边提供一个 `Load turn N` 控件。它经由该条目的 `turn/start` seq 分页，而循环是在该轮的提示词与各步骤*之前*记录这个 seq 的，因此一次点击就会把整轮取回：从读者的消息一直到模型回复的结尾。它挂在停靠区而不是轮次轨道上，因为轨道的悬浮卡片是读者最后才会去看的地方——控件必须待在阅读用量的地方。这也使它位于 Chat 视图之外，因此该停靠区的注册从 Session 绑定注入 `loadThrough`，而不是继承视图的 prop；并且用 `hasMore` 把关，使一个永远无法完成的控件不会出现。

模型选择器与 composer 座位中的每一行还以 `$in / $out` 显示费率，这正是让顺序变得可读的原因：部署的 `models` 列表顺序就是选择器的顺序。两个入口都经由 `rates.ts` 中同一个共享的 `formatRate` 渲染，因此同一条路由不会在两个菜单里出现两种写法。它至少打印两位小数：把末尾的零一路裁掉会把线上的 `$0.60` 输出费率变成 `$0.6`，一眼看去像是另一个数字，因此只有整数才去掉小数，低于一分的费率则保留其精度。当该路由公布了缓存命中费率时，它也会出现在同一个单元格里，因为在长时间的 agent 对话中大多数提示 token 都是缓存读取，决定账单的是那个费率而不是标称的一对价格；没有公布该费率的路由只显示那一对价格，而不是显示一个谁都不该拿来相乘的 `$0.00`。

## Alternatives considered

**只在 `PiAiModelProfile` 上加价格字段。** 那样部署可以声明费率，但金额仍然没有通向任何界面的路径；`LlmModelCost` 这道接缝正是让同一个折叠服务 Chat、Trajectory 以及此后任何界面的东西。

**从 pi-ai 目录为网关模型推导费率。** `opencode-go` 的目录把 `deepseek-v4-flash` 标为 `$0.22/$0.66`，那样无需一行配置就能为每个自动刷新的模型显示金额。它被否决了：价格属于实际计费的端点，而不属于描述另一个端点的厂商目录，而且内置目录会过期——2026-09-10 DeepSeek 下调 Flash 费率后，该条目仍在按 `$0.22/$0.66` 为一条 CommandCode 与 OpenCode Go 线上费率表都写着 `$0.15/$0.60` 的路由计价，于是推导出的金额会高出五成，却依然显得权威。目录价格仍然是目录模型的来源，那才是它权威的地方。

**把缺失的一半费率按零计费。** 方便，但恰好在要紧的方向上出错：每个请求都会低估花费，而那个数字看起来还很权威。

**把缺失的费率默认为零并总是渲染金额。** 那样未定价的路由会被读成免费——这是花费界面绝不能给出的那一个错误答案。

**用第一条路由的费率为跨路由轮次报告总额。** 该轮的桶并未按路由拆分，因此这样算出的总额没有描述这一轮；界面选择什么都不显示，读者便看得出没有单一费率适用。

## Verification

- `pnpm exec vitest run packages/llm/token-meter packages/llm/llm packages/llm/llm-pi-ai packages/api/session-controller packages/client/ui-chat packages/client/ui-trajectory packages/client/ui-model-selection`
- `usage-cost.spec.ts` 覆盖缩放求和、不足百万的情形、跳过空桶、无法定价桶的拒绝，以及空读数；`turn-cost.client.spec.ts` 覆盖单路由轮次、缓存桶、路由切换、未定价路由、未记录路由，以及缺少某个已计费桶的费率。
- `model-cost.spec.ts` 经由真实 profile 解析器解析声明的费率、为目录模型读取目录费率、为未定价的网关模型报告无费率，并拒绝只声明一半的价对。
- `turn-usage-panel.client.spec.tsx` 与 `table.client.spec.tsx` 在两个界面断言渲染出的金额及其缺失。
- `rates.client.spec.ts` 锁定该单元格的格式：整数费率保留两位小数，低于一分的费率保留精度，整数去掉小数，浮点噪声在四位处舍入，而缺失的缓存费率会被省略而不是渲染成 `$0.00`。
- `chat-stats.client.spec.tsx` 覆盖该加载控件：它恰好在窗口起点晚于最新一轮的 `turn/start` seq 时出现，经由该 seq 分页，在该轮已被覆盖或分页已尽时隐藏，在加载中显示忙碌文案，并在唯一可显示的内容就是那一轮未完成轮次时仍保持统计行存活。
- 在 [llm-streaming.zh.md](../../../../docs/subsystems/llm-streaming.zh.md) 上记录 `LlmModelCost` 之后运行 `pnpm run verify-type-equiv`。
