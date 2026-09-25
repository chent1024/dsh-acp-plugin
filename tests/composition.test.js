/**
 * Real-composition acceptance test.
 *
 * This boots the plugin against the ACTUAL harness runtime — a real Cordis
 * context with the real `dsh-llm` service — and asserts what the harness did
 * with it, rather than what the plugin's own units do. It is the evidence that
 * the registration path, the adapter contract, and the settings surface work
 * together, which hand-built stubs cannot show.
 *
 * One case runs a full model call: harness request in, real ACP handshake and
 * prompt over stdio, harness chunk stream out.
 *
 * @module dsh-acp-plugin/tests/composition.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { apply, Config, inject, name } from '../lib/index.js'
import { fakeAgentPath, spawnThroughSeam } from './spawn-seam.js'

/**
 * Boot the plugin against the real LLM service.
 *
 * Only the subprocess seam is supplied: the plugin never imports
 * `node:child_process` itself, so this one seam is what lets the test run a real
 * child process without booting an entire product profile.
 *
 * `ctx.plugin` receives the RAW config, exactly as the Loader hands it over: the
 * framework runs the schema itself and gives `apply` the resolved value carrying
 * the genuine `Volatile` refs the plugin reads.
 *
 * @param {{ agents?: Record<string, any>, sessions?: any }} [options] - configuration under test.
 * @returns {Promise<{ ctx: any, llm: any, fiber: any }>} the context, its LLM service, and the plugin fiber.
 */
async function boot(options = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  // Real services, not hand-planted objects: the Cordis property proxy refuses
  // an undeclared service, so a plugin that injects one must be given a
  // registered Service. Planting a bare object would make `apply` throw for a
  // reason the harness never produces.
  await ctx.plugin(class extends Service {
    constructor(scope) { super(scope, 'subprocess') }
    spawn(spec) { return spawnThroughSeam(spec) }
  })
  await ctx.plugin(class extends Service {
    constructor(scope) { super(scope, 'sessions') }
    get(id) { return options.sessions?.get?.(id) }
  })
  const fiber = await ctx.plugin({ name, inject, apply, Config }, {
    agents: options.agents ?? {
      fake: { displayName: 'Fake ACP', command: process.execPath, args: [fakeAgentPath()], cwd: process.cwd() },
    },
  })
  return { ctx, llm: ctx.get('llm'), fiber }
}

/** The default agent definition used by most cases. */
const FAKE = { displayName: 'Fake ACP', command: process.execPath, args: [fakeAgentPath()], cwd: process.cwd() }

test('registers a configured agent as a live provider route', async () => {
  const { llm, fiber } = await boot()
  try {
    const providers = llm.listProviders()
    assert.ok(providers.some((provider) => provider.id === 'acp:fake'), `routes: ${JSON.stringify(providers)}`)
    assert.equal(providers.find((provider) => provider.id === 'acp:fake').name, 'Fake ACP')
  } finally {
    await fiber.dispose()
  }
})

test('declares the route in the configurable-provider directory with a settings address', async () => {
  const { llm, fiber } = await boot()
  try {
    const entry = llm.listConfigurableProviders().find((candidate) => candidate.provider === 'acp:fake')
    assert.ok(entry, 'the directory carries the route')
    assert.equal(entry.settingsNs, 'acp-agents')
    assert.deepEqual(entry.settingsPath, ['agents', 'fake'])
    assert.equal(entry.displayName, 'Fake ACP')
  } finally {
    await fiber.dispose()
  }
})

test('lists the agent model catalog through the real registry', async () => {
  const { llm, fiber } = await boot()
  try {
    const models = await llm.listModels('acp:fake')
    assert.deepEqual(models.map((model) => model.id), ['fake-large', 'fake-small'])
    // Tagging is on by default, so the disclosed multiplier is in the name the
    // picker renders. The id stays the value a request carries.
    assert.equal(models[0].name, 'Fake Large  [FREE]')
    assert.equal(models[0].id, 'fake-large')
  } finally {
    await fiber.dispose()
  }
})

test('resolves reasoning metadata per model, not per route', async () => {
  // Reasoning is a per-model capability. A route-wide answer would attribute
  // levels to a model that does not have them — Qoder advertises none for `auto`
  // and six for `ultimate`, and CodeBuddy's models differ the same way.
  const { llm, fiber } = await boot()
  try {
    const large = await llm.resolveModelInfo('acp:fake', 'fake-large')
    assert.equal(large.provider, 'acp:fake')
    assert.deepEqual(large.reasoning.efforts.map((effort) => effort.id), ['low', 'medium', 'high'])
    assert.equal(large.reasoning.defaultEffort, 'medium')

    // The other model advertises no levels at all, and must not inherit any.
    const small = await llm.resolveModelInfo('acp:fake', 'fake-small')
    assert.equal(small.reasoning, undefined)
  } finally {
    await fiber.dispose()
  }
})

