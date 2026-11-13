/** Unit tests for the template draft builder (no model, no network). */
import { describe, expect, it } from 'vitest'
import { buildDraft } from '../src/core/drafts.ts'
import type { DingtalkEvent, Decision } from '../src/core/triage.ts'

const event = (text: string): DingtalkEvent => ({
  messageId: 'm1', eventType: 'message', chatType: 'dm', chatId: 'dm-a', senderId: 'u-a', senderName: '张三',
  text, atMe: true, timestamp: '2026-11-14T09:00:00+08:00', raw: {},
})
const direct: Decision = { action: 'direct', category: 'direct:greeting', confidence: 0.85, reason: '分类通过' }

describe('buildDraft direct', () => {
  it('answers a CJK greeting (no \\b after CJK)', () => {
    expect(buildDraft(event('你好'), direct, { live: false })).toBe('你好，我在，有什么事请说。')
    expect(buildDraft(event('在吗'), direct, { live: false })).toBe('你好，我在，有什么事请说。')
  })
  it('answers thanks', () => {
    expect(buildDraft(event('谢谢'), direct, { live: false })).toBe('不客气。')
  })
  it('returns undefined for direct text with no safe template (caller escalates)', () => {
    expect(buildDraft(event('帮我看下这个'), direct, { live: false })).toBeUndefined()
  })
})
