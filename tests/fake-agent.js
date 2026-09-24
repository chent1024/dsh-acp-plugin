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
 *   `auth`      — initialize advertises an auth method; session/new is still
 *                 allowed so the client's own auth gate is what gets tested.
 *   `slow`      — initialize never answers (timeout path).
 *   `exit`      — the process exits immediately (process-death path).
 *   `badversion`— initialize answers with a different protocol version.
 *   `noisy`     — initializes, then reports a failure stop reason.
 *
 * @module dsh-acp-plugin/tests/fake-agent
 */

import { agent as createAcpAgentApp, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
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
      authMethods: behavior === 'auth'
        ? [{ id: 'fake-login', name: 'Fake login', type: 'agent' }]
        : [],
    })
  })
  .onRequest(methods.agent.authenticate, () => Promise.resolve({}))
  .onRequest(methods.agent.session.new, ({ params }) => Promise.resolve({
    sessionId: 'fake-session-1',
    configOptions,
    _meta: { cwd: params.cwd },
  }))
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    const option = configOptions.find((candidate) => candidate.id === params.configId)
    if (option === undefined) return Promise.reject(new Error(`unknown config option ${params.configId}`))
    option.currentValue = params.value
    return Promise.resolve({ configOptions })
  })
  .onRequest(methods.agent.session.prompt, ({ params, client }) => {
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
        usage: { totalTokens: 11, inputTokens: 7, outputTokens: 4 },
      }
    })()
  })
  .onNotification(methods.agent.session.cancel, () => {})

const connection = app.connect(ndJsonStream(
  NodeWritable.toWeb(process.stdout),
  NodeReadable.toWeb(process.stdin),
))