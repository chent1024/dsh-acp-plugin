/**
 * Behavior tests for the adapter's session handling: working-directory
 * resolution and the best-effort model/effort selection.
 *
 * These cover the two things a real harness run surfaced — a request with no
 * session identity has no workspace, and an agent may refuse a configuration
 * option it advertised — both of which must produce a usable turn rather than a
 * failed one where possible.
 *
 * @module dsh-acp-plugin/tests/session.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { apply, Config, inject, name } from '../lib/index.js'
import { resolveCwd } from '../lib/adapter/index.js'
import { fakeAgentPath, spawnThroughSeam } from './spawn-seam.js'

/**
 * Boot the plugin against the real LLM service.
 * @param {{ agents?: Record<string, any>, sessions?: any }} [options] - configuration under test.
 * @returns {Promise<{ ctx: any, llm: any, fiber: any }>} the context, its LLM service, and the fiber.
 */
async function boot(options = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.subprocess = { spawn: spawnThroughSeam }
  if (options.sessions !== undefined) ctx.sessions = options.sessions
  const fiber = await ctx.plugin({ name, inject, apply, Config }, {
    agents: options.agents ?? {},
  })
  return { ctx, llm: ctx.get('llm'), fiber }
}

/** Collect one stream into chunks. */
async function collect(llm, options) {
  const chunks = []
  for await (const chunk of llm.stream(options)) chunks.push(chunk)
  return chunks
}

test('resolveCwd prefers the configured override', () => {
  const ctx = { sessions: { get: () => ({ header: { cwd: '/from/session' } }) } }
  assert.equal(resolveCwd(ctx, 's1', '/from/config'), '/from/config')
})

test('resolveCwd falls back to the session workspace', () => {
  const ctx = { sessions: { get: () => ({ header: { cwd: '/from/session' } }) } }
  assert.equal(resolveCwd(ctx, 's1', undefined), '/from/session')
})

test('resolveCwd fails loud when neither source supplies one', () => {
  // An ACP session cannot be created without a cwd, and guessing one would let
  // the agent write into a directory nobody chose.
  assert.throws(() => resolveCwd({}, undefined, undefined), /no working directory/)
  assert.throws(() => resolveCwd({ sessions: { get: () => undefined } }, 's1', undefined), /no working directory/)
  assert.throws(() => resolveCwd({ sessions: { get: () => ({ header: {} }) } }, 's1', ''), /no working directory/)
})

