/**
 * Behavior tests for session bindings and delta planning.
 *
 * @module dsh-acp-plugin/tests/bindings.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BindingRegistry, planDelta, prefixDigest } from '../lib/acp/bindings.js'

/** One harness message with text content. */
const message = (role, text) => ({ role, content: [{ type: 'text', text }] })

/** A connection stub whose disposal is observable. */
function fakeConnection() {
  const state = { disposed: 0 }
  return {
    state,
    async dispose() { state.disposed += 1 },
  }
}

test('sends the whole history when no binding exists', () => {
  const messages = [message('user', 'hi')]
  const plan = planDelta(undefined, { provider: 'acp:fake', model: 'large', messages })
  assert.equal(plan.reuse, false)
  assert.equal(plan.messages, messages)
  assert.equal(plan.reason, 'no binding')
})

test('sends only the new messages when the prefix matches', () => {
  const registry = new BindingRegistry()
  const sent = [message('user', 'one')]
  const connection = fakeConnection()
  registry.set('s1', { provider: 'acp:fake', model: 'large', connection, remoteSessionId: 'r1', sentCount: 1, sentMessages: sent })

  const all = [...sent, message('assistant', 'two'), message('user', 'three')]
  const plan = planDelta(registry.get('s1'), { provider: 'acp:fake', model: 'large', messages: all })
  assert.equal(plan.reuse, true)
  assert.deepEqual(plan.messages.map((m) => m.content[0].text), ['two', 'three'])
})

test('falls back to the full history when the history was rewritten', () => {
  const registry = new BindingRegistry()
  registry.set('s1', {
    provider: 'acp:fake', model: 'large', connection: fakeConnection(), remoteSessionId: 'r1',
    sentCount: 2, sentMessages: [message('user', 'one'), message('assistant', 'two')],
  })
  // Compaction replaced the prefix with a summary.
  const compacted = [message('user', 'summary of everything'), message('user', 'next')]
  const plan = planDelta(registry.get('s1'), { provider: 'acp:fake', model: 'large', messages: compacted })
  assert.equal(plan.reuse, false)
  assert.equal(plan.reason, 'history was rewritten')
  assert.equal(plan.messages.length, 2)
})

test('falls back when the history shrank below what was sent', () => {
  const registry = new BindingRegistry()
  registry.set('s1', {
    provider: 'acp:fake', model: 'large', connection: fakeConnection(), remoteSessionId: 'r1',
    sentCount: 5, sentMessages: [message('user', 'one')],
  })
  const plan = planDelta(registry.get('s1'), { provider: 'acp:fake', model: 'large', messages: [message('user', 'x')] })
  assert.equal(plan.reuse, false)
  assert.equal(plan.reason, 'history shrank')
})

test('refuses to reuse a binding across routes', () => {
  const registry = new BindingRegistry()
  const sent = [message('user', 'one')]
  registry.set('s1', { provider: 'acp:fake', model: 'large', connection: fakeConnection(), remoteSessionId: 'r1', sentCount: 1, sentMessages: sent })
  const all = [...sent, message('user', 'two')]
  const plan = planDelta(registry.get('s1'), { provider: 'acp:other', model: 'large', messages: all })
  assert.equal(plan.reuse, false)
  assert.equal(plan.reason, 'route or model changed')
})

test('refuses to reuse a binding across models on one route', () => {
  const registry = new BindingRegistry()
  const sent = [message('user', 'one')]
  registry.set('s1', { provider: 'acp:fake', model: 'large', connection: fakeConnection(), remoteSessionId: 'r1', sentCount: 1, sentMessages: sent })
  const all = [...sent, message('user', 'two')]
  const plan = planDelta(registry.get('s1'), { provider: 'acp:fake', model: 'small', messages: all })
  assert.equal(plan.reuse, false)
})