test('serves a real model call end to end over the ACP protocol', async () => {
  const { llm, fiber } = await boot()
  try {
    const chunks = []
    for await (const chunk of llm.stream({
      provider: 'acp:fake',
      model: 'fake-large',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    })) {
      chunks.push(chunk)
    }
    const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
    assert.equal(text, 'echo:User: hello')
    const finish = chunks.find((chunk) => chunk.type === 'finish')
    assert.equal(finish.reason.kind, 'stop')
    // The harness invariant the runtime enforces: usage before finish, nothing after.
    const finishAt = chunks.findIndex((chunk) => chunk.type === 'finish')
    const usageAt = chunks.findIndex((chunk) => chunk.type === 'usage')
    assert.ok(usageAt >= 0 && usageAt < finishAt, `chunks: ${JSON.stringify(chunks)}`)
    assert.equal(chunks.length, finishAt + 1)
  } finally {
    await fiber.dispose()
  }
})

test('reports an unconfigured route as a terminal error rather than an empty success', async () => {
  const { llm, fiber } = await boot()
  try {
    const chunks = []
    for await (const chunk of llm.stream({
      provider: 'acp:never-configured',
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      chunks.push(chunk)
    }
    const finish = chunks.find((chunk) => chunk.type === 'finish')
    // The runtime refuses an unknown route before any adapter runs.
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, 'NO_ADAPTER')
  } finally {
    await fiber.dispose()
  }
})

test('withdraws every registration when the plugin fiber is disposed', async () => {
  const { llm, fiber } = await boot()
  assert.ok(llm.listProviders().length > 0)
  assert.ok(llm.listConfigurableProviders().length > 0)
  await fiber.dispose()
  assert.deepEqual(llm.listProviders(), [])
  assert.deepEqual(llm.listConfigurableProviders(), [])
})

test('mounts dormant with no agents and registers nothing', async () => {
  const { llm, fiber } = await boot({ agents: {} })
  try {
    assert.deepEqual(llm.listProviders(), [])
    assert.deepEqual(llm.listConfigurableProviders(), [])
  } finally {
    await fiber.dispose()
  }
})

test('rejects an agent definition with no command at config validation', async () => {
  // `command` is a required Config field, so an incomplete agent fails loud at
  // load rather than mounting a route that would fail on first use.
  assert.throws(
    () => Config({ agents: { broken: { displayName: 'Broken' } } }),
    /command/,
  )
})

test('keeps serving when a route conflicts with another adapter', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const llm = ctx.get('llm')
  const { LlmAdapter } = await import('@deepseek-ai/dsh-llm')

  // A foreign adapter claims one of the two routes this plugin will declare.
  class Foreign extends LlmAdapter {
    async * stream() { /* never called */ }
  }
  llm.registerAdapter(['acp:taken'], new Foreign())

  await ctx.plugin(class extends Service {
    constructor(scope) { super(scope, 'subprocess') }
    spawn(spec) { return spawnThroughSeam(spec) }
  })
  await ctx.plugin(class extends Service {
    constructor(scope) { super(scope, 'sessions') }
    get() { return undefined }
  })
  // The whole replacement is refused, so the plugin keeps the routes it had
  // rather than dropping everything over one conflict.
  const fiber = await ctx.plugin({ name, inject, apply, Config }, {
    agents: {
      taken: { displayName: 'Taken', command: process.execPath, args: [fakeAgentPath()] },
      free: { displayName: 'Free', command: process.execPath, args: [fakeAgentPath()] },
    },
  })
  try {
    assert.deepEqual(llm.listProviders().map((provider) => provider.id), ['acp:taken'])
  } finally {
    await fiber.dispose()
  }
})

test('a second agent on the same plugin is served independently', async () => {
  const { llm, fiber } = await boot({
    agents: {
      one: { ...FAKE, displayName: 'One' },
      two: { ...FAKE, displayName: 'Two' },
    },
  })
  try {
    const routes = llm.listProviders().map((provider) => provider.id).sort()
    assert.deepEqual(routes, ['acp:one', 'acp:two'])
    const models = await llm.listModels('acp:two')
    assert.equal(models[0].provider, 'acp:two')
  } finally {
    await fiber.dispose()
  }
})
test('registers the subagent provider on the real service and withdraws it on dispose', async () => {
  const { Context: Ctx } = await import('@deepseek-ai/cordis')
  const Subagents = (await import('@deepseek-ai/dsh-subagent')).default
  const ctx = new Ctx()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Subagents)
  await ctx.plugin(class extends Service {
    constructor(scope) { super(scope, 'subprocess') }
    spawn(spec) { return spawnThroughSeam(spec) }
  })
  await ctx.plugin(class extends Service {
    constructor(scope) { super(scope, 'sessions') }
    get() { return undefined }
  })
  const fiber = await ctx.plugin({ name, inject, apply, Config }, {
    agents: { fake: { ...FAKE } },
  })
  const subs = ctx.get('subagents')
  const names = () => (typeof subs.listProviders === 'function'
    ? subs.listProviders()
    : [...(subs.providers?.keys?.() ?? [])])
  try {
    assert.deepEqual(names(), ['acp-agents'])
  } finally {
    await fiber.dispose()
  }
  assert.deepEqual(names(), [])
})

