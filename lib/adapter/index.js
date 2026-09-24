/**
 * The LLM adapter that serves ACP agents as model-provider routes.
 *
 * This is what makes an external CLI selectable in the composer's model picker
 * and settable as a session's default model. It satisfies the `dsh-llm` adapter
 * contract: `stream()` is the only required method, and the rest exist so model
 * metadata and reasoning levels are real rather than stubbed.
 *
 * @module dsh-acp-plugin/adapter/index
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { AcpConnection } from '../acp/connection.js'
import { CatalogCache, probeCatalog } from '../acp/discovery.js'
import { modelSelection, reasoningSelection } from '../acp/models.js'
import { planDelta } from '../acp/bindings.js'
import { toAcpPrompt } from './prompt.js'
import { TurnAccumulator, finishReasonOf, usageDelta } from './stream.js'

/**
 * Resolve one harness session's working directory.
 *
 * An ACP session is created with a `cwd`, so the adapter needs one. It comes
 * from the harness session header, which the loop has already validated as an
 * absolute path; without it an ACP session cannot be created at all, and failing
 * loud beats guessing a directory the agent would then write into.
 *
 * @param {any} ctx - the plugin context.
 * @param {any} sessionId - the harness session id from the request, if any.
 * @param {string | undefined} override - the agent's configured cwd.
 * @returns {string} an absolute working directory.
 * @throws {Error} when neither source supplies one.
 */
export function resolveCwd(ctx, sessionId, override) {
  if (typeof override === 'string' && override.length > 0) return override
  if (sessionId !== undefined) {
    const session = ctx.sessions?.get?.(sessionId)
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) return cwd
  }
  throw new Error(
    'acp-agents: no working directory for the ACP session — set `cwd` on this agent,'
    + ' or call it from a session that has a workspace',
  )
}

/**
 * The ACP-backed model adapter.
 *
 * One instance serves every configured route; the route selects which agent is
 * launched. Bindings and the catalog cache are per-instance, so disposing the
 * plugin releases every process it started.
 *
 * It extends the harness `LlmAdapter` rather than duck-typing it: the runtime
 * calls `prepareCall()` on every dispatch, which only the base class supplies.
 */
export class AcpLlmAdapter extends LlmAdapter {
  /**
   * @param {object} options - the adapter's collaborators.
   * @param {() => Record<string, any>} options.agents - current agent definitions by route id.
   * @param {() => any} options.spawn - the subprocess seam's spawn.
   * @param {any} options.ctx - the plugin context (for session cwd lookup).
   * @param {any} options.bindings - the binding registry.
   * @param {any} [options.logger] - optional logger.
   */
  constructor(options) {
    super()
    /** @type {any} */ this.options = options
    /** @type {CatalogCache} */ this.catalog = new CatalogCache()
  }

  /**
   * Describe one route for the model picker.
   * @param {string} provider - the provider route.
   * @returns {{ id: string, name: string }} display metadata.
   */
  providerInfo(provider) {
    const agent = this.options.agents()[provider]
    return { id: provider, name: agent?.displayName ?? provider }
  }

