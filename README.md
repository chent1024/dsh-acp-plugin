# dsh-acp-agents

English | [简体中文](README.zh.md)

Run external **ACP** (Agent Client Protocol) coding CLIs as DeepSeek Harness
model providers and subagents.

An ACP agent is a coding CLI that speaks a standard JSON-RPC protocol on stdio.
This plugin makes each configured agent available two ways:

- as a **model provider route** — `acp:<id>` appears in the composer's model
  picker and can be set as a session's default model, and
- as a **subagent provider** — an agent can delegate a task to it.

Agents are added and edited from **Settings → Models**, where the plugin adds an
*ACP agents* card. A saved agent is usable immediately, with no restart.

---

## Install

```sh
dsh plugin --profile <your-profile> add dsh-acp-agents
```

The bundle patch mounts the plugin with no agents configured. Supply them from
the Models page, or seed them in your profile's own patch
(`$DSH_HOME/profiles/<name>/cordis.patch.yml`), which is applied after every
bundle layer:

```yaml
- id: acp-agents
  config:
    agents:
      gemini:
        displayName: Gemini CLI
        command: npx
        args: ["-y", "@google/gemini-cli@latest", "--acp"]
      opencode:
        displayName: opencode
        command: opencode
        args: ["acp"]
```

---

## Configuration

Each agent is one entry under `agents`, keyed by an id you choose. The key
becomes the provider route `acp:<key>`, so `gemini` is selectable as
`acp:gemini`.

| Field | Default | Meaning |
|---|---|---|
| `displayName` | the key | Name shown in the provider directory and the Models page. |
| `command` | *required* | Executable to spawn. |
| `args` | `[]` | Arguments passed to it. |
| `env` | `{}` | Extra environment variables for the child. |
| `cwd` | the session workspace | Working directory for the child and its ACP session. |
| `permission` | `reject` | Permission policy. `allow` also selects the agent's auto-approving session mode, which is what stops the prompts in the first place; `reject` leaves the agent on its own prompting default and answers every request with reject. See [Permission](#permission). |
| `capabilities` | `none` | Client capabilities to advertise; `fs` offers scoped file reads and writes. |
| `showCredit` | `true` | Append the agent's disclosed credit multiplier to each model name, e.g. `Ultimate  [2x]` or `Qwen3.8-Flash  [FREE]`. See [Credit multipliers](#credit-multipliers). |
| `idleTimeoutMs` | `600000` | How long a bound session is kept before its process is released. |

`env` is merged **after** the subprocess seam strips credential-shaped variables
and every `DSH_*` name, so handing one CLI its own key does not leak your other
secrets into it.

### Known launch commands

Most ACP agents are distributed over `npx` or `uvx`, so `command: npx` works
without a global install.

| Agent | `command` | `args` |
|---|---|---|
| Gemini CLI | `npx` | `["-y", "@google/gemini-cli@latest", "--acp"]` |
| Claude Code | `npx` | `["-y", "@agentclientprotocol/claude-agent-acp@latest"]` |
| Codex | `npx` | `["-y", "@agentclientprotocol/codex-acp@latest"]` |
| Qwen Code | `npx` | `["-y", "@qwen-code/qwen-code@latest", "--acp"]` |
| opencode | `opencode` | `["acp"]` |
| Cursor | `cursor-agent` | `["acp"]` |
| Cline | `npx` | `["-y", "cline@latest", "--acp"]` |
| Goose | `goose` | `["acp"]` |
| GitHub Copilot | `npx` | `["-y", "@github/copilot@latest", "--acp"]` |

