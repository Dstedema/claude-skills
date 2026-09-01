#!/usr/bin/env python3
"""MCP stdio server exposing a local LM Studio model as a pool of workers.

Two modes:
  - Plain workers (worker_run / worker_batch): text in, text out, no tools.
  - Agentic worker (worker_agent): the local model drives a real tool loop -
    reading, searching, writing and running commands itself - confined to a
    root the orchestrator passes per call. Mutating actions (write, edit,
    shell) are gated behind an MCP elicitation prompt, so the user approves
    them; nothing destructive happens unattended.

Stdlib only - no pip install, no venv, no node. Python 3.9+.

Configuration (all optional, all via environment):
  LMSTUDIO_BASE_URL         default http://localhost:1234
  LMSTUDIO_WORKER_MODEL     pin a model id instead of auto-detecting
  LMSTUDIO_TIMEOUT          per-request seconds, default 600
  LMSTUDIO_MAX_CONCURRENCY  parallel workers in worker_batch, default 4
  LMSTUDIO_TTL              keep-loaded seconds for JIT models, default 1800
  LMSTUDIO_AGENT_MAX_STEPS  tool-loop step cap, default 12
  LMSTUDIO_APPROVAL_TIMEOUT seconds to wait for a permission answer, default 300
"""

import fnmatch
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor

PROTOCOL_VERSION = "2025-06-18"
SERVER_INFO = {"name": "lmstudio-workers", "version": "0.2.0"}

BASE_URL = os.environ.get("LMSTUDIO_BASE_URL", "http://localhost:1234").rstrip("/")
PINNED_MODEL = os.environ.get("LMSTUDIO_WORKER_MODEL") or None
TIMEOUT = float(os.environ.get("LMSTUDIO_TIMEOUT", "600"))
MAX_CONCURRENCY = max(1, int(os.environ.get("LMSTUDIO_MAX_CONCURRENCY", "4")))
# LM Studio JIT-loads on demand and unloads again straight after; without a TTL
# a fanned-out batch hits "Model is unloaded" mid-flight.
TTL = int(os.environ.get("LMSTUDIO_TTL", "1800"))
AGENT_MAX_STEPS = int(os.environ.get("LMSTUDIO_AGENT_MAX_STEPS", "12"))
APPROVAL_TIMEOUT = float(os.environ.get("LMSTUDIO_APPROVAL_TIMEOUT", "300"))

MAX_READ_BYTES = 200_000
MAX_TOOL_RESULT = 20_000
SHELL_TIMEOUT = 120

DEFAULT_SYSTEM = (
    "You are a worker model executing one scoped sub-task for an orchestrator. "
    "Do exactly the task given, using only the supplied context. "
    "Answer directly with the result - no preamble, no restating the task, "
    "no offers of further help. If the context is insufficient, say precisely "
    "what is missing in one line."
)

AGENT_SYSTEM = (
    "You are a worker agent with tools, executing one scoped task for an "
    "orchestrator. Work inside the given root directory only.\n"
    "Rules:\n"
    "- Investigate with read_file/list_dir/grep before changing anything.\n"
    "- Make the smallest change that accomplishes the task.\n"
    "- write_file, edit_file and shell require the user's approval; if a request "
    "is denied, stop and report what you needed instead of trying to work around it.\n"
    "- When done, reply with a short plain-text report: what you found, what you "
    "changed (exact paths), and anything you could not do. No preamble."
)


class WorkerError(Exception):
    pass


# --------------------------------------------------------------------------
# Transport: bidirectional JSON-RPC over stdio.
# The server both answers client requests and issues its own (elicitation),
# so stdin is read by one dispatcher and request handling runs off-thread.
# --------------------------------------------------------------------------

_stdout_lock = threading.Lock()
_log_lock = threading.Lock()
_pending_lock = threading.Lock()
_pending = {}          # server-issued request id -> {"event":Event,"msg":dict}
CLIENT_CAPS = {}


