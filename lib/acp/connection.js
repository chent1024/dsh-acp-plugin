/**
 * ACP (Agent Client Protocol) connection: spawn one external agent CLI, do the
 * handshake, and drive one session over newline-delimited JSON-RPC on stdio.
 *
 * The connection owns exactly one child process. Every failure path reaps that
 * process before rejecting, so a caller that never receives a connection never
 * leaks one. `dispose()` is idempotent and reaches quiescence: it ends stdin,
 * waits the EOF grace, escalates to the provider's terminate ladder, and then
 * awaits the WHOLE managed range exit.
 *
 * @module dsh-acp-plugin/acp/connection
 */

import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'

/** SDK type surface used here, kept local so the JS source stays untyped. */
/** @typedef {import('@agentclientprotocol/sdk').ClientContext} ClientContext */
/** @typedef {import('@agentclientprotocol/sdk').PromptResponse} PromptResponse */
/** @typedef {import('@agentclientprotocol/sdk').SessionConfigOption} SessionConfigOption */

/** Default window for the handshake + session/new transaction. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 60_000
/** Grace for stdin-EOF-driven child exit before the terminate ladder. */
export const DEFAULT_DISPOSE_EOF_GRACE_MS = 6_000

/**
 * A distinguishable ACP failure. `stage` says where it happened so a caller can
 * report "not authenticated" separately from "the session could not start",
 * and `authMethods` rides along when the agent demands authentication.
 */
export class AcpError extends Error {
  /**
   * @param {string} message - operator-facing description.
   * @param {string} code - stable machine-routing code.
   * @param {{ stage?: string, authMethods?: readonly unknown[], cause?: unknown }} [details]
   *   stage that failed, authentication methods the agent offered, and the cause.
   */
  constructor(message, code, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'AcpError'
    this.code = code
    if (details.stage !== undefined) this.stage = details.stage
    if (details.authMethods !== undefined) this.authMethods = details.authMethods
  }
}

/** One ACP agent's authentication requirement, surfaced instead of swallowed. */
export const ACP_AUTH_REQUIRED = 'ACP_AUTH_REQUIRED'

/**
 * Normalize any thrown value to an Error without losing the original.
 * @param {unknown} error - the thrown value.
 * @returns {Error} an Error carrying the original as its cause when it was not one.
 */
export function toError(error) {
  return error instanceof Error ? error : new Error(String(error), { cause: error })
}

/**
 * Race one promise against a deadline.
 * @template T
 * @param {Promise<T>} promise - the operation to bound.
 * @param {number} ms - deadline in milliseconds.
 * @param {string} label - operation name used in the timeout message.
 * @returns {Promise<T>} the operation's result.
 * @throws {AcpError} with code `ACP_TIMEOUT` when the deadline wins.
 */
function withTimeout(promise, ms, label) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new AcpError(`acp: ${label} timed out after ${String(ms)}ms`, 'ACP_TIMEOUT', { stage: label }))
    }, ms)
  })
  return Promise.race([promise, deadline]).finally(() => { clearTimeout(timer) })
}

/**
 * Extract text from one ACP content block, ignoring every other content kind.
 * @param {unknown} content - an ACP content block.
 * @returns {string} its text, or the empty string.
 */
export function contentText(content) {
  if (typeof content !== 'object' || content === null) return ''
  const block = /** @type {{ type?: unknown, text?: unknown }} */ (content)
  return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
}

/**
 * Build the ACP client handler set. Only the two handlers every agent uses are
 * registered; `fs` and `terminal` are advertised only when the caller supplies
 * their implementations, because advertising a capability the client cannot
 * serve makes a conforming agent take a path that then fails.
 * @param {{ onUpdate: (update: any, params: any) => void, requestPermission: (params: any) => Promise<any>, fs?: { readTextFile: Function, writeTextFile: Function } }} handlers
 *   the streaming sink, the permission policy, and optional fs callbacks.
 * @returns {any} the configured client app.
 */
