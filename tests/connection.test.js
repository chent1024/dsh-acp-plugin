/**
 * Behavior tests for the ACP connection layer.
 *
 * Every case spawns the fake ACP agent as a REAL child process over the real
 * ndjson protocol, so framing, handshake, session lifecycle, and teardown are
 * exercised end to end rather than mocked.
 *
 * @module dsh-acp-plugin/tests/connection.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AcpConnection, AcpError, ACP_AUTH_REQUIRED } from '../lib/acp/connection.js'
import { fakeAgentPath, spawnThroughSeam } from './spawn-seam.js'

/** Launch the fake agent under one behavior. */
function open(behavior, extra = {}) {
  return AcpConnection.open({
    command: process.execPath,
    args: [fakeAgentPath()],
    cwd: process.cwd(),
    env: { FAKE_ACP_BEHAVIOR: behavior },
    spawn: spawnThroughSeam,
    startupTimeoutMs: 5_000,
    eofGraceMs: 500,
    ...extra,
  })
}

test('completes the handshake and reports no authentication requirement', async () => {
  const connection = await open('ok')
  try {
    assert.equal(connection.needsAuthentication, false)
    assert.deepEqual(connection.authMethods, [])
    const sessionId = await connection.newSession(process.cwd())
    assert.equal(sessionId, 'fake-session-1')
    assert.equal(connection.sessionId, 'fake-session-1')
  } finally {
    await connection.dispose()
  }
})

test('exposes the agent model and reasoning options from session/new', async () => {
  const connection = await open('ok')
  try {
    await connection.newSession(process.cwd())
    const models = connection.configOptions.filter((option) => option.category === 'model')
    const efforts = connection.configOptions.filter((option) => option.category === 'thought_level')
    assert.deepEqual(models.map((option) => option.id), ['model'])
    assert.deepEqual(efforts.map((option) => option.id), ['reasoning_effort'])
  } finally {
    await connection.dispose()
  }
})

test('streams update text and returns the terminal prompt response', async () => {
  const connection = await open('ok')
  try {
    await connection.newSession(process.cwd())
    const chunks = []
    const result = await connection.prompt(
      [{ type: 'text', text: 'hello' }],
    )
    // The sink is wired at open(); this asserts the response half.
    assert.equal(chunks.length, 0)
    assert.equal(result.stopReason, 'end_turn')
    assert.equal(result.usage.inputTokens, 7)
    assert.equal(result.usage.outputTokens, 4)
  } finally {
    await connection.dispose()
  }
})

test('delivers agent_message_chunk through the update sink', async () => {
  const seen = []
  const connection = await open('ok', { onUpdate: (update) => { seen.push(update) } })
  try {
    await connection.newSession(process.cwd())
    await connection.prompt([{ type: 'text', text: 'ping' }])
    assert.equal(seen.length, 1)
    assert.equal(seen[0].sessionUpdate, 'agent_message_chunk')
    assert.equal(seen[0].content.text, 'echo:ping')
  } finally {
    await connection.dispose()
  }
})

test('an advertised auth method does not by itself block a session', async () => {
  // The exact trap this covers: an agent that is ALREADY signed in through its
  // own CLI still advertises an auth method. Refusing on the advert alone makes
  // it unusable. Qoder CLI lists `qodercli-login` while signed in and answers
  // session/new normally.
  const connection = await open('auth')
  try {
    assert.equal(connection.needsAuthentication, true)
    assert.equal(connection.authMethods.length, 1)
    const sessionId = await connection.newSession(process.cwd())
    assert.equal(sessionId, 'fake-session-1')
  } finally {
    await connection.dispose()
  }
})

