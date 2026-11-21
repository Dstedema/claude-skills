// PostToolUse (Bash) hook: after a `git push` in a Business Central AL repo, index that repo's
// AL code into Trilium (the "AL Codebases" tree), so the reference there follows what is shared.
//
// The indexer itself is JARVIS' (`npm run al:index`, src/tools/code/al). It needs tree-sitter
// and an AL grammar, which a plugin can't install, so this hook calls it in the Jarvis checkout
// named by the plugin option `jarvis_dir`. It runs detached in the background: the push is
// done already, and indexing a few hundred objects takes seconds to minutes. The output goes
// to a log file; Claude gets one line saying it started and where the log is.
//
// Only after a push (not every commit): what goes to Trilium is what is shared.
// Does nothing unless: the vault is set to trilium, the repo has an app.json, and `jarvis_dir`
// points to a Jarvis checkout that has the indexer and its node_modules.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { vaultKind, triliumSettings } = require("./vault-kind");

let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  try {
    run(JSON.parse(data.replace(/^﻿/, "").trim() || "{}"));
  } catch {
    // never break the session over a hook
  }
});

function run(input) {
  const cmd = (input.tool_input && input.tool_input.command) || "";
  if (!/\bgit\b[^\n|;&]*\bpush\b/.test(cmd) || /--dry-run|(^|\s)-n(\s|$)/.test(cmd)) return;
  if (vaultKind() !== "trilium") return;

  const root = repoRoot(workingDir(cmd, input.cwd || process.cwd()));
  if (!root || !isAlRepo(root)) return;

  const jarvis = (process.env.CLAUDE_PLUGIN_OPTION_JARVIS_DIR || process.env.JARVIS_DIR || "").trim();
  const problem = jarvisProblem(jarvis);
  if (problem) {
    say(`AL-code van ${path.basename(root)} is NIET naar Trilium (AL Codebases) geïndexeerd: ${problem}. ` +
      "Stel de plugin-optie jarvis_dir in (/plugin configure sharepoint-vault@jarvis) of draai `npm run al:index -- <repo>` in Jarvis.");
    return;
  }

  const { url, token } = triliumSettings();
  const insecure = /^(1|true|yes)$/i.test((process.env.CLAUDE_PLUGIN_OPTION_TRILIUM_INSECURE_TLS || "").trim()) ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0";
  const log = logFile(root);
  const out = fs.openSync(log, "a");
  fs.writeSync(out, `\n=== ${new Date().toISOString()} al:index ${root}\n`);

  const child = spawn("npm", ["run", "-s", "al:index", "--", root], {
    cwd: jarvis,
    detached: true,
    stdio: ["ignore", out, out],
    shell: process.platform === "win32",
    env: {
      ...process.env,
      TRILIUM_URL: url,
      TRILIUM_TOKEN: token,
      ...(insecure ? { TRILIUM_INSECURE_TLS: "true" } : {}),
    },
  });
  child.unref();
  say(`AL-code van ${path.basename(root)} wordt op de achtergrond naar Trilium (AL Codebases) geïndexeerd. Log: ${log}`);
}

/** The directory the command ran in: a leading `cd <dir> &&` wins over the session's cwd. */
function workingDir(cmd, cwd) {
  const m = cmd.match(/^\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*(&&|;)/);
  const dir = m ? (m[2] || m[3] || m[4]).replace(/^~(?=$|\/)/, os.homedir()) : cwd;
  return path.resolve(cwd, dir);
}

function repoRoot(dir) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** An AL app: app.json in the repo root with the fields a BC manifest always has. */
function isAlRepo(root) {
  try {
    const app = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8").replace(/^﻿/, ""));
    return Boolean(app.id && (app.idRanges || app.platform || app.runtime));
  } catch {
    return false;
  }
}

function jarvisProblem(dir) {
  if (!dir) return "plugin-optie jarvis_dir is leeg";
  if (!fs.existsSync(path.join(dir, "src", "tools", "code", "al", "run.ts")))
    return `in ${dir} staat de AL-indexer niet (src/tools/code/al); check de juiste branch uit`;
  if (!fs.existsSync(path.join(dir, "node_modules"))) return `in ${dir} ontbreekt node_modules (draai npm ci)`;
  return "";
}

function logFile(root) {
  const base = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), "sharepoint-vault")
    : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "sharepoint-vault");
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, `al-index-${path.basename(root).replace(/[^\w.-]+/g, "_")}.log`);
}

function say(text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } }));
}
