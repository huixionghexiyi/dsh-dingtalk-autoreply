# 验证报告 — 钉钉自动回复 DSH 插件

验证日期：2026-11-14（本机 VM，Linux）。插件版本 0.1.0。
上游：DeepSeek `dsh-superagent-prototype` v0.1.0（MIT），DSH 0.2.1-rc.3。

## 环境（实测版本）

| 项目 | 版本 / 说明 |
|---|---|
| Node | v24.22.1（要求 ≥22） |
| pnpm | 11.7.0（`npm install -g pnpm@11.7.0`，corepack 不可用） |
| DSH | 0.2.1-rc.3（super-agent 部署指南 pin 的版本；`engines.dsh ^0.2.1-alpha.2` 满足） |
| dws CLI | v1.0.68（官方安装脚本装在 `~/.local/bin/dws`，不在默认 PATH，需 `export PATH="$HOME/.local/bin:$PATH"`） |
| profile | `dingtalk-clone`（由默认 web profile 复制） |
| stateDir | `/home/hatch/.dsh/state/dingtalk-autoreply`（SQLite + 会话工作区） |

**未登录钉钉**：全程没有执行 `dws auth login`，没有索要/写入任何账号、密码、API Key、token。
**无模型调用**：没有 DeepSeek API Key，验证期分流与起草走确定性规则 + 模板（见"未验证项"）。

## 通过项（14/14 自动化检查 + 手动核查）

### 1. 构建与单测

- `pnpm typecheck` 通过；`pnpm build` 成功（`lib/index.js` 42.31 kB、`lib/client.js` 9.27 kB）。
- `pnpm test`：**26/26 通过**（3 个文件：triage 19、store 4、drafts 3）。

### 2. 插件加载与 profile 启动

- `dsh --profile dingtalk-clone --dump-config` 输出含插件 `dsh-dingtalk-autoreply` 及其配置
  （stateDir / simulateFile / selfUserId / confidenceThreshold 0.8 / dailyCap 50 / autoSendDirect false）
  与 `dingtalk-router`、`dingtalk-worker` 两个 preset。
- `dsh --profile dingtalk-clone --no-open --port 3082` 启动成功，日志无激活错误，
  插件日志打印 `dingtalk-autoreply ready`。API `GET /dingtalk-autoreply/api/status` 返回 200：
  `{"mode":"simulate","watcherMode":"simulate","routerSessionId":"dingtalk-router","colleagues":6,"pending":7,"sentToday":0,"dailyCap":50,"identityMarker":"——以上由 AI 助手代回","dwsLive":false}`。

### 3. 模拟消息走通五层关卡（夹具 11 条，启动时自动喂入）

| 类别 | 条数 | 实际结果 |
|---|---|---|
| 直接回（msg-001 问候、msg-002 问下午三点、msg-003 群聊@要文档链接） | 3 | 全部生成草稿进待处理队列 |
| 升级（msg-004 报销 deny:money、msg-005 绩效 deny:hr、msg-006 承诺 deny:commitment、msg-007 对抗索密码 deny:adversarial） | 4 | 全部升级，无草稿、无发送 |
| 丢弃（msg-008 撤回事件、msg-001 重复 messageId、msg-009 本人消息、msg-010 群聊未@） | 4 | 全部丢弃 |
| 审计行数 | 10 | 重复的 msg-001 只记一次（去重生效） |
| 否决类自动发送 | 0 | outbox 为空（审批前） |

草稿实例（msg-002）："今天下午三点已有安排：15:00–16:00 项目周会（Mock 数据）。除 15:00–16:00 外空闲"。

### 4. 审批流程（手动核查）

- `POST /dingtalk-autoreply/api/approve {"id":2,"action":"approve"}` → `{"status":"sent-dryrun"}`。
- outbox 出现 1 条，状态 `sent-dryrun`，正文末尾含 AI 标识 `——以上由 AI 助手代回`；
  待处理队列中该项状态变为 `sent-dryrun`，其余 6 项仍为 `pending`。
- 注意：此后 `scripts/verify.mjs` 的"outbox 为空"一项不再通过——属预期（已批准 1 条），
  重新跑完整验证需先重置状态（见末尾"重置命令"）。

