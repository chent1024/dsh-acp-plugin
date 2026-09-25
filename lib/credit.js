/**
 * Credit-multiplier extraction from ACP model descriptions.
 *
 * ACP agents disclose per-model cost as free text in the `description` of a
 * model option, and the notations differ:
 *
 *   Qoder      "Vision · 0.50x Credit"      multiplier before the `x`
 *              "Reasoning · Vision · New · 0.00x Credit"
 *   CodeBuddy  "x0.34 credits"              multiplier after the `x`
 *              "x0.00"
 *   WorkBuddy  (none)                       no credit text at all
 *
 * The harness model picker renders only `name`, so this text is invisible there
 * even though the plugin already passes it through as `description`. The
 * functions here turn it into a short suffix the picker will show.
 *
 * Nothing here assumes a particular currency or vendor: a multiplier is a
 * number, and zero means the agent charges nothing for the model.
 *
 * @module dsh-acp-plugin/credit
 */

/** A multiplier written either as `0.50x` or as `x0.34`. */
const MULTIPLIER = /(?:(\d+(?:\.\d+)?)\s*x)|(?:x\s*(\d+(?:\.\d+)?))/i

/**
 * Read the credit multiplier out of a model description.
 *
 * @param {unknown} description - the model option's description, as the agent sent it.
 * @returns {number | undefined} the multiplier, or undefined when none is stated.
 */
export function creditMultiplier(description) {
  if (typeof description !== 'string' || description.length === 0) return undefined
  const match = MULTIPLIER.exec(description)
  if (match === null) return undefined
  const value = Number(match[1] ?? match[2])
  return Number.isFinite(value) ? value : undefined
}

/**
 * Whether a model is free according to its description.
 * @param {unknown} description - the model option's description.
 * @returns {boolean} true when the agent states a zero multiplier.
 */
export function isFreeModel(description) {
  return creditMultiplier(description) === 0
}

/**
 * Render the picker suffix for one model.
 *
 * A zero multiplier becomes `[FREE]` rather than `[0.00x]`: the two mean the
 * same thing, and "free" is what a reader is looking for. Trailing zeros are
 * dropped from other multipliers so `2.00` reads as `2x` while `0.50` keeps its
 * significance.
 *
 * @param {unknown} description - the model option's description.
 * @returns {string} the suffix including its leading spaces, or an empty string.
 */
export function creditSuffix(description) {
  const multiplier = creditMultiplier(description)
  if (multiplier === undefined) return ''
  if (multiplier === 0) return '  [FREE]'
  return `  [${String(multiplier)}x]`
}

/**
 * Append credit suffixes to a model catalog's display names.
 *
 * Only `name` is changed, and only because it is the single field the harness
 * model picker renders — `description` reaches the harness intact and is simply
 * never shown. `id` is untouched: it is what `GenerateOptions.model` carries, so
 * changing it would make a selected model unusable.
 *
 * A model whose description states no multiplier keeps its name exactly as the
 * agent sent it, so an agent that discloses nothing is unaffected.
 *
 * @param {readonly any[]} models - catalog entries carrying `name` and `description`.
 * @param {boolean} enabled - whether the deployment asked for the suffix.
 * @returns {any[]} the models, with tagged names when enabled.
 */
export function withCreditTags(models, enabled) {
  if (!enabled) return [...models]
  return models.map((model) => {
    const suffix = creditSuffix(model?.description)
    if (suffix.length === 0) return model
    return { ...model, name: `${String(model.name)}${suffix}` }
  })
}