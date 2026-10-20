---
description: "共享 harness 部署中的按用户会话隔离：把反向代理断言的身份映射到它拥有的目录，使一个办公室共用一套 harness 而不共用会话列表。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-scope

[English](README.md) | 中文

## 概述

一个办公室、一套 harness、若干个人。没有这个插件时，每个用户在侧边栏都能看到所有工作区和所有会话；启用之后，用户只看到自己拥有的根目录之下的工作区与会话，管理员看到全部，而首次使用的用户会获得一个自己的工作目录。归属是路径前缀，身份来自反向代理注入的 header，执行则搭载在每个请求被准入时所属的 Peer 上。这是一个**减少杂乱、在同事之间保持隐私**的功能，而不是安全边界——[这不是什么](#what-this-is-not)说明原因。

## 目录

- [归属模型](#the-model)
- [身份如何到达执行点](#how-identity-reaches-enforcement)
- [执行点](#enforcement-points)
- [目录铸造](#provisioning)
- [配置](#configuration)
- [技能保持共享](#skills-stay-shared)
- [这不是什么](#what-this-is-not)
- [开发备注](#dev-note)

-----

<a id="the-model"></a>
## 归属模型

归属是**路径前缀**，而不是固定目录。部署为每个身份声明一个根目录，一个会话或工作区属于「其根目录包含它的 `cwd`」的那个人：

```
/root/punit              → punit@rubysteels.com
/root/punit/site-survey  → punit@rubysteels.com   (a second workspace, same owner)
/root/ruby               → the administrator
```

因此一个用户可以在自己的根目录下任意拥有多个工作区。新增工作区不需要任何新配置：在自己的根目录下创建一个目录，就是全部动作。

前缀判断是分隔符感知的，所以 `/root/punit2` **不**属于 `/root/punit` 的所有者；`..` 会在比较之前解析，因此构造出来的 `cwd` 无法爬出自己的根目录。两种情况都由 `tests/policy.spec.ts` 覆盖。

<a id="how-identity-reaches-enforcement"></a>
## 身份如何到达执行点

身份本来就已经到达。Caddy 的 `forward_auth` 会执行 `copy_headers X-Auth-Request-User X-Auth-Request-Email`，因此到达 harness 的每个请求都携带已认证的地址。在这个插件之前，harness 里没有任何东西读取它。

这套机制刻意做到**不需要新的管道**：

1. `HostConnectionService.admit()` 是每个请求都要经过的唯一入口——HTTP RPC、精确 Fetch 路由、WebSocket mux 升级都会调用它。
2. 本插件实现 Connection 的 `RequestIdentityResolver`，并用 `connection.setIdentityResolver(this)` 安装它。此后 `admit()` 读取该 header，返回**每个身份各自的 Peer**，而不是共享的浏览器 Peer。
3. 每个 Remote 调用已经把自己的 Peer 作为 `this.ctx.invocation.peer` 携带，每个流也携带它被准入时的 Peer。流比任何请求作用域上下文活得更久，这正是身份搭载在 Peer 上而不是放在 `AsyncLocalStorage` 里的原因。
4. 执行点询问 `ctx.sessionScope.scopeOfPeer(this.ctx.invocation.peer)`。

`PeerScope` 仍然不记录 Peer 是谁——插件自己持有 Peer 到身份的映射，这正是协议自身文档所要求的。

<a id="enforcement-points"></a>
## 执行点

列表路径不是到达会话的唯一方式；大约十几个 RPC 直接接收原始会话 id，绕开任何列表过滤。它们全部在范围内：

| 界面 | 位置 |
|---|---|
| 会话列表 | `packages/api/session-controller/src/list.ts`（`ApiSessionList.list`） |
| 内容搜索 | `packages/api/session-controller/src/list.ts`（`search`） |
| 工作区列表与 `follow` | `packages/workspace/workspace`（注册表 `list`、header 索引） |
| 会话 page / follow / rename / fork / prompt / attachments | `packages/api/session-controller/src/{history,commands}.ts` |
| 目标 | `packages/goal/goal`（`goals.*` 接收原始会话 id） |
| 定时任务 | `packages/schedule/schedule`——`catalog` 会枚举**每个**会话的提醒 |
| 会话导出 | `GET /api/session.export` |
| 输入草稿 | `packages/api/session-controller/src/composer-draft.ts` |
| 工作区 create / archive / pin | `packages/api/workspace-controller` |

有两处夹紧是承重的，而不是装饰性的：

- `session.create` 接受任意 `cwd`，否则用户可以把会话指向别人的目录，并通过自己的 agent 读取它。
- `workspace.create` 接受任意路径，后果相同。

<a id="provisioning"></a>
## 目录铸造

设置 `provisionRoot` 后，没有 `users` 条目的身份会在 `<provisionRoot>/<slug>` 处获得一个根目录，其中 slug 是地址的本地部分，把 `[a-z0-9._-]` 之外的字符折叠掉。slug 永远不会是 `.`、`..` 或点文件。该根目录在磁盘上存在之前就被立即视为已拥有，因此首次使用的用户可以一次创建出第一个工作区，无需第二次往返。

<a id="configuration"></a>
## 配置

默认关闭。在没有 `admin`、没有 `users`、也没有 `provisionRoot` 的情况下加载，插件不约束任何人，harness 的行为与未安装时完全一致。

该插件没有 settings 命名空间，因此配置写在插件条目本身——bundle 的 patch 列表，或从 profile 的 patch 层插入：

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

`requireIdentity: true` 是让该 header 可信的关键。服务器绑定 `0.0.0.0`，而 `/api` 围栏会自动准入 LAN 字面量，因此没有它，任何能访问 3080 端口的人都能伪造该 header。代理还必须在 `forward_auth` 重新注入之前剥掉客户端自带的副本——office Caddyfile 为 wg-easy 路由已经使用的 `request_header -X-Auth-Request-Email` 行正是这个作用。

<a id="skills-stay-shared"></a>
## 技能保持共享

技能位于 `$DSH_HOME/skills`，在每个用户根目录之外，不受隔离。所有人看到同一份技能目录。模型目录、插件列表和设置文档也是如此。

<a id="what-this-is-not"></a>
## 这不是什么

会话以 **root** 身份、在同一进程、同一文件系统上运行，并带有 shell 工具。想读别人对话的用户可以让自己的 agent 去读。会话日志是 600 权限，但每个会话都是同一个 root。

所以这阻止的是人们*误入*彼此的对话，而不是阻止任何刻意去找的人。对于十来个希望侧边栏清净的可信同事，这是正确的取舍。真正的隔离需要每人一套 harness 实例——独立的 `$DSH_HOME`、独立的操作系统用户、独立的端口，由同一个身份 header 路由——那是部署变更而非代码变更，并且与本插件组合，而不是取代它。

<a id="dev-note"></a>
## 开发备注

`tests/policy.spec.ts` 覆盖前缀、同前缀兄弟目录与 `..` 的情形；`tests/service.spec.ts` 覆盖 Peer 到身份的映射、目录铸造、可见性与拒绝。

身份归属位于 `packages/client/connection`：`RequestIdentityResolver` 是策略契约，`HostConnectionService.setIdentityResolver` 安装它，为每个身份铸造一个 Peer，并随服务一起销毁。插件自身只持有 Peer 到身份的映射与策略表。
