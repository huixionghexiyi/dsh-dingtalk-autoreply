# 钉钉同事消息自动回复 · DSH 插件

基于 DeepSeek 官方 `dsh-superagent-prototype`（MIT）改造的钉钉版：监听钉钉消息，五层关卡分流，
每同事一个独立持久 DSH Session 起草回复，审批通过后才发送（发送时统一追加 AI 身份标识）。

完整设计见 `docs/dingtalk-auto-reply-openspec.md`（OpenSpec 单文件：proposal / design / 8 个能力域 specs / tasks / 验证计划）。

## 架构

```text
钉钉 ── dws event +listen-im ──→ [常驻 Router Session]
        （单聊全部 + 群聊@）          │
                          ┌───────────┼───────────┐
                          ▼           ▼           ▼
                    [Worker Session] [Worker Session] [升级给本人]
                    同事 A 专属      同事 B 专属      敏感 / 低置信
                          │           │
                          └── dws 全能力 ───┘
```

- **分流（五层关卡）**：代码硬过滤（去重、跳过本人消息、非消息事件）→ 否决规则表（钱/人事/承诺/敏感信息/冲突/合规，命中即升级或丢弃，模型无权覆盖）
  → Router 分类（直接回/查资料后回/升级，低置信度升级）→ 起草校验（事实只引 dws 返回结果）→ 审批服务。
- **Session 不是 subagent**：每同事一个持久 DSH Session（单聊按 senderId、群聊按 chatId，SQLite 注册表复用），
  由 DSH 官方 `sessionController` 创建并持久化，桌面端 / Web 端工作区自动展示。**全程不启动 subagent。**
- **权限**：不用 `danger-full-access`；Session 权限为 `workspace-write`，写操作（发消息、批审批）只走审批服务。
- **发送**：发送服务统一追加 `——以上由 AI 助手代回`，缺失则阻断；实时发送走 `dws chat +messages-reply`（引用原消息，`--ai-tag` 保持开启）。

## 本机安装（用户机器）

```sh
# 1. Node 22.19+ 或 24+，pnpm
npm install -g pnpm@11.7.0

# 2. DSH（本插件按 super-agent 部署指南 pin 的版本）
npm install -g @deepseek-ai/dsh@0.2.1-rc.3

# 3. 钉钉官方 dws CLI（只在你自己的机器上执行下面这步）
curl -fsSL https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.sh | sh
dws auth login        # 按提示选组织；若企业未开通 CLI 访问，按提示给管理员发申请卡片

# 4. 建专用 profile 并装插件
git clone <本仓库> dingtalk-dsh-plugin && cd dingtalk-dsh-plugin
pnpm install && pnpm build
dsh dingtalk-clone --from-default-profile web --dump-config > /dev/null
dsh plugin --profile dingtalk-clone add "link:$PWD"
# 若 add 报 EPERM chown（某些 Linux 环境 pnpm 写临时文件时触发）：手动改
# ~/.dsh/profiles/dingtalk-clone/package.json——dependencies 加
# "dsh-dingtalk-autoreply": "link:<插件绝对路径>"，dsh.profile.bundles 加
# "dsh-dingtalk-autoreply"，再用 dsh --profile dingtalk-clone --dump-config 核对插件已列出。
# 注意 cordis.patch.yml 里插件的 name 必须是包名 dsh-dingtalk-autoreply（不是 dingtalk-autoreply）。

# 5. 配 profile（复制 examples/profile.cordis.patch.yml 到 ~/.dsh/profiles/dingtalk-clone/cordis.patch.yml，替换占位符）
#    stateDir：插件 SQLite 与会话工作区目录；mode: live；simulateFile 留空；selfUserId 填你的钉钉 userId

# 6. 配 DeepSeek 模型（DSH Web 设置里配 provider；Router 轻模型、Worker 强模型可在插件 UI 里选）

# 7. 启动（注意：没有 web 这个子命令，profile 本身就是 web 应用）
dsh --profile dingtalk-clone --no-open --port 3082
# 终端会打印 http://127.0.0.1:3082/?token=...（每次启动 token 不同），用该链接打开；
# 左侧栏「钉钉自动回复」即审批面板；工作区里会看到「钉钉自动回复 · Router」与每位同事的会话。
```

## 验证（无钉钉登录 / 无 API Key 也能跑）

```sh
# 模拟模式：启动时自动按 simulateFile 里的夹具 NDJSON 喂给 Router，走完整五层关卡，不发任何真实消息
node scripts/verify.mjs --port 3082   # 14 项检查（含 session 持久化文件）
pnpm test   # 单测 26 项：分流规则 + SQLite store + 起草模板
# scripts/simulate.mjs 是手动重喂（已喂过的 messageId 会被去重丢弃）或向运行中的服务注入事件：
node scripts/simulate.mjs --port 3082 --file fixtures/simulated-events.ndjson
```

详见 `VERIFICATION.md`。

## 模式

| 模式 | 说明 |
|---|---|
| `simulate`（默认） | 不碰钉钉。`dws` 调用走 Mock 返回（标注 Mock 数据），回复只进 dry-run outbox，永不真实发送。 |
| `live` | 调真实 `dws`。需 `dws auth login` 已完成；仍默认草稿模式（`autoSendDirect: false`），全部回复须经 UI 批准。 |

## 目录

| 路径 | 说明 |
|---|---|
| `src/index.ts` | Host 插件入口 |
| `src/app/runtime.ts` | 编排：监听 → 分流 → 会话 → 起草 → 审批 → 发送 |
| `src/app/sessions.ts` | Router / 每同事 Worker Session（官方 sessionController 创建） |
| `src/app/watcher.ts` | `dws event +listen-im` 监听 + 模拟喂数 + 断线重连/补拉 |
| `src/app/http.ts` | 回环管理 API（待处理/会话/审计/审批/注入） |
| `src/core/triage.ts` | Layer 0/1/2：硬过滤、否决规则、分类（可单测） |
| `src/core/dws.ts` | dws 客户端（live/mock）+ 发送服务（统一追加 AI 标识） |
| `src/core/drafts.ts` | 起草（只引 dws 事实，无法核实则升级） |
| `src/core/store.ts` | SQLite：去重、审计、待处理、会话注册表、outbox |
| `src/client/` | 最小版 UI：待处理队列 + 会话列表 |
| `cordis.patch.yml` | bundle 接线 + Router/Worker 双 preset（无 subagent） |
| `fixtures/` | 模拟消息 NDJSON（单聊/群聊@/否决类/撤回/重复/本人消息） |

## 安全红线

- 绝不替用户执行 `dws auth login`、绝不索要账号密码 / API Key / token；本仓库不含任何凭证。
- 否决类消息自动发送率必须为 0（每次发版重跑 `pnpm test` + 模拟验证）。
- 上线路径：影子模式 → 草稿模式 → 灰度（仅直接回类、5 位同事）→ 全量；升级类永不自动发。
