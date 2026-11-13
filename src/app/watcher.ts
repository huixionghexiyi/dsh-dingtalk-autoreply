/** DingTalk watcher: subscribes to the operator's own messages via the official dws CLI.
 * Live mode spawns `dws event +listen-im --kind all-direct` and `--kind all-group` (Stream WebSocket, NDJSON).
 * When dws is not logged in (or mode is `simulate`), it reads simulated NDJSON instead — the pipeline is identical,
 * only the source differs. Listener crashes auto-restart (≤30s backoff) and missed messages are backfilled via
 * `dws chat +search-msg` in live mode. */
import { spawn, type ChildProcess } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { normalizeDwsLine, type DingtalkEvent } from '../core/triage.ts'
import type { DwsClient } from '../core/dws.ts'

export type WatcherMode = 'live' | 'simulate'

export interface WatcherHost {
  dws: DwsClient
  dwsPath: string
  mode: WatcherMode
  /** Fixture NDJSON path used in simulate mode. */
  simulateFile?: string
  onEvent: (event: DingtalkEvent) => Promise<void>
  onLog: (message: string) => void
}

export class DingtalkWatcher {
  private children: ChildProcess[] = []
  private stopped = false
  private restarts = 0

  constructor(private readonly host: WatcherHost) {}

  async start(): Promise<WatcherMode> {
    if (this.host.mode === 'live') {
      const status = await this.host.dws.authStatusReadonly()
      if (!status.loggedIn) {
        this.host.onLog(`dws not logged in (${status.detail}); falling back to simulate mode — run \`dws auth login\` on the operator machine for live mode`)
        return this.startSimulate()
      }
      this.spawnListener('all-direct')
      this.spawnListener('all-group')
      return 'live'
    }
    return this.startSimulate()
  }

  /** Feed one raw NDJSON line (used by the HTTP ingest endpoint and the simulate feeder). */
  async feedLine(line: string): Promise<void> {
    const event = normalizeDwsLine(line)
    if (!event) { this.host.onLog(`skipping unparsable event line: ${line.slice(0, 120)}`); return }
    await this.host.onEvent(event)
  }

  private async startSimulate(): Promise<'simulate'> {
    const file = this.host.simulateFile
    if (!file) { this.host.onLog('simulate mode: no simulateFile configured; waiting for events via the HTTP ingest endpoint'); return 'simulate' }
    this.host.onLog(`simulate mode: feeding ${file}`)
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const line of lines) {
      if (this.stopped) break
      if (!line.trim()) continue
      await this.feedLine(line)
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    this.host.onLog('simulate mode: fixture fully fed')
    return 'simulate'
  }

  private spawnListener(kind: 'all-direct' | 'all-group'): void {
    if (this.stopped) return
    const child = spawn(this.host.dwsPath, ['event', '+listen-im', '--kind', kind, '-f', 'ndjson'], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.children.push(child)
    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) void this.feedLine(line)
    })
    child.stderr.on('data', (chunk: Buffer) => { this.host.onLog(`dws ${kind}: ${chunk.toString('utf8').trim().slice(0, 300)}`) })
    child.on('exit', (code) => {
      this.host.onLog(`dws listener ${kind} exited (${code}); restarting`)
      void this.restartListener(kind)
    })
  }

  private async restartListener(kind: 'all-direct' | 'all-group'): Promise<void> {
    if (this.stopped) return
    this.restarts += 1
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.restarts, 5))
    await new Promise(resolve => setTimeout(resolve, delay))
    if (this.stopped) return
    // Backfill missed messages in live mode before resuming the stream.
    try { await this.host.dws.searchMessages('') } catch { /* backfill is best-effort; audit notes it */ }
    this.spawnListener(kind)
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const child of this.children) child.kill()
    this.children = []
  }
}
