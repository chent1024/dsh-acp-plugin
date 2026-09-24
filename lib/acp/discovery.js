/**
 * Model discovery: learn an agent's model catalog by starting one throwaway
 * session and reading its configuration options.
 *
 * ACP discloses a model catalog only through a live session, so discovery costs
 * one process start per agent. The result is cached per route and refreshed on a
 * TTL, because the harness asks for a route's models on every model-picker read
 * and starting a CLI each time would make the picker unusable.
 *
 * @module dsh-acp-plugin/acp/discovery
 */

import { AcpConnection } from './connection.js'
import {
  currentModelId, projectModels, projectReasoning, projectModes, selectionFor,
} from './selectors.js'

/** How long a discovered catalog is served before it is probed again. */
export const DEFAULT_CATALOG_TTL_MS = 300_000

/** One route's discovered catalog and when it was read. */
class CatalogEntry {
  /**
   * @param {any} catalog - the complete discovered catalog.
   * @param {number} readAt - the clock reading when this was discovered.
   */
  constructor(catalog, readAt) {
    /** @type {any} */ this.catalog = catalog
    /** @type {number} */ this.readAt = readAt
  }
}

/**
 * Probes ACP agents for their model catalogs and caches the result.
 *
 * A failed probe is cached as a failure with a short TTL rather than retried on
 * every read: an agent that cannot start would otherwise spawn a process per
 * picker render. The failure is surfaced, never swallowed into an empty catalog,
 * so the Models page can name it.
 */
export class CatalogCache {
  /**
   * @param {{ ttlMs?: number, failureTtlMs?: number, now?: () => number }} [options] - cache windows and clock.
   */
  constructor(options = {}) {
    /** @type {Map<string, CatalogEntry>} */ this.entries = new Map()
    /** @type {Map<string, { error: Error, readAt: number }>} */ this.failures = new Map()
    /** @type {Map<string, Promise<any>>} */ this.inFlight = new Map()
    /** @type {number} */ this.ttlMs = options.ttlMs ?? DEFAULT_CATALOG_TTL_MS
    /** @type {number} */ this.failureTtlMs = options.failureTtlMs ?? 30_000
    /** @type {() => number} */ this.now = options.now ?? (() => Date.now())
  }

  /**
   * Read one route's catalog, probing when the cache is cold or stale.
   * @param {string} provider - the provider route.
   * @param {() => Promise<any>} probe - performs the process start.
   * @returns {Promise<any>} the complete catalog the probe produced.
   * @throws the probe's failure, so a caller reports it instead of showing an empty list.
   */
  async read(provider, probe) {
    const cached = this.entries.get(provider)
    if (cached !== undefined && this.now() - cached.readAt <= this.ttlMs) {
      return cached.catalog
    }
    const failure = this.failures.get(provider)
    if (failure !== undefined && this.now() - failure.readAt <= this.failureTtlMs) throw failure.error

    // One probe per route at a time: concurrent picker reads must not each
    // start a process.
    const existing = this.inFlight.get(provider)
    if (existing !== undefined) return await existing

    const pending = (async () => {
      try {
        const result = await probe()
        this.entries.set(provider, new CatalogEntry(result, this.now()))
        this.failures.delete(provider)
        return result
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error))
        this.failures.set(provider, { error: normalized, readAt: this.now() })
        throw normalized
      } finally {
        this.inFlight.delete(provider)
      }
    })()
    this.inFlight.set(provider, pending)
    return await pending
  }

  /**
   * Drop one route's cached catalog so the next read probes again.
   * @param {string} provider - the provider route.
   * @returns {void}
   */
  invalidate(provider) {
    this.entries.delete(provider)
    this.failures.delete(provider)
  }

  /** Drop every cached catalog. @returns {void} */
  clear() {
    this.entries.clear()
    this.failures.clear()
  }
}

/**
 * Start one throwaway ACP session and read its catalog.
 *
 * The connection is always disposed, including on failure, so a probe cannot
 * leak a process into a long-lived harness.
 *
 * @param {object} spec - how to launch the agent.
 * @param {string} spec.command - executable to spawn.
 * @param {string[]} spec.args - its arguments.
 * @param {string} spec.cwd - working directory for the probe session.
 * @param {Record<string, string>} [spec.env] - extra child environment.
 * @param {string} [spec.authMethodId] - authentication method to use when the agent demands one.
 * @param {any} spec.spawn - the subprocess seam's spawn.
 * @param {any} [spec.logger] - optional logger.
 * @returns {Promise<{ models: any[], reasoningByModel: Map<string, any>, modes: any[], configOptions: any[] }>}
 *   the discovered catalog. `reasoningByModel` is keyed by model id because
 *   reasoning is a per-model capability: Qoder advertises none for `auto` and
 *   six levels for `ultimate`, so a single route-wide answer would be wrong for
 *   whichever model it did not describe.
 */
export async function probeCatalog(spec) {
  const connection = await AcpConnection.open({
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    env: spec.env ?? {},
    spawn: spec.spawn,
    ...spec.logger === undefined ? {} : { logger: spec.logger },
  })
  try {
    // An advertised auth method is not a demand for authentication, so the
    // session is attempted as-is: an agent already signed in through its own CLI
    // answers normally. Only a genuine refusal is retried through the method.
    try {
      await connection.newSession(spec.cwd)
    } catch (error) {
      if (error?.code !== 'ACP_AUTH_REQUIRED' || spec.authMethodId === undefined) throw error
      await connection.authenticate(spec.authMethodId)
      await connection.newSession(spec.cwd)
    }
    const models = projectModels('', connection.configOptions)
    const modes = projectModes(connection.configOptions, connection.modeState)
    const reasoningByModel = new Map()
    // Reasoning is discovered by selecting each model: an agent only advertises
    // the levels a model actually supports. The session is left on the model it
    // started with, so a probe never changes what a later turn would use.
    const initial = currentModelId(connection.configOptions)
    try {
      for (const model of models) {
        const selection = selectionFor(connection.configOptions, 'model', model.id)
        if (selection !== undefined) {
          const response = await connection.connection.agent.request('session/set_config_option', {
            sessionId: connection.sessionId, configId: selection.configId, value: selection.value,
          })
          if (Array.isArray(response?.configOptions)) {
            const reasoning = projectReasoning(response.configOptions)
            if (reasoning !== undefined) reasoningByModel.set(model.id, reasoning)
          }
        }
      }
    } finally {
      if (initial !== undefined) {
        const restore = selectionFor(connection.configOptions, 'model', initial)
        if (restore !== undefined) {
          await connection.connection.agent.request('session/set_config_option', {
            sessionId: connection.sessionId, configId: restore.configId, value: restore.value,
          }).catch(() => { /* the probe's own answer is already assembled */ })
        }
      }
    }
    return { models, reasoningByModel, modes, configOptions: connection.configOptions }
  } finally {
    await connection.dispose().catch(() => { /* the probe's own failure is the one to report */ })
  }
}