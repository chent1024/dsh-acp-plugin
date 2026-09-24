/**
 * dsh-acp-agents — browser half.
 *
 * A hand-written dsh client bundle: the module system loads it with
 * `window.__ModuleLoader__.load`, and the Cordis Loader treats the returned
 * exports as an ordinary plugin (`apply` + `inject`). Plain CJS with no build
 * step, so `require` reaches only the shell's platform seed table — here, only
 * `react`.
 *
 * It adds one card to the bottom of the Models settings page. The card is the
 * ACP agents editor: add an agent, edit its command/args/env, test that it
 * starts, and read back the models it offers. Every read and write goes to the
 * authenticated `/api/acp-agents` route published by the Host half, so the card
 * and the Host share one source of truth.
 *
 * The card lives in the Models page's footer seat rather than in a provider row
 * because the provider editor is a closed set: the shipped page renders a
 * curated editor only for its own two namespaces and shows a third-party
 * namespace a "edit cordis.patch.yml" hint with a disabled Apply.
 *
 * @module dsh-acp-agents/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-acp-agents',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Locale namespace this card owns. */
    const NS = 'acp-agents'
    /** Exact `/api` Fetch route the Host half publishes. */
    const PANEL_PATH = '/api/acp-agents'
    /** Agent keys must be usable in a provider route and a credential name. */
    const KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

    /** Copy for both shipped locales. */
    const COPY = {
      zh: {
        title: 'ACP Agent',
        intro: '把外部 ACP CLI（Gemini、Claude Code、Codex、Qwen、opencode…）接入为模型 provider 与子代理。保存后立即可在模型选择器中使用。',
        empty: '还没有配置任何 ACP Agent。',
        add: '添加 Agent',
        remove: '删除',
        edit: '编辑',
        close: '收起',
        key: 'Agent ID',
        keyHint: '小写字母、数字与连字符，例如 gemini',
        displayName: '显示名称',
        command: '可执行文件',
        commandHint: '例如 npx、gemini、opencode',
        args: '参数',
        argsHint: '每行一个参数，例如 -y 与 @google/gemini-cli@latest 与 --acp',
        env: '环境变量',
        envHint: '每行一个 KEY=VALUE，用于把该 CLI 自己的密钥传给子进程',
        cwd: '工作目录',
        cwdHint: '留空则使用会话的工作区',
        permission: '权限策略',
        permissionReject: '拒绝（无人值守，默认）',
        permissionAllow: '允许一次',
        capabilities: '客户端能力',
        capabilitiesNone: '不声明（最保守）',
        capabilitiesFs: '文件读写',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        cancel: '取消',
        test: '测试连接',
        testing: '连接中…',
        testOk: '连接成功',
        testFail: '连接失败',
        models: '可用模型',
        saveFailed: '保存失败',
        loadFailed: '读取配置失败',
        keyRequired: '请填写 Agent ID',
        keyInvalid: 'Agent ID 只能用小写字母、数字与连字符，且以字母开头',
        keyTaken: '该 Agent ID 已存在',
        commandRequired: '请填写可执行文件',
      },
      en: {
        title: 'ACP agents',
        intro: 'Run external ACP CLIs (Gemini, Claude Code, Codex, Qwen, opencode, …) as model providers and as subagents. A saved agent is immediately selectable in the model picker.',
        empty: 'No ACP agent is configured yet.',
        add: 'Add agent',
        remove: 'Remove',
        edit: 'Edit',
        close: 'Close',
        key: 'Agent ID',
        keyHint: 'Lowercase letters, digits, and hyphens, e.g. gemini',
        displayName: 'Display name',
        command: 'Executable',
        commandHint: 'e.g. npx, gemini, opencode',
        args: 'Arguments',
        argsHint: 'One per line, e.g. -y, @google/gemini-cli@latest, --acp',
        env: 'Environment',
        envHint: 'One KEY=VALUE per line, to hand this CLI its own key',
        cwd: 'Working directory',
        cwdHint: 'Empty uses the session workspace',
        permission: 'Permission policy',
        permissionReject: 'Reject (unattended, default)',
        permissionAllow: 'Allow once',
        capabilities: 'Client capabilities',
        capabilitiesNone: 'Advertise none (most conservative)',
        capabilitiesFs: 'File read/write',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        cancel: 'Cancel',
        test: 'Test connection',
        testing: 'Connecting…',
        testOk: 'Connected',
        testFail: 'Connection failed',
        models: 'Available models',
        saveFailed: 'Save failed',
        loadFailed: 'Could not read the configuration',
        keyRequired: 'An agent ID is required',
        keyInvalid: 'An agent ID uses lowercase letters, digits, and hyphens, and starts with a letter',
        keyTaken: 'That agent ID already exists',
        commandRequired: 'An executable is required',
      },
    }

    /** Styles scoped to this card, using only shared theme tokens. */
    const CSS = [
      '.acpa{display:flex;flex-direction:column;gap:12px;margin-top:18px;color:var(--dsw-alias-label-primary);font-size:13px}',
      '.acpa-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
      '.acpa-title{margin:0;font-size:15px;font-weight:600}',
      '.acpa-intro{margin:0;color:var(--dsw-alias-label-tertiary);line-height:18px}',
      '.acpa-list{display:flex;flex-direction:column;gap:8px}',
      '.acpa-card{border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px}',
      '.acpa-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.acpa-grow{flex:1;min-width:140px}',
      '.acpa-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.acpa-name{font-weight:600}',
      '.acpa-field{display:flex;flex-direction:column;gap:4px}',
      '.acpa-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.acpa-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.acpa-input,.acpa-textarea,.acpa-select{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;font-size:13px;min-width:0;box-sizing:border-box;width:100%}',
      '.acpa-textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;resize:vertical;min-height:56px}',
      '.acpa-input:focus-visible,.acpa-textarea:focus-visible,.acpa-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.acpa-btn{border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer}',
      '.acpa-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}',
      '.acpa-btn:disabled{opacity:.5;cursor:default}',
      '.acpa-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600}',
      '.acpa-btn-danger{color:var(--dsw-alias-state-error-primary)}',
      '.acpa-msg{border-radius:6px;padding:6px 8px;font-size:12px;line-height:17px;white-space:pre-wrap;word-break:break-word}',
      '.acpa-msg-ok{background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-bg-base)}',
      '.acpa-msg-err{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}',
      '.acpa-chips{display:flex;flex-wrap:wrap;gap:6px}',
      '.acpa-chip{border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 8px;font-size:12px}',
    ].join('')

    const CSS_TAG = '@deepseek-ai/dsh-acp-agents/client.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-acp-agents'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * Call one panel action.
     * @param {string} endpoint - action name.
     * @param {any} [payload] - its payload.
     * @returns {Promise<any>} the envelope's value.
     */
    async function call(endpoint, payload) {
      const response = await fetch(PANEL_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, payload }),
      })
      if (!response.ok) throw new Error(`panel HTTP ${response.status}`)
      const body = await response.json()
      if (body?.ok !== true) throw new Error(body?.error?.message ?? 'the panel refused the request')
      return body.value
    }

    /** Split a textarea into lines, keeping empty lines out of the result. */
    function lines(text) {
      return String(text ?? '').split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
    }

    /** Render an environment textarea value back from a record. */
    function envText(env) {
      return Object.entries(env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n')
    }

    /** Parse a KEY=VALUE textarea, rejecting a line that names no key. */
    function parseEnv(text) {
      const env = {}
      for (const line of lines(text)) {
        const at = line.indexOf('=')
        if (at <= 0) throw new Error(`not a KEY=VALUE line: ${JSON.stringify(line)}`)
        env[line.slice(0, at).trim()] = line.slice(at + 1)
      }
      return env
    }

    /**
     * The ACP agents card.
     * @param {any} props - slot props, plus this plugin's injected face.
     * @returns {any} the rendered card.
     */
    function AcpAgentsCard(props) {
      const t = props.t
      const [agents, setAgents] = React.useState(null)
      const [editing, setEditing] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const refresh = React.useCallback(async () => {
        try {
          const value = await call('read')
          setAgents(value.agents ?? {})
          setFailure(null)
        } catch (error) {
          setFailure(`${t('loadFailed')}: ${error.message}`)
        }
      }, [t])

      React.useEffect(() => { void refresh() }, [refresh])

      const save = async (next) => {
        setBusy(true)
        setStatus(null)
        try {
          const value = await call('write', { agents: next })
          setAgents(value.agents ?? {})
          setFailure(null)
          setStatus(t('saved'))
          setEditing(null)
        } catch (error) {
          setFailure(`${t('saveFailed')}: ${error.message}`)
        } finally {
          setBusy(false)
        }
      }

      const test = async (key) => {
        setBusy(true)
        setStatus(null)
        try {
          const value = await call('probe', { key })
          const models = (value.models ?? []).map((model) => model.name || model.id)
          setStatus(`${t('testOk')}: ${models.length > 0 ? models.join(', ') : t('models') + ': —'}`)
          setFailure(null)
        } catch (error) {
          setFailure(`${t('testFail')}: ${error.message}`)
        } finally {
          setBusy(false)
        }
      }

      if (agents === null) {
        return h('div', { className: 'acpa' }, h('p', { className: 'acpa-intro' }, failure ?? '…'))
      }

      const keys = Object.keys(agents).sort()
      const rows = keys.map((key) => {
        const agent = agents[key]
        return h('div', { className: 'acpa-card', key },
          h('div', { className: 'acpa-row' },
            h('span', { className: 'acpa-name' }, agent.displayName || key),
            h('span', { className: 'acpa-id' }, key),
            h('span', { className: 'acpa-grow' }),
            h('button', {
              type: 'button', className: 'acpa-btn', disabled: busy,
              onClick: () => { setStatus(null); setEditing(editing === key ? null : key) },
            }, editing === key ? t('close') : t('edit')),
            h('button', {
              type: 'button', className: 'acpa-btn', disabled: busy,
              onClick: () => { void test(key) },
            }, busy ? t('testing') : t('test')),
            h('button', {
              type: 'button', className: 'acpa-btn acpa-btn-danger', disabled: busy,
              onClick: () => {
                const next = { ...agents }
                delete next[key]
                void save(next)
              },
            }, t('remove')),
          ),
          h('div', { className: 'acpa-id' }, `${agent.command || ''} ${(agent.args ?? []).join(' ')}`.trim()),
          editing === key
            ? h(AgentForm, {
              t, busy, agent, existingKeys: keys, keyLocked: true, agentKey: key,
              onCancel: () => { setEditing(null) },
              // AgentForm reports `{ key, agent }` because a NEW agent needs both.
              // Editing must store only the agent: spreading the envelope wrote
              // `key` and a nested `agent` into the definition itself.
              onSubmit: (draft) => { void save({ ...agents, [draft.key]: draft.agent }) },
            })
            : null,
        )
      })

      return h('div', { className: 'acpa' },
        h('div', { className: 'acpa-head' },
          h('h3', { className: 'acpa-title' }, t('title')),
          h('span', { className: 'acpa-grow' }),
          h('button', {
            type: 'button', className: 'acpa-btn acpa-btn-primary',
            disabled: busy || editing === '',
            onClick: () => { setStatus(null); setEditing(editing === '' ? null : '') },
          }, editing === '' ? t('close') : t('add')),
        ),
        h('p', { className: 'acpa-intro' }, t('intro')),
        failure === null ? null : h('p', { className: 'acpa-msg acpa-msg-err', role: 'alert' }, failure),
        status === null ? null : h('p', { className: 'acpa-msg acpa-msg-ok', role: 'status' }, status),
        keys.length === 0 ? h('p', { className: 'acpa-intro' }, t('empty')) : h('div', { className: 'acpa-list' }, rows),
        editing === ''
          ? h(AgentForm, {
            t, busy, existingKeys: keys, keyLocked: false,
            onCancel: () => { setEditing(null) },
            onSubmit: (draft) => { void save({ ...agents, [draft.key]: draft.agent }) },
          })
          : null,
      )
    }

    /**
     * The add/edit form for one agent.
     * @param {any} props - the form props.
     * @returns {any} the rendered form.
     */
    function AgentForm(props) {
      const t = props.t
      const source = props.agent ?? {}
      const [key, setKey] = React.useState(props.agentKey ?? '')
      const [displayName, setDisplayName] = React.useState(source.displayName ?? '')
      const [command, setCommand] = React.useState(source.command ?? '')
      const [args, setArgs] = React.useState((source.args ?? []).join('\n'))
      const [env, setEnv] = React.useState(envText(source.env))
      const [cwd, setCwd] = React.useState(source.cwd ?? '')
      const [permission, setPermission] = React.useState(source.permission ?? 'reject')
      const [capabilities, setCapabilities] = React.useState(source.capabilities ?? 'none')
      const [error, setError] = React.useState(null)

      const submit = () => {
        if (props.keyLocked !== true) {
          if (key.length === 0) { setError(t('keyRequired')); return }
          if (!KEY_PATTERN.test(key)) { setError(t('keyInvalid')); return }
          if (props.existingKeys.includes(key)) { setError(t('keyTaken')); return }
        }
        if (command.trim().length === 0) { setError(t('commandRequired')); return }
        let parsedEnv
        try {
          parsedEnv = parseEnv(env)
        } catch (parseFailure) {
          setError(parseFailure.message)
          return
        }
        setError(null)
        props.onSubmit({
          key: props.agentKey ?? key,
          agent: {
            displayName: displayName.trim() || (props.agentKey ?? key),
            command: command.trim(),
            args: lines(args),
            env: parsedEnv,
            ...cwd.trim().length === 0 ? {} : { cwd: cwd.trim() },
            permission,
            capabilities,
          },
        })
      }

      const field = (label, hint, control) => h('div', { className: 'acpa-field' },
        h('span', { className: 'acpa-label' }, label),
        control,
        hint === null ? null : h('span', { className: 'acpa-hint' }, hint),
      )

      return h('div', { className: 'acpa-card' },
        error === null ? null : h('p', { className: 'acpa-msg acpa-msg-err', role: 'alert' }, error),
        props.keyLocked === true
          ? null
          : field(t('key'), t('keyHint'), h('input', {
            className: 'acpa-input', type: 'text', value: key,
            onChange: (event) => { setKey(event.target.value) },
          })),
        field(t('displayName'), null, h('input', {
          className: 'acpa-input', type: 'text', value: displayName,
          onChange: (event) => { setDisplayName(event.target.value) },
        })),
        field(t('command'), t('commandHint'), h('input', {
          className: 'acpa-input', type: 'text', value: command,
          onChange: (event) => { setCommand(event.target.value) },
        })),
        field(t('args'), t('argsHint'), h('textarea', {
          className: 'acpa-textarea', value: args, rows: 3,
          onChange: (event) => { setArgs(event.target.value) },
        })),
        field(t('env'), t('envHint'), h('textarea', {
          className: 'acpa-textarea', value: env, rows: 2,
          onChange: (event) => { setEnv(event.target.value) },
        })),
        field(t('cwd'), t('cwdHint'), h('input', {
          className: 'acpa-input', type: 'text', value: cwd,
          onChange: (event) => { setCwd(event.target.value) },
        })),
        field(t('permission'), null, h('select', {
          className: 'acpa-select', value: permission,
          onChange: (event) => { setPermission(event.target.value) },
        },
          h('option', { value: 'reject' }, t('permissionReject')),
          h('option', { value: 'allow' }, t('permissionAllow')),
        )),
        field(t('capabilities'), null, h('select', {
          className: 'acpa-select', value: capabilities,
          onChange: (event) => { setCapabilities(event.target.value) },
        },
          h('option', { value: 'none' }, t('capabilitiesNone')),
          h('option', { value: 'fs' }, t('capabilitiesFs')),
        )),
        h('div', { className: 'acpa-row' },
          h('span', { className: 'acpa-grow' }),
          h('button', {
            type: 'button', className: 'acpa-btn', disabled: props.busy,
            onClick: props.onCancel,
          }, t('cancel')),
          h('button', {
            type: 'button', className: 'acpa-btn acpa-btn-primary', disabled: props.busy,
            onClick: submit,
          }, props.busy ? t('saving') : t('save')),
        ),
      )
    }

    /** Required services: the slot ledger and the locale registry. */
    const inject = ['slots', 'locale']

    /**
     * Register the ACP agents card on the Models page footer, plus its copy.
     * @param {any} ctx - the client root context.
     * @returns {void}
     */
    function apply(ctx) {
      // One registration carries both dictionaries and yields one disposer.
      ctx.effect(() => ctx.locale.register(NS, { zh: COPY.zh, en: COPY.en }), 'acp-agents: copy dictionaries')

      /**
       * Resolve one copy key.
       *
       * The shared registry is preferred, but a namespace lookup that resolves
       * nothing echoes the key back rather than throwing, so a result equal to
       * the key falls through to this bundle's own dictionary. That keeps the
       * card readable even if the registry is not installed yet.
       */
      const translate = (key) => {
        const locale = ctx.get('locale')
        if (locale !== undefined) {
          try {
            const translated = locale.bind(NS)(key)
            if (typeof translated === 'string' && translated !== key) return translated
          } catch { /* fall through to the bundled dictionary */ }
        }
        return COPY.zh[key] ?? COPY.en[key] ?? key
      }

      // The footer seat is a list with empty owner props, so this card owns its
      // own chrome and reads its own data. Registering against the Models page
      // does not require editing it.
      //
      // No `locale` option is declared: that would make the framework synthesize
      // its own `t` seat, which would collide with the one injected here. The
      // dictionary is still registered above, so the binding resolves.
      ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
        name: 'settings.models.footer',
        id: 'acp-agents',
        order: 50,
        inject: () => ({ t: translate }),
      }, AcpAgentsCard))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})