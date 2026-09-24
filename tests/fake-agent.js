/**
 * A minimal in-process ACP *agent* (server) used by the tests to drive
 * {@link AcpConnection} without any external CLI.
 *
 * It speaks the real protocol over ndjson stdio, so the test exercises the
 * genuine framing, handshake, and session lifecycle rather than a stub of them.
 * Behavior is chosen by the `FAKE_ACP_BEHAVIOR` environment variable so one
 * script covers every startup shape.
 *
 * Behaviors:
 *   `ok`        — initialize, session/new, one text answer, end_turn.
 *   `auth`      — initialize advertises an auth method but sessions still work,
 *                 like a CLI already signed in (Qoder CLI behaves this way).
 *   `auth-refuses` — advertises a method AND rejects session/new with -32000.
 *   `slow`      — initialize never answers (timeout path).
 *   `exit`      — the process exits immediately (process-death path).
 *   `badversion`— initialize answers with a different protocol version.
 *   `noisy`     — initializes, then reports a failure stop reason.
 *
 * @module dsh-acp-plugin/tests/fake-agent
 */

import { agent as createAcpAgentApp, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'

const behavior = process.env.FAKE_ACP_BEHAVIOR ?? 'ok'

if (behavior === 'exit') {
  process.exit(3)
}

/** The session's live config options; `set_config_option` mutates them. */
const configOptions = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'fake-large',
    options: [
      { value: 'fake-large', name: 'Fake Large' },
      { value: 'fake-small', name: 'Fake Small' },
    ],
  },
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default', description: 'Prompts for approval' },
      { value: 'acceptEdits', name: 'Accept Edits', description: 'Auto-approves edit tools' },
      { value: 'dontAsk', name: "Don't Ask", description: 'Refuses instead of prompting' },
    ],
  },
]

/**
 * Reasoning levels per model, mirroring the real shape: `fake-large` has them,
 * `fake-small` has none, and the option only exists once that model is selected.
 * A route-wide answer would be wrong for whichever model it did not describe.
 */
const REASONING_BY_MODEL = {
  'fake-large': [
    { value: 'low', name: 'Low' },
    { value: 'medium', name: 'Medium' },
    { value: 'high', name: 'High' },
  ],
}

const app = createAcpAgentApp({ name: 'fake-acp-agent' })
  .onRequest(methods.agent.initialize, () => {
    if (behavior === 'slow') return new Promise(() => {})
    return Promise.resolve({
      protocolVersion: behavior === 'badversion' ? 99 : PROTOCOL_VERSION,
      agentInfo: { name: 'fake-acp-agent', version: '1.0.0' },
      agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
      authMethods: behavior === 'auth' || behavior === 'auth-refuses'
        ? [{ id: 'fake-login', name: 'Fake login', type: 'agent' }]
        : [],
    })
  })
  .onRequest(methods.agent.authenticate, () => Promise.resolve({}))
  .onRequest(methods.agent.session.new, ({ params }) => {
    // `auth-refuses` models an agent that genuinely demands authentication: it
    // advertises a method AND rejects the session with ACP's -32000. Plain
    // `auth` advertises the method but still serves, like Qoder CLI signed in.
    if (behavior === 'auth-refuses') {
      // Exactly what the SDK's own `RequestError.authRequired` produces, so the
      // refusal travels the wire the way a real agent's does.
      return Promise.reject(RequestError.authRequired({ methods: ['fake-login'] }))
    }
    return Promise.resolve({
      sessionId: 'fake-session-1',
      configOptions: optionsFor(currentModel),
      modes: {
        currentModeId: currentMode,
        availableModes: configOptions
          .find((option) => option.id === 'mode').options
          .map(({ value, name, description }) => ({ id: value, name, description })),
      },
      _meta: { cwd: params.cwd },
    })
  })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    const option = optionsFor(currentModel).find((candidate) => candidate.id === params.configId)
    if (option === undefined) return Promise.reject(new Error(`unknown config option ${params.configId}`))
    if (params.configId === 'mode') currentMode = params.value
    if (params.configId === 'model') {
      if (!option.options.some((entry) => entry.value === params.value)) {
        return Promise.reject(new Error(`unknown model ${params.value}`))
      }
      currentModel = params.value
    }
    return Promise.resolve({ configOptions: optionsFor(currentModel) })
  })
  .onRequest(methods.agent.session.prompt, ({ params, client }) => {
    promptCount += 1
    const text = params.prompt
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
    return (async () => {
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo:${text}` } },
      })
      if (behavior === 'noisy') {
        return { stopReason: 'refusal' }
      }
      return {
        stopReason: 'end_turn',
        // Cumulative session totals that GROW per turn, as a real agent's do.
        // A constant reading would make every later delta zero, which cannot
        // distinguish a correct delta from an omitted one.
        usage: {
          totalTokens: promptCount * 11,
          inputTokens: promptCount * 7,
          outputTokens: promptCount * 4,
        },
      }
    })()
  })
  .onNotification(methods.agent.session.cancel, () => {})

/** The session's current model and mode; the option list depends on them. */
let currentModel = 'fake-large'
let currentMode = 'default'

/**
 * The config options for one model.
 *
 * The reasoning selector appears ONLY for a model that has levels, which is how
 * a real agent behaves and why the client must resolve effort after selecting
 * the model rather than from the options it first received.
 * @param {string} model - the selected model id.
 * @returns {any[]} that model's options.
 */
function optionsFor(model) {
  const reasoning = REASONING_BY_MODEL[model]
  return [
    ...configOptions.filter((option) => option.id !== 'mode'),
    ...reasoning === undefined
      ? []
      : [{
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'medium',
        options: reasoning,
      }],
  ].concat(configOptions.filter((option) => option.id === 'mode').map((option) => ({
    ...option, currentValue: currentMode,
  })))
}

/** Prompts served by this session; drives the cumulative usage totals. */
let promptCount = 0

const connection = app.connect(ndJsonStream(
  NodeWritable.toWeb(process.stdout),
  NodeReadable.toWeb(process.stdin),
))