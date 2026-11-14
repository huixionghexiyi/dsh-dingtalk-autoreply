/** Lifecycle for the Router session and one persistent DSH Session per colleague.
 * Sessions are created through DSH's official sessionController (resolveAgent / create / rename) with the bundle's
 * own presets, so they are persisted by DSH and listed in the Web/Desktop workspace like any other session.
 * No subagents are ever spawned: colleagues are served by their own long-lived sessions, not by child agents.
 * Adapted from dsh-superagent-prototype src/app/sessions.ts (MIT). */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Store } from '../core/store.ts'
import type { DwsClient } from '../core/dws.ts'

export const ROUTER_SESSION_ID = 'dingtalk-router'
export const ROUTER_PRESET = 'dingtalk-router'
export const WORKER_PRESET = 'dingtalk-worker'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dingtalk-autoreply': { kind: 'dingtalk-autoreply' } & ContextFormed
  }
}

/** Stable DSH session id for a colleague key (`dm:<senderId>` or `group:<chatId>`). */
export function colleagueSessionId(key: string): string {
  return `dingtalk-colleague-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
}

export interface ColleagueSessionsHost {
  context: Context
  store: Store
  dws: DwsClient
  stateDir: string
  /** Live mode with a model configured: worker turns are woken. Otherwise messages are injected without waking. */
  liveTurns: boolean
}

const ROUTER_PROMPT = `你是钉钉自动回复插件的 Router。你只做分类分流，不写回复、不发消息。
收到同事消息时，输出一行为 JSON：{"action":"direct"|"lookup"|"escalate","category":"...","confidence":0..1,"reason":"..."}。
命中以下任何一类必须 escalate：钱（报销/转账/报价/合同）、人事（绩效/薪酬/评价/离职）、对外承诺、敏感信息（密码/密钥/未公开数据）、冲突情绪、法律合规。
无法判断或置信度低于 0.8 时 escalate，绝不猜测。`

const WORKER_PROMPT = `你是钉钉自动回复插件的 Worker，负责一位同事的对话。
规则：只引用 dws 工具返回的事实起草回复，无法核实就说无法核实、不要编造；你只起草，不直接发送，发送由审批服务执行；
每条回复由发送服务统一追加 AI 身份标识。语气简洁、直接，像本人在回消息。`

/** Creates/decorates the Router session and one persistent session per colleague. */
export class ColleagueSessions {
  private readonly ctx: Context
  private readonly managed = new Set<string>([ROUTER_SESSION_ID])
  /** Agents already decorated (prompt section + tools): decorate() runs from both ensure() and the
   * agent/created event, so this guard prevents duplicate registration. */
  private readonly decorated = new Set<string>()

  constructor(private readonly host: ColleagueSessionsHost) {
    this.ctx = host.context
    for (const row of host.store.sessionList()) this.managed.add(row.sessionId)
  }

  /** Subscribe to agent creation so managed sessions get their dws tools and role prompt. Call once at startup. */
  install(): void {
    this.ctx.on('agent/created', async ({ agent }) => { await this.decorate(agent).catch(() => {}) })
  }

  isManaged(sessionId: string): boolean { return this.managed.has(sessionId) }

  /** Resolve or create the Router session, rename it, and pin it to the router preset's permission level.
   * Permissions are `workspace-write` (sandbox + ask-before-escalating), never `danger-full-access`. */
  async ensureRouter(): Promise<Agent> {
    const agent = await this.ensure(ROUTER_SESSION_ID, this.host.stateDir, '钉钉自动回复 · Router', ROUTER_PRESET)
    this.managed.add(ROUTER_SESSION_ID)
    return agent
  }

  /** Resolve or create (and register in SQLite) the persistent session for one colleague. */
  async ensureColleague(key: string, displayName: string, kind: 'dm' | 'group'): Promise<Agent> {
    const sessionId = colleagueSessionId(key)
    const existing = this.host.store.sessionGet(key)
    const cwd = join(this.host.stateDir, 'colleagues', sessionId)
    const agent = await this.ensure(sessionId, cwd, kind === 'dm' ? `钉钉·${displayName}` : `钉钉群·${displayName}`, WORKER_PRESET)
    this.host.store.sessionUpsert({ key, sessionId, displayName, kind, lastActive: new Date().toISOString(), paused: existing?.paused ?? 0 })
    this.managed.add(sessionId)
    return agent
  }

  private async ensure(id: string, cwd: string, title: string, preset: string): Promise<Agent> {
    const ctx = this.ctx
    let result = await ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result && result.error.code === 'session/not-found') {
      // workspaceRegistry.create realpaths the directory: it must exist first.
      mkdirSync(cwd, { recursive: true })
      const workspace = await ctx.workspaceRegistry.create(cwd)
      // A Session keeps the preset it was created with, one of this bundle's own (cordis.patch.yml).
      await ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id, agentPreset: preset })
      result = await ctx.sessionController.resolveAgent(id as SessionId)
    }
    if ('error' in result) throw result.error
    await this.decorate(result.agent)
    ctx.permissionPresets.set(result.agent.session, 'workspace-write')
    await ctx.sessionController.rename({ sessionId: id as SessionId, title })
    return result.agent
  }

  /** Inject a colleague's message into their session history WITHOUT waking the agent (no model call).
   * In live mode with a model configured, `wake=true` queues it as a followup turn instead. */
  async deliver(sessionId: string, requestId: string, text: string, wake: boolean): Promise<'injected' | 'followup'> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    const agent = result.agent
    const message = freezeMessage({
      id: `dingtalk-autoreply:${requestId}` as never,
      role: 'user' as const,
      content: [{ type: 'text' as const, text }],
      source: { kind: 'dingtalk-autoreply' as const, form: 'relay' as const },
    })
    if (wake && this.host.liveTurns) agent.followup(message)
    else agent.inject(message)
    await this.ctx.sessionPersistence.flush()
    return wake && this.host.liveTurns ? 'followup' : 'injected'
  }

  private async decorate(agent: Agent): Promise<void> {
    if (!this.managed.has(agent.id)) return
    if (this.decorated.has(agent.id)) return
    this.decorated.add(agent.id)
    const isRouter = agent.id === ROUTER_SESSION_ID
    const dws = this.host.dws
    // Role prompt (system-prompt section, no interpolation). The registration targets the agent's
    // session ctx, which outlives plugin reloads; its disposer is therefore owned by this plugin's
    // fiber so an unmount removes it instead of leaking into (and colliding on) the next mount.
    this.ctx.effect(() => agent.ctx.systemPrompt.section({
      name: 'dingtalk-autoreply', order: 9999, interpolate: false,
      text: () => `${isRouter ? ROUTER_PROMPT : WORKER_PROMPT}`,
    }))
    // Read-only dws tools. Write operations are NOT registered on the agent: sending goes through the host
    // approval/send service only. Same ownership rule as the prompt section above.
    const register = (name: string, description: string, schema: z.ZodType, execute: (args: never) => Promise<unknown>): void => {
      this.ctx.effect(() => agent.ctx.tools.register({
        name, description, parameters: z.toJSONSchema(schema),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
        execute: (args, execution) => execute(schema.parse(args) as never),
      }))
    }
    if (!isRouter) {
      register('dws_calendar_query', '查询本人的日历（只读）。', z.object({ date: z.string().describe('YYYY-MM-DD') }),
        async ({ date }: { date: string }) => dws.calendarQuery(date))
      register('dws_doc_search', '搜索钉钉文档（只读）。', z.object({ query: z.string() }),
        async ({ query }: { query: string }) => dws.docSearch(query))
      register('dws_todo_list', '列出本人的待办（只读）。', z.object({}),
        async () => dws.todoList())
      register('dws_chat_search', '搜索钉钉消息记录（只读，用于补拉）。', z.object({ query: z.string() }),
        async ({ query }: { query: string }) => dws.searchMessages(query))
    }
  }
}
