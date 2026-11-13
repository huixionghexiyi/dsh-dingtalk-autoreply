/** Deterministic triage for DingTalk messages: Layer 0 hard filter, Layer 1 deny rules, Layer 2 classification.
 * No model calls here by design: deny decisions are deterministic and a model can never override them.
 * Pure functions (except the `seen` set passed in) so they are unit-testable without DSH. */

/** Normalized DingTalk message event, produced by the watcher from dws NDJSON. */
export interface DingtalkEvent {
  messageId: string
  /** dws event kind: message | reaction | read | recall | ... */
  eventType: string
  chatType: 'dm' | 'group'
  chatId: string
  chatName?: string
  senderId: string
  senderName: string
  text: string
  atMe: boolean
  timestamp: string
  raw: unknown
}

export type DecisionAction = 'drop' | 'escalate' | 'direct' | 'lookup'

export interface Decision {
  action: DecisionAction
  /** Fine-grained category, e.g. `deny:money`, `direct:greeting`, `lookup:calendar`. */
  category: string
  /** 0..1. Deterministic classifier caps at 0.85; below the threshold the decision is escalated. */
  confidence: number
  /** Matched deny-rule id, when one fired. */
  rule?: string
  reason: string
}

/** One deterministic deny rule. A hit always escalates (never auto-sends) and the model cannot override it. */
export interface DenyRule {
  id: string
  category: string
  patterns: RegExp[]
  /** Where the hit goes: `escalate` (needs the human) — nothing in this table ever drops silently. */
  target: 'escalate'
}

export const DENY_RULES: DenyRule[] = [
  // Prompt-injection style attempts first: impersonation, instruction override, identity-marker removal.
  { id: 'deny:adversarial', category: 'adversarial', target: 'escalate', patterns: [/忽略.*指令/, /ignore.*instruction/i, /假装你是/, /不要加.*标识/, /假装.*本人/, /你是.*领导/, /我是你领导/] },
  { id: 'deny:money', category: 'money', target: 'escalate', patterns: [/报销/, /转账/, /付款/, /付钱/, /报价/, /合同金额/, /金额/, /打款/, /垫付/, /发票/] },
  { id: 'deny:hr', category: 'hr', target: 'escalate', patterns: [/绩效/, /薪酬/, /薪资/, /工资/, /奖金/, /评价.*同事/, /给.*打分/, /离职/, /裁员/, /开除/] },
  { id: 'deny:commitment', category: 'commitment', target: 'escalate', patterns: [/保证.*上线/, /承诺/, /一定.*完成/, /确保.*(周|月|今天|明天)/, /deadline/i, /向客户承诺/, /对外承诺/] },
  { id: 'deny:sensitive', category: 'sensitive', target: 'escalate', patterns: [/密码/, /密钥/, /token/i, /secret/i, /数据库密码/, /奖金方案/, /未公开/, /内部机密/, /身份证/, /银行卡/] },
  { id: 'deny:conflict', category: 'conflict', target: 'escalate', patterns: [/投诉/, /举报/, /问责/, /吵架/, /不满/, /为什么不回/, /推卸/] },
  { id: 'deny:compliance', category: 'compliance', target: 'escalate', patterns: [/法务/, /审计/, /监管/, /合规/, /律师/] },
]

const EMOJI_ONLY = /^[\p{Emoji}\p{Extended_Pictographic}\s]+$/u
const SYSTEM_OR_AD = /系统通知|钉钉小助手|广告|推广|抽奖|点击领取/

export interface TriageOptions {
  /** The operator's own DingTalk userId: their own messages are always dropped (anti-loop). */
  selfUserId?: string
  /** Classification confidence below this escalates. Default 0.8. */
  confidenceThreshold?: number
}

/** Layer 2: deterministic keyword classifier used when no model is configured (verification mode).
 * Confidence is capped at 0.85 so a keyword hit never claims model-grade certainty. */
export function classifyText(text: string): { action: 'direct' | 'lookup' | 'escalate', category: string, confidence: number } {
  const lookup = /(日历|日程|有空|空闲|会议|几点|什么时候|审批|待办|文档|链接|纪要|状态|进度|查一下|帮我查)/.test(text)
  if (lookup) return { action: 'lookup', category: /(日历|日程|有空|空闲|会议|几点|什么时候)/.test(text) ? 'lookup:calendar' : 'lookup:info', confidence: 0.8 }
  const direct = /^(你好|您好|在吗|在么|收到|谢谢|好的|嗯|OK|ok|👍|🙏)/.test(text.trim()) || /(周报链接|文档链接|发我一下|收到)/.test(text)
  if (direct) return { action: 'direct', category: 'direct:greeting', confidence: 0.85 }
  return { action: 'escalate', category: 'escalate:unclear', confidence: 0.6 }
}

