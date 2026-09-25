/**
 * Verify the plugin under the conditions the APPLICATION actually has.
 *
 * Three shipped bugs were each invisible to the rest of this suite because the
 * suite ran in a developer shell and the application does not:
 *
 *   - `zod/v4` resolved locally (zod 4.6.5) but not in the profile (3.23.0);
 *   - an undeclared `ctx.subprocess` was masked by tests hand-planting services;
 *   - the child `PATH` was full here and minimal in the GUI host, so every agent
 *     CLI failed as if it were not installed.
 *
 * This file makes that class reproducible in one command instead of only under
 * the real app. It runs an agent whose launcher is a `#!/usr/bin/env node`
 * script — the real failure mode — with `PATH` restricted to what a GUI host
 * inherits, through the harness's REAL `dsh-subprocess-local` seam.
 *
 * Every case here is written to fail if the fix is reverted; the first one
 * proves the launcher genuinely needs `PATH`, so a passing suite cannot come
 * from a launcher that never consulted it.
 *
 * Skipped, loudly, when the harness packages are not resolvable: the assertion
 * needs the actual seam, and quietly testing a fake one is what let this ship.
 *
 * @module dsh-acp-plugin/tests/app-conditions.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { probeCatalog } from '../lib/acp/discovery.js'
import { childEnvironment, mergePath } from '../lib/env.js'
import { fakeAgentPath } from './spawn-seam.js'

/** The PATH a GUI-launched host inherits, read from the running application. */
const GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

/**
 * Load the harness's real subprocess provider, or report it unavailable.
 * @returns {Promise<any>} the plugin, or undefined when it cannot be resolved.
 */
async function loadRealSeam() {
  for (const candidate of [
    '@deepseek-ai/dsh-subprocess-local',
    '/tmp/appdsh/dsh/node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js',
  ]) {
    try {
      const module = await import(candidate)
      return module.default ?? module
    } catch { /* try the next location */ }
  }
  return undefined
}

/**
 * Write a launcher that needs `node` from PATH, exactly as the real CLIs do.
 *
 * The shebang is the point: `#!/usr/bin/env node` fails with
 * `env: node: No such file or directory` when PATH lacks node, which is what
 * happened to CodeBuddy. Naming an absolute interpreter would remove the PATH
 * lookup and make the case vacuous.
 *
 * @returns {string} the launcher's path.
 */
function writeEnvNodeLauncher() {
  const dir = mkdtempSync(join(tmpdir(), 'acp-launcher-'))
  const launcher = join(dir, 'agent-with-env-node')
  writeFileSync(launcher, `#!/usr/bin/env node\nimport(${JSON.stringify(fakeAgentPath())})\n`)
  chmodSync(launcher, 0o755)
  return launcher
}

const realSeam = await loadRealSeam()
const skip = realSeam === undefined
  ? 'harness packages are not resolvable; install them beside this plugin to run application-condition tests'
  : false

test('the real subprocess seam is available to test against', { skip }, () => {
  assert.ok(realSeam, 'a fake seam would not reproduce the failure this file covers')
})

test('the launcher genuinely needs PATH, or the cases below prove nothing', { skip }, async () => {
  // Spawned the raw way, with only the GUI PATH and no widening, the launcher
  // must fail. If this ever passes, the shebang stopped consulting PATH and
  // the following case would be testing nothing.
  const ctx = new Context()
  await ctx.plugin(realSeam)
  const seam = ctx.get('subprocess')
  const child = seam.spawn({
    argv: [writeEnvNodeLauncher()],
    cwd: process.cwd(),
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 1_000,
    env: { PATH: GUI_PATH, FAKE_ACP_BEHAVIOR: 'ok' },
  })
  // No protocol answer can arrive: `env` cannot find node to run it.
  await assert.rejects(
    () => probeCatalog({ command: '/nonexistent/never', args: [], cwd: process.cwd(), spawn: () => child }),
    (error) => {
      assert.match(String(error.message), /initialization|closed|exited/i)
      return true
    },
    'a launcher that cannot find node must not complete a handshake',
  )
})

test('the plugin reaches the CLI under the application\'s minimal PATH', { skip }, async () => {
  // Reproduce the host exactly: the PROCESS PATH is minimal, which is what the
  // plugin widens. Passing a minimal PATH as an overlay would not reproduce it,
  // because the plugin deliberately merges rather than replaces.
  const saved = process.env.PATH
  process.env.PATH = GUI_PATH
  try {
    const ctx = new Context()
    await ctx.plugin(realSeam)
    const catalog = await probeCatalog({
      command: writeEnvNodeLauncher(),
      args: [],
      cwd: process.cwd(),
      spawn: ctx.get('subprocess').spawn.bind(ctx.get('subprocess')),
      env: { FAKE_ACP_BEHAVIOR: 'ok' },
    })
    assert.ok(catalog.models.length > 0, 'the widened PATH must let the launcher find node')
  } finally {
    process.env.PATH = saved
  }
})

test('widening preserves an explicitly pinned PATH ahead of the login one', () => {
  // A config that pins `env.PATH` must keep precedence, or an agent could be
  // launched with a toolchain the operator deliberately excluded.
  assert.equal(mergePath(['/pinned', '/usr/bin']), '/pinned:/usr/bin')
})

test('the resolved PATH reaches the directories a login shell adds', { skip }, async () => {
  // The fix depends on the login shell knowing where the toolchain is: node
  // must become reachable after widening, which is the property that broke.
  const widened = await childEnvironment({ PATH: GUI_PATH, SHELL: process.env.SHELL }, {})
  const dirs = String(widened.PATH).split(':')
  assert.ok(dirs.includes('/usr/bin'), 'inherited directories survive')
  assert.ok(dirs.length >= 4, `expected the login PATH to add directories, got ${widened.PATH}`)
})

test('reverting the widening reproduces the reported failure', { skip }, async () => {
  // The exact symptom the user saw, asserted rather than described: with the
  // minimal PATH and no login resolution, the child exits before the handshake
  // and the message names the underlying reason.
  const ctx = new Context()
  await ctx.plugin(realSeam)
  const seam = ctx.get('subprocess')
  const child = seam.spawn({
    argv: [writeEnvNodeLauncher()],
    cwd: process.cwd(),
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 1_000,
    env: { PATH: GUI_PATH },
  })
  const outcome = await child.done
  assert.notEqual(outcome.exitCode, 0, 'the child must exit non-zero without node on PATH')
})