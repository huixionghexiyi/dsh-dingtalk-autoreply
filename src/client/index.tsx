/** Browser plugin entry: registers the sidebar icon and the approval panel.
 * Pattern copied from dsh-superagent-prototype src/client/index.tsx (MIT), trimmed to the two MVP views. */
import { useCallback, useRef } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { openKnownSession, SessionNavigationError } from './navigation.ts'
import { App } from './app.tsx'

type ClientContext = Context & {
  sessions: ISessions
  /** Slot registry (same runtime API as dsh-superagent's client; typed structurally here). */
  slots: {
    inject: (name: string, factory: () => (() => void) | void) => void
    register: (...args: unknown[]) => () => void
  }
  uiWorkspace: { openSession: (id: SessionId) => void }
}
const PANEL_ID = 'dingtalk-autoreply' as MainPanelId

function ChatIcon({ size }: SidebarPanelIconOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  </svg>
}

function Mounted({ ctx }: { ctx: ClientContext }) {
  const pending = useRef<AbortController>(undefined)
  const openSession = useCallback(async (id: string) => {
    pending.current?.abort()
    const request = new AbortController(); pending.current = request
    try {
      await openKnownSession(ctx.sessions, id as SessionId, target => { ctx.uiWorkspace.openSession(target) }, request.signal)
    } catch (error) {
      if (error instanceof SessionNavigationError) throw new Error(error.code === 'not-ready' ? '会话列表尚未就绪' : '会话未在列表中')
      throw error
    }
  }, [ctx])
  return <App sessions={ctx.sessions} openSession={openSession} />
}

export const inject = ['slots', 'sessions', 'uiWorkspace']
/** Registers the panel and sidebar icon. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: 'dingtalk-autoreply', inject: () => ({}) },
    () => <Mounted ctx={ctx} />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => '钉钉自动回复', locale: 'dingtalk-autoreply' }, ChatIcon))
}
