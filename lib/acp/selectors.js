/**
 * ACP session-selector interpretation: one place that understands what an
 * agent's `modes` and `configOptions` mean.
 *
 * ACP agents express the same three ideas with different labels, and the
 * differences are not cosmetic:
 *
 *   - **Permission** is a session *mode* (`modes.availableModes` and the
 *     `category: "mode"` option), not a prompt-time answer. An agent in a mode
 *     that auto-approves never asks, so a client that only answers permission
 *     requests has no say at all. Qoder offers default / acceptEdits / auto /
 *     dontAsk / yolo; CodeBuddy offers eight including bypassPermissions and
 *     fullAccess.
 *   - **Model** is the `category: "model"` option.
 *   - **Reasoning level** is usually the `category: "thought_level"` option,
 *     but Qoder instead exposes `reasoning_effort` with `category: "model"`.
 *     Worse, it only appears AFTER a model that supports it is selected: the
 *     `auto` model advertises no effort option at all, while `ultimate` offers
 *     xhigh/high/medium/low/max/none. Reasoning is therefore a per-model
 *     capability discovered by selecting the model, not a route-wide fact.
 *
 * Everything here is a pure function over the option lists, so the mapping is
 * testable without a process, and the adapter, the subagent provider, and the
 * catalog probe all read the same interpretation.
 *
 * @module dsh-acp-plugin/acp/selectors
 */

/** The ACP config-option categories this client interprets. */
const MODE_CATEGORY = 'mode'
const MODEL_CATEGORY = 'model'
const THOUGHT_CATEGORY = 'thought_level'

/** Config ids agents use for the reasoning selector when the category is unhelpful. */
const REASONING_IDS = new Set(['reasoning_effort', 'reasoning', 'thought_level', 'thinking'])

/** Config ids agents use for the mode selector when the category is unhelpful. */
const MODE_IDS = new Set(['mode', 'session_mode'])

/**
 * Whether one config option is a select with usable values.
 * @param {any} option - an ACP `SessionConfigOption`.
 * @returns {boolean} true when it selects among named values.
 */
function isSelect(option) {
  return typeof option === 'object' && option !== null
    && option.type === 'select' && Array.isArray(option.options)
}

/**
 * The selectable values of one option, dropping malformed entries.
 * @param {any} option - an ACP `SessionConfigOption`.
 * @returns {any[]} its values in agent order.
 */
export function selectValues(option) {
  if (!isSelect(option)) return []
  return option.options.filter((entry) => (
    typeof entry === 'object' && entry !== null && typeof entry.value === 'string'
  ))
}

/**
 * The current value of one option, when it names an advertised value.
 *
 * An agent reporting a value it does not list would otherwise make that value
 * unusable as a default.
 *
 * @param {any} option - an ACP `SessionConfigOption`.
 * @returns {string | undefined} the current value, or undefined when it is absent or unlisted.
 */
export function currentValue(option) {
  if (typeof option?.currentValue !== 'string') return undefined
  return selectValues(option).some((entry) => entry.value === option.currentValue)
    ? option.currentValue
    : undefined
}

/**
 * Whether one option is the permission-mode selector.
 *
 * The `mode` category is authoritative when present; the id is the fallback for
 * an agent that omits the category, which ACP permits.
 *
 * @param {any} option - an ACP `SessionConfigOption`.
 * @returns {boolean} true when it selects the session's permission mode.
 */
export function isModeOption(option) {
  if (typeof option !== 'object' || option === null) return false
  if (option.category === MODE_CATEGORY) return true
  return option.category === undefined
    && typeof option.id === 'string' && MODE_IDS.has(option.id)
}

/**
 * Whether one option is the model selector.
 *
 * Reasoning is excluded first, and that order is load-bearing: Qoder labels its
 * `reasoning_effort` option with `category: "model"`, so a category test alone
 * would claim the effort selector as the model selector and replace the model
 * list with effort levels.
 *
 * @param {any} option - an ACP `SessionConfigOption`.
 * @returns {boolean} true when it selects the model.
 */