The authoritative list is the [ACP agent registry](https://agentclientprotocol.com/get-started/agents).
Package versions move; pin one you have verified if a floating `latest` breaks.

---

## Use

### As a model

Open the model picker in the composer and choose a model under the
`acp:<agent>` group. Each model is one the agent itself advertises through its
ACP session configuration, so the list is the agent's own — not a catalog this
plugin guesses.

Set it as a session's or the deployment's default model exactly as any other
route:

```yaml
- id: agent-default-model
  config:
    provider: acp:gemini
    model: gemini-2.5-pro
```

Whatever the agent exposes as a reasoning level appears as that model's
selectable effort.

### As a subagent

The plugin registers one subagent provider named `acp-agents`. Mount a
delegation tool over it (`dsh-tool-subagent`) and the model can hand work to a
configured agent. The provider refuses every start-time capability — tool
filters, personas, output schemas, agent options — because an out-of-process
child cannot honor them; a request needing one is rejected rather than silently
ignored.

---

## How a turn works

A request carries the whole conversation, while an ACP session remembers what it
was told. On the first request for a session the plugin starts the CLI, creates
an ACP session, and sends the conversation. On a follow-up it sends **only the
messages the agent has not seen**, which keeps the CLI's own memory and prompt
cache useful.

The optimization is only used while it is safe: before sending a delta the
plugin re-checks that the harness history still begins with the exact prefix the
agent received. After a compaction, a rewrite, or a model change it sends the
full history instead, rather than leaving the agent with a conversation it never
saw. A session's process is released after `idleTimeoutMs`; the next request
starts a fresh one.

---

## Requirements and limitations

**A working directory is required.** An ACP session is created with a `cwd`.
The plugin uses the agent's configured `cwd`, else the calling session's
workspace. A request with neither fails with a message naming the problem rather
than guessing a directory.

**Authentication is surfaced, not performed.** If an agent's `initialize`
response advertises authentication methods, the plugin reports
`ACP_AUTH_REQUIRED` as its own failure rather than letting it appear later as a
session error. Many agents expect to be logged in through their own CLI first;
do that once, outside the harness.

**Only text and tool-call annotations cross the wire.** ACP's prompt vocabulary
is narrower than the harness's. Images are not sent, and a tool call appears to
the agent as text. Nothing is silently dropped: anything without an ACP form
becomes a named placeholder.

**An agent's own tool calls are not executed by the harness.** The agent runs
its tools in its own process. Its tool-call updates are consumed but produce no
harness tool invocation, so the harness never shows them as executable calls.

## Credit multipliers

Agents disclose per-model cost as text in a model option's `description`, in two
notations: Qoder writes `Vision · 0.50x Credit` and CodeBuddy writes `x0.34
credits`. A zero multiplier means the model is free, and both Qoder and CodeBuddy
offer such models.

The harness model picker renders **only `name`** — `description` reaches it intact
and is deliberately never displayed, so this text is invisible there. Tagging is
on by default and appends the multiplier to each model name:

```
Ultimate         [2x]
Efficient        [0.3x]
Qwen3.8-Flash    [FREE]
```

Only the name changes. The model `id` is what a request carries, so tagging never
touches it, and a model whose agent discloses nothing keeps its name exactly as
sent — including every WorkBuddy model, which carries no descriptions at all.

There is no card control for this: the Models page does not offer a switch for a
behavior nobody needs to turn off. Edit `showCredit: false` in the profile's
`cordis.patch.yml` to disable it for one agent, for instance when the name also
appears somewhere a multiplier would read as noise.

Replacing the shipped picker to render a styled badge is possible — the
`conversation.input.model` seat accepts an occupant — but it means reproducing
that component's keyboard navigation, pane switching, and portal placement, and
maintaining it against product changes. Tagging the name achieves the same
visibility without shadowing shipped UI.

## Permission

`permission` is a policy, and ACP realizes permission through a session **mode**,
not through prompt-time answers alone. The distinction matters: an agent in a mode
that never asks cannot be governed by answering its questions, because it asks
none. Selecting the mode is what makes the policy real, so `allow` also chooses
the narrowest mode that stops the edit prompts — `acceptEdits` on Qoder and
CodeBuddy — leaving the agent's other checks intact rather than jumping to
`bypassPermissions` or `yolo`.

`reject` keeps the agent on its own prompting default. Selecting a refuse-only
mode would deny work the agent would otherwise raise for a decision, which is a
stronger claim than the policy makes.

An agent that offers no modes, or whose modes cannot be recognized, is left
alone: the policy then applies only to the requests it does make.

## Reasoning levels

Reasoning is a **per-model** capability, and agents disagree about how to expose
it. Qoder names it `reasoning_effort` under `category: "model"` and advertises it
only after a supporting model is selected — `auto` has no levels, `ultimate` has
six. CodeBuddy and WorkBuddy use the documented `thought_level` category. The
catalog probe therefore selects each model in turn and records the levels that
model actually reports, and the model picker shows each model's own set.

Levels are recorded during the probe and the session is returned to the model it
started on, so discovery never changes what a later turn would use.

**The `capabilities: fs` mode is a stub.** It advertises file read/write and
refuses both calls with `ACP_FS_UNAVAILABLE`. Advertising the capability without
serving it is deliberate: a conforming agent then takes a path it is told is
unsupported, instead of the plugin claiming support it does not have. Agents
that rely on client-side file access need `none` plus their own file tools.

**The Models page card sits at the bottom of the page, not on a provider row.**
A third-party settings namespace gets a row in the provider directory, but the
shipped provider editor renders a curated form only for its own two namespaces
and shows any other one a "edit `cordis.patch.yml`" hint with a disabled Apply.
This plugin therefore contributes its editor through the Models page's footer
seat, which needs no change to the shipped page. The row and the card are two
views of the same configuration; edit through the card.

**No MCP pass-through.** ACP can carry MCP servers into a session, which would
let an agent call harness tools. The harness has no MCP server face, so this
plugin sends an empty `mcpServers` list.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `no working directory for the ACP session` | Set `cwd` on the agent, or call it from a session with a workspace. |
| `ACP_AUTH_REQUIRED` | The agent needs a login. Run its CLI's own login once. |
| `ACP_PROCESS_START` / `ACP_PROCESS_EXIT` | The command is wrong, not executable, or exits at startup. Test it in a terminal first. |
| `ACP_PROTOCOL_VERSION` | The agent speaks a different ACP version than the client's (1). |
| The model list is empty | The agent started but advertises no model selector; it will run on its own default. |
| A saved agent does not appear | Use **Test connection** in the card to see the failure, which the provider directory also reports. |

---

## Development

```sh
npm install
npm test
```

The suite runs a **fake ACP agent** as a real child process over the real
protocol, and boots the plugin against the real `dsh-llm` service, so it covers
framing, handshake, session lifecycle, teardown, registration, and a full model
call. Tests that need the harness runtime resolve `@deepseek-ai/*` from a
DeepSeek Harness installation; see `tests/composition.test.js`.

## License

MIT
---

## Compatibility

The plugin requires `@deepseek-ai/schemastery` **3.18.3 or newer**. The
`.volatile()` schema modifier — which is what lets the Models page edit agents
while the profile stays mounted — was introduced in 3.18.3; 3.18.2 does not have
it, and a harness pinned to 3.18.2 cannot load this plugin. DeepSeek Harness
0.1.7-rc.1 ships 3.18.4.

Harness peers (`dsh-llm`, `dsh-settings`, `dsh-subagent`) are declared for
`>=0.1.5-alpha.1 <0.2.0`. They are resolved from the profile's own tree, not
installed by this package: a profile sets `autoInstallPeers: false`, so the
running harness supplies them.

`zod` is a direct dependency rather than a peer, and that is deliberate. The ACP
SDK imports `zod/v4`, but another plugin in the same profile may hoist an older
`zod` to the top of the profile tree — `dsh-plugin-product-subagents` pulls
`zod@3.23.0`, which has no `zod/v4` subpath. Because `autoInstallPeers: false`
stops pnpm from filling the SDK's own peer requirement, the SDK would then fail
to import and the whole plugin would fail to activate. Declaring `zod` here
makes the plugin carry a version the SDK can actually use.
