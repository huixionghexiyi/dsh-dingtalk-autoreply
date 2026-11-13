/** Minimal approval panel: pending queue + per-colleague session list.
 * Fetches the host plugin's loopback API; approve/reject posts back. Clicking a session opens it in the workspace. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { openKnownSession } from './navigation.ts'

interface PendingItem {
  id: number
  messageId: string
  senderName: string
  chatType: string
  category: string
  confidence: number
  rule: string | null
  draft: string
  status: string
}

interface SessionItem {
  key: string
  sessionId: string
  displayName: string
  kind: string
  lastActive: string
  paused: number
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`/dingtalk-autoreply/api/${path}`, {
    ...init,
    headers: { 'x-dingtalk-request': '1', 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = await response.json() as unknown
  if (!response.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${response.status}`)
  return body
}

export function App({ sessions, openSession }: { sessions: ISessions, openSession: (id: string) => Promise<void> }) {
  const [tab, setTab] = useState<'pending' | 'sessions'>('pending')
  const [pending, setPending] = useState<PendingItem[]>([])
  const [list, setList] = useState<SessionItem[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    try {
      setError('')
      setPending(await api('pending') as PendingItem[])
      setList(await api('sessions') as SessionItem[])
    } catch (err) { setError(String(err)) }
  }, [])
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 10_000); return () => clearInterval(timer) }, [load])
  const decide = async (id: number, action: 'approve' | 'reject'): Promise<void> => {
    setBusy(true)
    try { await api('approve', { method: 'POST', body: JSON.stringify({ id, action }) }); await load() }
    catch (err) { setError(String(err)) } finally { setBusy(false) }
  }
  const waiting = pending.filter(item => item.status === 'pending')
  return (
    <div style={{ padding: 16, fontFamily: 'sans-serif', maxWidth: 960 }}>
      <h2>钉钉自动回复</h2>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button disabled={tab === 'pending'} onClick={() => setTab('pending')}>待处理（{waiting.length}）</button>
        <button disabled={tab === 'sessions'} onClick={() => setTab('sessions')}>会话（{list.length}）</button>
        <button onClick={() => void load()}>刷新</button>
      </div>
      {tab === 'pending' && (waiting.length === 0 ? <p>暂无待处理事项。</p> : waiting.map(item => (
        <div key={item.id} style={{ border: '1px solid #ccc', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div><b>{item.senderName}</b> · {item.chatType === 'dm' ? '单聊' : '群聊'} · 分类 {item.category} · 置信度 {item.confidence}{item.rule ? ` · 规则 ${item.rule}` : ''}</div>
          <div style={{ margin: '8px 0', whiteSpace: 'pre-wrap' }}>{item.draft}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button disabled={busy} onClick={() => void decide(item.id, 'approve')}>批准发送</button>
            <button disabled={busy} onClick={() => void decide(item.id, 'reject')}>拒绝</button>
          </div>
        </div>
      )))}
      {tab === 'sessions' && (list.length === 0 ? <p>暂无同事会话。收到消息后会在这里出现。</p> : (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead><tr><th style={{ textAlign: 'left' }}>同事</th><th style={{ textAlign: 'left' }}>类型</th><th style={{ textAlign: 'left' }}>最后活跃</th><th /></tr></thead>
          <tbody>{list.map(item => (
            <tr key={item.key}>
              <td>{item.displayName}</td><td>{item.kind === 'dm' ? '单聊' : '群聊'}</td><td>{item.lastActive}</td>
              <td><button onClick={() => void openSession(item.sessionId)}>打开会话</button></td>
            </tr>
          ))}</tbody>
        </table>
      ))}
    </div>
  )
}
