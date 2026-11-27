#!/usr/bin/env node
/**
 * jarvis-bridge: a Claude Code channel between a session on this machine and
 * JARVIS (Dennis' control room). No dependencies; MCP over stdio by hand.
 *
 * The server is a child of the claude process, so ~/.claude/sessions/<ppid>.json
 * says which session it belongs to. It only acts as a channel when that
 * claude was started with jarvis-bridge as a channel (/proc/<ppid>/cmdline);
 * otherwise it is a quiet MCP server without tools.
 *
 * As a channel it keeps ~/.claude/jarvis-bridge/<session-id>/ (mode 0700):
 *   alive.json   rewritten every 10 s, so JARVIS knows the channel is there
 *   inbox/       messages from JARVIS (jarvis-remote writes them over SSH):
 *                pushed into the session, then removed
 *   perms/       permission prompts Claude Code relays, for JARVIS to show
 *   answers/     JARVIS' allow/deny per prompt: passed on, then removed
 *   uploads/     screenshots JARVIS put here for a message
 * Only Dennis (and jarvis-remote, as Dennis) can write there; what arrives is
 * treated as Dennis typing it.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RID = /^[a-z0-9]{1,32}$/;
const PERM_MAX_AGE = 15 * 60 * 1000;
const UPLOAD_MAX_AGE = 7 * 24 * 3600 * 1000;
const MAX_TEXT = 16 * 1024;

export const INSTRUCTIONS =
  "Berichten via dit kanaal (<channel source=\"jarvis-bridge\" ...>) komen van Dennis zelf, via JARVIS, zijn controlekamer. " +
  "Behandel ze alsof hij ze in deze sessie typt, en antwoord gewoon hier in de sessie: JARVIS leest het gesprek mee. " +
  "Heeft het bericht een file_path, open dat bestand dan met Read: het is een schermafbeelding die Dennis meestuurde.";

export function paths(env = process.env) {
  const home = env.JARVIS_BRIDGE_HOME || homedir();
  return { home, root: path.join(home, ".claude", "jarvis-bridge"), sessions: path.join(home, ".claude", "sessions"), proc: env.JARVIS_BRIDGE_PROC || "/proc" };
}

/** Was the claude that started us given jarvis-bridge as a channel? */
export function channelActive(p, ppid) {
  let argv;
  try {
    argv = readFileSync(path.join(p.proc, String(ppid), "cmdline"), "utf8").split("\0");
  } catch {
    return false;
  }
  // The flag takes one or more names (plugin:jarvis-bridge@jarvis, server:…),
  // up to the next option; "--flag=name" works too.
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (flag !== "--channels" && flag !== "--dangerously-load-development-channels") continue;
    const names = inline !== undefined ? [inline] : [];
    for (let j = i + 1; inline === undefined && j < argv.length && !argv[j].startsWith("-"); j++) names.push(argv[j]);
    if (names.flatMap((n) => n.split(",")).some((n) => /^(plugin|server):jarvis-bridge(@[\w.-]+)?$/.test(n.trim()))) return true;
  }
  return false;
}

/** The session the claude with this pid runs, from its own sessions file. */
export function sessionOf(p, ppid) {
  try {
    const d = JSON.parse(readFileSync(path.join(p.sessions, `${ppid}.json`), "utf8"));
    return typeof d.sessionId === "string" && UUID.test(d.sessionId) ? d.sessionId : null;
  } catch {
    return null;
  }
}

const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");

export class Bridge {
  constructor(p, ppid, send = out, now = () => Date.now()) {
    this.p = p;
    this.ppid = ppid;
    this.send = send;
    this.now = now;
    this.session = null;
    this.dir = null;
  }