### 5. Session 创建与持久化（用户要求的重点项）

- Router session `dingtalk-router` 与 6 个同事 Worker session
  （5 单聊 + 1 群聊：`dingtalk-colleague-efd6602a78af0478` 等）均由 DSH 官方
  `sessionController.resolveAgent/create/rename` 创建，**不是内存临时对象**。
- 持久化证据（两处，均为 DSH 全局 session 存储，桌面端与 Web 端读同一份）：
  1. `~/.dsh/storages/session_projcache/sessions/dingtalk-router.json` 及 6 个
     `dingtalk-colleague-*.json`：Router 文件内 title=`钉钉自动回复 · Router`、
     `sandboxMode=workspace-write`；同事文件例：title=`钉钉·张三`、
     `agentPreset=dingtalk-worker`、`sandboxMode=workspace-write`、
     cwd=`~/.dsh/state/dingtalk-autoreply/colleagues/dingtalk-colleague-b9958896dc090382`；
     6 个同事文件均含注入的原文消息。
  2. `~/.dsh/sessions/--home-hatch-.dsh-state-dingtalk-autoreply--/dingtalk-router/session.v4.jsonl.zstd`
     及 6 个同事对应目录：每份均为 DSH 会话事件日志（zstd 压缩 JSONL）。
     解压核查：6 个同事日志均含注入消息（`[钉钉单聊]`/`[钉钉群聊]` 正文），
     Router 日志 10 行、仅含创建元数据（Router 本身不收消息，正确）。
- 权限：全部 session 均为 `workspace-write`，**未使用 `danger-full-access`**。
- SQLite：`~/.dsh/state/dingtalk-autoreply/dingtalk-autoreply.sqlite` 存在，
  audit=10 行、colleague_sessions=6 行。

### 6. dws CLI

- `dws --version` = v1.0.68；`dws chat +messages-reply --help` 等命令形状与插件 `src/core/dws.ts` 预期一致。
- `dws auth status --readonly` 未执行登录流程；**未登录**（live 模式无法在本机跑，见下）。

## 验证中发现并修复的 3 个真问题

1. **插件包名与 patch 的 name 不一致**：`cordis.patch.yml` 里插件 `name` 写成 `dingtalk-autoreply`，
   DSH 按包名解析报 `Cannot find package 'dingtalk-autoreply'`。已改为包名 `dsh-dingtalk-autoreply`
   （`id` 仍为 `dingtalk-autoreply`，profile 配置用 id 引用，不变）。
2. **prompt section 重复注册**：`decorate()` 同时从 `ensure()` 与 `agent/created` 事件触发，
   报 `prompt section "dingtalk-autoreply" is already registered` 导致插件激活失败。
   已加 `decorated` 集合守卫（与上游 `bindings` 守卫同思路）。
3. **同事工作区目录不存在**：`workspaceRegistry.create(cwd)` 内部 realpath 要求目录已存在，
   首个同事 session 创建时报 `ENOENT .../colleagues/dingtalk-colleague-...`。
   已在 `ensure()` 里先 `mkdirSync(cwd, {recursive:true})`。
4. **中文问候草稿失效（验证抓出的 bug）**：`buildDraft` 的问候正则含 `\b`，
   `\b` 在两个中文字符之间永不匹配，"你好"命中分类却无草稿、被误升级。
   已改成中文分支不用 `\b`（英文 hi/hello 保留 `\b`），并补了 `tests/drafts.test.ts` 回归单测。
   此后重跑：草稿 3/3，`verify.mjs` 14/14 通过。

另：`dsh plugin --profile dingtalk-clone add "link:$PWD"` 在本 VM 报 `[EPERM] chown .../package.json.<tmp>`
（pnpm 写临时文件时 chown 即使 root 也 EPERM），但 lockfile 与 `node_modules/dsh-dingtalk-autoreply` 软链已写好。
已手动补 `~/.dsh/profiles/dingtalk-clone/package.json`（dependencies 加 link 依赖、
`dsh.profile.bundles` 加 `dsh-dingtalk-autoreply`），`--dump-config` 确认加载。
此问题已记入 README 安装步骤（备选手动修复）。

