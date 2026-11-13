/** Plugin configuration. Volatile fields apply without a restart; changing `stateDir` remounts the plugin.
 * Adapted from dsh-superagent-prototype src/deployment.ts (MIT). */
import s from '@deepseek-ai/schemastery'
import { IDENTITY_MARKER } from './core/dws.ts'

const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)

/** Plugin configuration of the dingtalk-autoreply entry. */
export const Config = s.object({
  stateDir: absolute('Directory for the SQLite database, locks and per-colleague session workspaces.').required(),
  mode: s.string().default('simulate').description('live: use the real dws CLI (requires dws auth login). simulate: feed fixture NDJSON / HTTP ingest, never touch DingTalk.').volatile(),
  simulateFile: s.string().default('').description('NDJSON fixture file fed on startup in simulate mode. Empty means: wait for HTTP ingest.').volatile(),
  selfUserId: s.string().default('').description('The operator DingTalk userId; their own messages are always dropped (anti-loop).').volatile(),
  confidenceThreshold: s.number().min(0).max(1).step(0.05).default(0.8).description('Classification confidence below this escalates.').volatile(),
  dailyCap: s.number().min(0).max(1000).step(1).default(50).description('Max auto-sent replies per day; further messages escalate.').volatile(),
  identityMarker: s.string().default(IDENTITY_MARKER).description('Text appended to every auto-sent reply.').volatile(),
  autoSendDirect: s.boolean().default(false).description('When true, direct replies auto-send (after the marker check and daily cap). Default false: everything waits for UI approval (draft mode).').volatile(),
  routerModel: s.string().default('').description('Model for the Router session (empty = profile default).').volatile(),
  workerModel: s.string().default('').description('Model for colleague Worker sessions (empty = profile default).').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  mode: string
  simulateFile: string
  selfUserId: string
  confidenceThreshold: number
  dailyCap: number
  identityMarker: string
  autoSendDirect: boolean
  routerModel: string
  workerModel: string
}

export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dingtalk-autoreply configuration has keys it does not use: ${unknown.join(', ')}`)
  // Schemastery exposes defaulted fields as Volatile<T>; resolve them to plain values here.
  return {
    stateDir: config.stateDir,
    mode: config.mode.get(),
    simulateFile: config.simulateFile.get(),
    selfUserId: config.selfUserId.get(),
    confidenceThreshold: config.confidenceThreshold.get(),
    dailyCap: config.dailyCap.get(),
    identityMarker: config.identityMarker.get(),
    autoSendDirect: config.autoSendDirect.get(),
    routerModel: config.routerModel.get(),
    workerModel: config.workerModel.get(),
  }
}
