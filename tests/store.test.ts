/** Unit tests for the SQLite store (node:sqlite, temp file). */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/core/store.ts'

function tempStore(): { store: Store, dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dingtalk-store-'))
  return { store: new Store(join(dir, 'test.sqlite')), dir }
}

describe('Store', () => {
  it('dedupes seen message ids', () => {
    const { store, dir } = tempStore()
    try {
      expect(store.hasSeen('m1')).toBe(false)
      store.markSeen('m1')
      expect(store.hasSeen('m1')).toBe(true)
      expect(store.seenIds().has('m1')).toBe(true)
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('records audit rows and pending items', () => {
    const { store, dir } = tempStore()
    try {
      store.auditAdd({ messageId: 'm1', senderId: 'u1', senderName: '张三', chatId: 'dm-a', chatType: 'dm', action: 'escalate', category: 'deny:money', confidence: 1, rule: 'deny:money', reason: '命中否决规则', draft: null, status: 'escalated' })
      expect(store.auditByMessage('m1')).toHaveLength(1)
      const id = store.pendingAdd({ messageId: 'm1', senderId: 'u1', senderName: '张三', chatId: 'dm-a', chatType: 'dm', category: 'deny:money', confidence: 1, rule: 'deny:money', draft: '（已升级）' })
      expect(store.pendingList('pending')).toHaveLength(1)
      store.pendingSetStatus(id, 'rejected')
      expect(store.pendingGet(id)?.status).toBe('rejected')
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('registers and lists colleague sessions', () => {
    const { store, dir } = tempStore()
    try {
      store.sessionUpsert({ key: 'dm:u1', sessionId: 'dingtalk-colleague-abc', displayName: '张三', kind: 'dm', lastActive: new Date().toISOString(), paused: 0 })
      expect(store.sessionGet('dm:u1')?.sessionId).toBe('dingtalk-colleague-abc')
      expect(store.sessionList()).toHaveLength(1)
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('records dry-run outbox entries', () => {
    const { store, dir } = tempStore()
    try {
      store.outboxAdd('m1', 'dm:张三', '你好，我在。\n——以上由 AI 助手代回', 'sent-dryrun')
      expect(store.outboxList()[0]?.text).toContain('AI 助手代回')
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
  })
})
