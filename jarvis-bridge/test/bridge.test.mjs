import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Bridge, channelActive, handle, INSTRUCTIONS, sessionOf } from "../server/bridge.mjs";

// The channel between a session on dev and JARVIS, against a fake home and /proc.
const SID = "11111111-aaaa-4bbb-8ccc-000000000001";
const SID2 = "22222222-aaaa-4bbb-8ccc-000000000002";

function fake(argv = ["claude", "--dangerously-load-development-channels", "plugin:jarvis-bridge@jarvis"], ppid = 4242) {
  const home = mkdtempSync(path.join(tmpdir(), "jarvis-bridge-"));
  const proc = path.join(home, "proc");
  mkdirSync(path.join(proc, String(ppid)), { recursive: true });
  writeFileSync(path.join(proc, String(ppid), "cmdline"), argv.join("\0") + "\0");
  mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "sessions", `${ppid}.json`), JSON.stringify({ pid: ppid, sessionId: SID }));
  const p = { home, root: path.join(home, ".claude", "jarvis-bridge"), sessions: path.join(home, ".claude", "sessions"), proc };
  return { p, ppid };
}

test("it is a channel only when its claude was started with jarvis-bridge as one", () => {
  const yes = [
    ["claude", "--dangerously-load-development-channels", "plugin:jarvis-bridge@jarvis"],
    ["claude", "--channels", "plugin:jarvis-bridge@jarvis", "--resume", SID],
    ["claude", "--channels=plugin:jarvis-bridge@jarvis"],
    ["claude", "--channels", "plugin:telegram@x,plugin:jarvis-bridge@jarvis"],
    ["claude", "--channels", "plugin:telegram@x", "server:jarvis-bridge"],
  ];
  const no = [
    ["claude"],
    ["claude", "--resume", SID],
    ["claude", "--channels", "plugin:telegram@x", "--resume", "jarvis-bridge"],
    ["claude", "-p", "jarvis-bridge"],
    ["claude", "--channels", "plugin:not-jarvis-bridge@x"],
  ];
  for (const a of yes) assert.equal(channelActive(fake(a).p, 4242), true, a.join(" "));
  for (const a of no) assert.equal(channelActive(fake(a).p, 4242), false, a.join(" "));
  assert.equal(channelActive(fake().p, 999), false, "no such process");
});

test("the session comes from the claude's own sessions file", () => {
  const { p, ppid } = fake();
  assert.equal(sessionOf(p, ppid), SID);
  writeFileSync(path.join(p.sessions, `${ppid}.json`), JSON.stringify({ sessionId: "../x" }));
  assert.equal(sessionOf(p, ppid), null);
  assert.equal(sessionOf(p, 1), null);
});

test("initialize offers the channel (and permission relay) only when active", () => {
  const sent = [];
  handle({ id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }, true, null, (m) => sent.push(m));
  handle({ id: 2, method: "initialize" }, false, null, (m) => sent.push(m));
  handle({ id: 3, method: "tools/list" }, true, null, (m) => sent.push(m));
  assert.deepEqual(sent[0].result.capabilities.experimental, { "claude/channel": {}, "claude/channel/permission": {} });
  assert.equal(sent[0].result.instructions, INSTRUCTIONS);
  assert.equal(sent[0].result.protocolVersion, "2025-11-25");
  assert.deepEqual(sent[1].result.capabilities.experimental, {});
  assert.equal(sent[1].result.instructions, undefined);
  assert.deepEqual(sent[2].result, { tools: [] });
});

