# lmstudio-workers

Claude Code plugin that turns a local [LM Studio](https://lmstudio.ai) model
into a worker pool. Claude stays the orchestrator — holding the tools, the
files and the judgment — and hands off bulk mechanical sub-tasks to your own
hardware instead of spending context or spawning cloud subagents.

## Why not just add LM Studio as an MCP server?

You can't. `http://localhost:1234/v1` is LM Studio's **OpenAI-compatible REST
API**; it does not speak MCP JSON-RPC, and LM Studio ships no MCP endpoint
(it is an MCP *host*, configured via its own `mcp.json`). `claude mcp add
--transport http … http://localhost:1234/v1` will always fail to connect.
This plugin is the missing adapter: a tiny MCP server that translates
`tools/call` into `/v1/chat/completions`.

## Requirements

- Python 3.9+ on `PATH` as `python3` (stdlib only — nothing to install)
- LM Studio with its local server running (`lms server start`)
- At least one **instruct/chat** model downloaded. Embedding models cannot run
  worker tasks.

## Install

Per machine, from the `jarvis` marketplace:

```
/plugin marketplace add Dstedema/claude-skills
/plugin install lmstudio-workers@jarvis
```

Verify:

```bash
claude mcp list          # expect: lmstudio-workers ✔ Connected
```

Then ask Claude to run `worker_models` — it reports whether LM Studio is
reachable and which model the workers will use.

> If you also copied this plugin into `~/.claude/skills/`, remove that copy after
> installing from the marketplace — two copies register two MCP servers under the
> same name.

## Tools

| Tool | Use |
| --- | --- |
| `worker_models` | Health + inventory: which models exist, their type, which is loaded, which workers would use, whether permission prompts are available. Call first when something fails. |
| `worker_run` | One scoped sub-task. Text in, text out, no tools. |
| `worker_batch` | Fan many sub-tasks out in parallel — the main throughput win. Per-item failures reported, never fatal. |
| `worker_agent` | The local model drives its **own tool loop**: read/list/grep freely, plus write/edit/shell behind a permission prompt. |

### worker_agent and permissions

`worker_agent` gives the local model real tools so Claude doesn't have to pipe
content in by hand. Two guarantees:

- **Sandbox.** `root` is required and set per call by the orchestrator. Paths are
  resolved through `realpath`; `../`, absolute paths and symlink escapes are
  refused.
- **Approval.** `write_file`, `edit_file` and `shell` each raise an MCP
  `elicitation/create` prompt — *allow once* / *allow for this session* / *deny*.
  A denial is final: the worker is told to stop rather than route around it. If
  the MCP client offers no elicitation capability, mutating tools **fail closed**.

Every call returns an audit trail of the tool calls and approval decisions.

```
[worker_agent: google/gemma-4-31b-qat | 2 step(s) | completed]

--- tool calls ---
  ok     write_file  {"content": "hi", "path": "hello.txt"}  (approved once)

--- worker report ---
Created hello.txt in the root directory with the content "hi".
```

## Configuration

Environment variables only — no absolute paths are baked into the plugin, which
uses `${CLAUDE_PLUGIN_ROOT}` to locate its own server.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LMSTUDIO_BASE_URL` | `http://localhost:1234` | Point at a remote LM Studio host |
| `LMSTUDIO_WORKER_MODEL` | auto-detect loaded model | Pin one model id |
| `LMSTUDIO_MAX_CONCURRENCY` | `4` | Parallel workers in `worker_batch` |
| `LMSTUDIO_TIMEOUT` | `600` | Per-request seconds |
| `LMSTUDIO_TTL` | `1800` | Keep-loaded seconds for JIT models |
| `LMSTUDIO_AGENT_MAX_STEPS` | `12` | Default `worker_agent` tool-loop cap |
| `LMSTUDIO_APPROVAL_TIMEOUT` | `300` | Seconds to wait for a permission answer |

### Windows

`.mcp.json` invokes `python3`. If that isn't on `PATH`, change `command` to
`python` or an absolute interpreter path.

## Limitations

- Worker output is a **draft**. Claude reviews it before use, and reads the
  audit trail before trusting an agentic run.
- A local model is a weaker agent than Claude. `worker_agent` has a step cap
  (default 12); hitting it means the task was left unfinished and possibly
  half-applied. Keep agentic tasks small and `root` narrow.
- `git` is your undo for anything an approved write got wrong.
- This does not reroute Claude Code's own `Agent` subagents to a local model —
  the `Agent` tool only accepts Anthropic model names. Doing that instead needs
  a translating proxy in front of `ANTHROPIC_BASE_URL`, which puts the proxy in
  the path of your main session.