def log(msg):
    """Diagnostics must go to stderr; stdout is the JSON-RPC channel."""
    with _log_lock:
        sys.stderr.write("[lmstudio-workers] %s\n" % msg)
        sys.stderr.flush()


def send(msg):
    with _stdout_lock:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


def request_client(method, params, timeout):
    """Send a request TO the client and block for its response."""
    rid = "srv-" + uuid.uuid4().hex[:12]
    event = threading.Event()
    with _pending_lock:
        _pending[rid] = {"event": event, "msg": None}
    send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
    if not event.wait(timeout):
        with _pending_lock:
            _pending.pop(rid, None)
        raise WorkerError("No response from the client for %s within %.0fs." % (method, timeout))
    with _pending_lock:
        entry = _pending.pop(rid, None)
    reply = (entry or {}).get("msg") or {}
    if "error" in reply:
        raise WorkerError("Client rejected %s: %s" % (method, reply["error"].get("message")))
    return reply.get("result") or {}


def client_supports_elicitation():
    return isinstance(CLIENT_CAPS.get("elicitation"), dict)


# --------------------------------------------------------------------------
# LM Studio HTTP
# --------------------------------------------------------------------------

RETRY_STATUS = (500, 502, 503, 504)
RETRIES = 3


def _http(method, path, payload=None, timeout=None, retries=RETRIES):
    """Request LM Studio, retrying the transient 5xx it emits while JIT-loading."""
    url = BASE_URL + path
    data = json.dumps(payload).encode() if payload is not None else None
    last = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout or TIMEOUT) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            if e.code in RETRY_STATUS and attempt < retries:
                delay = 2.0 * (attempt + 1)
                log("HTTP %s on %s (attempt %d/%d) - retrying in %.0fs"
                    % (e.code, path, attempt + 1, retries + 1, delay))
                time.sleep(delay)
                last = "HTTP %s: %s" % (e.code, body[:300])
                continue
            snippet = body[:300].strip()
            if "<html" in snippet.lower():
                snippet = "(HTML error page - check LM Studio's server log)"
            raise WorkerError(
                "LM Studio returned HTTP %s for %s: %s" % (e.code, path, snippet))
        except urllib.error.URLError as e:
            raise WorkerError(
                "Cannot reach LM Studio at %s (%s). Start its local server "
                "(Developer tab -> Start Server, or `lms server start`)." % (BASE_URL, e.reason)
            )
        except json.JSONDecodeError:
            raise WorkerError("LM Studio sent a non-JSON response for %s." % path)
    raise WorkerError("LM Studio kept failing %s after %d attempts. Last: %s"
                      % (path, retries + 1, last))


def list_models():
    """Return LM Studio's model inventory, richest source first."""
    try:
        data = _http("GET", "/api/v0/models", timeout=15, retries=1).get("data", [])
        return [
            {"id": m.get("id"), "type": m.get("type"), "state": m.get("state"),
             "arch": m.get("arch"), "max_context_length": m.get("max_context_length")}
            for m in data
        ]
    except WorkerError:
        data = _http("GET", "/v1/models", timeout=15, retries=1).get("data", [])
        return [
            {"id": m.get("id"),
             "type": "embeddings" if "embed" in (m.get("id") or "").lower() else "llm",
             "state": "unknown", "arch": None, "max_context_length": None}
            for m in data
        ]


def resolve_model(explicit=None):
    """Pick a worker model: explicit > env pin > loaded LLM > any LLM."""
    if explicit:
        return explicit
    if PINNED_MODEL:
        return PINNED_MODEL
    models = list_models()
    chat = [m for m in models if m.get("type") in ("llm", "vlm")]
    if not chat:
        inventory = ", ".join("%s (%s)" % (m["id"], m["type"]) for m in models) or "none"
        raise WorkerError(
            "No chat-capable model is available in LM Studio - only: %s. "
            "Download one in LM Studio (or `lms get <model>`), then load it. "
            "Embedding models cannot run worker tasks." % inventory
        )
    for m in chat:
        if m.get("state") == "loaded":
            return m["id"]
    return chat[0]["id"]  # not loaded; LM Studio JIT-loads it (first call is slow)


