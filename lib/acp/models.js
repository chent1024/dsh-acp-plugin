/**
 * Pure projections from ACP session configuration to harness model metadata.
 *
 * ACP discovers a model catalog only by starting a session: `session/new`
 * returns `configOptions`, and an option whose `category` is `model` carries the
 * selectable values while one whose `category` is `thought_level` carries the
 * reasoning levels. Everything here is a pure function over those options, so
 * the mapping is testable without a process.
 *
 * @module dsh-acp-plugin/acp/models
 */

/**
 * Whether one config option is the model selector.
 * @param {any} option - an ACP `SessionConfigOption`.
 * @returns {boolean} true when it selects the model.
 */
export function isModelOption(option) {
  if (typeof option !== 'object' || option === null) return false
  if (option.category === 'model') return true
  // Qoder ships its model selector with the id `model` and no category.
  return option.id === 'model' && option.type === 'select'
}

/**
 * Whether one config option is the reasoning-level selector.
 * @param {any} option - an ACP `SessionConfigOption`.
 * @returns {boolean} true when it selects a thought/reasoning level.
 */
export function isReasoningOption(option) {
  if (typeof option !== 'object' || option === null) return false
  if (isModelOption(option)) return false
  if (option.category === 'thought_level') return true
  // Some agents expose effort as the model option's own sub-selector.
  return option.id === 'reasoning_effort' && option.type === 'select'
}

/**
 * Read the selectable values of a select option.
 * @param {any} option - an ACP `SessionConfigOption`.
 * @returns {any[]} its values in agent order; empty for a non-select option.
 */
export function selectValues(option) {
  if (typeof option !== 'object' || option === null) return []
  if (option.type !== 'select' || !Array.isArray(option.options)) return []
  return option.options
    .filter((entry) => typeof entry === 'object' && entry !== null && typeof entry.value === 'string')
}

/**
 * The model option in one session's config options.
 * @param {readonly any[]} configOptions - options returned by `session/new`.
 * @returns {any} the model option, or undefined when the agent exposes none.
 */
export function modelOption(configOptions) {
  return (configOptions ?? []).find(isModelOption)
}

/**
 * The reasoning option in one session's config options.
 * @param {readonly any[]} configOptions - options returned by `session/new`.
 * @returns {any} the reasoning option, or undefined when the agent exposes none.
 */
export function reasoningOption(configOptions) {
  return (configOptions ?? []).find(isReasoningOption)
}

/**
 * Project one ACP session's config options into the model list the harness
 * advertises for a route.
 *
 * Model ids are the ACP selector values verbatim: they are what
 * `session/set_config_option` accepts, so inventing a different id would make a
 * selected model unusable.
 *
 * @param {string} provider - the route these models belong to.
 * @param {readonly any[]} configOptions - options returned by `session/new`.
 * @returns {Array<{ provider: string, id: string, name: string, description?: string }>} the model entries.
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
 * The model the agent's session currently has selected.
 * @param {readonly any[]} configOptions - options returned by `session/new`.
 * @returns {string | undefined} the current model id, when the agent names one.
 */
export function currentModelId(configOptions) {
  const option = modelOption(configOptions)
  if (option === undefined || typeof option.currentValue !== 'string') return undefined
  return selectValues(option).some((entry) => String(entry.value) === option.currentValue)
    ? option.currentValue
    : undefined
}

/**
 * Project one ACP session's reasoning levels into harness reasoning metadata.
 *
 * The agent's own current value becomes the default only when it is one of the
 * advertised levels; an agent reporting a value it does not list would otherwise
 * make the default unusable.
 *
 * @param {readonly any[]} configOptions - options returned by `session/new`.
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
  const current = typeof option.currentValue === 'string' ? option.currentValue : undefined
  const usable = current !== undefined && efforts.some((effort) => effort.id === current)
  return { efforts, ...usable ? { defaultEffort: current } : {} }
}

/**
 * Build the `session/set_config_option` request selecting one model, or nothing
 * when the session exposes no model selector.
 * @param {readonly any[]} configOptions - options returned by `session/new`.
 * @param {string} model - the model id the caller wants.
 * @returns {{ configId: string, value: string } | undefined} the request fields, or undefined when it cannot be honored.
 */
export function modelSelection(configOptions, model) {
  const option = modelOption(configOptions)
  if (option === undefined) return undefined
  const values = selectValues(option).map((entry) => String(entry.value))
  if (!values.includes(model)) return undefined
  return { configId: String(option.id), value: model }
}

/**
 * Build the `session/set_config_option` request selecting one reasoning level.
 * @param {readonly any[]} configOptions - options returned by `session/new`.
 * @param {string | undefined} effort - the effort id the caller wants.
 * @returns {{ configId: string, value: string } | undefined} the request fields, or undefined when it cannot be honored.
 */
export function reasoningSelection(configOptions, effort) {
  if (effort === undefined) return undefined
  const option = reasoningOption(configOptions)
  if (option === undefined) return undefined
  const values = selectValues(option).map((entry) => String(entry.value))
  if (!values.includes(effort)) return undefined
  return { configId: String(option.id), value: effort }
}