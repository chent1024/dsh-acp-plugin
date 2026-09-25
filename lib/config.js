/**
 * Plugin configuration: the ACP agents this plugin runs.
 *
 * The whole `agents` dict is volatile, so the Models page can add, edit, and
 * remove agents while the profile stays mounted. That shape is required rather
 * than merely convenient: schemastery forbids a volatile field inside another
 * volatile field, and a dict is what admits a route key the schema never
 * enumerated.
 *
 * @module dsh-acp-plugin/config
 */

import z from '@deepseek-ai/schemastery'

/** How much of the client capability surface to advertise. */
export const CAPABILITY_MODES = ['none', 'fs']

/** How to answer an ACP agent's permission prompts without a human present. */
export const PERMISSION_POLICIES = ['reject', 'allow']

/** Default provider-name prefix, so ACP routes cannot collide with a model route. */
export const DEFAULT_ROUTE_PREFIX = 'acp:'

/** Default idle window before a bound remote session is released. */
export const DEFAULT_IDLE_TIMEOUT_MS = 600_000

/**
 * One ACP agent definition.
 *
 * `command` and `args` describe how to launch the CLI. `env` is merged after the
 * subprocess seam's credential scrub, which is what lets a user hand one CLI its
 * own key without leaking every ambient secret into it.
 */
export const agentSchema = z.object({
  /** Human-readable name for the provider directory and the Models page. */
  displayName: z.string(),
  /** Executable to spawn. */
  command: z.string().required(),
  /** Arguments passed to {@link command}. */
  args: z.array(z.string()).default([]),
  /** Extra environment variables, merged after the seam's scrub. */
  env: z.dict(z.string()).default({}),
  /** Working directory override; the delegating session's cwd is used when omitted. */
  cwd: z.string(),
  /** How to answer permission prompts, which no human sees. */
  permission: z.union(PERMISSION_POLICIES).default('reject'),
  /** Client capabilities to advertise; `fs` offers scoped file reads and writes. */
  capabilities: z.union(CAPABILITY_MODES).default('none'),
  /** Idle window before this agent's bound session is released. */
  idleTimeoutMs: z.number().step(1).min(1).default(DEFAULT_IDLE_TIMEOUT_MS),
  /**
   * Append each model's credit multiplier to its name, e.g. `Ultimate  [2x]` or
   * `Qwen3.8-Flash  [FREE]`.
   *
   * The harness model picker renders only `name`; the multiplier an agent
   * discloses in `description` is never shown there. Tagging the name is the
   * only way to surface it without replacing the shipped picker, so this is on
   * by default. A model whose agent discloses nothing keeps its plain name, and
   * an agent that sends no descriptions at all is entirely unaffected.
   */
  showCredit: z.boolean().default(true),
})

/** Plugin configuration. */
export const Config = z.object({
  /** ACP agents keyed by route id (the key becomes `<prefix><id>`). */
  agents: z.dict(agentSchema).default({}).volatile(),
  /** Provider-route prefix, so an ACP route cannot shadow a model route. */
  routePrefix: z.string().default(DEFAULT_ROUTE_PREFIX),
})