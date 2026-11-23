# Phuket Switch v1.0.1 · 2026-11-23

- **子代理切换 API 地址时可直接填写密钥**：将「接口 Base URL」改为其他来源后，下方会立即显示「新地址 API 密钥」，支持显示或隐藏。部署和上游探测只使用为新地址填写的密钥，不会把原地址的密钥发往新接口。如果只更新部分客户端，而其他客户端仍使用 Windows 用户环境变量，可一键改用 `mcp-env` 独立存储，避免跨来源冲突。
- **第三方兼容 API 地址**：子代理请求与模型列表探测现在保留火山方舟 `/api/v3`、智谱 `/api/paas/v4`、阿里云百炼 `/compatible-mode/v1` 和 OpenRouter `/api/v1` 等版本路径。可以粘贴完整接口端点，也可以填写裸域名或中转前缀。常用接口提供快捷按钮，「实际请求」会实时显示最终 URL，方便核对。
- **发版与稳定性**：改进 Windows 8.3 短路径兼容性。安装版、便携版和更新元数据通过单个 GitHub Release 原子发布并校验；本地日志保留测试可在连接意外重置后重试读取。

## 下载与更新

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