  /**
   * List this route's models.
   *
   * ACP discloses models only through a live session, so this starts one and
   * caches the answer. A probe failure propagates: an empty list would present a
   * broken agent as a route with no models.
   *
   * @param {string} provider - the provider route.
   * @returns {Promise<any[]>} the models the agent offers.
   */
  async listModels(provider) {
    const agent = this.options.agents()[provider]
    if (agent === undefined) return []
    const { models } = await this.catalog.read(provider, () => this.#probe(provider, agent))
    return models.map((model) => ({ ...model, provider }))
  }

  /**
   * Resolve one model's metadata, including the reasoning levels this agent
   * exposes for it.
   * @param {string} provider - the provider route.
   * @param {string} model - the model id.
   * @returns {Promise<any>} the resolved model metadata.
   */
  async resolveModel(provider, model) {
    const agent = this.options.agents()[provider]
    const name = (await this.listModels(provider).catch(() => []))
      .find((candidate) => candidate.id === model)?.name ?? model
    const resolved = { provider, id: model, name }
    if (agent === undefined) return resolved
    try {
      const { reasoning } = await this.catalog.read(provider, () => this.#probe(provider, agent))
      if (reasoning !== undefined) resolved.reasoning = reasoning
    } catch { /* metadata is advisory; a probe failure must not refuse the request */ }
    return resolved
  }

  /**
   * Probe one agent for its catalog.
   * @param {string} provider - the provider route.
   * @param {any} agent - the agent definition.
   * @returns {Promise<{ models: any[], reasoning: any }>} the catalog.
   */
  async #probe(provider, agent) {
    const cwd = this.options.probeCwd?.() ?? process.cwd()
    const result = await probeCatalog({
      command: agent.command,
      args: agent.args ?? [],
      cwd,
      env: agent.env ?? {},
      spawn: this.options.spawn(),
      ...agent.authMethodId === undefined ? {} : { authMethodId: agent.authMethodId },
      ...this.options.logger === undefined ? {} : { logger: this.options.logger },
    })
    return {
      models: result.models.map((model) => ({ ...model, provider })),
      reasoning: result.reasoning,
    }
  }

  /**
   * Stream one model call through the ACP agent.
   *
   * The harness request is stateless and carries the full conversation; an ACP
   * session is stateful. The binding decides whether this call continues the
   * agent's existing session with only the new messages, or starts a fresh one
   * with everything. Either way the chunks satisfy the harness stream invariant,
   * and the terminal finish is never a success unless the agent said it was.
   *
   * @param {any} options - the assembled harness request.
   * @returns {AsyncIterable<any>} the chunk stream.
   */
  async * stream(options) {
    const provider = options.provider
    const agent = this.options.agents()[provider]
    const turn = new TurnAccumulator()
    if (agent === undefined) {
      yield* turn.finish(undefined, finishReasonOf('error', `no ACP agent is configured for route ${provider}`))
      return
    }

    const sessionKey = options.sessionId === undefined ? undefined : String(options.sessionId)
    const binding = sessionKey === undefined ? undefined : this.options.bindings.get(sessionKey)
    const plan = planDelta(binding, {
      provider,
      model: options.model,
      messages: options.messages ?? [],
    })

    let connection
    let created = false
    try {
      if (plan.reuse && binding !== undefined) {
        connection = binding.connection
      } else {
        const cwd = resolveCwd(this.options.ctx, options.sessionId, agent.cwd)
        connection = await AcpConnection.open({
          command: agent.command,
          args: agent.args ?? [],
          cwd,
          env: agent.env ?? {},
          spawn: this.options.spawn(),
          fs: agent.capabilities === 'fs',
          requestPermission: (params) => this.#permission(agent, params),
          onUpdate: (update) => turn.apply(update),
          ...this.options.logger === undefined ? {} : { logger: this.options.logger },
        })
        created = true
        if (connection.needsAuthentication) await connection.authenticate(agent.authMethodId)
        await connection.newSession(cwd)
        // The model and effort are per-session ACP state. Selecting them here,
        // before the prompt, is what makes this request's model choice real.
        await this.#select(connection, options.model, options.reasoningEffort)
      }

      // A reused connection still points at the PREVIOUS turn's sink, so this
      // turn claims the update stream before prompting. Without this a continued
      // session's text would land in the finished turn and never reach here.
      connection.setUpdateSink((update) => turn.apply(update))

      const prompt = toAcpPrompt(plan.messages)
      const previousUsage = plan.reuse && binding !== undefined ? binding.usageReading : undefined
      const response = await connection.prompt(prompt, options.signal)

      const { usage, reading } = response.usage === undefined || response.usage === null
        ? { usage: undefined, reading: previousUsage }
        : usageDelta(response.usage, previousUsage)

      // A turn that produced no visible text and no reasoning is a failure the
      // harness must not record as an empty success.
      const produced = turn.chunks.length > 0
      const reason = response.stopReason === 'end_turn' && !produced
        ? { kind: 'error', failure: { message: 'the ACP agent returned an empty response', code: 'EMPTY_RESPONSE' } }
        : finishReasonOf(response.stopReason)

      yield* turn.finish(usage, reason)

      if (sessionKey !== undefined) {
        this.options.bindings.set(sessionKey, {
          provider,
          model: options.model,
          connection,
          remoteSessionId: connection.sessionId,
          sentCount: (options.messages ?? []).length,
          sentMessages: options.messages ?? [],
          usageReading: reading,
        })
      } else if (created) {
        // A request with no session identity cannot be continued, so the
        // process it started is released rather than left running unowned.
        await connection.dispose().catch(() => { /* the stream already reported its outcome */ })
      }
    } catch (error) {
      // The failure is reported through the stream contract, not thrown: the
      // harness normalizes a throw the same way, but yielding keeps every
      // partial chunk this turn already produced.
      const failure = {
        message: error instanceof Error ? error.message : String(error),
        code: typeof error?.code === 'string' ? error.code : 'ACP_STREAM_FAILED',
      }
      yield* turn.finish(undefined, options.signal?.aborted === true
        ? { kind: 'aborted', failure }
        : { kind: 'error', failure })
      if (created && connection !== undefined) {
        await connection.dispose().catch(() => { /* the reported failure stands */ })
      }
      if (created && binding === undefined && sessionKey !== undefined) {
        // A failed fresh binding must not leave a half-built entry behind.
        await this.options.bindings.release(sessionKey).catch(() => { /* idem */ })
      }
    }
  }

  /**
   * Apply the requested model and reasoning effort to a fresh ACP session.
   *
   * Every selection is best-effort, for two reasons: the agent may not advertise
   * the value at all, and it may not implement `session/set_config_option`
   * despite advertising one. Neither is a reason to refuse the request — the
   * agent then runs on its own default, which is a usable turn — so a refusal is
   * reported and the prompt proceeds.
   *
   * @param {AcpConnection} connection - the session's connection.
   * @param {string} model - the requested model id.
   * @param {string} [reasoningEffort] - the requested effort id.
   * @returns {Promise<void>} resolves once every honored selection is applied.
   */
  async #select(connection, model, reasoningEffort) {
    for (const selection of [
      modelSelection(connection.configOptions, model),
      reasoningSelection(connection.configOptions, reasoningEffort),
    ]) {
      if (selection === undefined) continue
      try {
        await connection.connection.agent.request('session/set_config_option', {
          sessionId: connection.sessionId,
          configId: selection.configId,
          value: selection.value,
        })
      } catch (error) {
        this.options.logger?.warn?.(
          'acp-agents: the agent refused %s=%s (%s); continuing on its own default',
          selection.configId,
          selection.value,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }

  /**
   * Answer one permission prompt by policy. No human is present, so the policy
   * is the whole answer, and `reject` is the default.
   * @param {any} agent - the agent definition.
   * @param {any} params - the ACP permission request.
   * @returns {Promise<any>} the permission outcome.
   */
  async #permission(agent, params) {
    if (agent.permission === 'allow') {
      const option = (params.options ?? []).find((candidate) => (
        candidate.kind === 'allow_once' || candidate.kind === 'allow_always'
      ))
      if (option !== undefined) return { outcome: { outcome: 'selected', optionId: option.optionId } }
    }
    return { outcome: { outcome: 'cancelled' } }
  }

  /**
   * Release every resource this adapter owns: bound sessions and their processes.
   * @returns {Promise<void>} resolves once everything is reaped.
   */
  async dispose() {
    this.catalog.clear()
    await this.options.bindings.releaseAll()
  }
}