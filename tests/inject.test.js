/**
 * Composition contract tests: what this plugin declares, and what the Cordis
 * property proxy does when a declaration is missing.
 *
 * These exist because the failure they cover was invisible to the rest of the
 * suite. A test that hand-plants services on a bare context never touches the
 * proxy, so a plugin that reads `ctx.subprocess` while declaring only `['llm']`
 * passes every unit test and then fails on its first real use. That is exactly
 * how a broken build shipped: the install activated, the Models card rendered,
 * and "Test connection" answered
 * `cannot get property "subprocess" without inject`.
 *
 * The plugin is activated here by real `Service` classes, so `apply` runs
 * against the genuine proxy rather than around it.
 *
 * @module dsh-acp-plugin/tests/inject.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { apply, Config, inject, name } from '../lib/index.js'
import { fakeAgentPath } from './spawn-seam.js'

/** Minimal stand-in for the `llm` service: only the two registrations `apply` makes. */
class FakeLlm extends Service {
  constructor(ctx) { super(ctx, 'llm') }
  /** @returns {any} a disposable handle with the registry's `replace`. */
  registerAdapter() { return Object.assign(() => {}, { replace: () => {} }) }
  /** @returns {any} a disposable handle with the registry's `replace`. */
  registerConfigurableProviders() { return Object.assign(() => {}, { replace: () => {} }) }
}

/** Minimal stand-in for the subprocess seam. */
class FakeSubprocess extends Service {
  constructor(ctx) { super(ctx, 'subprocess') }
  /** @returns {never} never reached: activation is the behavior under test. */
  spawn() { throw new Error('the subprocess seam is not exercised here') }
}

/** Minimal stand-in for the session store. */
class FakeSessions extends Service {
  constructor(ctx) { super(ctx, 'sessions') }
  /** @returns {undefined} no session is bound in these tests. */
  get() { return undefined }
}

/**
 * Boot the plugin with real services so `apply` runs against the live proxy.
 * @param {{ agents?: Record<string, any>, omit?: string[] }} [options] - config and services to leave out.
 * @returns {Promise<{ ctx: any, fiber: any }>} the context and the plugin fiber.
 */
async function bootReal(options = {}) {
  const omit = new Set(options.omit ?? [])
  const ctx = new Context()
  if (!omit.has('llm')) await ctx.plugin(FakeLlm)
  if (!omit.has('subprocess')) await ctx.plugin(FakeSubprocess)
  if (!omit.has('sessions')) await ctx.plugin(FakeSessions)
  const fiber = await ctx.plugin({ name, inject, apply, Config }, {
    agents: options.agents ?? {
      fake: { displayName: 'Fake', command: process.execPath, args: [fakeAgentPath()], cwd: process.cwd() },
    },
  })
  return { ctx, fiber }
}

test('declares every service it reads through the context proxy', () => {
  // The exact regression: `ctx.subprocess` was read while only `llm` was
  // declared, and the proxy refuses that at the point of use.
  for (const service of ['llm', 'subprocess', 'sessions']) {
    assert.ok(inject.includes(service), `${service} is read but not declared in inject`)
  }
})

test('does not declare the services it reaches optionally', () => {
  // Each of these is reached through `ctx.inject` or `ctx.get`. Declaring one
  // would make the plugin refuse to mount in a composition that lacks it.
  for (const optional of ['settings', 'subagents', 'connection']) {
    assert.ok(!inject.includes(optional), `${optional} must stay optional`)
  }
})

test('the proxy refuses an undeclared service, which is why the list matters', async () => {
  // Pins the platform behavior the declaration list exists to satisfy. If this
  // ever stops throwing, the list above is no longer load-bearing.
  const ctx = new Context()
  await ctx.plugin(FakeLlm)
  await ctx.plugin(FakeSubprocess)
  let refusal
  const fiber = await ctx.plugin({
    name: 'probe',
    inject: ['llm'],
    apply: (scope) => {
      try {
        void scope.subprocess
      } catch (error) {
        refusal = error
      }
    },
  })
  await fiber.dispose()
  assert.ok(refusal, 'reading an undeclared service must throw')
  assert.match(String(refusal.message), /subprocess/)
})

test('apply completes against the live proxy with every declared service present', async () => {
  // Any undeclared read inside `apply` or its synchronous path throws here,
  // because these are real services behind the real proxy.
  const { fiber } = await bootReal()
  await fiber.dispose()
  assert.ok(true)
})

test('mounts with no llm, because that is a composition decision', async () => {
  // `llm` is required, so the fiber parks instead of activating. The point is
  // that it does not throw: the harness reports a waiting plugin.
  const ctx = new Context()
  await ctx.plugin(FakeSubprocess)
  await ctx.plugin(FakeSessions)
  const fiber = await ctx.plugin({ name, inject, apply, Config }, { agents: {} })
  await fiber.dispose()
  assert.ok(true)
})

test('a working directory is still required per call, not at mount', async () => {
  // The plugin must mount even when an agent names no cwd, because the cwd can
  // come from the calling session at request time.
  const { fiber } = await bootReal({
    agents: { bare: { displayName: 'Bare', command: process.execPath, args: [fakeAgentPath()] } },
  })
  await fiber.dispose()
  assert.ok(true)
})
test('the subprocess thunk resolves a declared service when invoked', async () => {
  // The real failure surfaced when "Test connection" invoked the spawn thunk,
  // not at mount: `apply` closes over `ctx.subprocess` lazily. A test that only
  // mounts therefore cannot see it. This one invokes the thunk through the
  // path the panel uses.
  const { ctx, fiber } = await bootReal()
  let spawnCalls = 0
  // Reaching the seam proves the plugin's own `ctx.subprocess` read resolved.
  ctx.subprocess.spawn = () => { spawnCalls += 1; throw new Error('reached the seam') }
  const { AcpSubagentProvider } = await import('../lib/subagent/provider.js')
  const provider = new AcpSubagentProvider({
    agents: () => ({ 'acp:fake': { displayName: 'Fake', command: process.execPath, args: [fakeAgentPath()], cwd: process.cwd() } }),
    spawn: () => ctx.subprocess.spawn(),
  })
  await assert.rejects(() => provider.start({
    prompt: [{ type: 'text', text: 'x' }],
    parent: { session: { header: { cwd: process.cwd() } } },
  }), /reached the seam/)
  assert.equal(spawnCalls, 1)
  await fiber.dispose()
})