function buildClientApp(handlers) {
  let app = createAcpClientApp({ name: 'deepseek-harness-acp-agents' })
    .onNotification(methods.client.session.update, ({ params }) => {
      handlers.onUpdate(params.update, params)
      return Promise.resolve()
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => handlers.requestPermission(params))
  if (handlers.fs !== undefined) {
    app = app
      .onRequest(methods.client.fs.readTextFile, ({ params }) => handlers.fs.readTextFile(params))
      .onRequest(methods.client.fs.writeTextFile, ({ params }) => handlers.fs.writeTextFile(params))
  }
  return app
}

/**
 * Wait for the whole managed subprocess range to exit, bounded by a deadline.
 * @param {any} child - the subprocess handle.
 * @param {number} ms - deadline in milliseconds.
 * @returns {Promise<boolean>} whether the range exited in time.
 */
async function rangeExitsWithin(child, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, ms)
  try {
    return await child.waitForExit(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Reap one ACP child: stdin EOF, then the provider's terminate ladder, then an
 * unbounded wait for whole-range exit. Failures are collected rather than
 * short-circuiting, so a broken EOF path still reaches the signal path.
 * @param {any} child - the subprocess handle.
 * @param {number} eofGraceMs - window for cooperative shutdown.
 * @returns {Promise<void>} resolves once the range is gone.
 */
async function disposeChild(child, eofGraceMs) {
  const failures = []
  child.stdin?.end()
  let exited = false
  try {
    exited = await rangeExitsWithin(child, eofGraceMs)
  } catch (error) {
    failures.push(toError(error))
  }
  if (!exited) {
    child.terminate()
    try {
      await child.waitForExit()
    } catch (error) {
      failures.push(toError(error))
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'acp: subprocess teardown failed')
}

/**
 * One live ACP connection to an external agent CLI.
 *
 * The connection outlives a single turn: a bound session is reused for later
 * requests, so the update sink is switchable. A sink installed at open time
 * would keep routing a continued session's updates into the first turn's
 * accumulator, where they would never reach the caller.
 */
export class AcpConnection {
  /**
   * @param {any} child - the spawned subprocess handle.
   * @param {any} connection - the SDK client connection.
   * @param {any[]} authMethods - authentication methods the agent advertised.
   * @param {(update: any) => void} onUpdate - the initial streaming sink.
   */
  constructor(child, connection, authMethods, onUpdate = () => {}) {
    /** @type {any} */ this.child = child
    /** @type {any} */ this.connection = connection
    /** @type {any[]} */ this.authMethods = authMethods
    /** @type {(update: any) => void} */ this.sink = onUpdate
    /** @type {string | undefined} */ this.sessionId = undefined
    /** @type {any[]} */ this.configOptions = []
    /** @type {any} */ this.modeState = undefined
    /** @type {boolean} */ this.closed = false
    /** @type {Promise<void> | undefined} */ this.disposal = undefined
    /** @type {number} */ this.eofGraceMs = DEFAULT_DISPOSE_EOF_GRACE_MS
  }

  /**
   * Point this connection's update stream at one turn's accumulator.
   *
   * Each turn installs its own sink before prompting, so a reused session
   * reports its updates to the turn that asked for them. Updates that arrive
   * with no turn installed are dropped rather than replayed into a finished one.
   *
   * @param {(update: any) => void} sink - the receiving turn's sink.
   * @returns {void}
   */
  setUpdateSink(sink) {
    this.sink = sink ?? (() => {})
  }

  /**
   * Spawn one ACP agent CLI and complete the handshake.
   *
   * The startup transaction owns the child until it succeeds, so every failure
   * reaps the process before it rejects.
   *
   * @param {object} spec - how to launch and answer this agent.
   * @param {string} spec.command - executable to spawn.
   * @param {string[]} spec.args - arguments passed to it.
   * @param {string} spec.cwd - working directory and ACP session cwd.
   * @param {Record<string, string>} [spec.env] - extra child environment, merged after the seam's scrub.
   * @param {number} [spec.startupTimeoutMs] - handshake deadline.
   * @param {number} [spec.eofGraceMs] - cooperative-shutdown window.
   * @param {boolean} [spec.fs] - whether to advertise filesystem callbacks.
   * @param {(params: any) => Promise<any>} [spec.requestPermission] - permission policy.
   * @param {(params: any) => void} [spec.onUpdate] - streaming sink.
   * @param {any} spec.spawn - the subprocess seam's `spawn`.
   * @param {any} [spec.logger] - optional logger.
   * @returns {Promise<AcpConnection>} the connected, session-less connection.
   * @throws {AcpError} stage `process` | `initialize` | `auth` | `new-session`.
   */
  static async open(spec) {
    const startupTimeoutMs = spec.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    const eofGraceMs = spec.eofGraceMs ?? DEFAULT_DISPOSE_EOF_GRACE_MS
    let child
    try {
      child = spec.spawn({
        argv: [spec.command, ...spec.args],
        cwd: spec.cwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
        graceMs: 3_000,
        env: spec.env ?? {},
      })
    } catch (error) {
      throw new AcpError(`acp: could not start ${spec.command}`, 'ACP_PROCESS_START', { stage: 'process', cause: error })
    }
    if (child.stdin === undefined || child.stdout === undefined) {
      await disposeChild(child, eofGraceMs).catch(() => { /* the missing-stream failure is the one to report */ })
      throw new AcpError('acp: subprocess seam dropped a piped protocol stream', 'ACP_PROCESS_START', { stage: 'process' })
    }

    // The instance is built first so the handler can route into it: the sink is
    // owned by the connection and swapped per turn, never captured once.
    let instance
    const app = buildClientApp({
      onUpdate: (update) => { instance?.sink(update) },
      requestPermission: spec.requestPermission ?? (() => Promise.resolve({ outcome: { outcome: 'cancelled' } })),
      ...spec.fs === true ? {
        fs: {
          readTextFile: () => Promise.reject(new AcpError('acp: fs/read_text_file is not available', 'ACP_FS_UNAVAILABLE')),
          writeTextFile: () => Promise.reject(new AcpError('acp: fs/write_text_file is not available', 'ACP_FS_UNAVAILABLE')),
        },
      } : {},
    })
    const connection = app.connect(ndJsonStream(
      NodeWritable.toWeb(child.stdin),
      NodeReadable.toWeb(child.stdout),
    ))

    instance = new AcpConnection(child, connection, [], spec.onUpdate)
    instance.eofGraceMs = eofGraceMs
    // A child that cannot be launched at all must fail now, not after the whole
    // handshake deadline: `initialize` can never be answered by a process that
    // never started, so racing it against process death turns a 60s hang into an
    // immediate, specific error.
    const diedFirst = child.done.then(
      (outcome) => Promise.reject(new AcpError(
        `acp: ${spec.command} exited (code ${String(outcome?.exitCode)}, signal ${String(outcome?.signal)}) before it completed the handshake`,
        'ACP_PROCESS_EXIT',
        { stage: 'process' },
      )),
      (error) => Promise.reject(new AcpError(
        `acp: could not start ${spec.command}`,
        'ACP_PROCESS_START',
        { stage: 'process', cause: error },
      )),
    )
    // Observed by the race below; the success arm parks forever so a child that
    // exits cleanly AFTER the handshake can never settle this.
    diedFirst.catch(() => { /* consumed by whichever branch observes it */ })
    try {
      const initialized = await withTimeout(
        Promise.race([
          connection.agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            // Advertise exactly what this client implements. `terminal` stays off
            // in every posture: the plugin has no terminal host to offer, and a
            // capability advertised without a handler fails the agent's call.
            clientCapabilities: spec.fs === true
              ? { fs: { readTextFile: true, writeTextFile: true } }
              : {},
            clientInfo: { name: 'dsh-acp-agents', version: '0.1.0' },
          }),
          diedFirst,
        ]),
        startupTimeoutMs,
        'initialize',
      )
      if (initialized.protocolVersion !== PROTOCOL_VERSION) {
        throw new AcpError(
          `acp: agent speaks protocol ${String(initialized.protocolVersion)}, this client speaks ${String(PROTOCOL_VERSION)}`,
          'ACP_PROTOCOL_VERSION',
          { stage: 'initialize' },
        )
      }
      instance.authMethods = initialized.authMethods ?? []
      instance.agentCapabilities = initialized.agentCapabilities ?? {}
      return instance
    } catch (error) {
      await instance.dispose().catch((cleanupError) => {
        spec.logger?.warn?.('acp: teardown after a failed startup also failed: %s', String(cleanupError))
      })
      if (error instanceof AcpError) throw error
      throw new AcpError('acp: the agent did not complete initialization', 'ACP_INITIALIZE_FAILED', {
        stage: 'initialize',
        cause: error,
      })
    }
  }

  /**
   * Whether the agent advertised a method for the caller to authenticate with.
   * @returns {boolean} true when `initialize` returned at least one auth method.
   */
  get needsAuthentication() {
    return this.authMethods.length > 0
  }

  /**
   * Authenticate with one advertised method.
   * @param {string} [methodId] - the method to use; defaults to the first advertised.
   * @returns {Promise<void>} resolves once the agent accepts it.
   * @throws {AcpError} code `ACP_AUTH_FAILED`, carrying `authMethods`.
   */
  async authenticate(methodId) {
    const chosen = methodId ?? (this.authMethods[0] && /** @type {{ id?: string }} */ (this.authMethods[0]).id)
    if (chosen === undefined) return
    try {
      await withTimeout(
        this.connection.agent.request(methods.agent.authenticate, { methodId: chosen }),
        DEFAULT_STARTUP_TIMEOUT_MS,
        'authenticate',
      )
    } catch (error) {
      throw new AcpError(
        `acp: authentication with method ${JSON.stringify(chosen)} failed`,
        'ACP_AUTH_FAILED',
        { stage: 'auth', authMethods: this.authMethods, cause: error },
      )
    }
  }

  /**
   * Create the remote session.
   *
   * An advertised `authMethods` list is NOT a demand for authentication: it tells
   * the client which method could be used if the agent is not yet signed in. An
   * agent that is already logged in through its own CLI advertises the same list
   * and then creates a session without complaint — verified against Qoder CLI,
   * which lists `qodercli-login` while already signed in and answers `session/new`
   * successfully. Refusing on the advert alone would make every such agent
   * unusable.
   *
   * So the session is attempted first, and an authentication requirement is
   * reported only when the agent actually refuses for that reason.
   *
   * @param {string} cwd - the session working directory.
   * @returns {Promise<string>} the agent-assigned session id.
   * @throws {AcpError} code `ACP_AUTH_REQUIRED` when the agent refuses for authentication,
   *   otherwise stage `new-session`.
   */
  async newSession(cwd) {
    try {
      const session = await withTimeout(
        this.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] }),
        DEFAULT_STARTUP_TIMEOUT_MS,
        'session/new',
      )
      this.sessionId = session.sessionId
      this.configOptions = session.configOptions ?? []
      this.modeState = session.modes ?? undefined
      return this.sessionId
    } catch (error) {
      if (this.#isAuthRefusal(error)) {
        throw new AcpError(
          `acp: this agent needs authentication before it will start a session`
          + ` (${this.authMethods.map((m) => String(/** @type {{ id?: unknown }} */ (m).id)).join(', ') || 'no method advertised'})`,
          ACP_AUTH_REQUIRED,
          { stage: 'auth', authMethods: this.authMethods, cause: error },
        )
      }
      throw new AcpError('acp: the agent refused a new session', 'ACP_SESSION_FAILED', {
        stage: 'new-session',
        cause: error,
      })
    }
  }

  /**
   * Whether a refusal is an authentication requirement rather than a session fault.
   *
   * ACP defines this as JSON-RPC `auth_required` (-32000), which the SDK's
   * `RequestError.authRequired` produces. Detection walks the cause chain
   * because the transport may wrap the peer's error before it surfaces here, and
   * matches on the numeric code rather than the message: prose that merely says
   * "authentication" must not be read as the protocol's own signal, while an
   * unrecognized code stays an ordinary session failure — the safer direction.
   *
   * @param {unknown} error - the refusal thrown by the session request.
   * @returns {boolean} true when the agent asked for authentication.
   */
  #isAuthRefusal(error) {
    for (let current = error, depth = 0; current != null && depth < 8; depth += 1) {
      const code = /** @type {{ code?: unknown }} */ (current).code
      if (code === -32000) return true
      current = /** @type {{ cause?: unknown }} */ (current).cause
    }
    return false
  }

  /**
   * Send one prompt and settle on the agent's final response.
   * @param {readonly any[]} prompt - ACP content blocks.
   * @param {AbortSignal} [signal] - cancellation; the session is cancelled when it aborts.
   * @returns {Promise<PromptResponse>} the agent's prompt response.
   */
  async prompt(prompt, signal) {
    if (this.sessionId === undefined) throw new AcpError('acp: no session to prompt', 'ACP_NO_SESSION')
    if (signal?.aborted === true) throw new AcpError('acp: prompt cancelled before it started', 'ACP_CANCELLED')
    const onAbort = () => {
      // Best-effort ACP cancel. Process teardown stays authoritative, so a
      // child that ignores the notification is still reaped by the caller.
      void this.cancel().catch(() => { /* the prompt rejection already reports this */ })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await this.connection.agent.request(methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt,
      })
      if (signal?.aborted === true) throw new AcpError('acp: prompt cancelled', 'ACP_CANCELLED')
      return result
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Ask the agent to cancel the in-flight turn.
   * @returns {Promise<void>} resolves once the notification is written.
   */
  async cancel() {
    if (this.sessionId === undefined || this.closed) return
    await this.connection.agent.notify(methods.agent.session.cancel, { sessionId: this.sessionId })
  }

  /**
   * Release this connection and reap its process. Idempotent; every concurrent
   * caller awaits the same teardown.
   * @returns {Promise<void>} resolves once the process range is gone.
   */
  dispose() {
    this.disposal ??= (async () => {
      this.closed = true
      try {
        this.connection.close()
      } catch { /* the transport is already gone; the process reap below is what matters */ }
      await disposeChild(this.child, this.eofGraceMs)
    })()
    return this.disposal
  }
}