def chat(model_id, messages, temperature=0.2, max_tokens=-1, tools=None):
    payload = {"model": model_id, "messages": messages, "temperature": temperature,
               "max_tokens": max_tokens, "stream": False, "ttl": TTL}
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    result = _http("POST", "/v1/chat/completions", payload)
    choices = result.get("choices") or []
    if not choices:
        raise WorkerError("LM Studio returned no completion choices.")
    return result, choices[0]


# --------------------------------------------------------------------------
# Plain workers
# --------------------------------------------------------------------------

def run_worker(task, context=None, model=None, system=None, temperature=0.2, max_tokens=-1):
    if not task or not task.strip():
        raise WorkerError("`task` is required and cannot be empty.")
    model_id = resolve_model(model)
    user = task if not context else "%s\n\n--- CONTEXT ---\n%s" % (task, context)
    result, choice = chat(model_id, [
        {"role": "system", "content": system or DEFAULT_SYSTEM},
        {"role": "user", "content": user},
    ], temperature, max_tokens)
    message = choice.get("message") or {}
    text = (message.get("content") or "").strip()
    # Reasoning models can spend the whole budget on reasoning_content and
    # return empty content; surface that rather than an unexplained blank.
    reasoning = (message.get("reasoning_content") or "").strip()
    usage = result.get("usage") or {}
    return {"model": result.get("model", model_id), "text": text,
            "reasoning_only": bool(reasoning and not text),
            "finish_reason": choice.get("finish_reason"),
            "prompt_tokens": usage.get("prompt_tokens"),
            "completion_tokens": usage.get("completion_tokens")}


def ensure_ready(model_id):
    """Force a cold model to load before fanning out.

    LM Studio JIT-loads on first request and answers concurrent requests with
    HTTP 500 while doing so, so a parallel batch against a cold model mostly
    fails. One cheap serialized request absorbs that load.
    """
    try:
        state = next((m.get("state") for m in list_models() if m.get("id") == model_id), None)
    except WorkerError:
        state = None
    if state == "loaded":
        return False
    log("warming up %s (state=%s) before fan-out" % (model_id, state))
    _http("POST", "/v1/chat/completions", {
        "model": model_id, "messages": [{"role": "user", "content": "ok"}],
        "max_tokens": 1, "stream": False, "ttl": TTL})
    return True


def run_batch(tasks, shared_context=None, model=None, system=None,
              temperature=0.2, max_tokens=-1, concurrency=None):
    if not tasks:
        raise WorkerError("`tasks` must contain at least one task.")
    model_id = resolve_model(model)  # resolve once so all workers share a model
    workers = min(concurrency or MAX_CONCURRENCY, len(tasks))
    warmed = ensure_ready(model_id) if workers > 1 else False

    def one(item):
        if isinstance(item, dict):
            task, ctx = item.get("task"), item.get("context") or shared_context
        else:
            task, ctx = item, shared_context
        try:
            r = run_worker(task, ctx, model_id, system, temperature, max_tokens)
            return {"ok": True, "task": task, "text": r["text"],
                    "empty": not r["text"], "finish_reason": r["finish_reason"],
                    "reasoning_only": r["reasoning_only"],
                    "completion_tokens": r["completion_tokens"]}
        except Exception as e:
            return {"ok": False, "task": task, "error": str(e)}

    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(one, tasks))

    return {"model": model_id, "concurrency": workers, "warmed": warmed,
            "succeeded": sum(1 for r in results if r["ok"]),
            "failed": sum(1 for r in results if not r["ok"]),
            "empty": sum(1 for r in results if r.get("empty")),
            "results": results}


# --------------------------------------------------------------------------
# Agentic worker: local model drives the tools
# --------------------------------------------------------------------------