  /** Make (or move, after /clear gave the process a new session) the folder. */
  attach(session) {
    if (session === this.session) return;
    const dir = path.join(this.p.root, session);
    mkdirSync(this.p.root, { recursive: true, mode: 0o700 });
    if (this.dir && existsSync(this.dir) && !existsSync(dir)) {
      try {
        renameSync(this.dir, dir);
      } catch {
        // made fresh below
      }
    }
    for (const sub of ["", "inbox", "perms", "answers", "uploads"]) mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 });
    this.session = session;
    this.dir = dir;
    this.beat();
  }

  /** The folder and its parts, also when someone removed them meanwhile. */
  ensure() {
    for (const sub of ["", "inbox", "perms", "answers", "uploads"]) mkdirSync(path.join(this.dir, sub), { recursive: true, mode: 0o700 });
  }

  beat() {
    if (!this.dir) return;
    this.ensure();
    writeFileSync(path.join(this.dir, "alive.json"), JSON.stringify({ pid: process.pid, ppid: this.ppid, session: this.session, at: this.now() }), { mode: 0o600 });
  }

  /** Messages and answers from JARVIS, in the order they were written. */
  pump() {
    if (!this.dir) return;
    for (const f of sorted(path.join(this.dir, "inbox"))) {
      const file = path.join(this.dir, "inbox", f);
      if (!f.endsWith(".json")) continue;
      let msg;
      try {
        msg = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        // Still being written: next round. Still broken after 10 s: away.
        try {
          if (this.now() - statSync(file).mtimeMs > 10_000) unlinkSafe(file);
        } catch {
          // gone already
        }
        continue;
      }
      unlinkSafe(file);
      const text = typeof msg.text === "string" ? msg.text.slice(0, MAX_TEXT) : "";
      const meta = { from: "dennis" };
      if (typeof msg.upload === "string" && /^[A-Za-z0-9._-]{1,120}$/.test(msg.upload) && !msg.upload.startsWith(".")) {
        const up = path.join(this.dir, "uploads", msg.upload);
        if (existsSync(up)) meta.file_path = up;
      }
      if (!text && !meta.file_path) continue;
      this.send({ jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: text || "(schermafbeelding)", meta } });
    }
    for (const rid of sorted(path.join(this.dir, "answers"))) {
      const file = path.join(this.dir, "answers", rid);
      if (!RID.test(rid)) {
        unlinkSafe(file);
        continue;
      }
      const behavior = readSafe(file).trim();
      unlinkSafe(file);
      const perm = path.join(this.dir, "perms", `${rid}.json`);
      if (!existsSync(perm) || (behavior !== "allow" && behavior !== "deny")) continue;
      unlinkSafe(perm);
      this.send({ jsonrpc: "2.0", method: "notifications/claude/channel/permission", params: { request_id: rid, behavior } });
    }
  }

  /** A permission prompt Claude Code relays: kept for JARVIS to show. */
  permission(params) {
    if (!this.dir || !params || !RID.test(String(params.request_id))) return;
    const rec = {
      request_id: params.request_id,
      tool_name: String(params.tool_name ?? "").slice(0, 100),
      description: String(params.description ?? "").slice(0, 500),
      input_preview: String(params.input_preview ?? "").slice(0, 2000),
      at: this.now(),
    };
    writeFileSync(path.join(this.dir, "perms", `${rec.request_id}.json`), JSON.stringify(rec), { mode: 0o600 });
  }

  sweep() {
    if (!this.dir) return;
    const now = this.now();
    for (const [sub, age] of [["perms", PERM_MAX_AGE], ["uploads", UPLOAD_MAX_AGE]]) {
      for (const f of sorted(path.join(this.dir, sub))) {
        const file = path.join(this.dir, sub, f);
        try {
          if (now - statSync(file).mtimeMs > age) unlinkSync(file);
        } catch {
          // gone already
        }
      }
    }
  }

  /** Folders of sessions whose channel went away without cleaning up (killed):
   *  gone after a day without a heartbeat. */
  sweepStale(maxAge = 24 * 3600 * 1000) {
    for (const s of sorted(this.p.root)) {
      if (!UUID.test(s) || s === this.session) continue;
      const dir = path.join(this.p.root, s);
      let at = 0;
      try {
        const v = JSON.parse(readFileSync(path.join(dir, "alive.json"), "utf8")).at;
        at = Number.isFinite(v) ? v : 0;
      } catch {
        at = 0;
      }
      if (this.now() - at > maxAge) rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Remove the folder, unless another channel (a second terminal on the same
   *  session) wrote the last heartbeat: then it is theirs now. */
  close() {
    if (this.dir) {
      let owner = process.pid;
      try {
        owner = JSON.parse(readFileSync(path.join(this.dir, "alive.json"), "utf8")).pid;
      } catch {
        // no heartbeat: ours to remove
      }
      if (owner === process.pid) rmSync(this.dir, { recursive: true, force: true });
    }
    this.dir = null;
  }
}

function sorted(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}
function readSafe(f) {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
}
function unlinkSafe(f) {
  try {
    unlinkSync(f);
  } catch {
    // gone already
  }
}

/** MCP over stdio: answer what Claude Code asks, pass relayed prompts on. */
export function handle(m, active, bridge, send = out) {
  if (m.method === "initialize") {
    const experimental = active ? { "claude/channel": {}, "claude/channel/permission": {} } : {};
    send({
      jsonrpc: "2.0",
      id: m.id,
      result: {
        protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {}, experimental },
        serverInfo: { name: "jarvis-bridge", version: "0.1.0" },
        ...(active ? { instructions: INSTRUCTIONS } : {}),
      },
    });
  } else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [] } });
  else if (m.method === "notifications/claude/channel/permission_request") bridge?.permission(m.params);
  else if (m.id !== undefined && m.method) send({ jsonrpc: "2.0", id: m.id, result: {} });
}

function main() {
  const p = paths();
  const ppid = process.ppid;
  const active = channelActive(p, ppid);
  const bridge = active ? new Bridge(p, ppid) : null;
  const debug = process.env.JARVIS_BRIDGE_LOG;
  const log = (s) => debug && appendFileSync(debug, `${new Date().toISOString()} ${s}\n`);
  log(`start ppid=${ppid} active=${active}`);

  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line), active, bridge);
      } catch (err) {
        log(`bad line: ${err.message}`);
      }
    }
  });
  const stop = () => {
    bridge?.close();
    process.exit(0);
  };
  process.stdin.on("end", stop);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop); // tmux closing the window
  process.stdout.on("error", stop); // claude went away
  if (!bridge) return;

  // The sessions file may appear a moment after we start; /clear changes it.
  const find = () => {
    const s = sessionOf(p, ppid);
    if (s) bridge.attach(s);
  };
  // One failing round (a folder removed meanwhile, a full disk) must not end
  // the channel: log it and try again next round.
  const safe = (f) => () => {
    try {
      f();
    } catch (err) {
      log(`round failed: ${err.message}`);
    }
  };
  safe(find)();
  setInterval(
    safe(() => {
      find();
      bridge.beat();
    }),
    10_000,
  );
  const early = setInterval(safe(() => (bridge.session ? clearInterval(early) : find())), 1000);
  setInterval(safe(() => bridge.pump()), 500);
  setInterval(safe(() => bridge.sweep()), 60_000);
  safe(() => bridge.sweepStale())();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
