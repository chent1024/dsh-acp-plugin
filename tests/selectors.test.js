/**
 * Behavior tests for the unified ACP selector interpretation.
 *
 * These cover the three shapes real agents ship, each verified against a live
 * CLI: Qoder (reasoning under `category: "model"`, permission as modes),
 * CodeBuddy/WorkBuddy (reasoning under `thought_level`, eight modes including
 * `bypassPermissions` and `fullAccess`), and the documented shape.
 *
 * @module dsh-acp-plugin/tests/selectors.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  currentModeId, currentModelId, isModeOption, isModelOption, isReasoningOption,
  modeForPolicy, projectModels, projectModes, projectReasoning, selectValues, selectionFor,
} from '../lib/acp/selectors.js'

/** The option set CodeBuddy and WorkBuddy actually return. */
const CODEBUDDY = [
  {
    id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default',
    options: [
      { value: 'default', name: 'Always Ask' },
      { value: 'acceptEdits', name: 'Accept Edits' },
      { value: 'plan', name: 'Plan' },
      { value: 'auto', name: 'Auto' },
      { value: 'dontAsk', name: "Don't Ask" },
      { value: 'bypassPermissions', name: 'Bypass Permissions' },
      { value: 'fullAccess', name: 'Full Access' },
      { value: 'delegate', name: 'Delegate' },
    ],
  },
  {
    id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'hy4-preview-f',
    options: [{ value: 'hy4-preview-f', name: 'Hy4 preview' }, { value: 'glm-5.3', name: 'GLM-5.3' }],
  },
  {
    id: 'thought_level', name: 'Thought level', category: 'thought_level', type: 'select',
    currentValue: 'enabled',
    options: [{ value: 'high', name: 'High' }, { value: 'enabled', name: 'On (default)' }],
  },
  {
    id: 'sandbox', name: 'Sandbox', category: 'sandbox', type: 'select', currentValue: 'false',
    options: [{ value: 'true', name: 'Sandbox Environment' }, { value: 'false', name: 'Local Environment' }],
  },
]

/** The option set Qoder returns for a model that supports reasoning. */
const QODER_EFFORT = [{
  type: 'select', id: 'reasoning_effort', name: 'Reasoning Effort', category: 'model',
  currentValue: 'xhigh',
  options: [
    { value: 'xhigh', name: 'Extra High' }, { value: 'high', name: 'High' },
    { value: 'low', name: 'Low' }, { value: 'max', name: 'Max' },
    { value: 'medium', name: 'Medium' }, { value: 'none', name: 'None' },
  ],
}]

test('recognizes Qoder reasoning under the model category', () => {
  // Qoder labels its effort selector `category: "model"`, so a client keyed on
  // `thought_level` alone sees no reasoning levels at all.
  const option = QODER_EFFORT[0]
  assert.equal(isReasoningOption(option), true)
  assert.equal(isModelOption(option), false, 'a reasoning selector is not the model selector')
  assert.deepEqual(projectReasoning(QODER_EFFORT).efforts.map((e) => e.id), ['xhigh', 'high', 'low', 'max', 'medium', 'none'])
  assert.equal(projectReasoning(QODER_EFFORT).defaultEffort, 'xhigh')
})

test('recognizes the documented thought_level category', () => {
  const reasoning = projectReasoning(CODEBUDDY)
  assert.deepEqual(reasoning.efforts.map((e) => e.id), ['high', 'enabled'])
  assert.equal(reasoning.defaultEffort, 'enabled')
})

test('reports no reasoning for a model that advertises none', () => {
  // Qoder's `auto` model returns only mode and model; the effort option appears
  // only after a supporting model is selected.
  assert.equal(projectReasoning([CODEBUDDY[0], CODEBUDDY[1]]), undefined)
  assert.equal(projectReasoning([]), undefined)
})

test('never mistakes a mode or model selector for a reasoning selector', () => {
  assert.equal(isReasoningOption(CODEBUDDY[0]), false)
  assert.equal(isReasoningOption(CODEBUDDY[1]), false)
  assert.equal(isReasoningOption({ id: 'reasoning_effort', category: 'mode', type: 'select', options: [] }), false)
})

test('projects the model list without inventing fields', () => {
  const models = projectModels('acp:codebuddy', CODEBUDDY)
  assert.deepEqual(models.map((m) => m.id), ['hy4-preview-f', 'glm-5.3'])
  assert.equal(currentModelId(CODEBUDDY), 'hy4-preview-f')
  assert.equal('selected' in models[0], false)
})

test('projects the agent modes from the dedicated modes state', () => {
  // `modes` carries descriptions the config option does not, so it wins.
  const modeState = {
    currentModeId: 'auto',
    availableModes: [
      { id: 'default', name: 'Default', description: 'Prompts for approval' },
      { id: 'auto', name: 'Auto', description: 'Auto-approves via the safety classifier' },
    ],
  }
  const modes = projectModes(CODEBUDDY, modeState)
  assert.deepEqual(modes.map((m) => m.id), ['default', 'auto'])
  assert.equal(modes[1].description, 'Auto-approves via the safety classifier')
  assert.equal(currentModeId(CODEBUDDY, modeState), 'auto')
})