READ_ONLY = ("read_file", "list_dir", "grep")
MUTATING = ("write_file", "edit_file", "shell")

AGENT_TOOL_SPECS = [
    ("read_file", "Read a UTF-8 text file inside the root. Returns its contents.",
     {"path": {"type": "string", "description": "Path relative to the root."}}, ["path"]),
    ("list_dir", "List the entries of a directory inside the root.",
     {"path": {"type": "string", "description": "Path relative to the root; '.' for the root itself."}}, []),
    ("grep", "Search file contents for a regular expression under the root.",
     {"pattern": {"type": "string", "description": "Python regular expression."},
      "glob": {"type": "string", "description": "Filename filter, e.g. '*.py'. Default '*'."}}, ["pattern"]),
    ("write_file", "Create or overwrite a file inside the root. Requires user approval.",
     {"path": {"type": "string", "description": "Path relative to the root."},
      "content": {"type": "string", "description": "Full new file contents."}}, ["path", "content"]),
    ("edit_file", "Replace an exact string in a file inside the root. Requires user approval.",
     {"path": {"type": "string", "description": "Path relative to the root."},
      "old_string": {"type": "string", "description": "Exact text to replace; must occur exactly once."},
      "new_string": {"type": "string", "description": "Replacement text."}}, ["path", "old_string", "new_string"]),
    ("shell", "Run a shell command with the root as working directory. Requires user approval.",
     {"command": {"type": "string", "description": "The command line to run."}}, ["command"]),
]


def agent_tools():
    specs = []
    for name, desc, props, required in AGENT_TOOL_SPECS:
        specs.append({"type": "function", "function": {
            "name": name, "description": desc,
            "parameters": {"type": "object", "properties": props, "required": required}}})
    return specs


def safe_path(root, rel):
    """Resolve rel under root, refusing anything that escapes (symlinks included)."""
    root_real = os.path.realpath(root)
    target = os.path.realpath(os.path.join(root_real, rel or "."))
    if target != root_real and not target.startswith(root_real + os.sep):
        raise WorkerError("path %r escapes the worker root" % rel)
    return target


def _clip(text):
    if len(text) <= MAX_TOOL_RESULT:
        return text
    return text[:MAX_TOOL_RESULT] + "\n...[truncated]"


def ask_permission(tool, detail, granted):
    """Elicit the user's approval for a mutating action.

    Returns True if allowed. 'always' grants that tool for the rest of the
    session. Without client elicitation support, mutating tools are refused.
    """
    if granted.get(tool):
        return True, "already approved for this session"
    if not client_supports_elicitation():
        return False, ("the MCP client does not support permission prompts, so "
                       "mutating tools are unavailable")
    result = request_client("elicitation/create", {
        "message": "Local LM Studio worker wants to run %s:\n\n%s" % (tool, detail),
        "requestedSchema": {
            "type": "object",
            "properties": {
                "decision": {
                    "type": "string",
                    "title": "Allow this?",
                    "enum": ["once", "always", "no"],
                    "enumNames": ["Allow once", "Allow %s for this session" % tool, "Deny"],
                }
            },
            "required": ["decision"],
        },
    }, APPROVAL_TIMEOUT)
    action = result.get("action")
    if action != "accept":
        return False, "the user %s the request" % ("declined" if action == "decline" else "cancelled")
    decision = (result.get("content") or {}).get("decision")
    if decision == "always":
        granted[tool] = True
        return True, "approved for the session"
    if decision == "once":
        return True, "approved once"
    return False, "the user denied the request"


