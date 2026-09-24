/**
 * Behavior tests for the prompt projection and the adapter's stream contract.
 *
 * @module dsh-acp-plugin/tests/adapter.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toAcpBlocks, toAcpPrompt, toAcpBlock } from '../lib/adapter/prompt.js'
import { TurnAccumulator, finishReasonOf } from '../lib/adapter/stream.js'

const text = (value) => ({ type: 'text', text: value })

test('renders a text message as one labelled block', () => {
  const blocks = toAcpPrompt([{ role: 'user', content: [text('hello')] }])
  assert.deepEqual(blocks, [{ type: 'text', text: 'User: hello' }])
})

test('labels every harness role distinctly', () => {
  const blocks = toAcpPrompt([
    { role: 'system', content: [text('s')] },
    { role: 'developer', content: [text('d')] },
    { role: 'assistant', content: [text('a')] },
    { role: 'tool', content: [text('t')] },
  ])
  assert.deepEqual(blocks.map((b) => b.text), ['System: s', 'Developer: d', 'Assistant: a', 'Tool: t'])
})

test('renders a tool call as visible text rather than dropping it', () => {
  const blocks = toAcpBlocks({ role: 'assistant', content: [{ type: 'tool-call', name: 'read', arguments: '{"p":"a"}' }] })
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].text, /read/)
  assert.match(blocks[0].text, /"p":"a"/)
})

test('keeps an unrepresentable message visible as a named placeholder', () => {
  const blocks = toAcpBlocks({ role: 'user', content: [{ type: 'image', attachment: {} }] })
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].text, /image/)
})

test('drops reasoning, which is model output rather than input', () => {
  assert.equal(toAcpBlock({ type: 'reasoning', text: 'thought' }), undefined)
})

test('drops an empty text block', () => {
  assert.equal(toAcpBlock({ type: 'text', text: '' }), undefined)
})

test('always produces a non-empty prompt', () => {
  // ACP rejects an empty prompt array, so a turn with nothing to say still says something.
  assert.deepEqual(toAcpPrompt([]), [{ type: 'text', text: 'Continue.' }])
  assert.equal(toAcpPrompt([{ role: 'user', content: [] }]).length, 1)
})

test('tolerates a malformed message without throwing', () => {
  assert.equal(toAcpBlocks(undefined).length, 1)
  assert.equal(toAcpBlocks({ role: 'user', content: [null, 7] }).length, 1)
  assert.equal(toAcpBlock(null), undefined)
})

test('labels a multi-block message with both a role and its parts', () => {
  const blocks = toAcpBlocks({ role: 'assistant', content: [text('a'), { type: 'tool-call', name: 'x', arguments: '' }] })
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'text')
})

test('a refusal turn produces an error finish, never a success', () => {
  const reason = finishReasonOf('refusal')
  assert.equal(reason.kind, 'error')
  assert.equal(reason.failure.code, 'ACP_REFUSAL')
})

test('an unknown stop reason produces an error finish', () => {
  const reason = finishReasonOf('brand_new_reason')
  assert.equal(reason.kind, 'error')
  assert.match(reason.failure.message, /brand_new_reason/)
})

test('an abort closes the open block before the terminal chunk', () => {
  const turn = new TurnAccumulator()
  turn.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'half' } })
  const chunks = turn.finish(undefined, finishReasonOf('cancelled'))
  const kinds = chunks.map((chunk) => chunk.type)
  assert.deepEqual(kinds, ['block-start', 'text-delta', 'block-end', 'finish'])
  assert.equal(chunks.at(-1).reason.kind, 'aborted')
})

test('every produced stream has usage before finish and nothing after', () => {
  const turn = new TurnAccumulator()
  turn.apply({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'r' } })
  turn.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 't' } })
  const chunks = turn.finish({ inputTokens: 3, outputTokens: 2 }, finishReasonOf('end_turn'))
  const finishAt = chunks.findIndex((chunk) => chunk.type === 'finish')
  const usageAt = chunks.findIndex((chunk) => chunk.type === 'usage')
  assert.ok(usageAt >= 0 && usageAt < finishAt)
  assert.equal(chunks.length, finishAt + 1)
  // Every delta belongs to an open block that was later closed.
  const opened = new Set(chunks.filter((c) => c.type === 'block-start').map((c) => c.index))
  const closed = new Set(chunks.filter((c) => c.type === 'block-end').map((c) => c.index))
  assert.deepEqual([...opened].sort(), [...closed].sort())
})