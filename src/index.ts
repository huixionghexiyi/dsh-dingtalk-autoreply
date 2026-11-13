/** Main plugin entry: mounts the Runtime (watcher + triage + sessions + approval HTTP routes).
 * Adapted from dsh-superagent-prototype src/index.ts (MIT): same inject shape, minus GitHub/Feishu sources. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-skill'
import { Runtime } from './app/runtime.ts'
import { registerHttp } from './app/http.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'

export const name = 'dingtalk-autoreply'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }

export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const runtime = new Runtime(ctx, machine)
  const disposeHttp = registerHttp(ctx, runtime)
  ctx.effect(() => async () => { disposeHttp(); await runtime.stop() })
  await runtime.ready
  ctx.logger.info('dingtalk-autoreply ready; the DingTalk sidebar entry opens the approval panel')
}

export type { DeploymentConfig } from './deployment.ts'
export * from './core/triage.ts'