def exec_agent_tool(name, args, root, granted, audit):
    """Run one tool call for the worker. Returns the text handed back to it."""
    if name in MUTATING:
        detail = json.dumps(args)[:600]
        allowed, why = ask_permission(name, detail, granted)
        audit.append({"tool": name, "args": args, "allowed": allowed, "why": why})
        if not allowed:
            return "DENIED: %s. Do not retry; report this as a blocker." % why
    else:
        audit.append({"tool": name, "args": args, "allowed": True, "why": "read-only"})

    if name == "read_file":
        p = safe_path(root, args.get("path"))
        if not os.path.isfile(p):
            return "ERROR: not a file: %s" % args.get("path")
        with open(p, "rb") as fh:
            raw = fh.read(MAX_READ_BYTES + 1)
        if len(raw) > MAX_READ_BYTES:
            return _clip(raw[:MAX_READ_BYTES].decode("utf-8", "replace"))
        return _clip(raw.decode("utf-8", "replace"))

    if name == "list_dir":
        p = safe_path(root, args.get("path") or ".")
        if not os.path.isdir(p):
            return "ERROR: not a directory: %s" % (args.get("path") or ".")
        rows = []
        for entry in sorted(os.listdir(p)):
            full = os.path.join(p, entry)
            rows.append("%s%s" % (entry, "/" if os.path.isdir(full) else ""))
        return _clip("\n".join(rows) or "(empty)")

    if name == "grep":
        pattern, glob = args.get("pattern"), args.get("glob") or "*"
        try:
            rx = re.compile(pattern)
        except re.error as e:
            return "ERROR: bad regex: %s" % e
        root_real = os.path.realpath(root)
        hits = []
        for dirpath, dirnames, filenames in os.walk(root_real):
            dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules", "__pycache__")]
            for fn in filenames:
                if not fnmatch.fnmatch(fn, glob):
                    continue
                full = os.path.join(dirpath, fn)
                try:
                    with open(full, "r", errors="replace") as fh:
                        for i, line in enumerate(fh, 1):
                            if rx.search(line):
                                hits.append("%s:%d: %s" % (
                                    os.path.relpath(full, root_real), i, line.rstrip()[:200]))
                                if len(hits) >= 200:
                                    return _clip("\n".join(hits) + "\n...[capped at 200 matches]")
                except OSError:
                    continue
        return _clip("\n".join(hits) or "(no matches)")

    if name == "write_file":
        p = safe_path(root, args.get("path"))
        os.makedirs(os.path.dirname(p) or root, exist_ok=True)
        with open(p, "w") as fh:
            fh.write(args.get("content") or "")
        return "OK: wrote %s (%d bytes)" % (args.get("path"), len(args.get("content") or ""))

    if name == "edit_file":
        p = safe_path(root, args.get("path"))
        if not os.path.isfile(p):
            return "ERROR: not a file: %s" % args.get("path")
        old, new = args.get("old_string") or "", args.get("new_string") or ""
        with open(p, "r", errors="replace") as fh:
            body = fh.read()
        count = body.count(old)
        if count == 0:
            return "ERROR: old_string not found in %s" % args.get("path")
        if count > 1:
            return "ERROR: old_string occurs %d times in %s; make it unique" % (count, args.get("path"))
        with open(p, "w") as fh:
            fh.write(body.replace(old, new, 1))
        return "OK: edited %s" % args.get("path")

    if name == "shell":
        cmd = args.get("command") or ""
        try:
            proc = subprocess.run(cmd, shell=True, cwd=os.path.realpath(root),
                                  capture_output=True, text=True, timeout=SHELL_TIMEOUT)
        except subprocess.TimeoutExpired:
            return "ERROR: command timed out after %ds" % SHELL_TIMEOUT
        out = (proc.stdout or "") + (("\n[stderr]\n" + proc.stderr) if proc.stderr else "")
        return _clip("exit=%d\n%s" % (proc.returncode, out.strip() or "(no output)"))

    return "ERROR: unknown tool %s" % name


