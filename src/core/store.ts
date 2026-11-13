/** SQLite state for the plugin (node:sqlite, built into Node 24): dedupe, audit trail, pending queue,
 * per-colleague session registry, and the dry-run outbox. One file under stateDir, like super-agent's stateDir. */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// DB columns are snake_case; row interfaces are camelCase. Convert on read.
function camelRows<T>(rows: Record<string, unknown>[]): T[] {
  return rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), value,
  ])) as unknown as T)
}

export interface AuditRow {
  id: number
  messageId: string
  senderId: string
  senderName: string
  chatId: string
  chatType: string
  action: string
  category: string
  confidence: number
  rule: string | null
  reason: string
  draft: string | null
  status: string
  createdAt: string
}

export interface PendingRow {
  id: number
  messageId: string
  senderId: string
  senderName: string
  chatId: string
  chatType: string
  category: string
  confidence: number
  rule: string | null
  draft: string
  status: 'pending' | 'approved' | 'rejected' | 'sent' | 'sent-dryrun'
  createdAt: string
  updatedAt: string
}

export interface SessionRow {
  key: string
  sessionId: string
  displayName: string
  kind: 'dm' | 'group'
  lastActive: string
  paused: number
}

export class Store {
  private readonly db: DatabaseSync
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen (message_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL, chat_id TEXT NOT NULL, chat_type TEXT NOT NULL, action TEXT NOT NULL,
        category TEXT NOT NULL, confidence REAL NOT NULL, rule TEXT, reason TEXT NOT NULL,
        draft TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending (
        id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL, chat_id TEXT NOT NULL, chat_type TEXT NOT NULL, category TEXT NOT NULL,
        confidence REAL NOT NULL, rule TEXT, draft TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS colleague_sessions (
        key TEXT PRIMARY KEY, session_id TEXT NOT NULL, display_name TEXT NOT NULL, kind TEXT NOT NULL,
        last_active TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, target TEXT NOT NULL,
        text TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_audit_message ON audit(message_id);
      CREATE INDEX IF NOT EXISTS idx_pending_status ON pending(status);
    `)
  }
  close(): void { this.db.close() }

  // Dedupe
  hasSeen(messageId: string): boolean {
    return this.db.prepare('SELECT 1 FROM seen WHERE message_id = ?').get(messageId) !== undefined
  }
  markSeen(messageId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO seen(message_id, created_at) VALUES (?, ?)').run(messageId, new Date().toISOString())
  }
  seenIds(): Set<string> {
    return new Set(this.db.prepare('SELECT message_id FROM seen').all().map(row => (row as { message_id: string }).message_id))
  }

  // Audit
  auditAdd(row: Omit<AuditRow, 'id' | 'createdAt'>): number {
    const result = this.db.prepare(`INSERT INTO audit(message_id, sender_id, sender_name, chat_id, chat_type, action,
      category, confidence, rule, reason, draft, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.messageId, row.senderId, row.senderName, row.chatId, row.chatType, row.action, row.category,
        row.confidence, row.rule, row.reason, row.draft, row.status, new Date().toISOString())
    return Number(result.lastInsertRowid)
  }
  auditList(limit = 100): AuditRow[] {
    return camelRows<AuditRow>(this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[])
  }
  auditByMessage(messageId: string): AuditRow[] {
    return camelRows<AuditRow>(this.db.prepare('SELECT * FROM audit WHERE message_id = ? ORDER BY id').all(messageId) as Record<string, unknown>[])
  }

  // Pending queue (drafts + escalations awaiting a human decision in the UI)
  pendingAdd(row: Omit<PendingRow, 'id' | 'status' | 'createdAt' | 'updatedAt'>): number {
    const now = new Date().toISOString()
    const result = this.db.prepare(`INSERT INTO pending(message_id, sender_id, sender_name, chat_id, chat_type, category,
      confidence, rule, draft, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(row.messageId, row.senderId, row.senderName, row.chatId, row.chatType, row.category,
        row.confidence, row.rule, row.draft, now, now)
    return Number(result.lastInsertRowid)
  }
  pendingList(status?: string): PendingRow[] {
    if (status) return camelRows<PendingRow>(this.db.prepare('SELECT * FROM pending WHERE status = ? ORDER BY id').all(status) as Record<string, unknown>[])
    return camelRows<PendingRow>(this.db.prepare('SELECT * FROM pending ORDER BY id').all() as Record<string, unknown>[])
  }
  pendingGet(id: number): PendingRow | undefined {
    const row = this.db.prepare('SELECT * FROM pending WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? camelRows<PendingRow>([row])[0] : undefined
  }
  pendingSetStatus(id: number, status: PendingRow['status']): void {
    this.db.prepare('UPDATE pending SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id)
  }

  // Per-colleague session registry: key `dm:<senderId>` or `group:<chatId>` -> DSH session id.
  sessionGet(key: string): SessionRow | undefined {
    const row = this.db.prepare('SELECT * FROM colleague_sessions WHERE key = ?').get(key) as Record<string, unknown> | undefined
    return row ? camelRows<SessionRow>([row])[0] : undefined
  }
  sessionUpsert(row: SessionRow): void {
    this.db.prepare(`INSERT INTO colleague_sessions(key, session_id, display_name, kind, last_active, paused)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET last_active = excluded.last_active, display_name = excluded.display_name`)
      .run(row.key, row.sessionId, row.displayName, row.kind, row.lastActive, row.paused)
  }
  sessionList(): SessionRow[] {
    return camelRows<SessionRow>(this.db.prepare('SELECT * FROM colleague_sessions ORDER BY last_active DESC').all() as Record<string, unknown>[])
  }
  sessionSetPaused(key: string, paused: boolean): void {
    this.db.prepare('UPDATE colleague_sessions SET paused = ? WHERE key = ?').run(paused ? 1 : 0, key)
  }

  // Dry-run outbox: what WOULD have been sent (verification mode never sends real messages).
  outboxAdd(messageId: string, target: string, text: string, status: string): number {
    const result = this.db.prepare('INSERT INTO outbox(message_id, target, text, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(messageId, target, text, status, new Date().toISOString())
    return Number(result.lastInsertRowid)
  }
  outboxList(limit = 100): { id: number, messageId: string, target: string, text: string, status: string, createdAt: string }[] {
    return camelRows<{ id: number, messageId: string, target: string, text: string, status: string, createdAt: string }>(this.db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[])
  }
}
