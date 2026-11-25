# Phuket Switch

**v1.1.2 · Windows x64**　[下载正式版](https://github.com/qazplm1208-tech/phuket-switch/releases/latest) · [更新日志](CHANGELOG.md) · [本地 API](shared/api-contract.md)

Phuket Switch 是面向 [PhuketAI](https://ai.pukitcore.com) 的 Windows 桌面工作台。在本机管理供应商、切换客户端、接管代理、检查分组额度与渠道状态；也可为不同工具配置自己的兼容端点。桌面应用版本与内置 Astra MCP 服务版本分别维护。

## 安装与更新

从[官方 GitHub Releases](https://github.com/qazplm1208-tech/phuket-switch/releases) 的 **Assets** 中按用途选择：

| 发行包 | 首次使用 | 之后怎样更新 |
| --- | --- | --- |
| `Phuket.Switch.Setup.1.1.2.exe`（NSIS 安装版） | 运行安装向导，选择目录，使用开始菜单或桌面快捷方式启动 | 在「扩展与设置 → 偏好设置 → 软件更新」检查并下载。下载完成后可确认重启安装，也可留待下次正常退出时安装。 |
| `Phuket.Switch.1.1.2.exe`（便携版） | 将单文件放到可写目录，直接运行，无需安装 | 同一面板会显示新版说明和下载入口。下载后退出旧程序，再手动替换；不会自动覆盖运行中的文件。 |

桌面版自带 Electron 和后端。子代理、物理网卡直连和 AI 下载脚本需要 Python 3.10+；仅让桌面后端跳过系统代理不需要 Python。便携指程序免安装，业务数据默认仍在当前用户的 `~/.phuket-switch/`。首次运行可在「供应商」添加兼容端点，或先登录 PhuketAI 选择分组密钥；预览 Diff 后再决定是否写入客户端。关闭窗口会收起到托盘，**退出 Phuket Switch** 才会关闭自有后台。

安装版与便携版均可关闭「启动时自动检查更新」。检查使用公开 GitHub Releases，不需要 GitHub Token，也不发送 PhuketAI 凭据。启动检查失败不会弹错；手动检查可重试。安装包未做 Windows 代码签名，更新器使用 `latest.yml` 中的 SHA-512 校验安装包完整性；这不等同于发布者签名。不要从转载站或第三方更新源安装。安装或替换前请先完成本地代理上的活跃请求。

## 能力一览

| 范围 | 支持内容 |
| --- | --- |
| 六类客户端 | Claude Code、Codex、Claude Desktop、Gemini CLI、Antigravity、Grok / 国产（GPT 原生）。统一管理供应商、模型和密钥；按各客户端能力预览并应用配置。 |
| 本地代理 | 按客户端接管、故障转移、模型路由、标准 / Fast / UltraFast 与 Codex 目录同步；Anthropic Messages ↔ OpenAI Responses 的 JSON / SSE 转换，Gemini 原生转发。 |
| Astra 分流 | 默认关闭。在 Codex 速度栏选择「一键配置并启用 Only astra」可复用或新建分组密钥并开启代理接管。标准 / Fast 的 Astra 模型优先使用 Only astra（分组 155，参考倍率 0.08x）；其他模型仍走当前分组，UltraFast 仍走 Pro500 ultrafast。 |
| 网络直连 | 默认关闭。「扩展与设置 → 偏好设置」可绑定 Windows 物理网卡、自选 DNS 并测试直连；也可仅跳过 HTTP 代理，沿用系统路由。在「本地代理」可快速开关，子代理需重新应用才会同步。 |
| AI 直连下载 | 在「扩展与设置 → AI 直连下载」部署可选脚本，向七种 AI 客户端写入可单独移除的标记规则。支持 HTTP(S) 断点续传、并行分片、批量并发、`.torrent` / `magnet:`、哈希校验、限速、安全解压与元数据探测；可预览变更并从配置备份恢复。 |
| PhuketAI 账号 | 密码 / Token / 桌面网页登录、双重认证、分组与密钥、余额与用量、充值与订单、兑换、渠道状态及连通性 / 测速诊断。 |
| 模型子代理 | Astra MCP **v1.5.0**；OpenAI Responses、OpenAI Chat、Anthropic Messages、Gemini 原生四种协议。支持自定义模型、只读 / 编辑与会话恢复。默认 `max_steps=0`，直到任务完成；显式传正数可限步。后台启动并行 worker 返回的 `watch_command`（`--wait-worker`）后即可结束回合，完成时由宿主自动唤醒，无需主模型轮询。模型可主动分块压缩历史；默认保留最近 2 组交互，88% 阈值触发自动压缩。 |
| 九种 Harness | Antigravity、Claude Code、Codex、Gemini CLI、Claude Desktop、Cursor、Windsurf、OpenCode、Cline。可按目标检测、预览、部署、验证握手及移除。 |
| 扩展与生图 | MCP 服务、提示词预设、Skills 浏览；Codex / Claude 生图提示词适配；配置备份恢复和 CC-Switch 只读导入。 |
| 软件更新 | 标题栏与托盘展示更新状态；NSIS 支持分块下载、校验及重启安装。便携版和 Electron 开发模式使用发布页下载；普通浏览器不调用本机安装接口。 |

## 架构与数据安全

- `electron/` 管理桌面窗口、托盘和更新。渲染层使用受限 preload 接口，主进程检查窗口、主框架和来源。安装前关闭托盘、登录窗口与**本实例启动的**后端，不终止独立启动的服务。
- `web/` 是 React 界面，`server/` 是 Node.js + SQLite 本地后端；`shared/` 保存类型、端点与契约。管理服务默认 `127.0.0.1:15720`，推理代理默认 `127.0.0.1:15722`，均只绑定回环地址。不要将端口转发到公网。
- `~/.cc-switch/` 只读，不写入源库；WAL 数据库通过私有副本读取。配置写入限定在受管理路径，使用临时文件后原子替换。可在偏好设置控制切换前备份，从「配置备份」恢复。
- 管理视图与 Diff 隐藏密钥，代理日志记录元数据而不是提示词。**脱敏不等于加密**：本机数据库、配置及备份可能包含可用凭据，请限制目录访问，不要将其上传到问题单或仓库。
- 已保存的官方旧端点会在 SQLite 初始化事务内更新为 `https://ai.pukitcore.com`，保留 `/v1` 等路径；第三方域名不会被替换。

## 开发、测试与打包

Windows 开发环境使用 **Node.js 24.x**、npm 和 **Python 3.13**（服务最低要求 3.10）。在 PowerShell 中进入仓库，**先隔离再运行**，以下环境变量仅影响当前终端和子进程：

```powershell
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('phuket-test-' + [guid]::NewGuid())
$env:PHUKET_SWITCH_USER_HOME = Join-Path $fixture 'home'
$env:PHUKET_SWITCH_HOME = Join-Path $fixture 'db'
$env:PLUGIN_DATA = Join-Path $fixture 'plugin-data'
New-Item -ItemType Directory -Force $env:PHUKET_SWITCH_USER_HOME | Out-Null
$env:PYTHONUTF8 = '1'
$env:npm_config_cache = Join-Path (Get-Location) '.npm-cache\npm'
$env:npm_config_logs_max = '0'
$env:npm_config_update_notifier = 'false'
npm.cmd ci
```

`npm.cmd run dev` 启动前后端热更新。`npm.cmd run build` 构建 `dist/`；`npm.cmd run desktop:start` 启动桌面模式。如果首次开发运行缺少 Electron 可执行文件，可运行 `node node_modules/electron/install.js`。

在**同一隔离终端**执行完整验证。测试使用临时目录和本地模拟上游，不需要真实 API 密钥或 GitHub 发布权限。设置 `PHUKET_SWITCH_USER_HOME` 后，Windows 用户环境变量操作不会写入真实注册表。

```powershell
python -m py_compile direct/direct_dns.py direct/direct_net.py direct/direct_bridge.py direct/direct_torrent.py direct/direct_download.py subagent/astra_mcp_server.py
python -m unittest discover -s direct -p "test_*.py" -v
python -m unittest discover -s subagent -p "test_*.py" -v
node scripts/api-contract.mjs --check
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
node scripts/smoke-subagent-ui.mjs
```

本地打包使用 `npm.cmd run dist:win`（`--publish never`，无需 `GH_TOKEN`）。`release/` 下应有两个 `.exe`、安装包的 `.blockmap` 和 `latest.yml`；`win-unpacked/resources/app-update.yml` 是内嵌更新源配置，不是需要单独上传的安装包。

维护者发版时同步 `package.json`、锁文件、`shared/constants.ts` 中的版本与变更记录，验证后推送对应的稳定标签（如 `v1.1.2`）。[发布工作流](.github/workflows/release.yml) 检查标签、运行测试，并用 `npm run dist:win` 打包，再用 `gh release` 将四个文件发布到该标签的同一个 GitHub Release；也可对已有标签手动运行。不要把发布令牌写入应用或配置文件。