test("a message from JARVIS goes into the session once, with a screenshot as file_path", () => {
  const { p, ppid } = fake();
  const sent = [];
  const b = new Bridge(p, ppid, (m) => sent.push(m));
  b.attach(SID);
  const dir = path.join(p.root, SID);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "alive.json"), "utf8")).session, SID);
  writeFileSync(path.join(dir, "uploads", "shot-1.png"), "png");
  writeFileSync(path.join(dir, "inbox", "001.json"), JSON.stringify({ text: "Kijk hiernaar", upload: "shot-1.png" }));
  writeFileSync(path.join(dir, "inbox", "002.json"), JSON.stringify({ text: "en dit", upload: "../../etc/passwd" }));
  writeFileSync(path.join(dir, "inbox", "003.json"), "{half");
  b.pump();
  assert.deepEqual(sent, [
    { jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: "Kijk hiernaar", meta: { from: "dennis", file_path: path.join(dir, "uploads", "shot-1.png") } } },
    { jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: "en dit", meta: { from: "dennis" } } },
  ]);
  assert.deepEqual(readdirSync(path.join(dir, "inbox")), ["003.json"], "a half-written file waits for the next round");
  b.pump();
  assert.equal(sent.length, 2, "not twice");
});

test("a relayed permission prompt waits in perms/ until JARVIS answers it", () => {
  const { p, ppid } = fake();
  const sent = [];
  const b = new Bridge(p, ppid, (m) => sent.push(m), () => 1000);
  b.attach(SID);
  const dir = path.join(p.root, SID);
  handle({ method: "notifications/claude/channel/permission_request", params: { request_id: "ssuce", tool_name: "Bash", description: "Create file", input_preview: "touch x" } }, true, b);
  handle({ method: "notifications/claude/channel/permission_request", params: { request_id: "../evil", tool_name: "Bash" } }, true, b);
  assert.deepEqual(readdirSync(path.join(dir, "perms")), ["ssuce.json"]);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "perms", "ssuce.json"), "utf8")).tool_name, "Bash");
  writeFileSync(path.join(dir, "answers", "nope1"), "allow"); // no such prompt
  writeFileSync(path.join(dir, "answers", "ssuce"), "allow\n");
  b.pump();
  assert.deepEqual(sent, [{ jsonrpc: "2.0", method: "notifications/claude/channel/permission", params: { request_id: "ssuce", behavior: "allow" } }]);
  assert.deepEqual(readdirSync(path.join(dir, "perms")), []);
  assert.deepEqual(readdirSync(path.join(dir, "answers")), []);
});

test("old prompts and uploads are swept; /clear moves the folder; closing removes it", () => {
  const { p, ppid } = fake();
  let now = Date.now();
  const b = new Bridge(p, ppid, () => {}, () => now);
  b.attach(SID);
  const dir = path.join(p.root, SID);
  writeFileSync(path.join(dir, "perms", "old.json"), "{}");
  const t = (Date.now() - 20 * 60 * 1000) / 1000;
  utimesSync(path.join(dir, "perms", "old.json"), t, t);
  writeFileSync(path.join(dir, "perms", "new.json"), "{}");
  b.sweep();
  assert.deepEqual(readdirSync(path.join(dir, "perms")), ["new.json"]);
  b.attach(SID2);
  assert.equal(existsSync(dir), false);
  assert.ok(existsSync(path.join(p.root, SID2, "perms", "new.json")));
  b.close();
  assert.equal(existsSync(path.join(p.root, SID2)), false);
});

test("as a process: answers MCP, and without the channel flag makes no folder", async () => {
  const { p } = fake(["claude"], process.pid);
  const server = fileURLToPath(new URL("../server/bridge.mjs", import.meta.url));
  const child = spawn(process.execPath, [server], { env: { ...process.env, JARVIS_BRIDGE_HOME: p.home, JARVIS_BRIDGE_PROC: p.proc }, stdio: ["pipe", "pipe", "inherit"] });
  let outBuf = "";
  child.stdout.on("data", (d) => (outBuf += d));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  await new Promise((r) => setTimeout(r, 400));
  child.stdin.end();
  await new Promise((r) => child.on("close", r));
  const reply = JSON.parse(outBuf.split("\n")[0]);
  assert.equal(reply.result.serverInfo.name, "jarvis-bridge");
  assert.equal(existsSync(p.root), false);
});
