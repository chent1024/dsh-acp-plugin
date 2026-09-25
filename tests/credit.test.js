/**
 * Behavior tests for credit-multiplier tagging.
 *
 * The descriptions below are the exact strings three real CLIs send, verified
 * against Qoder 1.1.62, CodeBuddy, and WorkBuddy. WorkBuddy sends none, which is
 * the case that must stay untouched.
 *
 * @module dsh-acp-plugin/tests/credit.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { creditMultiplier, creditSuffix, isFreeModel, withCreditTags } from '../lib/credit.js'

/** Real descriptions, as each CLI sends them. */
const REAL = {
  qoderMultiplierFirst: 'Vision · 0.50x Credit',
  qoderFree: 'Reasoning · Vision · New · 0.00x Credit',
  qoderHigh: 'Reasoning · Vision · 2.00x Credit',
  codebuddyMultiplierLast: 'x0.34 credits',
  codebuddyFree: 'x0.00',
  workbuddyNone: undefined,
}

test('reads a multiplier written before the x, as Qoder writes it', () => {
  assert.equal(creditMultiplier(REAL.qoderMultiplierFirst), 0.5)
  assert.equal(creditMultiplier(REAL.qoderHigh), 2)
})

test('reads a multiplier written after the x, as CodeBuddy writes it', () => {
  assert.equal(creditMultiplier(REAL.codebuddyMultiplierLast), 0.34)
  assert.equal(creditMultiplier(REAL.codebuddyFree), 0)
})

test('reports no multiplier when the description states none', () => {
  assert.equal(creditMultiplier(REAL.workbuddyNone), undefined)
  assert.equal(creditMultiplier(''), undefined)
  assert.equal(creditMultiplier(null), undefined)
  assert.equal(creditMultiplier({}), undefined)
})

test('does not read a bare number as a multiplier', () => {
  // A description mentioning a version or size must not be mistaken for a price.
  assert.equal(creditMultiplier('GPT-5.5'), undefined)
  assert.equal(creditMultiplier('200k context'), undefined)
})

test('recognizes a free model in either notation', () => {
  assert.equal(isFreeModel(REAL.qoderFree), true)
  assert.equal(isFreeModel(REAL.codebuddyFree), true)
  assert.equal(isFreeModel(REAL.qoderHigh), false)
  assert.equal(isFreeModel(REAL.workbuddyNone), false)
})

test('renders zero as FREE rather than a bare multiplier', () => {
  // The two say the same thing, and "free" is what a reader looks for.
  assert.equal(creditSuffix(REAL.qoderFree), '  [FREE]')
  assert.equal(creditSuffix(REAL.codebuddyFree), '  [FREE]')
})

test('renders a non-zero multiplier without trailing zeros', () => {
  assert.equal(creditSuffix(REAL.qoderHigh), '  [2x]')
  assert.equal(creditSuffix(REAL.qoderMultiplierFirst), '  [0.5x]')
  assert.equal(creditSuffix(REAL.codebuddyMultiplierLast), '  [0.34x]')
})

test('renders nothing when no multiplier is stated', () => {
  assert.equal(creditSuffix(REAL.workbuddyNone), '')
  assert.equal(creditSuffix('Vision'), '')
})

test('tags names only when enabled', () => {
  const models = [
    { id: 'ultimate', name: 'Ultimate', description: REAL.qoderHigh },
    { id: 'qfmodel', name: 'Qwen3.8-Flash', description: REAL.qoderFree },
  ]
  assert.deepEqual(withCreditTags(models, false).map((m) => m.name), ['Ultimate', 'Qwen3.8-Flash'])
  assert.deepEqual(withCreditTags(models, true).map((m) => m.name), ['Ultimate  [2x]', 'Qwen3.8-Flash  [FREE]'])
})

test('leaves a model whose agent discloses nothing exactly as sent', () => {
  // WorkBuddy sends no descriptions; its names must be untouched.
  const models = [{ id: 'glm-5.1', name: 'GLM-5.1' }]
  assert.deepEqual(withCreditTags(models, true), models)
})

test('never changes the id, which is what a request carries', () => {
  // Changing the id would make the selected model unusable.
  const models = [{ id: 'ultimate', name: 'Ultimate', description: REAL.qoderHigh }]
  const [tagged] = withCreditTags(models, true)
  assert.equal(tagged.id, 'ultimate')
  assert.equal(tagged.provider, undefined)
})

test('preserves every other field on a tagged model', () => {
  const models = [{ id: 'x', name: 'X', provider: 'acp:q', description: REAL.qoderHigh, extra: 7 }]
  const [tagged] = withCreditTags(models, true)
  assert.equal(tagged.provider, 'acp:q')
  assert.equal(tagged.description, REAL.qoderHigh)
  assert.equal(tagged.extra, 7)
})

test('does not mutate the input catalog', () => {
  const models = [{ id: 'x', name: 'X', description: REAL.qoderHigh }]
  withCreditTags(models, true)
  assert.equal(models[0].name, 'X')
})

test('tolerates malformed catalog entries', () => {
  assert.deepEqual(withCreditTags([null, undefined], true), [null, undefined])
  assert.equal(withCreditTags([{ id: 'a', name: 'A', description: 42 }], true)[0].name, 'A')
})