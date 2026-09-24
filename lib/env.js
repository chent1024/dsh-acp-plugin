/**
 * Child-process environment resolution for external agent CLIs.
 *
 * A GUI-launched host inherits a minimal `PATH` — the running application has
 * `/usr/bin:/bin:/usr/sbin:/sbin` — while the agent CLIs a user installs live on
 * a login-shell path such as `/opt/homebrew/bin`. Every configured agent in the
 * profile failed from this: `codebuddy` is a `#!/usr/bin/env node` script and
 * reported `env: node: No such file or directory`, and `qoder` is a bash
 * launcher that looks up `qodercli` on `PATH` and reported "Qoder CLI is not
 * installed" even though it was installed.
 *
 * Neither the harness nor this plugin can know where a given user's toolchain
 * lives, and both `PATH` and the login-shell convention are platform- and
 * user-specific, so the directory list is resolved rather than hardcoded. The
 * resolved value is cached for the process: a login shell is expensive to start
 * and its `PATH` does not change while an agent session is open.
 *
 * @module dsh-acp-plugin/env
 */

import { execFile } from 'node:child_process'

/** How long a login shell may take to report its PATH. */
const SHELL_PROBE_TIMEOUT_MS = 5_000

/** The login shell's PATH, once resolved; `undefined` until then, `null` when unusable. */
let loginPath

/**
 * Read `PATH` from the user's login shell.
 *
 * `-l` makes the shell read its login files, which is where a package manager
 * adds its bin directory. `-i` is deliberately omitted: an interactive shell can
 * block on a prompt or print banners into the output, and the login files are
 * what carry the PATH.
 *
 * @param {NodeJS.ProcessEnv} env - the environment to read `SHELL` from.
 * @returns {Promise<string | undefined>} the shell's PATH, or undefined when it cannot be read.
 */
async function readLoginPath(env) {
  const shell = env.SHELL
  if (typeof shell !== 'string' || shell.length === 0) return undefined
  return await new Promise((resolve) => {
    execFile(shell, ['-l', '-c', 'printf %s "$PATH"'], {
      timeout: SHELL_PROBE_TIMEOUT_MS,
      // No stdin: a shell that reads it would otherwise wait on a terminal that
      // is not there.
      windowsHide: true,
      env,
    }, (error, stdout) => {
      if (error) return resolve(undefined)
      const path = String(stdout).trim()
      resolve(path.length === 0 ? undefined : path)
    })
  })
}

/**
 * Resolve the login shell's `PATH`, caching only a successful result.
 *
 * A failure is deliberately NOT cached. The probe can fail transiently — a
 * loaded machine exceeding the deadline, a shell whose startup file is briefly
 * unreadable — and caching that for the process lifetime would leave every later
 * agent launch unable to find its toolchain, with a restart as the only remedy.
 * Retrying costs one shell start per launch until it succeeds.
 *
 * @param {NodeJS.ProcessEnv} env - the environment to read `SHELL` from.
 * @returns {Promise<string | undefined>} the resolved PATH, or undefined when none is available.
 */
export async function resolveLoginPath(env = process.env) {
  if (loginPath !== undefined && loginPath !== null) return loginPath
  const resolved = await readLoginPath(env)
  if (resolved !== undefined) loginPath = resolved
  return resolved
}

/**
 * Merge directory lists into one `PATH`, first occurrence winning.
 * @param {readonly (string | undefined)[]} lists - the lists, most significant first.
 * @returns {string} the merged `PATH`.
 */
export function mergePath(lists) {
  const seen = new Set()
  const entries = []
  for (const list of lists) {
    if (typeof list !== 'string' || list.length === 0) continue
    for (const dir of list.split(':')) {
      if (dir.length === 0 || seen.has(dir)) continue
      seen.add(dir)
      entries.push(dir)
    }
  }
  return entries.join(':')
}

/**
 * Build the environment for one agent child process.
 *
 * The child receives the calling process's environment with its `PATH` widened
 * by the login shell's directories. Widening rather than replacing keeps a
 * caller that deliberately narrowed `PATH` — a per-agent `env.PATH` in config,
 * for instance — in control of precedence, while still reaching the toolchain
 * that the login shell knows about.
 *
 * @param {NodeJS.ProcessEnv} base - the environment the child would otherwise get.
 * @param {Record<string, string>} [overlay] - per-agent entries, which win outright.
 * @returns {Promise<NodeJS.ProcessEnv>} the environment to spawn with.
 */
export async function childEnvironment(base = process.env, overlay = {}) {
  const login = await resolveLoginPath(base)
  const path = mergePath([overlay.PATH, base.PATH, login])
  return {
    ...base,
    ...overlay,
    // Only replace PATH when the merge produced something; an environment with
    // no PATH at all is better than an empty one, which would break lookups
    // that would otherwise have worked.
    ...path.length === 0 ? {} : { PATH: path },
  }
}