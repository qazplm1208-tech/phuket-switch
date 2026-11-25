# Phuket Switch v1.1.2 · 2026-11-25

- **仅 Astra 自动分流**：在 Codex 速度栏一键绑定 PhuketAI 的 `Only astra` 分组（155，参考倍率 0.08x）并开启本地代理接管。保留当前 Codex 供应商；标准与 Fast 的 Astra 请求使用专属密钥，其他模型不变，UltraFast 仍走 Pro500 ultrafast。此功能默认关闭。
- **模型目录**：启用后，代理和 Codex 菜单会列出绑定供应商的 Astra 型号，包括可用的 `gpt-6.2-astra-pro` 及其 Fast 直选项。子代理选用 Astra 模型时，分组列表优先显示 Only astra。

## 下载与更新

Windows x64 安装版：**`Phuket.Switch.Setup.1.1.2.exe`**；便携版：**`Phuket.Switch.1.1.2.exe`**。安装版可在「扩展与设置 → 偏好设置 → 软件更新」检查更新；便携版请从[官方发布页](https://github.com/qazplm1208-tech/phuket-switch/releases)下载后手动替换。

---

## Phuket Switch v1.1.1 · 2026-11-25

- **子代理步数**：取消默认 30 步和最高 60 步的限制。默认 `max_steps=0`，由自动压缩兜底，直到任务完成；显式传入正整数仍可限步，减少任务做到一半需要确认续跑的情况。
- **异步派活**：`astra_spawn_worker` 持久化进度和完整报告，并返回 `watch_command`。主模型在宿主中后台启动该命令后即可结束本回合，完成时会被自动唤醒，无需反复轮询 `astra_wait_worker`。`--wait-worker` 支持多 worker 联合等待，也能检测 MCP 父进程提前退出。
- **网络稳定性**：子代理请求遇到瞬时断流、TLS EOF 或 HTTP 502/503/504 时最多自动重试两次。内置 Astra MCP 服务升级为 **v1.5.0**。

### 下载与更新

Windows x64 安装版：**`Phuket.Switch.Setup.1.1.1.exe`**；便携版：**`Phuket.Switch.1.1.1.exe`**。请从[官方发布页](https://github.com/qazplm1208-tech/phuket-switch/releases)下载。v1.0.0 至 v1.1.0 安装版可在「扩展与设置 → 偏好设置 → 软件更新」检查并安装更新；便携版请退出旧程序后手动替换。升级后请在「子代理」页重新应用配置，以同步 v1.5.0 服务和派活规则。

---

## Phuket Switch v1.1.0 · 2026-11-24

- **AI 直连下载**：在「扩展与设置 → AI 直连下载」按需部署 Python 3.10+ 下载脚本与 Windows 启动器。HTTP(S) 支持断点续传、并行分片与 URL 清单批量并发；可跟随网络直连设置、绑定物理网卡，或仅跳过代理并沿用系统路由。
- **种子与磁力链接**：支持 `.torrent` 与 `magnet:`、Tracker 和 DHT 节点发现、按文件选择、分片校验与续传。
- **下载检查**：可先用 `--info` 探测文件名、大小及续传支持，再按需限速、校验 SHA-256 / MD5 或安全解压。面板可单独自检脚本，也可探测指定的 HTTP(S) 地址。
- **客户端规则**：可向 Codex、Claude Code、Gemini CLI、Antigravity、Windsurf、OpenCode 和 Cline 中的所选客户端写入规则。支持先预览文件差异；写入和移除只调整下载器标记区块，保留其他规则。Cursor、Claude Desktop 等工具可手动复制规则。
- **子代理与恢复**：启用下载器后，在子代理页重新应用即可向 Astra MCP 提供脚本路径。部署和移除前会备份变更，可从「配置备份」恢复规则、脚本及原下载配置。

### 下载与更新

Windows x64 安装版：**`Phuket.Switch.Setup.1.1.0.exe`**；便携版：**`Phuket.Switch.1.1.0.exe`**。请从[官方发布页](https://github.com/qazplm1208-tech/phuket-switch/releases)下载。使用 v1.0.0、v1.0.1 或 v1.0.2 安装版的用户可在「扩展与设置 → 偏好设置 → 软件更新」检查并安装更新。便携版请退出旧程序后手动替换。

---

## Phuket Switch v1.0.2 · 2026-11-24

- **可选网络直连**：PhuketAI 请求、本地代理转发与测速现在可绑定 Windows 物理网卡，用该网卡的 DNS 解析域名，避开 HTTP 代理、TUN/VPN 虚拟路由与 fake-IP DNS。此选项默认关闭，不修改系统代理或路由表。物理模式需要 Python 3.10+；网卡不可用时会报告错误，不会悄悄改走代理。
- **仅跳过系统代理**：无需 Python，桌面后端直接用 Node.js 发送请求。此模式仍使用操作系统的路由和 DNS，不保证避开 VPN。
- **设置与测试**：在「扩展与设置 → 偏好设置 → 网络直连（绕过代理）」选择网卡或自定义 DNS，测试指定网址，查看 HTTP 状态、延迟与实际使用的路径。「本地代理」页可快速开关直连或进入详细设置。
- **子代理同步**：可选择将直连模式同步给 Astra MCP。修改偏好不会写入客户端文件；请前往「子代理」页预览并重新应用。

### 下载与更新

Windows x64 安装版：**`Phuket.Switch.Setup.1.0.2.exe`**；便携版：**`Phuket.Switch.1.0.2.exe`**。请从[官方发布页](https://github.com/qazplm1208-tech/phuket-switch/releases)下载。使用 v1.0.0 或 v1.0.1 安装版的用户可在「扩展与设置 → 偏好设置 → 软件更新」检查并安装更新。便携版请下载新文件，退出旧程序后手动替换。

---

## Phuket Switch v1.0.1 · 2026-11-23

- **子代理切换 API 地址时可直接填写密钥**：将「接口 Base URL」改为其他来源后，下方会立即显示「新地址 API 密钥」，支持显示或隐藏。部署和上游探测只使用为新地址填写的密钥，不会把原地址的密钥发往新接口。如果只更新部分客户端，而其他客户端仍使用 Windows 用户环境变量，可一键改用 `mcp-env` 独立存储，避免跨来源冲突。
- **第三方兼容 API 地址**：子代理请求与模型列表探测现在保留火山方舟 `/api/v3`、智谱 `/api/paas/v4`、阿里云百炼 `/compatible-mode/v1` 和 OpenRouter `/api/v1` 等版本路径。可以粘贴完整接口端点，也可以填写裸域名或中转前缀。常用接口提供快捷按钮，「实际请求」会实时显示最终 URL，方便核对。
- **发版与稳定性**：改进 Windows 8.3 短路径兼容性。安装版、便携版和更新元数据通过单个 GitHub Release 原子发布并校验；本地日志保留测试可在连接意外重置后重试读取。

### 下载与更新

Windows x64 安装版：**`Phuket.Switch.Setup.1.0.1.exe`**；便携版：**`Phuket.Switch.1.0.1.exe`**。请从[官方发布页](https://github.com/qazplm1208-tech/phuket-switch/releases)下载。已安装 **v1.0.0 安装版**的用户可直接在「扩展与设置 → 偏好设置 → 软件更新」检查并安装本次更新。便携版请退出后手动替换程序。

---

## Phuket Switch v1.0.0 · 2026-11-23

首个正式版，面向 Windows x64。Phuket Switch 将 [PhuketAI](https://ai.pukitcore.com) 的账号、供应商、客户端配置与本地代理整合到一个桌面工作台。

### 本版内容

- **六类客户端**：管理 Claude Code、Codex、Claude Desktop、Gemini CLI、Antigravity 和 Grok / 国产（GPT 原生）供应商；支持配置预览、切换和连通性诊断。
- **本地代理与模型路由**：支持按客户端接管、故障转移、按模型路由、Anthropic Messages 与 OpenAI Responses 的 JSON / SSE 转换，以及 Gemini 原生转发。支持标准、Fast、UltraFast 预设与 Codex 模型目录同步。
- **PhuketAI 工作台**：支持账号登录、双重认证、分组和密钥管理、余额与用量、充值订单和兑换、渠道监控及模型测速。
- **自定义模型子代理**：内置 Astra MCP 服务 **v1.4.0**；支持四种模型协议、只读与编辑模式、并行任务和会话恢复。九种 Harness 可按需部署。支持模型主动分块压缩、保留最近交互及自动全量压缩。
- **扩展与恢复**：管理 MCP 服务、系统提示词和本地 Skills；为 Codex / Claude 配置生图提示词。可预览脱敏差异、恢复配置备份，并从 CC-Switch 只读导入供应商。
- **桌面与升级**：支持托盘操作与浅色 / 深色主题。从本版开始，安装版可通过 GitHub Releases 检查、下载并在退出时安装更新，也可确认后立即重启安装。便携版提示新版下载地址，不覆盖运行中的程序。启动检查可关闭。
- **已有配置**：保留 Windows 应用标识；首次打开时自动迁移官方旧端点，保留路径、自定义供应商及其他偏好设置。

### 下载

在本页 Assets 中选择 **`Phuket.Switch.Setup.1.0.0.exe`**（安装版，推荐）或 **`Phuket.Switch.1.0.0.exe`**（便携版）。`latest.yml` 与 `.blockmap` 供更新器使用，无需手动打开。两个版本均未进行 Windows 代码签名，请只从[官方发布页](https://github.com/qazplm1208-tech/phuket-switch/releases)下载。使用子代理需另备 Python 3.10 或更高版本。
