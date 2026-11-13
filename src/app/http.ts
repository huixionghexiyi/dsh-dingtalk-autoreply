/** Loopback-only management HTTP routes for the panel and the verification scripts.
 * Same pattern as dsh-superagent's /orchestrator routes: prefix registration on DSH's webServer with a
 * same-origin check. Clients must send `x-dingtalk-request: 1` and an Origin matching the loopback host. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Runtime } from './runtime.ts'

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.headers['x-dingtalk-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) as unknown : {}
}

export function registerHttp(ctx: Context, runtime: Runtime): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('DingTalk management requires a loopback Web server')
  const dispose = ctx.webServer.register({
    kind: 'prefix', path: '/dingtalk-autoreply', handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/dingtalk-autoreply/api/')) { res.writeHead(404); res.end(); return }
      if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      try {
        await runtime.ready
        const path = url.pathname.slice('/dingtalk-autoreply/api/'.length)
        const method = req.method ?? 'GET'
        if (method === 'GET' && path === 'status') return json(res, 200, runtime.status())
        if (method === 'GET' && path === 'pending') return json(res, 200, runtime.store.pendingList())
        if (method === 'GET' && path === 'sessions') return json(res, 200, runtime.store.sessionList())
        if (method === 'GET' && path === 'audit') return json(res, 200, runtime.store.auditList(100))
        if (method === 'GET' && path === 'outbox') return json(res, 200, runtime.store.outboxList(100))
        if (method === 'POST' && path === 'approve') {
          const body = await readBody(req, 64 * 1024) as { id?: number, action?: string, text?: string }
          if (typeof body.id !== 'number' || (body.action !== 'approve' && body.action !== 'reject')) {
            return json(res, 400, { error: 'expected {id: number, action: approve|reject, text?}' })
          }
          return json(res, 200, await runtime.decidePending(body.id, body.action, body.text))
        }
        if (method === 'POST' && path === 'ingest') {
          const body = await readBody(req, 64 * 1024) as { line?: string }
          if (typeof body.line !== 'string') return json(res, 400, { error: 'expected {line: string} (NDJSON)' })
          await runtime.ingest(body.line)
          return json(res, 200, { ok: true })
        }
        return json(res, 404, { error: 'Unknown operation' })
      } catch (error) { json(res, 500, { error: String(error) }) }
    },
  })
  return () => { dispose() }
}