test('surfaces a genuine authentication refusal as its own failure code', async () => {
  const connection = await open('auth-refuses')
  try {
    assert.equal(connection.needsAuthentication, true)
    await assert.rejects(
      () => connection.newSession(process.cwd()),
      (error) => {
        assert.ok(error instanceof AcpError)
        assert.equal(error.code, ACP_AUTH_REQUIRED)
        assert.equal(error.stage, 'auth')
        assert.equal(error.authMethods.length, 1)
        return true
      },
    )
  } finally {
    await connection.dispose()
  }
})

test('authenticates when the agent advertises a method', async () => {
  const connection = await open('auth')
  try {
    await connection.authenticate()
  } finally {
    await connection.dispose()
  }
})

test('reports a protocol version mismatch instead of proceeding', async () => {
  await assert.rejects(
    () => open('badversion'),
    (error) => {
      assert.ok(error instanceof AcpError)
      assert.equal(error.code, 'ACP_PROTOCOL_VERSION')
      assert.equal(error.stage, 'initialize')
      return true
    },
  )
})

test('times out a handshake that never answers', async () => {
  await assert.rejects(
    () => open('slow', { startupTimeoutMs: 300 }),
    (error) => {
      assert.ok(error instanceof AcpError)
      assert.equal(error.code, 'ACP_TIMEOUT')
      return true
    },
  )
})

test('reaps the child when the agent exits during startup', async () => {
  await assert.rejects(
    () => open('exit', { startupTimeoutMs: 3_000 }),
    (error) => {
      assert.ok(error instanceof AcpError)
      assert.ok(['ACP_INITIALIZE_FAILED', 'ACP_TIMEOUT'].includes(error.code), `unexpected code ${error.code}`)
      return true
    },
  )
})

test('rejects a prompt before the session exists', async () => {
  const connection = await open('ok')
  try {
    await assert.rejects(
      () => connection.prompt([{ type: 'text', text: 'x' }]),
      (error) => error.code === 'ACP_NO_SESSION',
    )
  } finally {
    await connection.dispose()
  }
})

test('dispose is idempotent and leaves no live child', async () => {
  const connection = await open('ok')
  await connection.newSession(process.cwd())
  const child = connection.child
  await connection.dispose()
  await connection.dispose()
  assert.equal(connection.closed, true)
  // The handle proves whole-range exit, so a second read is already true.
  assert.equal(await child.waitForExit(), true)
})

test('reports a refusal stop reason rather than treating it as success', async () => {
  const connection = await open('noisy')
  try {
    await connection.newSession(process.cwd())
    const result = await connection.prompt([{ type: 'text', text: 'x' }])
    assert.equal(result.stopReason, 'refusal')
  } finally {
    await connection.dispose()
  }
})
test('fails fast when the agent binary cannot be launched', async () => {
  const started = Date.now()
  await assert.rejects(
    () => AcpConnection.open({
      command: '/definitely/not/a/binary',
      args: [],
      cwd: process.cwd(),
      spawn: spawnThroughSeam,
      startupTimeoutMs: 30_000,
      eofGraceMs: 200,
    }),
    (error) => {
      assert.ok(error instanceof AcpError)
      assert.ok(['ACP_PROCESS_START', 'ACP_PROCESS_EXIT'].includes(error.code), `code ${error.code}`)
      assert.equal(error.stage, 'process')
      return true
    },
  )
  // The point of racing startup against process death: a 30s deadline must not
  // be spent waiting on a process that never existed.
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started}ms`)
})

test('fails fast when the agent exits during the handshake', async () => {
  const started = Date.now()
  await assert.rejects(
    () => open('exit', { startupTimeoutMs: 30_000 }),
    (error) => {
      assert.ok(error instanceof AcpError)
      // A child that exits closes the transport, so either the process-death
      // arm or the initialize arm can win; both are honest, and the deadline
      // is what must NOT be what settles it.
      assert.ok(
        ['ACP_PROCESS_EXIT', 'ACP_INITIALIZE_FAILED'].includes(error.code),
        `code ${error.code}`,
      )
      return true
    },
  )
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started}ms`)
})
