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
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
]

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
      configOptions,
      _meta: { cwd: params.cwd },
    })
  })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    const option = configOptions.find((candidate) => candidate.id === params.configId)
    if (option === undefined) return Promise.reject(new Error(`unknown config option ${params.configId}`))
    option.currentValue = params.value
    return Promise.resolve({ configOptions })
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

/** Prompts served by this session; drives the cumulative usage totals. */
let promptCount = 0

const connection = app.connect(ndJsonStream(
  NodeWritable.toWeb(process.stdout),
  NodeReadable.toWeb(process.stdin),
))