export function isModelOption(option) {
  if (typeof option !== 'object' || option === null) return false
  if (option.type !== 'select') return false
  if (isReasoningOption(option)) return false
  if (option.category === MODEL_CATEGORY) return true
  // Qoder ships its model selector with the id `model` and no category.
  return option.category === undefined && option.id === 'model'
}

/**
 * Whether one option is the reasoning-level selector.
 *
 * Three shapes occur in the wild, and all three are recognized: the documented
 * `thought_level` category, a `model`-category option whose id names reasoning
 * (Qoder), and a category-less option with a reasoning id.
 *
 * @param {any} option - an ACP `SessionConfigOption`.
 * @returns {boolean} true when it selects the reasoning level.
 */
export function isReasoningOption(option) {
  if (typeof option !== 'object' || option === null) return false
  if (option.type !== 'select') return false
  // A mode selector is never the reasoning selector, however it is named.
  if (isModeOption(option)) return false
  if (option.category === THOUGHT_CATEGORY) return true
  return typeof option.id === 'string' && REASONING_IDS.has(option.id)
}

/**
 * The mode option in one session's config options.
 * @param {readonly any[]} configOptions - options from `session/new`.
 * @returns {any} the option, or undefined when the agent exposes none.
 */
export function modeOption(configOptions) {
  return (configOptions ?? []).find(isModeOption)
}

/**
 * The model option in one session's config options.
 * @param {readonly any[]} configOptions - options from `session/new`.
 * @returns {any} the option, or undefined when the agent exposes none.
 */
export function modelOption(configOptions) {
  return (configOptions ?? []).find(isModelOption)
}

/**
 * The reasoning option in one session's config options.
 * @param {readonly any[]} configOptions - options from `session/new`.
 * @returns {any} the option, or undefined when the agent exposes none.
 */
export function reasoningOption(configOptions) {
  return (configOptions ?? []).find(isReasoningOption)
}

/**
 * Project one session's model list.
 *
 * Ids are the ACP selector values verbatim: they are what
 * `session/set_config_option` accepts, so inventing a different id would make a
 * chosen model unusable.
 *
 * @param {string} provider - the route these models belong to.
 * @param {readonly any[]} configOptions - options from `session/new`.
 * @returns {Array<{ provider: string, id: string, name: string, description?: string }>} the models.
 */
export function projectModels(provider, configOptions) {
  const option = modelOption(configOptions)
  if (option === undefined) return []
  return selectValues(option).map((entry) => ({
    provider,
    id: String(entry.value),
    name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : String(entry.value),
    ...typeof entry.description === 'string' && entry.description.length > 0
      ? { description: entry.description }
      : {},
  }))
}

/**
 * The model the session currently has selected.
 * @param {readonly any[]} configOptions - options from `session/new`.
 * @returns {string | undefined} the current model id.
 */
export function currentModelId(configOptions) {
  return currentValue(modelOption(configOptions))
}

/**
 * Project one session's reasoning levels.
 *
 * `configOptions` must be the options for the model the caller intends to use:
 * Qoder advertises `reasoning_effort` only after a supporting model is selected,
 * so calling this before that selection reports no levels — which is the correct
 * answer for a model that has none.
 *
 * @param {readonly any[]} configOptions - options for the exact model in question.
 * @returns {{ efforts: Array<{ id: string, name: string, description?: string }>, defaultEffort?: string } | undefined}
 *   the reasoning metadata, or undefined when the agent exposes no levels.
 */
export function projectReasoning(configOptions) {
  const option = reasoningOption(configOptions)
  if (option === undefined) return undefined
  const efforts = selectValues(option).map((entry) => ({
    id: String(entry.value),
    name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : String(entry.value),
    ...typeof entry.description === 'string' && entry.description.length > 0
      ? { description: entry.description }
      : {},
  }))
  if (efforts.length === 0) return undefined
  const current = currentValue(option)
  return { efforts, ...current === undefined ? {} : { defaultEffort: current } }
}

/**
 * Project one session's permission modes.
 * @param {readonly any[]} configOptions - options from `session/new`.
 * @param {any} [modeState] - the `modes` object from `session/new`, when present.
 * @returns {{ id: string, name: string, description?: string }[]} the modes the agent offers.
 */