test('the panel probe answers what the Test connection button needs', async () => {
  // The exact path the Models card's button takes: the plugin publishes a route
  // on `connection`, and the card POSTs `{ endpoint: 'probe', payload: { key } }`.
  // Nothing else in this suite covered it, so a break here would reach the user
  // as "Test connection" failing with no test to catch it.
  const routes = []
  class Connection extends Service {
    constructor(scope) {
      super(scope, 'connection')
      this.fetch = { register: (route) => { routes.push(route); return async () => {} } }
    }
  }
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(class extends Service {
    constructor(scope) { super(scope, 'subprocess') }
    spawn(spec) { return spawnThroughSeam(spec) }
  })
  await ctx.plugin(class extends Service {
    constructor(scope) { super(scope, 'sessions') }
    get() { return undefined }
  })
  await ctx.plugin(Connection)
  const fiber = await ctx.plugin({ name, inject, apply, Config }, {
    agents: { fake: { displayName: 'Fake', command: process.execPath, args: [fakeAgentPath()], cwd: process.cwd() } },
  })
  try {
    assert.equal(routes.length, 1, 'the panel route must be published')
    const response = await routes[0].fetch(new Request('http://x/api/acp-agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'probe', payload: { key: 'fake' } }),
    }))
    const body = await response.json()
    assert.equal(body.ok, true, JSON.stringify(body.error))
    assert.ok(body.value.models.length > 0, 'the probe must report the model catalog')
    assert.ok(Array.isArray(body.value.modes), 'the probe must report the permission modes')
    // Reasoning is keyed by model, so the card can show each model its own set.
    assert.ok(body.value.reasoningByModel['fake-large'], 'a model with levels must report them')
    assert.equal(body.value.reasoningByModel['fake-small'], undefined)
  } finally {
    await fiber.dispose()
  }
})

test('the panel probe names an unknown agent instead of answering emptily', async () => {
  const routes = []
  class Connection extends Service {
    constructor(scope) {
      super(scope, 'connection')
      this.fetch = { register: (route) => { routes.push(route); return async () => {} } }
    }
  }
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(class extends Service {
    constructor(scope) { super(scope, 'subprocess') }
    spawn(spec) { return spawnThroughSeam(spec) }
  })
  await ctx.plugin(class extends Service {
    constructor(scope) { super(scope, 'sessions') }
    get() { return undefined }
  })
  await ctx.plugin(Connection)
  const fiber = await ctx.plugin({ name, inject, apply, Config }, { agents: {} })
  try {
    const response = await routes[0].fetch(new Request('http://x/api/acp-agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'probe', payload: { key: 'nope' } }),
    }))
    const body = await response.json()
    assert.equal(body.ok, false)
    assert.match(String(body.error.message), /nope/)
  } finally {
    await fiber.dispose()
  }
})

test('shows the multiplier by default, with no opt-in', async () => {
  // The picker renders only `name`, so a multiplier an agent discloses in
  // `description` never reaches the user there. Tagging is therefore on by
  // default: an agent configured without the field still gets it.
  const { llm, fiber } = await boot()
  try {
    const models = await llm.listModels('acp:fake')
    const large = models.find((model) => model.id === 'fake-large')
    assert.equal(large.name, 'Fake Large  [FREE]')
    assert.equal(large.id, 'fake-large')
  } finally {
    await fiber.dispose()
  }
})

test('a stored agent that predates the field is tagged', async () => {
  // The profile holds agents written before `showCredit` existed. They carry no
  // such field, so the default must be what decides — not the stored value.
  const { llm, fiber } = await boot({
    agents: { fake: { displayName: 'Fake', command: process.execPath, args: [fakeAgentPath()], cwd: process.cwd() } },
  })
  try {
    const models = await llm.listModels('acp:fake')
    assert.match(models.find((model) => model.id === 'fake-large').name, /\[FREE\]$/)
  } finally {
    await fiber.dispose()
  }
})

test('showCredit: false opts an agent out of tagging', async () => {
  const { llm, fiber } = await boot({
    agents: {
      fake: {
        displayName: 'Fake', command: process.execPath, args: [fakeAgentPath()],
        cwd: process.cwd(), showCredit: false,
      },
    },
  })
  try {
    const models = await llm.listModels('acp:fake')
    assert.equal(models.find((model) => model.id === 'fake-large').name, 'Fake Large')
  } finally {
    await fiber.dispose()
  }
})

test('a model with no disclosed credit keeps its plain name', async () => {
  const { llm, fiber } = await boot({
    agents: {
      fake: {
        displayName: 'Fake', command: process.execPath, args: [fakeAgentPath()],
        cwd: process.cwd(), showCredit: true,
      },
    },
  })
  try {
    const models = await llm.listModels('acp:fake')
    const small = models.find((model) => model.id === 'fake-small')
    assert.equal(small.name, 'Fake Small')
  } finally {
    await fiber.dispose()
  }
})