def run_agent(task, root, context=None, model=None, max_steps=None,
              temperature=0.2, max_tokens=-1):
    if not task or not task.strip():
        raise WorkerError("`task` is required and cannot be empty.")
    if not root:
        raise WorkerError("`root` is required - the orchestrator must set the worker's sandbox root.")
    if not os.path.isdir(root):
        raise WorkerError("root %r is not an existing directory." % root)

    model_id = resolve_model(model)
    steps_cap = max_steps or AGENT_MAX_STEPS
    granted, audit = {}, []
    user = task if not context else "%s\n\n--- CONTEXT ---\n%s" % (task, context)
    messages = [
        {"role": "system", "content": AGENT_SYSTEM},
        {"role": "user", "content": "Root directory: %s\n\nTask: %s" % (os.path.realpath(root), user)},
    ]
    tools = agent_tools()
    steps = 0

    while steps < steps_cap:
        steps += 1
        _, choice = chat(model_id, messages, temperature, max_tokens, tools)
        message = choice.get("message") or {}
        calls = message.get("tool_calls") or []
        messages.append({"role": "assistant",
                         "content": message.get("content") or "",
                         "tool_calls": calls})
        if not calls:
            text = (message.get("content") or "").strip()
            return {"model": model_id, "steps": steps, "audit": audit,
                    "text": text, "stopped": "completed"}

        for call in calls:
            fn = call.get("function") or {}
            name = fn.get("name")
            raw = fn.get("arguments")
            try:
                args = json.loads(raw) if isinstance(raw, str) else (raw or {})
            except json.JSONDecodeError:
                args = {}
            log("step %d: %s %s" % (steps, name, json.dumps(args)[:160]))
            try:
                out = exec_agent_tool(name, args, root, granted, audit)
            except WorkerError as e:
                out = "ERROR: %s" % e
            except Exception as e:
                out = "ERROR: %r" % e
            messages.append({"role": "tool", "tool_call_id": call.get("id"),
                             "content": out})

    return {"model": model_id, "steps": steps, "audit": audit,
            "text": "", "stopped": "hit the %d-step cap" % steps_cap}


# --------------------------------------------------------------------------
# MCP tool surface
# --------------------------------------------------------------------------

