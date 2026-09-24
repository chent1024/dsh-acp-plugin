/**
 * DeepSeek Harness plugin: run external ACP agent CLIs as model providers and as
 * subagent providers.
 *
 * An ACP (Agent Client Protocol) agent is a coding CLI that speaks a standard
 * JSON-RPC protocol on stdio — Gemini CLI, Claude Code, Codex, Qwen Code,
 * opencode, Cursor, Cline, and others. This plugin makes each configured agent
 * available two ways:
 *
 *   - as a **model provider route** (`acp:<id>`), so it appears in the composer's
 *     model picker and can be a session's default model, and
 *   - as a **subagent provider**, so an agent can delegate a task to it.
 *
 * Configuration lives in this plugin's own settings section, which the Models
 * page edits, so agents can be added and changed without a restart.
 *
 * @module dsh-acp-agents
 */

import { AcpLlmAdapter } from './adapter/index.js'
import { BindingRegistry } from './acp/bindings.js'
import { Config, DEFAULT_ROUTE_PREFIX } from './config.js'
import { AcpSubagentProvider } from './subagent/provider.js'
import { registerPanel } from './panel/route.js'

export const name = 'acp-agents'
export const inject = ['llm']
export { Config }

/** The settings namespace this plugin's section is addressed by. */
const NS = 'acp-agents'

/**
 * Mount the plugin: register every configured agent as a provider route, keep
 * those registrations in step with settings edits, and publish the panel route
 * the Models page uses to edit them.
 *
 * @param {any} ctx - the plugin context.
 * @param {any} config - the resolved plugin configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  const routePrefix = config.routePrefix ?? DEFAULT_ROUTE_PREFIX
  const bindings = new BindingRegistry()

  /** The route id for one configured agent key. */
  const routeOf = (key) => `${routePrefix}${key}`

  /** Current agent definitions keyed by provider route. */
  const agents = () => Object.fromEntries(
    Object.entries(config.agents.get())
      .filter(([, agent]) => typeof agent?.command === 'string' && agent.command.length > 0)
      .map(([key, agent]) => [routeOf(key), agent]),
  )

  const adapter = new AcpLlmAdapter({
    agents,
    spawn: () => ctx.subprocess.spawn.bind(ctx.subprocess),
    ctx,
    bindings,
    logger: ctx.logger,
  })

  // Release every process this plugin started when it unloads. Without this a
  // profile reload would leave external CLIs running with no owner.
  ctx.effect(() => () => { void adapter.dispose() }, 'acp-agents: release bound sessions')

  // ---- provider registration ------------------------------------------------

  let registration
  let directory
  let registeredFacts

  /**
   * Bring the adapter registration and the configurable-provider directory in
   * step with the current agents.
   *
   * The registry captures a route's metadata at registration, so a rename or a
   * route-set change must re-register. Both handles are replaced atomically:
   * a conflict leaves the previous routes serving rather than dropping them.
   */
  const sync = () => {
    const routes = Object.keys(agents())
    const facts = routes.map((route) => {
      const agent = agents()[route]
      return { route, displayName: agent.displayName ?? route }
    }).sort((left, right) => left.route.localeCompare(right.route))
    const factsKey = JSON.stringify(facts)
    if (factsKey === registeredFacts) return
    try {
      if (registration === undefined) {
        if (routes.length > 0) registration = ctx.llm.registerAdapter(routes, adapter)
      } else {
        registration.replace(routes)
      }
      const entries = facts.map(({ route, displayName }) => ({
        provider: route,
        displayName,
        settingsNs: NS,
        settingsPath: ['agents', route.slice(routePrefix.length)],
      }))
      if (directory === undefined) {
        if (entries.length > 0) directory = ctx.llm.registerConfigurableProviders(entries)
      } else {
        directory.replace(entries)
      }
      registeredFacts = factsKey
    } catch (error) {
      // A route another adapter already owns is a configuration conflict, not a
      // reason to unpublish the routes that do work.
      ctx.logger?.error?.('acp-agents: provider registration refused')
      ctx.logger?.error?.(error)
    }
  }
  sync()

  // A volatile settings edit lands in the running fiber without a remount; this
  // is where the new route set reaches the registries.
  ctx.on('loader/volatile-update', () => { sync() })

  // ---- settings page policy -------------------------------------------------

  // This plugin ships its own Models-page configuration surface, so it takes
  // itself off the generic generated settings page.
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  // ---- subagent provider ----------------------------------------------------

  ctx.inject(['subagents'], (child) => {
    child.effect(() => child.subagents.registerProvider(new AcpSubagentProvider({
      agents,
      spawn: () => ctx.subprocess.spawn.bind(ctx.subprocess),
      logger: ctx.logger,
    })), 'acp-agents: subagent provider')
  })

  // ---- panel route ----------------------------------------------------------

  // The Models page edits agents through an authenticated `/api` route, because
  // an out-of-tree plugin cannot declare a typed Remote namespace: those are
  // generated at build time inside the harness repository.
  registerPanel(ctx, {
    readAgents: () => config.agents.get(),
    writeAgents: async (next) => {
      const settings = ctx.get('settings')
      if (settings === undefined) throw new Error('acp-agents: the settings service is not mounted, so agents cannot be saved')
      await settings.update(NS, { agents: next })
      sync()
    },
    probe: async (key) => {
      const agent = config.agents.get()[key]
      if (agent === undefined) throw new Error(`acp-agents: no agent named ${JSON.stringify(key)}`)
      const { probeCatalog } = await import('./acp/discovery.js')
      const result = await probeCatalog({
        command: agent.command,
        args: agent.args ?? [],
        cwd: agent.cwd ?? process.cwd(),
        env: agent.env ?? {},
        spawn: ctx.subprocess.spawn.bind(ctx.subprocess),
        logger: ctx.logger,
      })
      adapter.catalog.invalidate(routeOf(key))
      return { models: result.models, reasoning: result.reasoning ?? null }
    },
    logger: ctx.logger,
  })
}