# dsh web 自动启动 + VS Code 侧边栏

[English](README.md) | 中文

把本部署的 harness web 环境复刻到另一台服务器（你的办公 LXC）上，并补上那台机器唯一缺的东西：**自动启动**。

## 原本有什么、缺什么

在参考机器上，侧边栏扩展只是*发现* harness——它读取 `/root/.dsh/current-token.txt`，回退到从启动日志里抓取 `?token=` 那一行，逐个探测候选地址，最后把可用的那个渲染进 iframe。它从不启动任何东西。harness 本身是手动启动的：

```
alias dshstart='/usr/local/bin/dsh-web-launch 3080 ~/.dsh/web.log <bin.js> >/dev/null 2>&1 &'
```

`dsh-web-launch` 无法在 systemd 下使用：它用 `setsid` 把 harness 放到后台，并在令牌写入后立即退出，因此 systemd 会看到服务马上停止。所以本套件把这两件事拆开。

## 内容

| 文件 | 作用 |
|---|---|
| `dsh-web.service` | systemd 单元：开机启动 harness，失败时重启 |
| `dsh-web-run` | 单元调用的前台运行器；从 `.env` 组装参数 |
| `dsh-token-writer` | `ExecStartPost`：为侧边栏记录启动令牌 URL |
| `install-dsh-web.sh` | 上述全部内容 + 扩展的幂等安装脚本 |
| `dsh-sidebar/` | VS Code 扩展（`custom.dsh-native-sidebar-1.1.0`） |

该扩展是自包含的——只依赖 `vscode` 与 Node 内置模块——因此可以直接复制。

## 安装

```bash
# on the work server, from this directory
./install-dsh-web.sh                          # sidebar uses loopback :3080
./install-dsh-web.sh http://10.0.0.5:3080     # sidebar uses a reachable origin
```

然后：

```bash
vi /root/.dsh/.env            # API keys + WEBGUI_TRUSTED_HOSTS
systemctl start dsh-web
systemctl status dsh-web --no-pager
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/   # want 200
```

之后请重新加载 VS Code 窗口，以便加载新扩展。

## 唯一必须弄对的事：侧边栏的 origin

侧边栏是在**你浏览器里的 iframe**中渲染 GUI 的。因此 `http://127.0.0.1:3080` 指的是*你自己的机器*，而不是服务器。

- **带端口转发的 VS Code 桌面版** → loopback 可用；不带参数运行安装脚本即可。
- **浏览器中的远程 code-server** → 传入服务器的 LAN IP 或其代理 URL，并把该主机加入 `/root/.dsh/.env` 的 `WEBGUI_TRUSTED_HOSTS`。未声明的 authority 会得到只读设置页，并且每个 `/api` 请求都返回 `403`。

参考机器用一个与 code-server 主机同站的公开 URL 解决此问题，从而共享认证 cookie。如果你用反向代理放在办公服务器前面，请在那里给 dsh 一个独立主机名并传入它。

## 容量规划

单元里的 `DSH_WEB_HEAP_MB`（默认 6144）只约束 **JS 堆**——RSS 会高于它。请在容器上限之下留出余量：在参考机器上，RSS 曾停在 4.31 GB，而上限是 4096 MB，而提高上限并不会消除增长，只会改变进程死亡的方式（可见的 V8 abort 变成静默的内核 OOM kill）。请按办公服务器的内存来调整。

## 验证自动启动确实能存活

```bash
systemctl restart dsh-web && sleep 20 && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/
cat /root/.dsh/current-token.txt      # the sidebar's target
```
