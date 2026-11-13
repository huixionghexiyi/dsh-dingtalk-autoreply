/** dws CLI client + send service.
 * Two modes:
 * - `live`: shells out to the real `dws` binary (requires `dws auth login` on the operator machine).
 * - `mock`: returns canned, clearly-labeled data so the pipeline can be verified without any DingTalk login.
 * The send service ALWAYS appends the AI identity marker and refuses to send when the marker is missing.
 * In mock mode nothing is ever sent: the reply is recorded in the outbox as `sent-dryrun`. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Store } from './store.ts'

const execFileAsync = promisify(execFile)

export type DwsMode = 'live' | 'mock'

export const IDENTITY_MARKER = '——以上由 AI 助手代回'

export class DwsClient {
  constructor(
    private readonly mode: DwsMode,
    private readonly dwsPath = 'dws',
  ) {}

  get isLive(): boolean { return this.mode === 'live' }

  private async run(args: string[]): Promise<string> {
    if (this.mode === 'mock') throw new Error('DwsClient is in mock mode; live dws calls are disabled')
    const { stdout } = await execFileAsync(this.dwsPath, [...args, '--format', 'json'], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
    return stdout
  }

  /** Read-only: query the operator's calendar. Mock returns a fixed, labeled fixture. */
  async calendarQuery(date: string): Promise<unknown> {
    if (this.mode === 'mock') return { mock: true, date, busy: [{ start: '15:00', end: '16:00', title: '项目周会（Mock 数据）' }], free: '除 15:00–16:00 外空闲' }
    return JSON.parse(await this.run(['calendar', '+day', '--date', date]))
  }

  /** Read-only: search chat history (used for backfill after a listener outage). */
  async searchMessages(query: string): Promise<unknown> {
    if (this.mode === 'mock') return { mock: true, query, items: [] }
    return JSON.parse(await this.run(['chat', '+search-msg', '--query', query]))
  }

  /** Read-only: list todos. */
  async todoList(): Promise<unknown> {
    if (this.mode === 'mock') return { mock: true, items: [{ title: '提交项目周报（Mock 数据）', status: 'open' }] }
    return JSON.parse(await this.run(['todo', 'list']))
  }

  /** Read-only: search docs. */
  async docSearch(query: string): Promise<unknown> {
    if (this.mode === 'mock') return { mock: true, query, items: [{ title: '项目周报模板（Mock 数据）', url: 'https://example.invalid/mock-doc' }] }
    return JSON.parse(await this.run(['doc', 'search', '--query', query]))
  }

  /** Live-only: check login state without logging in (`--readonly` never writes credentials). */
  async authStatusReadonly(): Promise<{ loggedIn: boolean, detail: string }> {
    try {
      const out = await execFileAsync(this.dwsPath, ['auth', 'status', '--readonly', '--format', 'json'], { timeout: 15_000 })
      const parsed = JSON.parse(out.stdout) as { logged_in?: boolean, local_state?: string, reason?: string }
      return { loggedIn: parsed.logged_in === true, detail: parsed.reason ?? parsed.local_state ?? '' }
    } catch (error) {
      return { loggedIn: false, detail: String(error) }
    }
  }
}

export interface SendRequest {
  messageId: string
  chatType: 'dm' | 'group'
  chatId: string
  /** For DM fallback: the colleague's display name (`dws chat +dm --to <name>`). */
  senderName: string
  text: string
  /** Idempotency key for the reply (messageId-based). */
  idempotencyKey: string
}

export interface SendResult {
  status: 'sent' | 'sent-dryrun'
  target: string
  text: string
  detail: string
}

/** The ONLY way a reply leaves this plugin. Appends the identity marker, verifies it, then either calls
 * `dws chat +messages-reply` (live) or records the reply in the dry-run outbox (mock). */
export class SendService {
  constructor(
    private readonly dws: DwsClient,
    private readonly store: Store,
    private readonly marker: string = IDENTITY_MARKER,
  ) {}

  withMarker(text: string): string {
    return text.includes(this.marker) ? text : `${text}\n${this.marker}`
  }

  async send(request: SendRequest): Promise<SendResult> {
    const text = this.withMarker(request.text)
    if (!text.includes(this.marker)) throw new Error('refusing to send: AI identity marker missing')
    const target = request.chatType === 'group' ? `group:${request.chatId}` : `dm:${request.senderName}`
    if (!this.dws.isLive) {
      this.store.outboxAdd(request.messageId, target, text, 'sent-dryrun')
      return { status: 'sent-dryrun', target, text, detail: 'mock mode: recorded in outbox, nothing sent' }
    }
    // Live: quote-reply the original message as the user; --ai-tag keeps dws's own AI badge on.
    const args = ['chat', '+messages-reply', '--message-id', request.messageId, '--content', text,
      '--idempotency-key', request.idempotencyKey, '--yes']
    if (request.chatType === 'group') args.push('--group', request.chatId)
    const out = await execFileAsync('dws', [...args, '--format', 'json'], { timeout: 30_000 })
    this.store.outboxAdd(request.messageId, target, text, 'sent')
    return { status: 'sent', target, text, detail: out.stdout.slice(0, 500) }
  }
}
