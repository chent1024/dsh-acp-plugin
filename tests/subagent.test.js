/**
 * Behavior tests for the subagent provider.
 *
 * The provider is exercised against the real `ctx.subagents` registry where
 * possible, and against the real ACP protocol through the fake agent, so the run
 * handle and result vocabulary are the ones the harness actually consumes.
 *
 * @module dsh-acp-plugin/tests/subagent.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AcpSubagentProvider, PROVIDER_NAME, runAcpChild } from '../lib/subagent/provider.js'
import { fakeAgentPath, spawnThroughSeam } from './spawn-seam.js'

/** A provider over one configured agent. */
function provider(agents, extra = {}) {
  return new AcpSubagentProvider({
    agents: () => agents,
    spawn: () => spawnThroughSeam,
    ...extra,
  })
}

/** The agent definition the tests delegate to. */
const FAKE = { displayName: 'Fake', command: process.execPath, args: [fakeAgentPath()], cwd: process.cwd() }

/** A delegation request carrying only what this provider reads. */
const request = (prompt = 'do the thing') => ({
  prompt: [{ type: 'text', text: prompt }],
  parent: { session: { header: { cwd: process.cwd() } } },
})

test('declares the provider name and refuses every start-time capability', () => {
  const instance = provider({ 'acp:fake': FAKE })
  assert.equal(instance.name, PROVIDER_NAME)
  assert.deepEqual(instance.capabilities, {
    agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false,
  })
  // Descriptive, top-level, and false: the child sees only the prompt handed to it.
  assert.equal(instance.inheritsParentContext, false)
})

test('runs one delegated turn and returns the child text as the result', async () => {
  const instance = provider({ 'acp:fake': FAKE })
  const run = await instance.start(request('hello'))
  const result = await run.result
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(result.output, [{ type: 'text', text: 'echo:User: hello' }])
  assert.equal(result.diagnostic, undefined)
  await run.dispose()
})

test('exposes a run id, a non-local run, and an idempotent dispose', async () => {
  const instance = provider({ 'acp:fake': FAKE })
  const run = await instance.start(request())
  assert.equal(typeof run.id, 'string')
  assert.ok(run.id.length > 0)
  assert.equal(run.localAgent, undefined)
  await run.dispose()
  await run.dispose()
})

test('mints a distinct run id per start', async () => {
  const instance = provider({ 'acp:fake': FAKE })
  const first = await instance.start(request())
  const second = await instance.start(request())
  assert.notEqual(first.id, second.id)
  await Promise.all([first.dispose(), second.dispose()])
})

test('reports a refusal as an error stop reason, never a completed run', async () => {
  // The fake agent answers `refusal` when launched under the `noisy` behavior.
  const instance = provider({
    'acp:fake': { ...FAKE, env: { FAKE_ACP_BEHAVIOR: 'noisy' } },
  })
  const run = await instance.start(request('x'))
  const result = await run.result
  assert.equal(result.stopReason, 'error')
  assert.ok(result.diagnostic.length > 0)
  await run.dispose()
})

test('refuses to start with no configured agent, naming the problem', async () => {
  const instance = provider({})
  await assert.rejects(() => instance.start(request()), /no ACP agent is configured/)
})

test('refuses to start with no workspace and no configured cwd', async () => {
  const instance = provider({ 'acp:fake': { command: process.execPath, args: [fakeAgentPath()] } })
  await assert.rejects(
    () => instance.start({ prompt: [{ type: 'text', text: 'x' }], parent: { session: { header: {} } } }),
    /no working directory/,
  )
})

test('inherits the delegating workspace when the agent sets no cwd', async () => {
  const instance = provider({ 'acp:fake': { command: process.execPath, args: [fakeAgentPath()] } })
  const run = await instance.start({
    prompt: [{ type: 'text', text: 'hi' }],
    parent: { session: { header: { cwd: process.cwd() } } },
  })
  assert.equal((await run.result).stopReason, 'completed')
  await run.dispose()
})

test('reports a child that cannot start as an error result, not a rejection', async () => {
  // The seam contract forbids `result` rejecting on a child-level failure.
  const instance = provider({ 'acp:fake': { command: '/definitely/not/a/binary', args: [], cwd: process.cwd() } })
  const run = await instance.start(request())
  const result = await run.result
  assert.equal(result.stopReason, 'error')
  assert.equal(result.output.length, 0)
  await run.dispose()
})

test('runAcpChild folds multi-chunk text into one output block', async () => {
  const result = await runAcpChild(request('split'), {
    command: process.execPath,
    args: [fakeAgentPath()],
    cwd: process.cwd(),
    spawn: spawnThroughSeam,
  })
  assert.equal(result.stopReason, 'completed')
  assert.equal(result.output.length, 1)
  assert.equal(result.output[0].type, 'text')
})

test('runAcpChild never rejects on a launch failure', async () => {
  const result = await runAcpChild(request(), {
    command: '/definitely/not/a/binary',
    args: [],
    cwd: process.cwd(),
    spawn: spawnThroughSeam,
  })
  assert.equal(result.stopReason, 'error')
  assert.ok(result.diagnostic.length > 0)
})

test('an aborted request settles as aborted rather than error', async () => {
  const controller = new AbortController()
  const instance = provider({ 'acp:fake': FAKE })
  const run = await instance.start({
    ...request('x'),
    signal: controller.signal,
  })
  controller.abort()
  const result = await run.result
  // Either the prompt was cancelled or it completed before the abort landed;
  // both are honest, and neither may be reported as a plain error.
  assert.ok(['aborted', 'completed'].includes(result.stopReason), `stop: ${result.stopReason}`)
  await run.dispose()
})