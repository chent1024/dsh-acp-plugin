/**
 * Session bindings: map one harness session onto one ACP remote session and
 * decide how much conversation to send on each request.
 *
 * The harness model contract is stateless — every request carries the full
 * conversation — while an ACP session is stateful and remembers what it was
 * told. Binding the two lets a follow-up request send only the messages the
 * agent has not seen, which is what keeps an external CLI's own memory (and its
 * prompt cache) useful.
 *
 * The optimization is only safe while the agent's view is a prefix of the
 * harness history. Every request therefore re-checks the recorded prefix; when
 * history was compacted, rewritten, or moved to a different route, the binding
 * falls back to sending everything rather than sending a delta that would leave
 * the agent with a conversation it never saw.
 *
 * @module dsh-acp-plugin/acp/bindings
 */

/**
 * A stable, order-sensitive digest of the messages a turn already sent.
 *
 * Only the fields the agent actually received are hashed, so an unrelated
 * harness-side annotation cannot invalidate a binding.
 *
 * @param {readonly any[]} messages - harness request messages.
 * @returns {string} a digest identifying that exact prefix.
 */
export function prefixDigest(messages) {
  // FNV-1a over a canonical projection: cheap, dependency-free, and stable
  // across processes, which matters because the digest is persisted.
  let hash = 0x811c9dc5
  const feed = (text) => {
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  for (const message of messages) {
    feed(String(message?.role ?? ''))
    feed('\u0000')
    for (const block of message?.content ?? []) {
      feed(String(block?.type ?? ''))
      feed('\u0000')
      if (typeof block?.text === 'string') feed(block.text)
      if (typeof block?.arguments === 'string') feed(block.arguments)
      if (typeof block?.name === 'string') feed(block.name)
      feed('\u0001')
    }
    feed('\u0002')
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Decide what to send for one request against a binding.
 *
 * A binding is reusable only when all of these hold:
 *   - it is bound to the same route and model (a different agent must not
 *     inherit another's conversation), and
 *   - the harness history still starts with the exact prefix the agent was
 *     sent, and
 *   - at least one new message exists to send.
 *
 * @param {object | undefined} binding - the recorded binding, if any.
 * @param {object} request - this request's facts.
 * @param {string} request.provider - the route being called.
 * @param {string} request.model - the model being called.
 * @param {readonly any[]} request.messages - the full harness history.
 * @returns {{ reuse: boolean, messages: readonly any[], reason: string }} whether the
 *   remote session is reusable, the messages to send, and why.
 */
export function planDelta(binding, request) {
  const all = request.messages ?? []
  if (binding === undefined) {
    return { reuse: false, messages: all, reason: 'no binding' }
  }
  if (binding.provider !== request.provider || binding.model !== request.model) {
    return { reuse: false, messages: all, reason: 'route or model changed' }
  }
  if (binding.sentCount > all.length) {
    return { reuse: false, messages: all, reason: 'history shrank' }
  }
  const prefix = all.slice(0, binding.sentCount)
  if (prefixDigest(prefix) !== binding.prefixDigest) {
    return { reuse: false, messages: all, reason: 'history was rewritten' }
  }
  const delta = all.slice(binding.sentCount)
  if (delta.length === 0) {
    return { reuse: false, messages: all, reason: 'nothing new to send' }
  }
  return { reuse: true, messages: delta, reason: 'prefix matched' }
}

/**
 * Bindings for every live harness session, with idle release.
 *
 * A binding is dropped when it goes idle so a long-lived harness does not pin
 * an external CLI process per session forever. Dropping a binding never drops
 * remote state the harness could have used: the next request simply starts a
 * fresh remote session and sends the full history.
 */
export class BindingRegistry {
  /**
   * @param {{ idleTimeoutMs?: number, now?: () => number }} [options] - idle window and clock.
   */
  constructor(options = {}) {
    /** @type {Map<string, any>} */ this.bindings = new Map()
    /** @type {number} */ this.idleTimeoutMs = options.idleTimeoutMs ?? 600_000
    /** @type {() => number} */ this.now = options.now ?? (() => Date.now())
  }

  /**
   * Read one binding, or undefined when it is absent or idle-expired.
   * @param {string} sessionId - harness session id.
   * @returns {any} the binding.
   */
  get(sessionId) {
    const binding = this.bindings.get(sessionId)
    if (binding === undefined) return undefined
    if (this.now() - binding.touchedAt > this.idleTimeoutMs) return undefined
    return binding
  }

  /**
   * Record a binding after a successful turn.
   * @param {string} sessionId - harness session id.
   * @param {object} value - the binding facts.
   * @param {string} value.provider - route that served the turn.
   * @param {string} value.model - model that served the turn.
   * @param {any} value.connection - the live ACP connection.
   * @param {string} value.remoteSessionId - the ACP session id.
   * @param {number} value.sentCount - messages the agent has now seen.
   * @param {readonly any[]} value.sentMessages - the exact prefix sent.
   * @param {any} [value.usageReading] - the session-cumulative usage baseline.
   * @returns {any} the stored binding.
   */
  set(sessionId, value) {
    const binding = {
      provider: value.provider,
      model: value.model,
      connection: value.connection,
      remoteSessionId: value.remoteSessionId,
      sentCount: value.sentCount,
      prefixDigest: prefixDigest(value.sentMessages),
      usageReading: value.usageReading,
      touchedAt: this.now(),
    }
    this.bindings.set(sessionId, binding)
    return binding
  }

  /**
   * Mark a binding as just used, so idle release measures from the last turn.
   * @param {string} sessionId - harness session id.
   * @returns {void}
   */
  touch(sessionId) {
    const binding = this.bindings.get(sessionId)
    if (binding !== undefined) binding.touchedAt = this.now()
  }

  /**
   * Release every idle binding, disposing its connection.
   * @returns {Promise<void>} resolves once each released connection is reaped.
   */
  async releaseIdle() {
    const now = this.now()
    const expired = [...this.bindings.entries()]
      .filter(([, binding]) => now - binding.touchedAt > this.idleTimeoutMs)
    for (const [sessionId, binding] of expired) {
      this.bindings.delete(sessionId)
      await binding.connection.dispose().catch(() => { /* an already-dead child is released, not reported */ })
    }
  }

  /**
   * Release one session's binding and reap its connection.
   * @param {string} sessionId - harness session id.
   * @returns {Promise<void>} resolves once the connection is reaped.
   */
  async release(sessionId) {
    const binding = this.bindings.get(sessionId)
    if (binding === undefined) return
    this.bindings.delete(sessionId)
    await binding.connection.dispose().catch(() => { /* idem */ })
  }

  /**
   * Release every binding and reap every connection.
   * @returns {Promise<void>} resolves once all connections are reaped.
   */
  async releaseAll() {
    const all = [...this.bindings.values()]
    this.bindings.clear()
    await Promise.all(all.map((binding) => binding.connection.dispose().catch(() => { /* idem */ })))
  }

  /** @returns {number} how many live bindings are held. */
  get size() {
    return this.bindings.size
  }
}