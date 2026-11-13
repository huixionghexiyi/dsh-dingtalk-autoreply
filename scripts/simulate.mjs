/** Feed the fixture NDJSON to the running plugin via its HTTP ingest endpoint.
 * Usage: node scripts/simulate.mjs [--port 3082] [--file fixtures/simulated-events.ndjson] */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const portIndex = args.indexOf('--port')
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : Number(process.env.DSH_PORT ?? 3082)
const fileIndex = args.indexOf('--file')
const file = fileIndex >= 0 ? resolve(args[fileIndex + 1]) : resolve('fixtures/simulated-events.ndjson')
const base = `http://127.0.0.1:${port}`

const headers = { 'content-type': 'application/json', 'x-dingtalk-request': '1', origin: base }

async function call(path, init) {
  const response = await fetch(`${base}/dingtalk-autoreply/api/${path}`, { ...init, headers })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}: ${JSON.stringify(body)}`)
  return body
}

const lines = readFileSync(file, 'utf8').split('\n').filter(line => line.trim())
console.log(`feeding ${lines.length} events from ${file} to ${base}`)
for (const line of lines) {
  const event = JSON.parse(line)
  await call('ingest', { method: 'POST', body: JSON.stringify({ line }) })
  console.log(`  ingested ${event.messageId} (${event.chatType}${event.chatType === 'group' ? ` @=${event.atMe}` : ''}) ${event.senderName}: ${event.text.slice(0, 40)}`)
  await new Promise(resolve => setTimeout(resolve, 400))
}
await new Promise(resolve => setTimeout(resolve, 1500))
const status = await call('status')
const pending = await call('pending')
const sessions = await call('sessions')
const audit = await call('audit')
const outbox = await call('outbox')
console.log('\n--- status ---')
console.log(JSON.stringify(status, null, 2))
console.log(`\n--- pending (${pending.length}) ---`)
for (const item of pending) console.log(`#${item.id} [${item.status}] ${item.senderName} ${item.category} conf=${item.confidence} rule=${item.rule ?? '-'} draft=${JSON.stringify(item.draft.slice(0, 60))}`)
console.log(`\n--- sessions (${sessions.length}) ---`)
for (const item of sessions) console.log(`${item.key} -> ${item.sessionId} (${item.displayName})`)
console.log(`\n--- audit (${audit.length}) ---`)
for (const row of audit) console.log(`${row.messageId} ${row.action} ${row.category} conf=${row.confidence} status=${row.status}`)
console.log(`\n--- outbox (${outbox.length}) ---`)
for (const row of outbox) console.log(`#${row.id} ${row.messageId} -> ${row.target} [${row.status}]`)