export function projectModes(configOptions, modeState) {
  // `modes` is the dedicated surface and carries richer descriptions; the
  // config option is the fallback for an agent that only exposes the latter.
  const fromState = Array.isArray(modeState?.availableModes) ? modeState.availableModes : []
  const source = fromState.length > 0 ? fromState : selectValues(modeOption(configOptions))
  return source
    .filter((entry) => typeof entry?.id === 'string' || typeof entry?.value === 'string')
    .map((entry) => ({
      id: String(entry.id ?? entry.value),
      name: typeof entry.name === 'string' && entry.name.length > 0
        ? entry.name
        : String(entry.id ?? entry.value),
      ...typeof entry.description === 'string' && entry.description.length > 0
        ? { description: entry.description }
        : {},
    }))
}

/** Substrings marking a mode that auto-approves edits. */
const ACCEPT_EDITS = /accept.?edits?|auto.?accept/i
/** Substrings marking a mode that never prompts and refuses instead. */
const REFUSE_ONLY = /dont.?ask|don.?t ask|reject/i
/** Substrings marking a mode that bypasses permission checks entirely. */
const BYPASS = /yolo|bypass|full.?access|dangerous/i

/**
 * Choose the mode that best realizes a permission policy.
 *
 * The policy is the deployment's intent, and a mode is how an ACP agent
 * implements it. The match is by name because ACP does not define mode
 * semantics: `acceptEdits` and `yolo` are agent-defined ids.
 *
 * For `allow`, preference runs narrowest-first:
 *
 *   1. an edit-accepting mode, which stops the edit prompts without dropping the
 *      remaining checks;
 *   2. a bypass mode, which also stops them but removes more;
 *   3. any mode that is not refuse-only — a prompting mode still realizes
 *      `allow`, because this client answers every request with allow;
 *   4. otherwise the agent's own current mode, unchanged.
 *
 * `undefined` means "leave the mode as it is", which is also the answer when the
 * chosen mode is already selected: re-selecting it would spend a request to
 * change nothing. `reject` deliberately keeps the agent's prompting default,
 * because selecting a refuse-only mode would deny work the agent would otherwise
 * ask about — a stronger claim than the policy makes.
 *
 * @param {'allow' | 'reject'} policy - the configured permission policy.
 * @param {{ id: string, name: string, description?: string }[]} modes - the agent's modes.
 * @param {string | undefined} current - the agent's currently selected mode.
 * @returns {string | undefined} the mode id to select, or undefined to leave it alone.
 */
export function modeForPolicy(policy, modes, current) {
  if (modes.length === 0) return undefined
  if (policy !== 'allow') return undefined
  const matches = (pattern) => modes.find((mode) => (
    pattern.test(mode.id) || pattern.test(mode.name) || pattern.test(mode.description ?? '')
  ))
  const chosen = matches(ACCEPT_EDITS)
    ?? matches(BYPASS)
    ?? modes.find((mode) => !REFUSE_ONLY.test(mode.id))
  // Already selected: nothing to change, so no request is sent.
  if (chosen === undefined || chosen.id === current) return undefined
  return chosen.id
}

/**
 * Build the `session/set_config_option` request selecting one value.
 * @param {readonly any[]} configOptions - options from `session/new`.
 * @param {'mode' | 'model' | 'reasoning'} kind - which selector to set.
 * @param {string} value - the value the caller wants.
 * @returns {{ configId: string, value: string } | undefined} the request fields, or undefined when unhonorable.
 */
export function selectionFor(configOptions, kind, value) {
  const option = kind === 'mode'
    ? modeOption(configOptions)
    : kind === 'model'
      ? modelOption(configOptions)
      : reasoningOption(configOptions)
  if (option === undefined) return undefined
  if (!selectValues(option).some((entry) => String(entry.value) === value)) return undefined
  return { configId: String(option.id), value }
}

/**
 * The mode id the session currently has selected.
 * @param {readonly any[]} configOptions - options from `session/new`.
 * @param {any} [modeState] - the `modes` object from `session/new`, when present.
 * @returns {string | undefined} the current mode id.
 */
export function currentModeId(configOptions, modeState) {
  if (typeof modeState?.currentModeId === 'string') return modeState.currentModeId
  return currentValue(modeOption(configOptions))
}