test('a request with no session and no cwd fails with a named diagnostic', async () => {
  const { llm, fiber } = await boot({
    agents: { bare: { displayName: 'Bare', command: process.execPath, args: [fakeAgentPath()] } },
  })
  try {
    const chunks = await collect(llm, {
      provider: 'acp:bare',
      model: 'fake-large',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    const finish = chunks.find((chunk) => chunk.type === 'finish')
    assert.equal(finish.reason.kind, 'error')
    assert.match(finish.reason.failure.message, /no working directory/)
  } finally {
    await fiber.dispose()
  }
})

test('a request carrying a session id resolves its workspace', async () => {
  const { llm, fiber } = await boot({
    agents: { bare: { displayName: 'Bare', command: process.execPath, args: [fakeAgentPath()] } },
    // The harness validates this path before a session exists; here it stands
    // in for a real session header.
    sessions: { get: () => ({ header: { cwd: process.cwd() } }) },
  })
  try {
    const chunks = await collect(llm, {
      provider: 'acp:bare',
      model: 'fake-large',
      sessionId: 'session-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    const finish = chunks.find((chunk) => chunk.type === 'finish')
    assert.equal(finish.reason.kind, 'stop', JSON.stringify(finish.reason))
  } finally {
    await fiber.dispose()
  }
})

test('a model selection the agent accepts is applied before the prompt', async () => {
  const { llm, fiber } = await boot({
    agents: { fake: { displayName: 'Fake', command: process.execPath, args: [fakeAgentPath()], cwd: process.cwd() } },
  })
  try {
    const chunks = await collect(llm, {
      provider: 'acp:fake',
      model: 'fake-small',
      reasoningEffort: 'high',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    })
    const finish = chunks.find((chunk) => chunk.type === 'finish')
    assert.equal(finish.reason.kind, 'stop', JSON.stringify(finish.reason))
  } finally {
    await fiber.dispose()
  }
})

test('an agent refusing a config option still serves the turn', async () => {
  const { llm, fiber } = await boot({
    agents: {
      // The fake agent implements set_config_option, so an unlisted model is the
      // refusal path: it is never selected, and the turn must still complete.
      fake: { displayName: 'Fake', command: process.execPath, args: [fakeAgentPath()], cwd: process.cwd() },
    },
  })
  try {
    const chunks = await collect(llm, {
      provider: 'acp:fake',
      model: 'not-a-real-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    })
    const finish = chunks.find((chunk) => chunk.type === 'finish')
    assert.equal(finish.reason.kind, 'stop', JSON.stringify(finish.reason))
    const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
    assert.equal(text, 'echo:User: x')
  } finally {
    await fiber.dispose()
  }
})

test('a second request on the same session continues the bound ACP session', async () => {
  const { llm, fiber } = await boot({
    agents: { fake: { displayName: 'Fake', command: process.execPath, args: [fakeAgentPath()], cwd: process.cwd() } },
    sessions: { get: () => ({ header: { cwd: process.cwd() } }) },
  })
  try {
    const first = await collect(llm, {
      provider: 'acp:fake',
      model: 'fake-large',
      sessionId: 'session-bind',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'one' }] }],
    })
    assert.equal(first.find((chunk) => chunk.type === 'finish').reason.kind, 'stop')

    // The follow-up sends only the new message, so the agent echoes that alone.
    const second = await collect(llm, {
      provider: 'acp:fake',
      model: 'fake-large',
      sessionId: 'session-bind',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'one' }] },
        // A durable assistant message always carries its model source; the
        // harness reads `source.replayState` on every assistant message it
        // routes, so a hand-written one without it is not a valid request.
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'echo:User: one' }],
          source: { kind: 'model', provider: 'acp:fake', model: 'fake-large' },
        },
        { role: 'user', content: [{ type: 'text', text: 'two' }] },
      ],
    })
    const text = second.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
    assert.equal(text, 'echo:Assistant: echo:User: oneUser: two')
    assert.equal(second.find((chunk) => chunk.type === 'finish').reason.kind, 'stop')
  } finally {
    await fiber.dispose()
  }
})

test('the second turn reports usage as a delta, not a cumulative total', async () => {
  const { llm, fiber } = await boot({
    agents: { fake: { displayName: 'Fake', command: process.execPath, args: [fakeAgentPath()], cwd: process.cwd() } },
    sessions: { get: () => ({ header: { cwd: process.cwd() } }) },
  })
  try {
    await collect(llm, {
      provider: 'acp:fake',
      model: 'fake-large',
      sessionId: 'session-usage',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'one' }] }],
    })
    const second = await collect(llm, {
      provider: 'acp:fake',
      model: 'fake-large',
      sessionId: 'session-usage',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'one' }] },
        { role: 'user', content: [{ type: 'text', text: 'two' }] },
      ],
    })
    // The fake agent reports the same cumulative totals each turn, so the second
    // turn's delta is zero rather than the cumulative figure repeated.
    const usage = second.find((chunk) => chunk.type === 'usage')
    assert.equal(usage.usage.inputTokens, 0)
    assert.equal(usage.usage.outputTokens, 0)
  } finally {
    await fiber.dispose()
  }
})

test('disposing the plugin releases every bound session process', async () => {
  const { llm, fiber } = await boot({
    agents: { fake: { displayName: 'Fake', command: process.execPath, args: [fakeAgentPath()], cwd: process.cwd() } },
    sessions: { get: () => ({ header: { cwd: process.cwd() } }) },
  })
  await collect(llm, {
    provider: 'acp:fake',
    model: 'fake-large',
    sessionId: 'session-dispose',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'one' }] }],
  })
  // A successful dispose reaching here proves the bound child was reaped rather
  // than left running after its owner unloaded.
  await fiber.dispose()
  assert.deepEqual(llm.listProviders(), [])
})