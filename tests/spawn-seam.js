/**
 * Test-only implementation of the `dsh-subprocess` seam's `spawn` contract.
 *
 * The plugin never imports `node:child_process` directly — it goes through the
 * seam so the product can confine, scrub, and own the process range. Tests need
 * the same handle shape without booting a harness, so this module reproduces the
 * exact contract: `stdin`/`stdout`/`stderr` streams, `done`, `terminate()`, and
 * `waitForExit(signal)`.
 *
 * @module dsh-acp-plugin/tests/spawn-seam
 */

import { spawn as nodeSpawn } from 'node:child_process'

/**
 * Spawn one child and expose it through the subprocess-seam handle contract.
 * @param {object} spec - the seam's spawn spec.
 * @param {readonly string[]} spec.argv - program and arguments; never shell-interpreted.
 * @param {string} spec.cwd - working directory.
 * @param {{ stdin: string, stdout: string, stderr: string }} spec.stdio - stream dispositions.
 * @param {Record<string, string>} [spec.env] - extra environment.
 * @returns {any} the handle.
 */
export function spawnThroughSeam(spec) {
  const [program, ...args] = spec.argv
  const child = nodeSpawn(program, args, {
    cwd: spec.cwd,
    // A scrubbed parent env plus the explicit overlay, matching the seam: an
    // explicit entry wins, and nothing else from the caller leaks implicitly.
    env: { ...process.env, ...spec.env },
  })
  let exited = false
  child.once('exit', () => { exited = true })
  // One settlement for both an `error` (the process never started) and a
  // `close` (it ran and ended). `error` is captured here rather than left to
  // Node's unhandled-event default, which would crash the test process.
  const outcome = new Promise((resolve, reject) => {
    child.once('error', (error) => { exited = true; reject(error) })
    child.once('close', (code, signal) => { exited = true; resolve({ exitCode: code, signal }) })
  })
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    control: undefined,
    collected: {},
    done: outcome,
    terminate() { child.kill('SIGKILL') },
    async waitForExit(signal) {
      if (exited) return true
      const settled = new Promise((resolve) => {
        // Both outcomes mean the range is gone; a launch failure is exit too.
        outcome.then(() => { resolve(true) }, () => { resolve(true) })
      })
      if (signal === undefined) return await settled
      const aborted = new Promise((resolve) => {
        if (signal.aborted) { resolve(false); return }
        signal.addEventListener('abort', () => { resolve(false) }, { once: true })
      })
      return await Promise.race([settled, aborted])
    },
  }
}

/**
 * The path to the fake ACP agent script, resolved from this module.
 * @returns {string} absolute script path.
 */
export function fakeAgentPath() {
  return new URL('./fake-agent.js', import.meta.url).pathname
}