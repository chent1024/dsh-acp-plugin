/**
 * Back-compatible re-export of the ACP selector interpretation.
 *
 * The logic moved to `selectors.js` when permission modes and per-model
 * reasoning levels turned out to belong to the same interpretation. This module
 * stays so existing imports keep working; new code should import
 * `./selectors.js` directly.
 *
 * @module dsh-acp-plugin/acp/models
 */

export {
  currentModeId,
  currentModelId,
  currentValue,
  isModeOption,
  isModelOption,
  isReasoningOption,
  modeForPolicy,
  modeOption,
  modelOption,
  projectModels,
  projectModes,
  projectReasoning,
  reasoningOption,
  selectValues,
  selectionFor,
} from './selectors.js'
