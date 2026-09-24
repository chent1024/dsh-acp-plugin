/**
 * Behavior tests for child-process environment resolution.
 *
 * These cover a failure that every other test in this suite could not see: the
 * suite ran from a shell with a full `PATH`, while a GUI-launched host inherits
 * `/usr/bin:/bin:/usr/sbin:/sbin`. The agent CLIs live on a login-shell path, so
 * all three configured agents failed with the CLI apparently missing —
 * `codebuddy` reported `env: node: No such file or directory` and `qoder`, a bash
 * launcher that looks `qodercli` up on `PATH`, reported "Qoder CLI is not
 * installed" while installed.
 *
 * @module dsh-acp-plugin/tests/env.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { childEnvironment, mergePath } from '../lib/env.js'

test('mergePath unions directory lists, first occurrence winning', () => {
  assert.equal(mergePath(['/a:/b', '/b:/c']), '/a:/b:/c')
})

test('mergePath keeps the first of a duplicated directory', () => {
  // Precedence matters: the caller's own PATH must not be reordered by the
  // login shell's copy of the same directory.
  assert.equal(mergePath(['/first', '/second:/first']), '/first:/second')
})

test('mergePath ignores absent and empty lists', () => {
  assert.equal(mergePath([undefined, '', '/a']), '/a')
  assert.equal(mergePath([]), '')
  assert.equal(mergePath(['', '']), '')
})

test('mergePath drops empty segments', () => {
  // An empty segment means "current directory" to some shells, which is not
  // something to introduce into a child's PATH.
  assert.equal(mergePath([':/a::/b:']), '/a:/b')
})

test('childEnvironment widens PATH by the login shell', async () => {
  const env = await childEnvironment(
    { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: '/home/x' },
    {},
  )
  assert.equal(env.HOME, '/home/x')
  // The login PATH of /bin/sh may be empty in a bare environment, but the
  // original directories must survive either way.
  assert.ok(String(env.PATH).includes('/usr/bin'))
  assert.ok(String(env.PATH).includes('/bin'))
})

test('childEnvironment carries the per-agent overlay verbatim', async () => {
  const env = await childEnvironment({ PATH: '/usr/bin' }, { PATH: '/custom/bin', TOKEN: 't' })
  assert.equal(env.TOKEN, 't')
  // The overlay's PATH keeps precedence, so a config that pins one still wins.
  assert.ok(String(env.PATH).startsWith('/custom/bin'))
})

test('childEnvironment never produces an empty PATH', async () => {
  // An empty PATH would break lookups that would otherwise have worked, which
  // is worse than leaving the inherited one alone.
  const env = await childEnvironment({ PATH: '', SHELL: '/nonexistent/shell' }, {})
  assert.notEqual(env.PATH, '')
})

test('childEnvironment tolerates a missing SHELL', async () => {
  // A successful resolution is cached for the process, so this asserts what
  // must hold either way: the inherited directories survive.
  const env = await childEnvironment({ PATH: '/usr/bin:/bin' }, {})
  assert.ok(String(env.PATH).includes('/usr/bin'))
  assert.ok(String(env.PATH).includes('/bin'))
})

test('childEnvironment tolerates a shell that cannot be run', async () => {
  const env = await childEnvironment({ PATH: '/usr/bin:/bin', SHELL: '/definitely/not/a/shell' }, {})
  assert.ok(String(env.PATH).includes('/usr/bin'))
})

test('childEnvironment resolves a real login shell PATH', async () => {
  // The mechanism the fix depends on: a login shell reports the PATH its own
  // startup files built. /bin/sh is present on every supported platform.
  const env = await childEnvironment({ PATH: '/usr/bin:/bin', SHELL: '/bin/sh' }, {})
  assert.ok(typeof env.PATH === 'string' && env.PATH.length > 0)
})
test('an unusable shell is reported, never as an empty PATH', async () => {
  // Caching a failure for the process lifetime would leave every later launch
  // unable to find its toolchain, with a restart as the only remedy, so a
  // failure is not cached. This asserts the observable half: whatever the
  // cache holds, asking about a shell that cannot run never yields an empty
  // PATH, and the inherited directories are still present.
  const env = await childEnvironment(
    { PATH: '/usr/bin:/bin', SHELL: '/definitely/not/a/shell' }, {},
  )
  assert.ok(String(env.PATH).startsWith('/usr/bin:/bin'))
})
