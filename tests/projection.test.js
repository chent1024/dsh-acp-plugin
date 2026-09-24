/**
 * Behavior tests for the pure ACP projections (models and streaming).
 *
 * @module dsh-acp-plugin/tests/projection.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  modelOption, projectModels, projectReasoning, reasoningOption,
  modelSelection, reasoningSelection, selectValues, currentModelId,
} from '../lib/acp/models.js'
import { TurnAccumulator, finishReasonOf, usageDelta } from '../lib/adapter/stream.js'

/** Config options shaped as an agent that exposes both selectors. */
const OPTIONS = [
  {
    id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'large',
    options: [
      { value: 'large', name: 'Large' },
      { value: 'small', name: 'Small', description: 'cheaper' },
    ],
  },
  {
    id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select',
    currentValue: 'medium',
    options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }],
  },
]

test('projects the model list without inventing fields the harness does not declare', () => {
  const models = projectModels('acp:fake', OPTIONS)
  assert.equal(models.length, 2)
  assert.equal(models[0].id, 'large')
  assert.equal(models[0].provider, 'acp:fake')
  assert.equal(models[1].description, 'cheaper')
  // `selected` is not part of the harness model vocabulary; the current value
  // is reported separately so an unknown field never reaches the picker.
  assert.equal('selected' in models[0], false)
  assert.equal(currentModelId(OPTIONS), 'large')
})

test('reports no current model when the agent names an unlisted value', () => {
  const options = [{ ...OPTIONS[0], currentValue: 'not-listed' }]
  assert.equal(currentModelId(options), undefined)
  assert.equal(currentModelId([]), undefined)
})

test('keeps the ACP selector value as the model id', () => {
  // The id must round-trip: it is what set_config_option accepts.
  const models = projectModels('acp:fake', OPTIONS)
  assert.deepEqual(models.map((m) => m.id), ['large', 'small'])
})

test('projects reasoning efforts with a usable default only', () => {
  const reasoning = projectReasoning(OPTIONS)
  assert.deepEqual(reasoning.efforts.map((e) => e.id), ['low', 'medium'])
  assert.equal(reasoning.defaultEffort, 'medium')
})

test('drops a default the agent does not advertise', () => {
  const options = [{ ...OPTIONS[1], currentValue: 'not-listed' }]
  const reasoning = projectReasoning(options)
  assert.equal(reasoning.defaultEffort, undefined)
})

test('returns nothing when the agent exposes no selectors', () => {
  assert.deepEqual(projectModels('acp:fake', []), [])
  assert.equal(projectReasoning([]), undefined)
  assert.equal(modelOption([]), undefined)
  assert.equal(reasoningOption([]), undefined)
})

test('recognizes a category-less model option by its id', () => {
  const options = [{ id: 'model', name: 'Model', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }] }]
  assert.equal(modelOption(options)?.id, 'model')
  assert.deepEqual(projectModels('p', options).map((m) => m.id), ['a'])
})

test('builds a selection request only for an advertised value', () => {
  assert.deepEqual(modelSelection(OPTIONS, 'small'), { configId: 'model', value: 'small' })
  assert.equal(modelSelection(OPTIONS, 'nope'), undefined)
  assert.deepEqual(reasoningSelection(OPTIONS, 'high' === 'high' ? 'low' : ''), { configId: 'reasoning_effort', value: 'low' })
  assert.equal(reasoningSelection(OPTIONS, 'high'), undefined)
  assert.equal(reasoningSelection(OPTIONS, undefined), undefined)
})

test('ignores non-select options', () => {
  assert.deepEqual(selectValues({ type: 'boolean', id: 'x' }), [])
  assert.deepEqual(selectValues(undefined), [])
})

test('maps every ACP stop reason, never defaulting to success', () => {
  assert.deepEqual(finishReasonOf('end_turn'), { kind: 'stop' })
  assert.deepEqual(finishReasonOf('max_tokens'), { kind: 'max-tokens' })
  assert.equal(finishReasonOf('cancelled').kind, 'aborted')
  assert.equal(finishReasonOf('refusal').kind, 'error')
  assert.equal(finishReasonOf('max_turn_requests').kind, 'error')
  assert.equal(finishReasonOf('something_new').kind, 'error')
})