test('falls back to the mode config option when no modes state exists', () => {
  const modes = projectModes(CODEBUDDY, undefined)
  assert.equal(modes.length, 8)
  assert.equal(currentModeId(CODEBUDDY, undefined), 'default')
})

test('policy reject leaves the agent on its own prompting default', () => {
  // Selecting a refuse-only mode would deny work the agent would otherwise ask
  // about, which is a stronger claim than `reject` makes.
  assert.equal(modeForPolicy('reject', projectModes(CODEBUDDY), 'default'), undefined)
})

test('policy allow prefers the narrowest auto-approving mode', () => {
  // `bypassPermissions` and `fullAccess` also stop the prompts, but they remove
  // guard rails the policy never asked to drop, so acceptEdits wins.
  const modes = projectModes(CODEBUDDY)
  assert.equal(modeForPolicy('allow', modes, 'default'), 'acceptEdits')
})

test('policy allow falls back to a bypass mode when no edit mode exists', () => {
  const modes = projectModes([
    { id: 'mode', category: 'mode', type: 'select', currentValue: 'default', options: [
      { value: 'default', name: 'Default' },
      { value: 'yolo', name: 'Bypass Permissions' },
    ] },
  ])
  assert.equal(modeForPolicy('allow', modes, 'default'), 'yolo')
})

test('policy allow escapes a refuse-only mode and never picks one', () => {
  const modes = projectModes([
    { id: 'mode', category: 'mode', type: 'select', currentValue: 'default', options: [
      { value: 'default', name: 'Default' },
      { value: 'dontAsk', name: "Don't Ask" },
    ] },
  ])
  // A prompting mode still realizes `allow`, because this client answers every
  // request with allow. A refuse-only mode cannot, so `dontAsk` is left behind.
  assert.equal(modeForPolicy('allow', modes, 'dontAsk'), 'default')
  // Already on the prompting mode: selecting it again would change nothing.
  assert.equal(modeForPolicy('allow', modes, 'default'), undefined)
})

test('policy allow changes nothing when the chosen mode is already selected', () => {
  // Re-selecting would spend a request to achieve no change.
  assert.equal(modeForPolicy('allow', projectModes(CODEBUDDY), 'acceptEdits'), undefined)
})

test('policy allow is a no-op when the agent offers no modes', () => {
  assert.equal(modeForPolicy('allow', [], undefined), undefined)
})

test('builds a selection only for an advertised value', () => {
  assert.deepEqual(selectionFor(CODEBUDDY, 'mode', 'auto'), { configId: 'mode', value: 'auto' })
  assert.deepEqual(selectionFor(CODEBUDDY, 'model', 'glm-5.3'), { configId: 'model', value: 'glm-5.3' })
  assert.deepEqual(selectionFor(CODEBUDDY, 'reasoning', 'high'), { configId: 'thought_level', value: 'high' })
  assert.equal(selectionFor(CODEBUDDY, 'mode', 'nonexistent'), undefined)
  assert.equal(selectionFor(CODEBUDDY, 'reasoning', 'xhigh'), undefined)
})

test('keeps ids verbatim, because they are what the agent accepts', () => {
  const models = projectModels('p', [{
    id: 'model', category: 'model', type: 'select', currentValue: 'a',
    options: [{ value: 'hy4-preview-f', name: 'Hy4 preview' }],
  }])
  assert.equal(models[0].id, 'hy4-preview-f')
  assert.deepEqual(selectionFor([{ id: 'model', category: 'model', type: 'select', currentValue: 'a', options: [{ value: 'hy4-preview-f' }] }], 'model', 'hy4-preview-f'),
    { configId: 'model', value: 'hy4-preview-f' })
})

test('tolerates malformed options without throwing', () => {
  assert.deepEqual(selectValues(undefined), [])
  assert.deepEqual(selectValues({ type: 'boolean', id: 'x' }), [])
  assert.deepEqual(projectModels('p', [null, 7]), [])
  assert.equal(projectReasoning([{ id: 'thought_level', category: 'thought_level', type: 'select', options: [] }]), undefined)
  assert.deepEqual(projectModes([], { availableModes: [{ name: 'no id' }] }), [])
})

test('ignores a current value the agent does not advertise', () => {
  const options = [{ id: 'model', category: 'model', type: 'select', currentValue: 'gone', options: [{ value: 'a', name: 'A' }] }]
  assert.equal(currentModelId(options), undefined)
  const reasoning = projectReasoning([{ id: 'reasoning_effort', category: 'model', type: 'select', currentValue: 'gone', options: [{ value: 'low', name: 'Low' }] }])
  assert.equal(reasoning.defaultEffort, undefined)
})

test('recognizes selectors that omit the category, which ACP permits', () => {
  assert.equal(isModelOption({ id: 'model', type: 'select', options: [] }), true)
  assert.equal(isModeOption({ id: 'mode', type: 'select', options: [] }), true)
  assert.equal(isReasoningOption({ id: 'reasoning_effort', type: 'select', options: [] }), true)
})