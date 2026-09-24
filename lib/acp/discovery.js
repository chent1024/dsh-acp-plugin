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
import { projectModels, projectReasoning } from './models.js'

/** How long a discovered catalog is served before it is probed again. */
export const DEFAULT_CATALOG_TTL_MS = 300_000

/** One route's discovered catalog and when it was read. */
class CatalogEntry {
  /**
   * @param {any[]} models - the discovered models.
   * @param {any} reasoning - the discovered reasoning metadata, if any.
   * @param {number} readAt - the clock reading when this was discovered.
   */
  constructor(models, reasoning, readAt) {
    /** @type {any[]} */ this.models = models
    /** @type {any} */ this.reasoning = reasoning
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
   * @param {() => Promise<{ models: any[], reasoning: any }>} probe - performs the process start.
   * @returns {Promise<{ models: any[], reasoning: any }>} the catalog.
   * @throws the probe's failure, so a caller reports it instead of showing an empty list.
   */
  async read(provider, probe) {
    const cached = this.entries.get(provider)
    if (cached !== undefined && this.now() - cached.readAt <= this.ttlMs) {
      return { models: cached.models, reasoning: cached.reasoning }
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
        this.entries.set(provider, new CatalogEntry(result.models, result.reasoning, this.now()))
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
 * @returns {Promise<{ models: any[], reasoning: any, configOptions: any[] }>} the discovered catalog.
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
    if (connection.needsAuthentication) {
      // A probe that skips the auth step would fail at session/new with a
      // message about sessions; authenticating first makes the failure honest.
      await connection.authenticate(spec.authMethodId)
    }
    await connection.newSession(spec.cwd)
    return {
      models: projectModels('', connection.configOptions),
      reasoning: projectReasoning(connection.configOptions),
      configOptions: connection.configOptions,
    }
  } finally {
    await connection.dispose().catch(() => { /* the probe's own failure is the one to report */ })
  }
}