## 未验证项（需在用户自己机器上完成）

1. **真实钉钉联调（live 模式）**：需用户在自己机器执行 `dws auth login` 后，把 profile 配置
   `mode` 改为 `live`、删掉 `simulateFile`、填真实 `selfUserId`，重启后观察真实消息流入。
   另需按实际 dws NDJSON 字段名校准 `normalizeDwsLine`（当前对真实 dws flatten 字段的映射是尽力而为，
   以夹具形状为准）。
2. **真实模型调用**：需 DeepSeek API Key（在 DSH 设置里配 provider）。无 Key 时 Router/Worker
   的模型 turn 不会发生——验证期分流与起草走确定性规则 + 模板，session 内注入消息不唤醒 agent。
   首次 live 时应先在影子模式（只看不发）观察分类质量，再开草稿模式。
3. **Web UI 列表与侧栏面板的可视确认**：本机 Linux 无桌面端；Web UI 每次启动的 `?token=...`
   只打印在终端且被脱敏，无法从外部用 curl 打开 UI 页面。
   Session 文件本身就是 Web/Desktop 共用的存储（上文第 5 节已核对内容无误），
   但"列表里肉眼看到"这一步需用户在自己机器打开启动时打印的链接确认：
   工作区应出现「钉钉自动回复 · Router」与每位同事的会话；左侧栏应有「钉钉自动回复」面板
   （待处理队列 + 会话列表）。若面板未出现，检查 `lib/client.js` 是否随 bundle 正常加载。
4. **真实发送**：simulate 下发送只进 dry-run outbox；live 下 `dws chat +messages-reply`
   的真实发送未跑过。首次 live 发送前，先用 `--dry-run` 方式或在测试群里验证一条。

## 用户本机收尾步骤

```sh
# 1. 装 DSH 0.2.1-rc.3、pnpm 11.7.0、dws CLI（见 README）
# 2. 只在自己机器上：dws auth login（选组织；企业未开通时按提示发管理员申请卡片）
# 3. 在 DSH 设置里配 DeepSeek provider / API Key
# 4. 建 profile 并装插件（README 第 4 步；若 plugin add 报 EPERM，按 README 手动改 package.json）
# 5. 复制 examples/profile.cordis.patch.yml 到 ~/.dsh/profiles/<你的 profile>/cordis.patch.yml，
#    改 mode: live、删 simulateFile、填真实 selfUserId
# 6. 启动：dsh --profile <你的 profile> --no-open --port 3082
#    用终端打印的 http://127.0.0.1:3082/?token=... 打开，确认：
#    (a) 工作区出现 Router 与同事会话；(b) 左侧栏有「钉钉自动回复」面板
# 7. 先影子模式观察（只看不发），再开草稿模式；升级类永不自动发
```

## 重置命令（重新跑完整验证前执行）

```sh
pkill -f "dsh --profile dingtalk-clone"   # 注意：别把 kill 和启动写在同一条命令里，否则 pkill 会误杀自己的 shell
rm -rf /home/hatch/.dsh/state/dingtalk-autoreply \
  /home/hatch/.dsh/storages/session_projcache/sessions/dingtalk-*.json \
  /home/hatch/.dsh/sessions/--home-hatch-.dsh-state-dingtalk-autoreply*
cd ~/workspace/dingtalk-dsh-plugin
pnpm build
dsh --profile dingtalk-clone --no-open --port 3082   # 后台跑，等 ~30 秒让夹具喂完
node scripts/verify.mjs --port 3082                  # 应为 14/14
```

## 当前本机状态（2026-11-14 16:17，验证结束时）

- `dsh --profile dingtalk-clone --no-open --port 3082` 仍在后台运行，API 可用：
  `http://127.0.0.1:3082/dingtalk-autoreply/api/status`（需加请求头 `x-dingtalk-request: 1`）。
- 状态：同事 6、待处理 7（其中 msg-002 已在验证中批准为 `sent-dryrun`，outbox 1 条），审计 10 行。
