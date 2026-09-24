/**
 * Projection from one ACP prompt turn into the harness `StreamChunk` protocol.
 *
 * The harness enforces ordering mechanically (`dsh-llm`'s stream invariant):
 * every delta needs an open block of its type, `usage` must precede the terminal
 * `finish`, nothing may follow `finish`, and a non-error finish may not leave a
 * block open. This module is a state machine over ACP updates that maintains
 * exactly those conditions, so a well-behaved agent can never produce a stream
 * the harness refuses.
 *
 * ACP distinguishes visible text (`agent_message_chunk`) from reasoning
 * (`agent_thought_chunk`); harness block indexes are allocated in first-seen
 * order and reopened independently for each.
 *
 * @module dsh-acp-plugin/adapter/stream
 */

/** ACP tool-call updates carry no executable harness tool invocation. */
const IGNORED_UPDATES = new Set([
  'tool_call',
  'tool_call_update',
  'plan',
  'plan_update',
  'plan_removed',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'compaction_update',
  'compaction_summary_chunk',
  'user_message_chunk',
])

/**
 * Map one ACP `StopReason` onto the harness finish reason.
 *
 * An unknown or future reason becomes an error: reporting it as `stop` would
 * present a failed turn as a successful one.
 *
 * @param {string} stopReason - the ACP stop reason.
 * @param {string} [message] - detail for the failure case.
 * @returns {{ kind: string, failure?: { message: string, code: string } }} the harness finish reason.
 */
export function finishReasonOf(stopReason, message) {
  switch (stopReason) {
    case 'end_turn':
      return { kind: 'stop' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'cancelled':
      return { kind: 'aborted', failure: { message: message ?? 'the ACP agent cancelled the turn', code: 'ABORTED' } }
    case 'refusal':
      return { kind: 'error', failure: { message: message ?? 'the ACP agent refused the request', code: 'ACP_REFUSAL' } }
    case 'max_turn_requests':
      return { kind: 'error', failure: { message: message ?? 'the ACP agent hit its turn limit', code: 'ACP_TURN_LIMIT' } }
    default:
      return {
        kind: 'error',
        failure: { message: message ?? `unrecognized ACP stop reason ${JSON.stringify(stopReason)}`, code: 'ACP_UNKNOWN_STOP' },
      }
  }
}

/**
 * Map ACP `Usage` onto harness token usage.
 *
 * ACP reports session-cumulative totals while the harness expects one call's
 * disjoint counts, so the caller supplies the previous reading and this function
 * returns the delta. Counts stay disjoint: cached input is reported separately
 * and subtracted out of the input half, matching the harness contract.
 *
 * @param {any} usage - ACP usage totals.
 * @param {{ totalTokens: number, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, reasoningTokens: number } | undefined} previous
 *   the previous reading for the same session, when this is not the first turn.
 * @returns {{ usage: any, reading: any }} the delta to report and the new baseline.
 */
export function usageDelta(usage, previous) {
  const read = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)
  const reading = {
    totalTokens: read(usage?.totalTokens),
    inputTokens: read(usage?.inputTokens),
    outputTokens: read(usage?.outputTokens),
    cacheReadTokens: read(usage?.cachedReadTokens),
    cacheWriteTokens: read(usage?.cachedWriteTokens),
    reasoningTokens: read(usage?.thoughtTokens),
  }
  const base = previous ?? {
    totalTokens: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  }
  const delta = {
    // Cache reads are a subset of ACP's input count, and the harness bills them
    // separately; subtracting keeps the counts disjoint as its contract requires.
    inputTokens: Math.max(0, reading.inputTokens - base.inputTokens - (reading.cacheReadTokens - base.cacheReadTokens)),
    outputTokens: Math.max(0, reading.outputTokens - base.outputTokens),
    totalTokens: Math.max(0, reading.totalTokens - base.totalTokens),
  }
  const cacheRead = reading.cacheReadTokens - base.cacheReadTokens
  const cacheWrite = reading.cacheWriteTokens - base.cacheWriteTokens
  const reasoning = reading.reasoningTokens - base.reasoningTokens
  if (cacheRead > 0) delta.cacheReadTokens = cacheRead
  if (cacheWrite > 0) delta.cacheWriteTokens = cacheWrite
  if (reasoning > 0) delta.reasoningTokens = reasoning
  return { usage: delta, reading }
}

