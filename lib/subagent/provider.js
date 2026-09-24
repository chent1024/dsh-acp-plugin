/**
 * The subagent provider: let a harness agent delegate a task to one ACP agent.
 *
 * This is the second face of the same connection core. Where the model adapter
 * serves a conversation, this serves a delegation: one task in, one final answer
 * out, with the child's own tools and permissions.
 *
 * ACP exposes no complete assistant messages, so the result is the accumulated
 * text of the turn, matching what the shipped ACP subagent does.
 *
 * @module dsh-acp-plugin/subagent/provider
 */

import { randomUUID } from 'node:crypto'
import { AcpConnection } from '../acp/connection.js'
import { finishReasonOf } from '../adapter/stream.js'
import { toAcpPrompt } from '../adapter/prompt.js'

/** The provider name this plugin registers on `ctx.subagents`. */
export const PROVIDER_NAME = 'acp-agents'

/**
 * Map an ACP response onto the harness stop-reason vocabulary.
 * @param {any} reason - the harness finish reason.
 * @returns {string} the subagent stop reason.
 */
function stopReasonOf(reason) {
  switch (reason.kind) {
    case 'stop': return 'completed'
    case 'aborted': return 'aborted'
    case 'max-tokens': return 'max-tokens'
    default: return 'error'
  }
}

/**
 * Run one ACP agent as a one-shot delegated child.
 *
 * The full text of the child's turn is folded as it streams. Only the two
 * handlers every ACP agent uses are registered, and no capability is advertised
 * that this provider cannot serve: a conforming agent must not call back for
 * files or terminals it will not get.
 *
 * The returned promise never rejects on a child-level failure — the seam
 * requires a failure to arrive as a stop reason, so a consumer maps it to an
 * error tool result rather than an infrastructure fault.
 *
 * @param {object} request - the harness delegation request.
 * @param {readonly any[]} request.prompt - the child's user content.
 * @param {AbortSignal} [request.signal] - cancellation.
 * @param {object} spec - how to launch the agent.
 * @param {string} spec.command - executable to spawn.
 * @param {string[]} spec.args - its arguments.
 * @param {string} spec.cwd - working directory for the child.
 * @param {Record<string, string>} [spec.env] - extra child environment.
 * @param {string} [spec.permission] - permission policy.
 * @param {any} spec.spawn - the subprocess seam's spawn.
 * @param {any} [spec.logger] - optional logger.
 * @returns {Promise<{ output: any[], stopReason: string, diagnostic?: string }>} the child's result.
 */
export async function runAcpChild(request, spec) {
  const text = []
  let connection
  try {
    connection = await AcpConnection.open({
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env ?? {},
      spawn: spec.spawn,
      requestPermission: async (params) => {
        if (spec.permission === 'allow') {
          const option = (params.options ?? []).find((candidate) => (
            candidate.kind === 'allow_once' || candidate.kind === 'allow_always'
          ))
          if (option !== undefined) return { outcome: { outcome: 'selected', optionId: option.optionId } }
        }
        return { outcome: { outcome: 'cancelled' } }
      },
      onUpdate: (update) => {
        if (update?.sessionUpdate !== 'agent_message_chunk') return
        if (update.content?.type === 'text' && typeof update.content.text === 'string') {
          text.push(update.content.text)
        }
      },
      ...spec.logger === undefined ? {} : { logger: spec.logger },
    })
    // An advertised method is not a demand; try the session first and only
    // retry through the method when the agent genuinely refuses.
    try {
      await connection.newSession(spec.cwd)
    } catch (error) {
      if (error?.code !== 'ACP_AUTH_REQUIRED' || spec.authMethodId === undefined) throw error
      await connection.authenticate(spec.authMethodId)
      await connection.newSession(spec.cwd)
    }
    const response = await connection.prompt(
      toAcpPrompt([{ role: 'user', content: request.prompt ?? [] }]),
      request.signal,
    )
    const answer = text.join('')
    const reason = finishReasonOf(response.stopReason)
    return {
      output: answer.length > 0 ? [{ type: 'text', text: answer }] : [],
      stopReason: stopReasonOf(reason),
      ...reason.failure === undefined ? {} : { diagnostic: reason.failure.message },
    }
  } catch (error) {
    // A child-level failure is a stop reason, never a rejection.
    return {
      output: text.length > 0 ? [{ type: 'text', text: text.join('') }] : [],
      stopReason: request.signal?.aborted === true ? 'aborted' : 'error',
      diagnostic: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await connection?.dispose().catch(() => { /* the result already carries the outcome */ })
  }
}

/**
 * The `ctx.subagents` provider for ACP agents.
 *
 * Every start-time capability is refused: an out-of-process child cannot honor a
 * harness tool filter, persona, output schema, or agent options, and advertising
 * one would make the delegation service accept a request this provider cannot
 * satisfy. `inheritsParentContext` is false for the same reason — the child sees
 * only the prompt it was handed.
 */
export class AcpSubagentProvider {
  /**
   * @param {object} options - the provider's collaborators.
   * @param {() => Record<string, any>} options.agents - current agents by route id.
   * @param {string} [options.defaultAgent] - route to use when a request names none.
   * @param {() => any} options.spawn - the subprocess seam's spawn.
   * @param {any} [options.logger] - optional logger.
   */
  constructor(options) {
    /** @type {any} */ this.options = options
    /** @type {string} */ this.name = PROVIDER_NAME
    /** @type {any} */ this.capabilities = {
      agentOptions: false,
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    }
    /** @type {boolean} */ this.inheritsParentContext = false
  }

  /**
   * Start one delegated ACP child.
   * @param {any} request - the resolved harness start request.
   * @returns {Promise<any>} the run handle.
   * @throws {Error} when no agent is configured or the request has no workspace.
   */
  async start(request) {
    const agents = this.options.agents()
    const available = Object.keys(agents)
    const route = this.options.defaultAgent ?? available[0]
    const agent = agents[route]
    if (agent === undefined) {
      throw new Error(
        available.length === 0
          ? 'acp-agents: no ACP agent is configured, so nothing can be delegated'
          : `acp-agents: no such ACP agent ${JSON.stringify(String(route))}; configured: ${available.join(', ')}`,
      )
    }
    const cwd = agent.cwd ?? request.parent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new Error(
        'acp-agents: this agent sets no `cwd` and the delegating session has no workspace,'
        + ' so the ACP session would have no working directory',
      )
    }
    // The id is minted in the PARENT namespace: an ACP session id is unique only
    // inside its own child process, so reusing it could collide across children.
    const id = request.id ?? randomUUID()
    const result = runAcpChild(request, {
      command: agent.command,
      args: agent.args ?? [],
      cwd,
      env: agent.env ?? {},
      permission: agent.permission,
      ...agent.authMethodId === undefined ? {} : { authMethodId: agent.authMethodId },
      spawn: this.options.spawn(),
      ...this.options.logger === undefined ? {} : { logger: this.options.logger },
    })
    return {
      id,
      localAgent: undefined,
      result,
      dispose: async () => { await result.catch(() => { /* a failed child is already reaped */ }) },
    }
  }
}