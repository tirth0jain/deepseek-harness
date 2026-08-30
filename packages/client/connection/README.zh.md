---
description: "Web GUI 的浏览器-Host 线层：Remote RPC、带重连的事件流投递、精确 Fetch 路由、/api HTTP 桥与浏览器信任栅栏。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

## 概述

本包承载浏览器到 Host 的 Remote 调用、精确 Fetch 响应与 connection generation。Client 插件挂载 `ctx.connection`，其中包含当前页面的 loopback 状态、通用 RPC carrier、当前 generation 及其 Host 信息、可观察的恢复状态、立即重连命令，以及单一 generation source 的注册点。source 报告 ready 后 generation 才可见；source 结束、失败、被撤回或显式 stop 都会清空它，再由 `ConnectionController` 执行重试策略。

## 目录

- [使用本包](#use-this-package)
- [无浏览器认证下的请求信任](#request-trust-without-browser-authentication)
- [Connection generation](#connection-generation)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

浏览器通过 HTTP POST 执行 Remote 一元调用；API Gateway 自己拥有 `/api/remote.mux` WebSocket 及其逻辑流。进程内组合通过 `connection.rpc.open` 提供等价的 Remote 流，不打开 WebSocket。Host half 拥有唯一 `/api` route、Fetch bridge、Host/Origin 校验与精确 `GET`/`HEAD` 路由注册表。Typert Gateway 认领生成的 Remote endpoint，功能包注册 Session 日志下载等非 JSON 响应，未认领的请求返回 404。Loopback hostname 判定只供浏览器侧当前页面状态使用，留在包内。

-----

<a id="request-trust-without-browser-authentication"></a>
## 无浏览器认证下的请求信任

本 fork 已**禁用**浏览器会话认证：没有启动令牌、没有持久 cookie、没有 401 门槛。`authenticatedUrl` 原样返回 URL，`authorizeIndex` 始终放行 index，所有可信请求无需凭据即可被服务。`dsh-web-app` 直接打印并打开干净的根 URL；`frontend-static` 通过 `ctx.connection.authorizeIndex` 服务根路径和 index 请求，而该检查是无操作。静态资源与 index 均公开。

仍然保留的是 `src/api-request-trust.ts` 中的请求信任防线，应用于每次分发前的每个请求。其 `Host` 必须是 loopback，或与 `trustedHosts` 条目匹配：带端口的 `host:port` 精确匹配，不带端口的条目匹配任意端口，两侧均经 WHATWG 归一化。若附带 `Origin`，它必须等于该 Host；`sec-fetch-site: cross-site` 一律拒绝。畸形配置 authority 会让插件加载失败。这些检查防御 DNS rebinding 与跨站浏览器请求，绝不建立身份。Host/Origin 校验失败返回 403；可信请求始终被服务。`dsh web --host 0.0.0.0` 受支持：绑定所有接口即可服务局域网，Host 防线放行 loopback、派生的 LAN 字面量以及任何 `--trusted-host` 条目。决策记录：[浏览器请求信任](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.zh.md)。

<a id="connection-generation"></a>
## Connection generation

API Gateway Client 把内部 `$events` logical stream 注册为唯一 generation source，与有无 `$on` 订阅无关。Host 在 API Remotes source factory 同步挂好所有增量 listener 后，先发送唯一 `{ type: 'ready', clientId, host: { home } }` 项，再发送事件。`ConnectionController` 仅在收到该 ready 项后发布 generation 并调用 `onConnected`，因此 baseline 不会跑在增量 listener 前面。

`$events` 结束、返回 Remote stream error、收到非 ready 首项或畸形事件项，都会使当前 generation 失效。浏览器报告网络可用时，Controller 发布 `connecting`，并在 500ms、1s、2s、4s、8s 与 10s 上限内采用 50%–100% 抖动重试。它记录每次尝试、要求 Gateway 替换物理 WebSocket，再重开 `$events`；10s 档失败后发布终态 `disconnected`。`ctx.connection.reconnect()` 会中断活动工作、重置序列，并立即开始 retry 1。浏览器 `offline` 会中断活动工作、发布 `disconnected` 并暂停自动尝试；下一次 `online` 转换会重置序列并从 500ms 档开始。ready 项会发布 `connected`。Gateway mux 每次收到请求只做一次物理连接尝试，不再运行另一套重试调度。[连接恢复决策](../../../.agents/notes/implemented/feature/2026-08-28-web-connection-recovery-control.zh.md)规定重试节奏和手动恢复行为。

<a id="model-experience"></a>
## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **`/api` 桥把每个请求体整体缓冲在内存里**：`maxRequestBodyBytes`（默认 300 MiB，按默认 200 MiB 图片总量上限经 base64 膨胀加信封余量得出）因此同时是单请求的驻留内存上界；要降低它而不缩小图片限额，需要流式请求体路径。
- **无浏览器认证**：本 fork 在没有任何登录门槛的情况下服务所有可信请求；Host/Origin 防线只是 rebinding/跨站防御，不是身份，因此网络可达（`0.0.0.0`）的部署应放在可信网络中。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
