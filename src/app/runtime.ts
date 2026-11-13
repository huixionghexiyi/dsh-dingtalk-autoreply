/** Composition root: wires Store, DwsClient, ColleagueSessions, DingtalkWatcher, triage, drafting,
 * approval queue and the send service. The pipeline runs in host code (deterministic gates); model turns in the
 * Router/Worker sessions happen only in live mode with a model configured. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import type { Context } from '@deepseek-ai/cordis'
import { buildDraft, factsNeeded } from '../core/drafts.ts'
import { DwsClient, SendService } from '../core/dws.ts'
import { Store } from '../core/store.ts'
import { triage, type DingtalkEvent } from '../core/triage.ts'
import { ColleagueSessions, ROUTER_SESSION_ID } from './sessions.ts'
import { DingtalkWatcher, type WatcherMode } from './watcher.ts'
import type { Machine } from '../deployment.ts'

export class Runtime {
  readonly store: Store
  readonly dws: DwsClient
  readonly sessions: ColleagueSessions
  readonly send: SendService
  readonly ready: Promise<void>
  private readonly watcher: DingtalkWatcher
  private readonly seen: Set<string>
  private watcherMode: WatcherMode = 'simulate'
  private releaseLock?: () => Promise<void>
  private readonly lifetime = new AbortController()

  constructor(
    private readonly ctx: Context,
    private readonly machine: Machine,
  ) {
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const release = lockSync(machine.stateDir, { stale: 30_000 })
    this.releaseLock = async () => { release() }
    this.store = new Store(join(machine.stateDir, 'dingtalk-autoreply.sqlite'))
    this.seen = this.store.seenIds()
    const live = machine.mode === 'live'
    this.dws = new DwsClient(live ? 'live' : 'mock')
    this.send = new SendService(this.dws, this.store, machine.identityMarker)
    this.sessions = new ColleagueSessions({
      context: ctx, store: this.store, dws: this.dws, stateDir: machine.stateDir, liveTurns: live,
    })
    this.sessions.install()
    this.watcher = new DingtalkWatcher({
      dws: this.dws, dwsPath: 'dws', mode: live ? 'live' : 'simulate', simulateFile: machine.simulateFile || undefined,
      onEvent: event => this.handleEvent(event),
      onLog: message => ctx.logger.info(`dingtalk-autoreply: ${message}`),
    })
    this.ready = this.start()
  }

  private async start(): Promise<void> {
    await this.sessions.ensureRouter()
    this.ctx.logger.info('dingtalk-autoreply: Router session ready (dingtalk-router)')
    this.watcherMode = await this.watcher.start()
    this.ctx.logger.info(`dingtalk-autoreply: watcher running in ${this.watcherMode} mode`)
  }

  async stop(): Promise<void> {
    this.lifetime.abort()
    await this.watcher.stop()
    this.store.close()
    await this.releaseLock?.()
  }

  status(): Record<string, unknown> {
    return {
      mode: this.machine.mode, watcherMode: this.watcherMode, routerSessionId: ROUTER_SESSION_ID,
      colleagues: this.store.sessionList().length,
      pending: this.store.pendingList('pending').length,
      sentToday: this.sentToday(), dailyCap: this.machine.dailyCap,
      identityMarker: this.machine.identityMarker, dwsLive: this.dws.isLive,
    }
  }

  private sentToday(): number {
    const today = new Date().toISOString().slice(0, 10)
    return this.store.auditList(500).filter(row => (row.status === 'sent' || row.status === 'sent-dryrun') && row.createdAt.startsWith(today)).length
  }

  /** The five-gate pipeline for one normalized event. */
  async handleEvent(event: DingtalkEvent): Promise<void> {
    const decision = triage(event, this.seen, { selfUserId: this.machine.selfUserId || undefined, confidenceThreshold: this.machine.confidenceThreshold })
    // Dedupe: record the id once a message event has been triaged (replays are dropped without a second audit row).
    if (event.eventType === 'message' && decision.category !== 'drop:duplicate') this.markSeen(event.messageId)
    const writeAudit = (status: string, draft?: string): void => {
      if (decision.category === 'drop:duplicate') return
      this.store.auditAdd({
        messageId: event.messageId, senderId: event.senderId, senderName: event.senderName, chatId: event.chatId,
        chatType: event.chatType, action: decision.action, category: decision.category, confidence: decision.confidence,
        rule: decision.rule ?? null, reason: decision.reason, draft: draft ?? null, status,
      })
    }
    if (decision.action === 'drop') { writeAudit('dropped'); return }
    // Every non-dropped message gets its colleague session (context continuity), even escalations.
    const key = event.chatType === 'dm' ? `dm:${event.senderId}` : `group:${event.chatId}`
    const displayName = event.chatType === 'dm' ? (event.senderName || event.senderId) : (event.chatName || event.chatId)
    const agent = await this.sessions.ensureColleague(key, displayName, event.chatType)
    const paused = this.store.sessionGet(key)?.paused === 1
    await this.sessions.deliver(agent.id, `msg:${event.messageId}`, `[钉钉${event.chatType === 'dm' ? '单聊' : '群聊@'}] ${event.senderName}: ${event.text}`, false)
    if (decision.action === 'escalate' || paused) {
      this.store.pendingAdd({
        messageId: event.messageId, senderId: event.senderId, senderName: event.senderName, chatId: event.chatId,
        chatType: event.chatType, category: decision.category, confidence: decision.confidence, rule: decision.rule ?? null,
        draft: paused ? '（该同事已暂停自动回复，需人工处理）' : '（已升级，需人工处理）',
      })
      writeAudit('escalated')
      return
    }
    // direct / lookup: gather dws facts, then draft. No honest draft -> escalate (fail-closed).
    const facts: Record<string, unknown> = {}
    for (const need of factsNeeded(decision)) {
      try {
        if (need === 'calendar') facts.calendar = await this.dws.calendarQuery(new Date().toISOString().slice(0, 10))
        if (need === 'docs') facts.docs = await this.dws.docSearch(event.text)
        if (need === 'todos') facts.todos = await this.dws.todoList()
      } catch (error) {
        this.store.pendingAdd({
          messageId: event.messageId, senderId: event.senderId, senderName: event.senderName, chatId: event.chatId,
          chatType: event.chatType, category: decision.category, confidence: decision.confidence, rule: decision.rule ?? null,
          draft: `（查资料失败，已升级：${String(error).slice(0, 200)}）`,
        })
        writeAudit('escalated', undefined)
        return
      }
    }
    const draft = buildDraft(event, decision, { facts, live: this.dws.isLive })
    if (!draft) {
      this.store.pendingAdd({
        messageId: event.messageId, senderId: event.senderId, senderName: event.senderName, chatId: event.chatId,
        chatType: event.chatType, category: decision.category, confidence: decision.confidence, rule: decision.rule ?? null,
        draft: '（无可信草稿，已升级，需人工处理）',
      })
      writeAudit('escalated')
      return
    }
    // Draft mode is the default: drafts wait for human approval in the UI.
    if (!this.machine.autoSendDirect || decision.action !== 'direct' || this.sentToday() >= this.machine.dailyCap) {
      this.store.pendingAdd({
        messageId: event.messageId, senderId: event.senderId, senderName: event.senderName, chatId: event.chatId,
        chatType: event.chatType, category: decision.category, confidence: decision.confidence, rule: decision.rule ?? null, draft,
      })
      writeAudit('drafted', draft)
      return
    }
    const result = await this.send.send({
      messageId: event.messageId, chatType: event.chatType, chatId: event.chatId, senderName: event.senderName,
      text: draft, idempotencyKey: `dingtalk-autoreply:${event.messageId}`,
    })
    writeAudit(result.status, draft)
  }

  private markSeen(messageId: string): void {
    this.seen.add(messageId)
    this.store.markSeen(messageId)
  }

  /** Approve a pending item from the UI: `approve` sends (with the marker), `reject` drops it. */
  async decidePending(id: number, action: 'approve' | 'reject', editedText?: string): Promise<{ status: string }> {
    const item = this.store.pendingGet(id)
    if (!item) throw new Error(`pending item ${id} not found`)
    if (item.status !== 'pending') throw new Error(`pending item ${id} is already ${item.status}`)
    if (action === 'reject') { this.store.pendingSetStatus(id, 'rejected'); return { status: 'rejected' } }
    const text = (editedText ?? item.draft).trim()
    if (!text || text.startsWith('（')) throw new Error('cannot send an escalation placeholder as a reply')
    const result = await this.send.send({
      messageId: item.messageId, chatType: item.chatType as 'dm' | 'group', chatId: item.chatId,
      senderName: item.senderName, text, idempotencyKey: `dingtalk-autoreply:${item.messageId}`,
    })
    this.store.pendingSetStatus(id, result.status === 'sent' ? 'sent' : 'sent-dryrun')
    return { status: result.status }
  }

  /** Direct event injection (HTTP ingest endpoint + tests). */
  async ingest(line: string): Promise<void> {
    await this.watcher.feedLine(line)
  }
}
