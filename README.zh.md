# dsh-acp-agents

[English](README.md) | 简体中文

把外部 **ACP**（Agent Client Protocol）编程 CLI 接入 DeepSeek Harness，作为模型
provider 与子代理使用。

ACP agent 是一个在 stdio 上使用标准 JSON-RPC 协议的编程 CLI。本插件让每个配置好的
agent 有两种用法：

- 作为**模型 provider 路由** —— `acp:<id>` 出现在输入框的模型选择器里，可以设为会话的
  默认模型；
- 作为**子代理 provider** —— Harness 的 agent 可以把任务委派给它。

agent 在**设置 → 模型**中添加与编辑，本插件会在该页面底部增加一个 *ACP Agent* 卡片。
保存后立即可用，无需重启。

---

## 安装

```sh
dsh plugin --profile <你的 profile> add dsh-acp-agents
```

bundle patch 会以「零 agent」挂载插件。你可以在模型页面添加，也可以在自己的 profile
补丁（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）里预置 —— 该文件在所有 bundle
层之后应用：

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

## 配置

每个 agent 是 `agents` 下的一项，key 由你决定。key 会成为 provider 路由
`acp:<key>`，所以 `gemini` 在选择器里是 `acp:gemini`。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `displayName` | 等于 key | provider 列表与模型页面显示的名称。 |
| `command` | *必填* | 要拉起的可执行文件。 |
| `args` | `[]` | 传给它的参数。 |
| `env` | `{}` | 给子进程的额外环境变量。 |
| `cwd` | 会话工作区 | 子进程与它 ACP 会话的工作目录。 |
| `permission` | `reject` | 权限策略。`allow` 还会选择 agent 的自动批准会话模式 —— 真正让询问不再发生的是这个模式；`reject` 让 agent 保持自己的询问默认值，并对每次请求都回答拒绝。见[权限](#权限)。 |
| `capabilities` | `none` | 声明的客户端能力；`fs` 表示提供受限的文件读写。 |
| `idleTimeoutMs` | `600000` | 绑定的会话在释放进程前保留多久。 |

`env` 是在子进程缝**剥掉**形如凭据的变量与全部 `DSH_*` 变量**之后**合并的，所以把某个
CLI 自己的密钥交给它，不会把你其余的密钥一并泄进去。

### 已知启动命令

多数 ACP agent 通过 `npx` 或 `uvx` 分发，因此 `command: npx` 无需全局安装。

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

权威清单见 [ACP agent registry](https://agentclientprotocol.com/get-started/agents)。
包版本会变；若浮动的 `latest` 出问题，请固定到你验证过的版本。

---

## 使用

### 作为模型

在输入框的模型选择器里，选 `acp:<agent>` 分组下的模型。每个模型都是 agent 通过自己的
ACP 会话配置宣告的，因此这个列表来自 agent 本身，而不是本插件的猜测。

把它设为会话或部署的默认模型，与任何其他路由一样：

```yaml
- id: agent-default-model
  config:
    provider: acp:gemini
    model: gemini-2.5-pro
```

agent 暴露的推理档位会成为该模型可选的努力级别。

### 作为子代理

本插件注册一个名为 `acp-agents` 的子代理 provider。在上面挂一个委派工具
（`dsh-tool-subagent`），模型就能把工作交给配置好的 agent。该 provider 拒绝所有启动期
能力 —— 工具过滤、人设、输出 schema、agent 选项 —— 因为进程外的子代理无法兑现它们；
需要这些能力的请求会被拒绝，而不是被静默忽略。

---

## 一轮请求是如何进行的

请求携带完整对话，而 ACP 会话记得它被告知过什么。会话的第一次请求会拉起 CLI、创建
ACP 会话并发送整段对话；后续请求**只发送 agent 还没见过的消息**，这让 CLI 自身的记忆
与 prompt 缓存继续有用。

这个优化只在安全时使用：发送增量之前，插件会重新核对 Harness 历史是否仍以 agent 收到的
那个前缀开头。发生压缩、改写或换模型之后，它会改为发送完整历史，而不是让 agent 拿着
一段它从未见过的对话。会话进程在 `idleTimeoutMs` 后被释放；下一次请求重新建立一个。

---

## 要求与限制

**必须能确定工作目录。** ACP 会话创建时要带 `cwd`。插件使用 agent 配置的 `cwd`，否则
用调用会话的工作区。两者都没有时，会以明确指出问题的错误失败，而不是猜一个目录。

**认证是被暴露出来的，不是被代办的。** 若 agent 在 `initialize` 响应里宣告了认证方式，
插件会把 `ACP_AUTH_REQUIRED` 作为独立的失败报出来，而不是让它稍后伪装成会话错误。很多
agent 期望你先用它自己的 CLI 登录一次，请在 Harness 之外完成。

**只有文本与工具调用注记会过线。** ACP 的 prompt 词汇比 Harness 窄。图片不会发送，
工具调用以文本形式呈现给 agent。没有任何内容被静默丢弃：凡是 ACP 无法表达的内容都会变成
带名字的占位符。

**agent 自己的工具调用不由 Harness 执行。** agent 在自己的进程里运行它的工具。它的工具
调用更新会被消费，但不产生 Harness 的工具调用，所以 Harness 不会把它们显示为可执行的
调用。

## 权限

`permission` 是策略，而 ACP 通过会话**模式**（mode）实现权限，不只是靠回答询问。
这个区别很关键：一个从不询问的模式，无法通过回答它的提问来约束 —— 因为它根本不问。
选择模式才是让策略真正生效的方式，因此 `allow` 还会挑选「最窄的、能停掉编辑询问」的模式
（Qoder 和 CodeBuddy 上是 `acceptEdits`），保留 agent 其余检查，而不是直接跳到
`bypassPermissions` 或 `yolo`。

`reject` 让 agent 保持自己的询问默认值。选择一个「只拒绝」的模式，会拒绝那些
agent 本会提请你决定的工作 —— 这比策略本身的主张更强。

若 agent 没有提供模式，或其模式无法识别，则保持不动：此时策略只作用于它确实发出的请求。

## 思考等级

思考等级是**按模型**的能力，而各 agent 对它的暴露方式并不一致。Qoder 把它命名为
`reasoning_effort`，挂在 `category: "model"` 下，且只在选定支持它的模型后才宣告 ——
`auto` 没有档位，`ultimate` 有六档。CodeBuddy 与 WorkBuddy 使用文档规定的
`thought_level` 类别。因此目录探测会逐个选择模型，记录该模型真正上报的档位，
模型选择器也显示每个模型自己的那一组。

档位在探测期间记录，随后会话会切回它原本的模型，因此探测不会改变后续轮次使用的模型。

**`capabilities: fs` 目前是占位实现。** 它宣告文件读写，并以 `ACP_FS_UNAVAILABLE` 拒绝
两种调用。宣告能力却不提供服务是刻意的：合规的 agent 会走一条被告知「不支持」的路径，
而不是让插件谎称支持它并不具备的能力。依赖客户端文件访问的 agent 请用 `none`，并依靠
它自己的文件工具。

**模型页面的卡片位于页面底部，而不是某一行 provider 上。** 第三方设置命名空间会在
provider 目录里得到一行，但产品自带的编辑器只为它自己的两个命名空间渲染定制表单，对其他
命名空间只显示一句「请直接编辑 `cordis.patch.yml`」的提示，且 Apply 永久禁用。因此本插件
通过模型页面的 footer 槽位贡献自己的编辑器 —— 这不需要改动产品页面。那一行和这张卡片是
同一份配置的两个视图；请通过卡片编辑。

**没有 MCP 透传。** ACP 可以把 MCP server 带进会话，从而让 agent 调用 Harness 的工具。
但 Harness 没有 MCP server 面，所以本插件发送空的 `mcpServers` 列表。

---

## 排查

| 现象 | 原因 |
|---|---|
| `no working directory for the ACP session` | 给该 agent 设置 `cwd`，或从有工作区的会话调用它。 |
| `ACP_AUTH_REQUIRED` | 该 agent 需要登录。先运行它自己的登录命令一次。 |
| `ACP_PROCESS_START` / `ACP_PROCESS_EXIT` | 命令写错、不可执行，或启动即退出。先在终端里试一下。 |
| `ACP_PROTOCOL_VERSION` | 该 agent 说的 ACP 版本与客户端（1）不同。 |
| 模型列表为空 | agent 启动了但没有宣告模型选择器；它会用自己的默认模型运行。 |
| 保存的 agent 没出现 | 在卡片里点**测试连接**查看失败原因；provider 目录也会报告它。 |

---

## 开发

```sh
npm install
npm test
```

测试套件会把一个**假 ACP agent** 作为真实子进程、走真实协议跑起来，并把插件挂到真实的
`dsh-llm` 服务上，因此覆盖了分帧、握手、会话生命周期、teardown、注册，以及一次完整的
模型调用。需要 Harness 运行时的测试会从一份 DeepSeek Harness 安装里解析
`@deepseek-ai/*`；见 `tests/composition.test.js`。

## 许可证

MIT
---

## 兼容性

本插件要求 `@deepseek-ai/schemastery` **3.18.3 或更高**。让模型页面能在 profile
保持挂载的情况下编辑 agent 的 `.volatile()` schema 修饰符是在 3.18.3 引入的；3.18.2
没有它，钉在 3.18.2 的 Harness 无法加载本插件。DeepSeek Harness 0.1.7-rc.1 自带
3.18.4。

Harness 侧 peer（`dsh-llm`、`dsh-settings`、`dsh-subagent`）声明为
`>=0.1.5-alpha.1 <0.2.0`。它们由 profile 自己的依赖树提供，而不是由本包安装：profile
设置了 `autoInstallPeers: false`，因此运行中的 Harness 会提供它们。

`zod` 被声明为直接依赖而非 peer，这是刻意的。ACP SDK 内部 `import "zod/v4"`，但同一
profile 里的其他插件可能把较旧的 `zod` 提升到 profile 树顶层 ——
`dsh-plugin-product-subagents` 会带入 `zod@3.23.0`，它没有 `zod/v4` 子路径。由于
`autoInstallPeers: false` 使 pnpm 不去补足 SDK 自己的 peer 要求，SDK 就会导入失败，
整个插件随之无法激活。在这里声明 `zod` 让插件自带一个 SDK 真正能用的版本。
