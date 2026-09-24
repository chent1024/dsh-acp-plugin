/**
 * The `/api/acp-agents` panel route.
 *
 * An out-of-tree plugin cannot declare a typed Remote namespace: those faces are
 * generated at build time from packages inside the harness repository. The
 * supported way for a plugin to expose Host capability to the browser is to join
 * the Connection's authenticated `/api` channel, which inherits the Host/Origin
 * fence and the browser's own session authentication. That is what this route
 * does, and it is the single source of truth the Models page card reads and
 * writes.
 *
 * @module dsh-acp-plugin/panel/route
 */

/** The exact `/api` Fetch route this plugin owns. */
export const PANEL_PATH = '/api/acp-agents'

/** Stable failure code for every panel refusal. */
export const PANEL_ERROR_CODE = 'acp-agents/panel-rejected'

/**
 * Trim text to one line and a bounded length, so a diagnostic cannot carry a
 * multi-line stack or an unbounded payload into the browser.
 * @param {unknown} value - the value to describe.
 * @param {number} limit - maximum characters to keep.
 * @returns {string} the bounded single-line description.
 */
function firstLine(value, limit) {
  const text = value instanceof Error ? value.message : String(value ?? '')
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}

/**
 * Publish the panel route and dispatch its actions.
 *
 * Every action answers one JSON envelope: `{ ok: true, value }` or
 * `{ ok: false, error }`. A thrown action becomes a refusal rather than a 500,
 * so the card always has something to show.
 *
 * @param {any} ctx - the plugin context.
 * @param {object} actions - the Host operations the panel exposes.
 * @param {() => Record<string, any>} actions.readAgents - current agents.
 * @param {(agents: Record<string, any>) => Promise<void>} actions.writeAgents - persist agents.
 * @param {(key: string) => Promise<any>} actions.probe - interrogate one agent.
 * @param {any} [actions.logger] - optional logger.
 * @returns {void}
 */
export function registerPanel(ctx, actions) {
  const dispatch = async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case 'read':
          return { ok: true, value: { agents: actions.readAgents() } }
        case 'write':
          await actions.writeAgents(payload?.agents ?? {})
          return { ok: true, value: { agents: actions.readAgents() } }
        case 'probe':
          return { ok: true, value: await actions.probe(String(payload?.key ?? '')) }
        default:
          return {
            ok: false,
            error: { code: PANEL_ERROR_CODE, message: `unknown panel action ${JSON.stringify(String(endpoint))}`, details: {} },
          }
      }
    } catch (error) {
      return { ok: false, error: { code: PANEL_ERROR_CODE, message: firstLine(error, 400), details: {} } }
    }
  }

  ctx.inject(['connection'], (connectionCtx) => {
    const registered = connectionCtx.connection.fetch.register({
      path: PANEL_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          body = await request.json()
        } catch {
          return Response.json(
            { ok: false, error: { code: PANEL_ERROR_CODE, message: 'the request body is not JSON', details: {} } },
            { status: 400, headers: { 'cache-control': 'no-store' } },
          )
        }
        const result = await dispatch(String(body?.endpoint ?? ''), body?.payload)
        return Response.json(result, { headers: { 'cache-control': 'no-store' } })
      },
    })
    actions.logger?.info?.('[acp-agents] panel route %s published', PANEL_PATH)
    return registered
  })
}