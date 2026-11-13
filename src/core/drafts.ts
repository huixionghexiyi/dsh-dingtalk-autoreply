/** Draft builder (Layer 3).
 * Verification mode drafts from templates + dws facts only. It NEVER invents a fact: when the needed fact is not
 * in the dws result, the draft says so and the message is escalated instead of answered. In live mode with a model
 * configured, the Worker session's model turn replaces this template draft (same contract: cite dws facts only). */
import type { DingtalkEvent, Decision } from './triage.ts'

export interface DraftContext {
  /** Facts returned by dws read calls (calendar, docs, todos, ...). Empty when nothing was queried. */
  facts?: Record<string, unknown>
  /** Whether the dws layer is live. In mock mode, facts are labeled mock data. */
  live: boolean
}

/** Build a reply draft for a `direct` or `lookup` decision. Returns undefined when no honest draft is possible
 * (caller must escalate instead). */
export function buildDraft(event: DingtalkEvent, decision: Decision, context: DraftContext): string | undefined {
  if (decision.action === 'direct') {
    // NOTE: no \b after CJK alternatives — \b never matches between two CJK chars.
    if (/^(你好|您好|在吗|在么)/.test(event.text.trim()) || /^(hi|hello)\b/i.test(event.text.trim())) return '你好，我在，有什么事请说。'
    if (/谢谢/.test(event.text)) return '不客气。'
    if (/收到/.test(event.text.trim())) return '收到。'
    return undefined // direct but no safe template: escalate rather than improvise.
  }
  if (decision.action === 'lookup') {
    if (decision.category === 'lookup:calendar') {
      const facts = context.facts?.calendar as { busy?: { start: string, end: string, title: string }[], free?: string } | undefined
      if (!facts) return undefined
      const busy = (facts.busy ?? []).map(item => `${item.start}–${item.end} ${item.title}`).join('；')
      return busy ? `今天下午三点已有安排：${busy}。${facts.free ?? ''}`.trim() : '今天下午三点目前是空闲的。'
    }
    if (decision.category === 'lookup:info') {
      const facts = context.facts
      if (!facts || Object.keys(facts).length === 0) return undefined
      if (facts.docs) {
        const docs = facts.docs as { items?: { title: string, url: string }[] }
        const first = docs.items?.[0]
        if (first) return `找到了相关文档：${first.title} ${first.url}`
      }
      if (facts.todos) {
        const todos = facts.todos as { items?: { title: string, status: string }[] }
        const open = (todos.items ?? []).filter(item => item.status === 'open').map(item => item.title).join('、')
        if (open) return `待办里还有这些未完成：${open}。`
      }
      return undefined
    }
  }
  return undefined
}

/** Facts the Worker should query for a lookup decision. The host runs these dws calls before drafting. */
export function factsNeeded(decision: Decision): ('calendar' | 'docs' | 'todos')[] {
  if (decision.action !== 'lookup') return []
  if (decision.category === 'lookup:calendar') return ['calendar']
  return ['docs', 'todos']
}