/** Run Layers 0–2 over one event. `seen` is the set of already-processed messageIds (SQLite-backed in the app). */
export function triage(event: DingtalkEvent, seen: ReadonlySet<string>, options: TriageOptions = {}): Decision {
  const threshold = options.confidenceThreshold ?? 0.8
  // Layer 0 — hard filter (no model, no rules).
  if (event.eventType !== 'message') return { action: 'drop', category: 'drop:non-message-event', confidence: 1, reason: `eventType=${event.eventType} 不是消息事件` }
  if (options.selfUserId && event.senderId === options.selfUserId) return { action: 'drop', category: 'drop:own-message', confidence: 1, reason: '本人发出的消息，防自回环' }
  if (seen.has(event.messageId)) return { action: 'drop', category: 'drop:duplicate', confidence: 1, reason: `messageId=${event.messageId} 已处理过` }
  if (!event.text || !event.text.trim() || EMOJI_ONLY.test(event.text.trim())) return { action: 'drop', category: 'drop:empty-or-emoji', confidence: 1, reason: '空消息或纯表情' }
  if (SYSTEM_OR_AD.test(event.text)) return { action: 'drop', category: 'drop:system-or-ad', confidence: 1, reason: '系统通知或广告' }
  if (event.chatType === 'group' && !event.atMe) return { action: 'drop', category: 'drop:group-not-at-me', confidence: 1, reason: '群聊未 @本人' }
  // Layer 1 — deny rules (deterministic; model cannot override).
  for (const rule of DENY_RULES) {
    if (rule.patterns.some(pattern => pattern.test(event.text))) {
      return { action: 'escalate', category: rule.category, confidence: 1, rule: rule.id, reason: `命中否决规则 ${rule.id}` }
    }
  }
  // Layer 2 — classification. Low confidence escalates (fail-closed).
  const classified = classifyText(event.text)
  if (classified.confidence < threshold) {
    return { action: 'escalate', category: classified.category, confidence: classified.confidence, reason: `分类置信度 ${classified.confidence} 低于阈值 ${threshold}` }
  }
  return { action: classified.action, category: classified.category, confidence: classified.confidence, reason: '分类通过' }
}

/** Normalize one NDJSON line from `dws event` into a DingtalkEvent.
 * Handles (a) this plugin's fixture format (already normalized), (b) dws `--flatten` output (best-effort field
 * aliases), (c) the dws transport envelope `{type, event_type, data, headers}` where `data` is a JSON string.
 * Unknown shapes return undefined instead of throwing; the watcher logs and skips them. */
export function normalizeDwsLine(line: string): DingtalkEvent | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(line) } catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const obj = parsed as Record<string, unknown>
  // (a) Fixture / already-normalized shape.
  if (typeof obj.messageId === 'string' && typeof obj.text === 'string') {
    return {
      messageId: obj.messageId,
      eventType: typeof obj.eventType === 'string' ? obj.eventType : 'message',
      chatType: obj.chatType === 'group' ? 'group' : 'dm',
      chatId: typeof obj.chatId === 'string' ? obj.chatId : '',
      chatName: typeof obj.chatName === 'string' ? obj.chatName : undefined,
      senderId: typeof obj.senderId === 'string' ? obj.senderId : '',
      senderName: typeof obj.senderName === 'string' ? obj.senderName : '',
      text: obj.text,
      atMe: obj.atMe === true || obj.chatType === 'dm',
      timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : new Date().toISOString(),
      raw: parsed,
    }
  }
  // (b/c) dws envelope or flattened shape: unwrap `data` if it is a JSON string.
  let data: Record<string, unknown> = obj
  if (typeof obj.data === 'string') {
    try { const inner = JSON.parse(obj.data); if (typeof inner === 'object' && inner !== null) data = inner as Record<string, unknown> } catch { /* keep envelope */ }
  }
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) { const value = data[key]; if (typeof value === 'string' && value) return value }
    return undefined
  }
  const messageId = pick('messageId', 'msgId', 'openMessageId', 'id')
  const text = pick('text', 'content', 'messageContent')
  if (!messageId || text === undefined) return undefined
  const conversationId = pick('conversationId', 'openConversationId', 'chatId', 'chat_id') ?? ''
  const senderId = pick('senderId', 'senderStaffId', 'sender_user_id', 'openDingTalkId') ?? ''
  const eventType = typeof obj.event_type === 'string' ? obj.event_type : (pick('eventType', 'event_type') ?? 'message')
  const isGroup = /group/i.test(conversationId) || data.chatType === 'group' || data.conversationType === 'group'
  return {
    messageId,
    eventType: eventType.includes('recall') ? 'recall' : eventType.includes('read') ? 'read' : eventType.includes('reaction') ? 'reaction' : 'message',
    chatType: isGroup ? 'group' : 'dm',
    chatId: conversationId,
    chatName: pick('chatName', 'conversationName'),
    senderId,
    senderName: pick('senderName', 'senderNick', 'nick') ?? senderId,
    text,
    atMe: data.atMe === true || !isGroup,
    timestamp: pick('timestamp', 'createAt', 'createdAt') ?? new Date().toISOString(),
    raw: parsed,
  }
}