test('falls back when there is nothing new to send', () => {
  const registry = new BindingRegistry()
  const sent = [message('user', 'one')]
  registry.set('s1', { provider: 'acp:fake', model: 'large', connection: fakeConnection(), remoteSessionId: 'r1', sentCount: 1, sentMessages: sent })
  const plan = planDelta(registry.get('s1'), { provider: 'acp:fake', model: 'large', messages: sent })
  assert.equal(plan.reuse, false)
  assert.equal(plan.reason, 'nothing new to send')
})

test('keeps the digest order-sensitive', () => {
  const a = [message('user', 'one'), message('assistant', 'two')]
  const b = [message('assistant', 'two'), message('user', 'one')]
  assert.notEqual(prefixDigest(a), prefixDigest(b))
  const reordered = [message('assistant', 'two'), message('user', 'one')]
  assert.notEqual(prefixDigest(a), prefixDigest(reordered))
})

test('changes the digest when role or text changes', () => {
  assert.notEqual(prefixDigest([message('user', 'x')]), prefixDigest([message('assistant', 'x')]))
  assert.notEqual(prefixDigest([message('user', 'x')]), prefixDigest([message('user', 'y')]))
  assert.equal(prefixDigest([message('user', 'x')]), prefixDigest([message('user', 'x')]))
})

test('expires a binding after the idle window', () => {
  let now = 1_000
  const registry = new BindingRegistry({ idleTimeoutMs: 100, now: () => now })
  registry.set('s1', {
    provider: 'acp:fake', model: 'large', connection: fakeConnection(), remoteSessionId: 'r1',
    sentCount: 1, sentMessages: [message('user', 'one')],
  })
  now += 50
  assert.ok(registry.get('s1'))
  now += 200
  assert.equal(registry.get('s1'), undefined)
})

test('releaseIdle disposes exactly the expired connections', async () => {
  let now = 1_000
  const registry = new BindingRegistry({ idleTimeoutMs: 100, now: () => now })
  const stale = fakeConnection()
  const fresh = fakeConnection()
  registry.set('old', { provider: 'p', model: 'm', connection: stale, remoteSessionId: 'r1', sentCount: 0, sentMessages: [] })
  now += 200
  registry.set('new', { provider: 'p', model: 'm', connection: fresh, remoteSessionId: 'r2', sentCount: 0, sentMessages: [] })
  await registry.releaseIdle()
  assert.equal(stale.state.disposed, 1)
  assert.equal(fresh.state.disposed, 0)
  assert.equal(registry.size, 1)
})

test('releaseAll disposes every connection and empties the registry', async () => {
  const registry = new BindingRegistry()
  const one = fakeConnection()
  const two = fakeConnection()
  registry.set('a', { provider: 'p', model: 'm', connection: one, remoteSessionId: 'r1', sentCount: 0, sentMessages: [] })
  registry.set('b', { provider: 'p', model: 'm', connection: two, remoteSessionId: 'r2', sentCount: 0, sentMessages: [] })
  await registry.releaseAll()
  assert.equal(one.state.disposed, 1)
  assert.equal(two.state.disposed, 1)
  assert.equal(registry.size, 0)
})

test('release of an unknown session is a no-op', async () => {
  const registry = new BindingRegistry()
  await registry.release('nope')
  assert.equal(registry.size, 0)
})

test('tolerates a connection whose disposal rejects', async () => {
  const registry = new BindingRegistry()
  registry.set('a', {
    provider: 'p', model: 'm', remoteSessionId: 'r', sentCount: 0, sentMessages: [],
    connection: { dispose: () => Promise.reject(new Error('already dead')) },
  })
  await registry.releaseAll()
  assert.equal(registry.size, 0)
})

test('touch extends the idle window', () => {
  let now = 1_000
  const registry = new BindingRegistry({ idleTimeoutMs: 100, now: () => now })
  registry.set('s1', {
    provider: 'p', model: 'm', connection: fakeConnection(), remoteSessionId: 'r', sentCount: 0, sentMessages: [],
  })
  now += 90
  registry.touch('s1')
  now += 90
  assert.ok(registry.get('s1'), 'the window restarts from the last turn')
})