TOOLS = [
    {
        "name": "worker_run",
        "description": (
            "Delegate ONE scoped sub-task to the local LM Studio model, text in / "
            "text out, no tools. Use for bulk work where a local model is good "
            "enough and saves orchestrator context: summarizing a long file, "
            "extracting or reformatting data, drafting boilerplate, classifying "
            "items, first-pass translation. Pass everything it needs in `context`; "
            "use worker_agent instead if it must read files itself."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": "The instruction for the worker."},
                "context": {"type": "string", "description": "Source material the worker should use."},
                "model": {"type": "string", "description": "Override the model id; defaults to the loaded LM Studio model."},
                "system": {"type": "string", "description": "Override the worker system prompt."},
                "temperature": {"type": "number", "description": "Sampling temperature, default 0.2."},
                "max_tokens": {"type": "integer", "description": "Max tokens to generate; -1 (default) means unlimited."},
            },
            "required": ["task"],
        },
    },
    {
        "name": "worker_batch",
        "description": (
            "Fan out MANY text sub-tasks to the local model in parallel and return "
            "all results. Use this instead of calling worker_run in a loop - it is "
            "the main throughput win. Each entry is a string or {task, context}. "
            "Failures and empty outputs are reported per item, never fatal."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array",
                    "description": "Task strings, or objects with `task` and optional per-item `context`.",
                    "items": {"oneOf": [
                        {"type": "string"},
                        {"type": "object",
                         "properties": {"task": {"type": "string"}, "context": {"type": "string"}},
                         "required": ["task"]},
                    ]},
                },
                "shared_context": {"type": "string", "description": "Context given to every task that lacks its own."},
                "model": {"type": "string", "description": "Override the model id."},
                "system": {"type": "string", "description": "Override the worker system prompt."},
                "temperature": {"type": "number", "description": "Sampling temperature, default 0.2."},
                "max_tokens": {"type": "integer", "description": "Max tokens per task; -1 (default) means unlimited."},
                "concurrency": {"type": "integer", "description": "Parallel requests; defaults to LMSTUDIO_MAX_CONCURRENCY (4)."},
            },
            "required": ["tasks"],
        },
    },
    {
        "name": "worker_agent",
        "description": (
            "Hand a task to the local model as an AGENT that uses tools itself: it "
            "reads files, lists directories, greps, and - with the user's approval "
            "per action - writes files, edits them and runs shell commands. All "
            "paths are confined to the `root` you pass, which is REQUIRED: set it "
            "to the narrowest directory that contains the work. Use this when the "
            "worker should do the tooling rather than have you pipe content in. "
            "Returns the worker's report plus an audit trail of every tool call and "
            "approval decision. Review that audit before trusting the result."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": "What the worker should accomplish."},
                "root": {"type": "string", "description": "Absolute path the worker is confined to. Required. Use the narrowest directory that suffices."},
                "context": {"type": "string", "description": "Extra background the worker cannot discover from the filesystem."},
                "model": {"type": "string", "description": "Override the model id."},
                "max_steps": {"type": "integer", "description": "Tool-loop step cap; default LMSTUDIO_AGENT_MAX_STEPS (12)."},
                "temperature": {"type": "number", "description": "Sampling temperature, default 0.2."},
                "max_tokens": {"type": "integer", "description": "Max tokens per step; -1 (default) means unlimited."},
            },
            "required": ["task", "root"],
        },
    },
    {
        "name": "worker_models",
        "description": (
            "Report LM Studio's health and model inventory: which models exist, "
            "their type (llm/vlm/embeddings), which are loaded, which one worker "
            "calls would use, and whether permission prompts are available for "
            "worker_agent's mutating tools. Call this first when workers fail."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def call_tool(name, args):
    if name == "worker_run":
        r = run_worker(args.get("task"), args.get("context"), args.get("model"),
                       args.get("system"), args.get("temperature", 0.2),
                       args.get("max_tokens", -1))
        header = "[worker: %s | %s completion tokens]" % (r["model"], r["completion_tokens"])
        if r["finish_reason"] == "length":
            header += "\n[WARNING: output truncated - raise max_tokens]"
        if not r["text"]:
            header += "\n[WARNING: empty output%s]" % (
                "; the model spent its budget on reasoning" if r["reasoning_only"] else "")
        return header + "\n\n" + r["text"]

    if name == "worker_batch":
        r = run_batch(args.get("tasks"), args.get("shared_context"), args.get("model"),
                      args.get("system"), args.get("temperature", 0.2),
                      args.get("max_tokens", -1), args.get("concurrency"))
        lines = ["[worker_batch: %s | %d ok, %d failed | concurrency %d%s]" % (
            r["model"], r["succeeded"], r["failed"], r["concurrency"],
            " | warmed cold model" if r["warmed"] else "")]
        if r["empty"]:
            lines.append("[WARNING: %d worker(s) returned empty output - re-run those "
                         "yourself or raise max_tokens]" % r["empty"])
        for i, item in enumerate(r["results"], 1):
            lines.append("\n--- [%d/%d] %s ---" % (i, len(r["results"]), item["task"][:120]))
            if not item["ok"]:
                lines.append("ERROR: " + item["error"])
            elif item["empty"]:
                lines.append("(empty output; finish_reason=%s%s)" % (
                    item["finish_reason"],
                    "; model spent the budget on reasoning" if item.get("reasoning_only") else ""))
            else:
                lines.append(item["text"])
        return "\n".join(lines)

    if name == "worker_agent":
        r = run_agent(args.get("task"), args.get("root"), args.get("context"),
                      args.get("model"), args.get("max_steps"),
                      args.get("temperature", 0.2), args.get("max_tokens", -1))
        lines = ["[worker_agent: %s | %d step(s) | %s]" % (r["model"], r["steps"], r["stopped"])]
        if r["audit"]:
            lines.append("\n--- tool calls ---")
            for a in r["audit"]:
                mark = "ok " if a["allowed"] else "DENIED"
                lines.append("  %-6s %-11s %s  (%s)" % (
                    mark, a["tool"], json.dumps(a["args"])[:140], a["why"]))
        denied = [a for a in r["audit"] if not a["allowed"]]
        if denied:
            lines.append("\n[%d action(s) were not permitted - the report below is "
                         "incomplete accordingly]" % len(denied))
        lines.append("\n--- worker report ---")
        lines.append(r["text"] or "(no report; worker %s)" % r["stopped"])
        return "\n".join(lines)

    if name == "worker_models":
        models = list_models()
        lines = ["LM Studio at %s is reachable." % BASE_URL, ""]
        if not models:
            lines.append("No models installed.")
        for m in models:
            lines.append("  %-52s type=%-11s state=%s" % (m["id"], m["type"], m["state"]))
        lines.append("")
        try:
            lines.append("Worker calls would use: %s" % resolve_model())
        except WorkerError as e:
            lines.append("No usable worker model: %s" % e)
        if PINNED_MODEL:
            lines.append("(pinned via LMSTUDIO_WORKER_MODEL)")
        lines.append("Permission prompts (worker_agent writes/shell): %s" % (
            "available" if client_supports_elicitation()
            else "NOT available - mutating tools will be refused"))
        return "\n".join(lines)

    raise WorkerError("Unknown tool: %s" % name)


# --------------------------------------------------------------------------
# Dispatch
# --------------------------------------------------------------------------

def handle_request(msg):
    method, mid, params = msg.get("method"), msg.get("id"), msg.get("params") or {}

    def ok(result):
        return {"jsonrpc": "2.0", "id": mid, "result": result}

    if method == "initialize":
        CLIENT_CAPS.clear()
        CLIENT_CAPS.update(params.get("capabilities") or {})
        log("client capabilities: %s (elicitation %s)" % (
            sorted(CLIENT_CAPS), "yes" if client_supports_elicitation() else "no"))
        return ok({"protocolVersion": PROTOCOL_VERSION,
                   "capabilities": {"tools": {}},
                   "serverInfo": SERVER_INFO})
    if method in ("notifications/initialized", "notifications/cancelled"):
        return None
    if method == "ping":
        return ok({})
    if method == "tools/list":
        return ok({"tools": TOOLS})
    if method == "tools/call":
        name = params.get("name")
        try:
            text = call_tool(name, params.get("arguments") or {})
            return ok({"content": [{"type": "text", "text": text}], "isError": False})
        except WorkerError as e:
            return ok({"content": [{"type": "text", "text": "Worker error: %s" % e}], "isError": True})
        except Exception as e:  # never let a worker fault kill the server
            log("unexpected error in %s: %r" % (name, e))
            return ok({"content": [{"type": "text", "text": "Unexpected worker failure: %r" % e}],
                       "isError": True})
    if mid is None:
        return None
    return {"jsonrpc": "2.0", "id": mid,
            "error": {"code": -32601, "message": "Method not found: %s" % method}}


def main():
    log("ready - LM Studio base URL %s" % BASE_URL)
    # tools/call may block on a permission prompt, so it must not occupy the
    # reader; requests are handled off-thread while stdin keeps flowing.
    pool = ThreadPoolExecutor(max_workers=8)

    def serve(msg):
        try:
            resp = handle_request(msg)
        except Exception as e:
            log("fatal-guard: %r" % e)
            resp = {"jsonrpc": "2.0", "id": msg.get("id"),
                    "error": {"code": -32603, "message": "Internal error: %r" % e}}
        if resp is not None:
            send(resp)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            send({"jsonrpc": "2.0", "id": None,
                  "error": {"code": -32700, "message": "Parse error"}})
            continue
        if "method" not in msg and msg.get("id") is not None:
            # A response to one of our own elicitation requests.
            with _pending_lock:
                entry = _pending.get(msg["id"])
                if entry:
                    entry["msg"] = msg
                    entry["event"].set()
            continue
        pool.submit(serve, msg)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