/**
 * Accumulates one ACP turn into an ordered, invariant-satisfying chunk list.
 *
 * Chunks are collected rather than yielded so the terminal ordering is decided
 * in one place: an abort that arrives while a block is open must close that
 * block before the abort finish, and no path may emit after the finish.
 */
export class TurnAccumulator {
  constructor() {
    /** @type {any[]} */ this.chunks = []
    /** @type {Map<string, number>} */ this.open = new Map()
    /** @type {boolean} */ this.finished = false
  }

  /**
   * Open one block of a type, returning its index.
   * @param {string} blockType - harness content block type.
   * @returns {number} the allocated or reused index.
   */
  openBlock(blockType) {
    const existing = this.open.get(blockType)
    if (existing !== undefined) return existing
    const index = this.chunks.filter((chunk) => chunk.type === 'block-start').length
    this.open.set(blockType, index)
    this.chunks.push({ type: 'block-start', index, blockType })
    return index
  }

  /**
   * Close one open block.
   * @param {string} blockType - harness content block type.
   * @param {any} block - the assembled block.
   * @returns {void}
   */
  closeBlock(blockType, block) {
    const index = this.open.get(blockType)
    if (index === undefined) return
    this.open.delete(blockType)
    this.chunks.push({ type: 'block-end', index, block })
  }

  /**
   * Append text to one block type, opening it on first use.
   * @param {string} blockType - `text` or `reasoning`.
   * @param {string} text - the delta.
   * @returns {void}
   */
  pushText(blockType, text) {
    if (this.finished || text.length === 0) return
    const index = this.openBlock(blockType)
    this.chunks.push({
      type: blockType === 'reasoning' ? 'reasoning-delta' : 'text-delta',
      index,
      text,
    })
  }

  /**
   * Apply one ACP session update.
   * @param {any} update - an ACP `SessionUpdate`.
   * @returns {void}
   */
  apply(update) {
    if (this.finished || typeof update !== 'object' || update === null) return
    if (IGNORED_UPDATES.has(update.sessionUpdate)) return
    if (update.sessionUpdate === 'agent_message_chunk') {
      this.pushText('text', textOf(update.content))
      return
    }
    if (update.sessionUpdate === 'agent_thought_chunk') {
      this.pushText('reasoning', textOf(update.content))
    }
  }

  /**
   * Close every open block, then emit usage and the terminal finish.
   * @param {any} usage - the usage delta to report, when there is one.
   * @param {any} reason - the harness finish reason.
   * @returns {any[]} the complete chunk list.
   */
  finish(usage, reason) {
    if (this.finished) return this.chunks
    this.finished = true
    // Close open blocks before finishing: a non-error finish with an open block
    // is refused by the harness stream invariant.
    for (const [blockType, index] of [...this.open.entries()]) {
      this.open.delete(blockType)
      this.chunks.push({ type: 'block-end', index, block: this.blockOf(blockType) })
    }
    if (usage !== undefined) this.chunks.push({ type: 'usage', usage })
    this.chunks.push({ type: 'finish', reason })
    return this.chunks
  }

  /**
   * The assembled block for one open type, built from the deltas already seen.
   * @param {string} blockType - harness content block type.
   * @returns {any} the assembled block.
   */
  blockOf(blockType) {
    const index = this.chunks
      .filter((chunk) => chunk.type === 'block-start' && chunk.blockType === blockType)
      .map((chunk) => chunk.index)[0]
    const deltaType = blockType === 'reasoning' ? 'reasoning-delta' : 'text-delta'
    const text = this.chunks
      .filter((chunk) => chunk.type === deltaType && chunk.index === index)
      .map((chunk) => chunk.text)
      .join('')
    return blockType === 'reasoning' ? { type: 'reasoning', text } : { type: 'text', text }
  }
}

/**
 * Read the text of one ACP content block.
 * @param {any} content - an ACP content block.
 * @returns {string} its text, or the empty string for another content kind.
 */
export function textOf(content) {
  if (typeof content !== 'object' || content === null) return ''
  return content.type === 'text' && typeof content.text === 'string' ? content.text : ''
}