test('reports disjoint usage deltas across turns', () => {
  const first = usageDelta({ totalTokens: 10, inputTokens: 6, outputTokens: 4 }, undefined)
  assert.equal(first.usage.inputTokens, 6)
  assert.equal(first.usage.outputTokens, 4)
  const second = usageDelta({ totalTokens: 25, inputTokens: 15, outputTokens: 10 }, first.reading)
  assert.equal(second.usage.inputTokens, 9)
  assert.equal(second.usage.outputTokens, 6)
  assert.equal(second.usage.totalTokens, 15)
})

test('subtracts cache reads out of the input half', () => {
  const result = usageDelta(
    { totalTokens: 10, inputTokens: 10, outputTokens: 0, cachedReadTokens: 4 },
    undefined,
  )
  assert.equal(result.usage.inputTokens, 6)
  assert.equal(result.usage.cacheReadTokens, 4)
})

test('tolerates missing or malformed usage fields', () => {
  const result = usageDelta({}, undefined)
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  const negative = usageDelta({ inputTokens: -5, outputTokens: Number.NaN }, undefined)
  assert.equal(negative.usage.inputTokens, 0)
})

test('emits an invariant-satisfying stream for text then finish', () => {
  const turn = new TurnAccumulator()
  turn.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'he' } })
  turn.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'llo' } })
  const chunks = turn.finish({ inputTokens: 1, outputTokens: 2 }, { kind: 'stop' })
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'he' },
    { type: 'text-delta', index: 0, text: 'llo' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('interleaves reasoning and text on separate indexes', () => {
  const turn = new TurnAccumulator()
  turn.apply({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think' } })
  turn.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'say' } })
  const chunks = turn.finish(undefined, { kind: 'stop' })
  assert.deepEqual(chunks.filter((c) => c.type === 'block-start'), [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'block-start', index: 1, blockType: 'text' },
  ])
  assert.equal(chunks.at(-1).type, 'finish')
})

test('closes an open block before an abort finish', () => {
  const turn = new TurnAccumulator()
  turn.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } })
  const chunks = turn.finish(undefined, { kind: 'aborted', failure: { message: 'x', code: 'ABORTED' } })
  const finishAt = chunks.findIndex((c) => c.type === 'finish')
  const closeAt = chunks.findIndex((c) => c.type === 'block-end')
  assert.ok(closeAt >= 0 && closeAt < finishAt, 'the open block closes before the finish')
})

test('emits usage before finish and nothing after finish', () => {
  const turn = new TurnAccumulator()
  turn.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } })
  const chunks = turn.finish({ inputTokens: 1, outputTokens: 1 }, { kind: 'stop' })
  const finishAt = chunks.findIndex((c) => c.type === 'finish')
  const usageAt = chunks.findIndex((c) => c.type === 'usage')
  assert.ok(usageAt >= 0 && usageAt < finishAt)
  assert.equal(chunks.length, finishAt + 1)
})

test('ignores every update kind the harness cannot express', () => {
  const turn = new TurnAccumulator()
  for (const kind of ['tool_call', 'tool_call_update', 'plan', 'current_mode_update', 'user_message_chunk']) {
    turn.apply({ sessionUpdate: kind })
  }
  const chunks = turn.finish(undefined, { kind: 'stop' })
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].type, 'finish')
})

test('ignores updates that arrive after the finish', () => {
  const turn = new TurnAccumulator()
  turn.finish(undefined, { kind: 'stop' })
  turn.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } })
  assert.equal(turn.chunks.length, 1)
})

test('finishing twice does not duplicate the terminal chunk', () => {
  const turn = new TurnAccumulator()
  const first = turn.finish(undefined, { kind: 'stop' })
  const second = turn.finish(undefined, { kind: 'stop' })
  assert.equal(first.length, 1)
  assert.equal(second.length, 1)
})

test('does not open a block for an empty text delta', () => {
  const turn = new TurnAccumulator()
  turn.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } })
  assert.equal(turn.finish(undefined, { kind: 'stop' }).length, 1)
})