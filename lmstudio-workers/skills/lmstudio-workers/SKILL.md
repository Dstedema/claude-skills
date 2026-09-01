---
name: lmstudio-workers
description: Push work onto a local LM Studio model instead of doing it yourself or spawning cloud subagents — Claude orchestrates, the local model executes. Use whenever a task decomposes into many similar mechanical units (summarize/triage these N files, extract fields, classify a list, draft boilerplate, translate a batch), or when a scoped chunk of work can be handed over wholesale for the local model to investigate and carry out with its own tools. Triggers on "use the local model", "use LM Studio", "run that locally", "spin up workers", "fan this out", "let the local LM do it", "don't waste tokens on this". Also use to check local model health when worker calls fail. Tools: worker_run, worker_batch, worker_agent, worker_models.
---

# LM Studio workers

You are the orchestrator. This skill gives you a local model as a worker pool
through the `lmstudio-workers` MCP server. Default posture: **if a piece of work
can reasonably run on the local model, send it there** — you plan, delegate,
verify and report; the local model does the execution.

## The three modes

| Tool | Worker capability | Use when |
| --- | --- | --- |
| `worker_run` | text in, text out | one scoped transformation, you supply the material |
| `worker_batch` | text, in parallel | many similar units — the throughput win |
| `worker_agent` | **its own tools**: read, list, grep, and (with the user's approval) write, edit, shell | the worker should investigate and act on the filesystem itself |

Prefer `worker_agent` when the work is "go look at X and do Y" — it stops you
piping file contents by hand. Prefer `worker_batch` when you already hold the
material and just need N transformations.

## What stays with you

Planning and decomposition. Reviewing every worker result. The final answer to
the user. Anything security-relevant, the shape of a real diff, cross-file
reasoning, and any judgment call where a subtly wrong answer is expensive.

Delegate freely; trust nothing unverified.

## worker_agent

The local model drives a real tool loop. You **must** pass `root` — the
narrowest directory containing the work. Every path is resolved against it and
anything escaping it (`../`, absolute paths, symlinks) is refused.

- Read-only tools (`read_file`, `list_dir`, `grep`) run freely inside `root`.
- `write_file`, `edit_file` and `shell` trigger a **permission prompt to the
  user** for each action, with "allow once" / "allow for this session" / "deny".
  A denial is final — the worker is told to stop, not to work around it.
- The result includes an **audit trail** of every tool call and approval
  decision. Read it. If actions were denied, the report is incomplete by
  definition and you must say so.
- `max_steps` caps the loop (default 12). Hitting the cap means the worker did
  not finish; treat the partial state as suspect and inspect it yourself.

Scope `root` tightly. A worker rooted at a whole repo can read the whole repo.

## Using it well

1. **Check the pool once per session** before the first delegation —
   `worker_models` reports reachability, the inventory, which model is loaded,
   and whether permission prompts are available. Without prompts, `worker_agent`
   cannot write or run anything; fall back to read-only use or do it yourself.
2. **Batch, don't loop.** `worker_batch` runs in parallel and reports per-item
   failures without aborting the rest. Pass common material once as
   `shared_context`.
3. **Write tight prompts.** Local models are smaller: one instruction, an
   explicit output shape. "Return only a JSON array of {file, severity, reason}"
   beats "analyse these logs". Give reasoning models room — a small
   `max_tokens` can be consumed entirely by reasoning, returning nothing.
4. **Verify before use.** Spot-check structure and paths. Never paste worker
   output into a file without reading it. Re-run failures yourself rather than
   delegating the same thing twice.

## Reporting to the user

Say what ran locally and what you did yourself — "the local Qwen model
summarized the 20 logs, I reviewed and merged them". Name any denied action and
what it cost. If the pool was unavailable and you did the work directly, say so
rather than silently substituting.

## Configuration

All optional, all environment variables — no paths are baked in:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LMSTUDIO_BASE_URL` | `http://localhost:1234` | Point at a remote LM Studio host |
| `LMSTUDIO_WORKER_MODEL` | auto-detect | Pin one model id |
| `LMSTUDIO_MAX_CONCURRENCY` | `4` | Parallel workers in `worker_batch` |
| `LMSTUDIO_TIMEOUT` | `600` | Per-request seconds |
| `LMSTUDIO_TTL` | `1800` | Keep-loaded seconds for JIT models |
| `LMSTUDIO_AGENT_MAX_STEPS` | `12` | Default tool-loop cap |
| `LMSTUDIO_APPROVAL_TIMEOUT` | `300` | Seconds to wait for a permission answer |

## Troubleshooting

- **"Cannot reach LM Studio"** — its local server is off. `lms server start`,
  or LM Studio's Developer tab → Start Server.
- **"No chat-capable model"** — only embedding models are installed. The user
  must download an instruct/coder model; ask which one rather than picking and
  downloading tens of GB on their behalf.
- **"Model is unloaded" / HTTP 500 on the first batch** — LM Studio was
  JIT-loading. The server already warms the model and retries; a cold 30B load
  simply takes a while.
- **Empty worker output** — a reasoning model spent the budget thinking. Raise
  `max_tokens`; the result header flags this case.
- **`worker_agent` refuses to write** — the client offered no elicitation
  capability, so there is no way to ask permission. Check `worker_models`.
