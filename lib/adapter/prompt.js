/**
 * Projection from harness request messages into ACP prompt content blocks.
 *
 * ACP's prompt vocabulary is narrower than the harness's: it carries text and
 * images, and expresses a tool call as a *conversation annotation* rather than
 * as something the client can execute. Everything the harness has that ACP
 * cannot express is rendered as text, so nothing is silently dropped from the
 * agent's view.
 *
 * @module dsh-acp-plugin/adapter/prompt
 */

/**
 * Render one harness content block as ACP content.
 *
 * Images are skipped rather than sent: an ACP agent accepts them only when its
 * `promptCapabilities.image` says so, and this client does not track that
 * per-prompt. The caller of this projection decides image handling; a block this
 * function cannot express returns undefined so the caller can substitute a
 * deterministic placeholder instead of losing the occurrence.
 *
 * @param {any} block - one harness content block.
 * @returns {any | undefined} the ACP block, or undefined when it has no ACP form.
 */
export function toAcpBlock(block) {
  if (typeof block !== 'object' || block === null) return undefined
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' && block.text.length > 0
        ? { type: 'text', text: block.text }
        : undefined
    case 'reasoning':
      // Reasoning is the model's own output; replaying it back is not an input.
      return undefined
    case 'tool-call':
      return {
        type: 'text',
        text: `[tool call ${String(block.name ?? 'unknown')} ${String(block.arguments ?? '')}]`,
      }
    default:
      return undefined
  }
}

/**
 * Render one harness message as a single ACP prompt block.
 *
 * A message whose blocks are all unrepresentable still produces a named
 * placeholder: the agent must be able to see that something happened, and a
 * silently empty prompt would make the turn look like a no-op.
 *
 * @param {any} message - one harness request message.
 * @returns {any[]} the ACP blocks for that message.
 */
export function toAcpBlocks(message) {
  const rendered = []
  const placeholder = []
  for (const block of message?.content ?? []) {
    const converted = toAcpBlock(block)
    if (converted !== undefined) rendered.push(converted)
    else placeholder.push(String(block?.type ?? 'unknown'))
  }
  if (rendered.length === 0) {
    const role = String(message?.role ?? 'unknown')
    const kinds = placeholder.length > 0 ? placeholder.join(', ') : 'no content'
    return [{ type: 'text', text: `[${role} message with ${kinds}]` }]
  }
  return rendered
}

/**
 * Label one harness role inside a flattened prompt.
 * @param {string} role - harness message role.
 * @returns {string} the label to prefix.
 */
function roleLabel(role) {
  switch (role) {
    case 'user': return 'User'
    case 'assistant': return 'Assistant'
    case 'system': return 'System'
    case 'developer': return 'Developer'
    case 'tool': return 'Tool'
    default: return String(role)
  }
}

/**
 * Flatten a batch of harness messages into one ACP prompt.
 *
 * ACP has no multi-turn prompt: `session/prompt` takes one prompt for one turn.
 * The messages a delta carries are therefore folded into one text prompt with
 * role labels, which is how the agent distinguishes a user instruction from the
 * assistant turn it is continuing.
 *
 * @param {readonly any[]} messages - the messages to send this turn.
 * @returns {any[]} the ACP prompt blocks.
 */
export function toAcpPrompt(messages) {
  const blocks = []
  for (const message of messages ?? []) {
    const inner = toAcpBlocks(message)
    // A single text block with a role label wins: it is readable by every agent
    // and keeps the boundary between turns explicit.
    if (inner.length === 1 && inner[0].type === 'text') {
      blocks.push({ type: 'text', text: `${roleLabel(String(message?.role ?? ''))}: ${inner[0].text}` })
    } else {
      blocks.push({ type: 'text', text: `${roleLabel(String(message?.role ?? ''))}:` }, ...inner)
    }
  }
  if (blocks.length === 0) {
    // A turn with nothing to send still needs a prompt: ACP rejects an empty one.
    blocks.push({ type: 'text', text: 'Continue.' })
  }
  return blocks
}