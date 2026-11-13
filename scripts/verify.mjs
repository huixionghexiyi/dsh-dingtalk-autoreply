/** Verification checks after booting the profile and feeding the fixture.
 * Usage: node scripts/verify.mjs [--port 3082] [--profile-dir ~/.dsh/profiles/dingtalk-clone] [--state-dir ~/.dsh/state/dingtalk-autoreply]
 * Prints PASS/FAIL per check and exits non-zero on any FAIL. */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const get = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback }
const port = Number(get('--port', process.env.DSH_PORT ?? 3082))
const profileDir = get('--profile-dir', join(homedir(), '.dsh', 'profiles', 'dingtalk-clone')).replace(/^~/, homedir())
const stateDir = get('--state-dir', join(homedir(), '.dsh', 'state', 'dingtalk-autoreply')).replace(/^~/, homedir())
const base = `http://127.0.0.1:${port}`
const headers = { 'content-type': 'application/json', 'x-dingtalk-request': '1', origin: base }

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

async function call(path, init) {
  const response = await fetch(`${base}/dingtalk-autoreply/api/${path}`, { ...init, headers })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}: ${JSON.stringify(body)}`)
  return body
}

function grepTree(dir, needle, depth = 0) {
  if (depth > 4 || !existsSync(dir)) return []
  const hits = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    try {
      if (entry.isDirectory()) hits.push(...grepTree(path, needle, depth + 1))
      else if (entry.isFile() && statSync(path).size < 20_000_000) {
        const text = readFileSync(path, 'utf8')
        if (text.includes(needle)) hits.push(path)
      }
    } catch { /* unreadable/binary: skip */ }
  }
  return hits
}

// 1. Plugin HTTP API reachable
let status
try {
  status = await call('status')
  check('plugin HTTP API reachable', true, `mode=${status.mode} watcher=${status.watcherMode}`)
} catch (error) { check('plugin HTTP API reachable', false, String(error)) }

if (status) {
  check('watcher in simulate mode (no DingTalk login)', status.watcherMode === 'simulate', `watcherMode=${status.watcherMode}`)
  check('Router session id registered', status.routerSessionId === 'dingtalk-router')
  const sessions = await call('sessions')
  check('colleague sessions created (expect 6: 5 DM + 1 group)', sessions.length === 6, `got ${sessions.length}`)
  check('all colleague sessions have DSH session ids', sessions.every(s => s.sessionId.startsWith('dingtalk-colleague-')), sessions.map(s => s.sessionId).join(', '))
  const pending = await call('pending')
  check('pending queue has 7 items (3 drafts + 4 escalations)', pending.length === 7, `got ${pending.length}`)
  const drafts = pending.filter(p => p.draft && !p.draft.startsWith('（'))
  check('drafts present for direct/lookup classes', drafts.length === 3, `got ${drafts.length}`)
  const audit = await call('audit')
  check('audit has 10 rows (duplicate replay not double-counted)', audit.length === 10, `got ${audit.length}`)
  const denyAutoSent = audit.filter(r => r.category.startsWith('deny:') && (r.status === 'sent' || r.status === 'sent-dryrun'))
  check('deny-class messages: zero auto-sent', denyAutoSent.length === 0, `got ${denyAutoSent.length}`)
  const outbox = await call('outbox')
  check('outbox empty in draft mode (nothing sent yet)', outbox.length === 0, `got ${outbox.length}`)
}

// 2. On-disk session persistence (the same store the Desktop app reads).
// DSH persists sessions globally under ~/.dsh/storages/session_projcache/sessions/<sessionId>.json,
// not under the profile dir — the Desktop app reads this same store, so plugin-created sessions
// show up in the Desktop workspace automatically.
const sessionStoreDir = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')
const routerHits = grepTree(sessionStoreDir, 'dingtalk-router')
check('Router session persisted in DSH session store', routerHits.length > 0, routerHits.slice(0, 3).join(', ') || 'no file mentions dingtalk-router')
const colleagueHits = grepTree(sessionStoreDir, 'dingtalk-colleague-')
check('colleague sessions persisted in DSH session store', colleagueHits.length > 0, `${colleagueHits.length} file(s)`)

// 3. Plugin SQLite state
const sqlitePath = join(stateDir, 'dingtalk-autoreply.sqlite')
check('plugin SQLite state file exists', existsSync(sqlitePath), sqlitePath)
if (existsSync(sqlitePath)) {
  try {
    const out = execFileSync('sqlite3', [sqlitePath, 'SELECT COUNT(*) FROM audit; SELECT COUNT(*) FROM colleague_sessions;'], { encoding: 'utf8' }).trim().split('\n')
    check('SQLite audit + session tables populated', Number(out[0]) === 10 && Number(out[1]) === 6, `audit=${out[0]} sessions=${out[1]}`)
  } catch { check('SQLite audit + session tables populated', false, 'sqlite3 CLI not available; check via API instead') }
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
