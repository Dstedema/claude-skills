// SessionStart hook — inject the vault-first standing rule into context.
// Resolves the SharePoint second-brain vault root across Windows (native),
// WSL (Windows OneDrive mounted under /mnt/c), and Linux/macOS synced folders.
// When a local copy is found it injects the CONCRETE path + most-recent logs so
// the model can act immediately; otherwise it falls back to connector guidance.
const fs = require("fs");
const path = require("path");

const VAULT_LEAF = "ai-development - claude-memory";

function candidateRoots() {
  const c = [];
  const env = process.env;

  // Windows (native) — resolve per-user OneDrive env vars, never hardcode a user.
  for (const v of [env.OneDriveCommercial, env.OneDrive]) {
    if (v) c.push(path.join(v, VAULT_LEAF));
  }
  if (env.USERPROFILE) {
    c.push(path.join(env.USERPROFILE, "OneDrive - BeBo Vloeren", VAULT_LEAF));
  }

  // WSL / Linux with the Windows OneDrive mounted under /mnt/c/Users/<user>/OneDrive*/
  const usersDir = "/mnt/c/Users";
  try {
    for (const u of fs.readdirSync(usersDir)) {
      const base = path.join(usersDir, u);
      let entries = [];
      try { entries = fs.readdirSync(base); } catch { /* not a dir / no access */ }
      for (const e of entries) {
        if (/^OneDrive/i.test(e)) c.push(path.join(base, e, VAULT_LEAF));
      }
    }
  } catch { /* no /mnt/c (not WSL) */ }

  // Native Linux/macOS OneDrive sync under $HOME (best-effort).
  if (env.HOME) c.push(path.join(env.HOME, "OneDrive - BeBo Vloeren", VAULT_LEAF));

  return c;
}

function findRoot() {
  for (const r of candidateRoots()) {
    try { if (fs.existsSync(path.join(r, "CLAUDE.md"))) return r; } catch { /* skip */ }
  }
  return null;
}

function recentLogs(root) {
  const found = [];
  const dirs = [path.join(root, "logs")]; // global logs/
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push(path.join(root, e.name, "logs")); // <project>/logs/
    }
  } catch { /* skip */ }
  for (const d of dirs) {
    try {
      for (const f of fs.readdirSync(d)) {
        if (f.endsWith(".md")) found.push(path.relative(root, path.join(d, f)));
      }
    } catch { /* no logs dir here */ }
  }
  // Log filenames are date-stamped (YYYY-MM-DD-HHMM-...), so lexical sort == chronological.
  return found.sort().reverse().slice(0, 3);
}

const root = findRoot();
let msg;
if (root) {
  const logs = recentLogs(root);
  msg = [
    "sharepoint-vault rule — VAULT-FIRST: before planning, reasoning, or writing code,",
    "consult the SharePoint second-brain vault FIRST. It is synced locally at:",
    "[" + root + "].",
    "Read its CLAUDE.md, the relevant <project>/Index.md + <project>/architecture/, and the",
    "most recent <project>/logs/" + (logs.length ? " (latest: " + logs.join(", ") + ")" : "") + ".",
    "Use the normal file tools (Read/Glob/Grep/Write/Edit) on that path — OneDrive syncs changes",
    "up to SharePoint automatically; no connector needed. Only then act. Don't work from",
    "assumptions — if it's not in the vault or the code, ask.",
    "After EVERY git commit, update the vault (session log + affected notes)."
  ].join(" ");
} else {
  msg = [
    "sharepoint-vault rule — VAULT-FIRST: before planning, reasoning, or writing code,",
    "consult the SharePoint second-brain vault FIRST. No locally-synced copy was found on this",
    "machine; reach it via the Microsoft 365 connector (sharepoint_search on a distinctive note",
    "title -> real driveId -> read_resource). When synced, Windows path = %OneDriveCommercial%\\" + VAULT_LEAF,
    "and WSL = /mnt/c/Users/<user>/OneDrive - BeBo Vloeren/" + VAULT_LEAF + ".",
    "Read the root CLAUDE.md, <project>/Index.md, <project>/architecture/, and recent",
    "<project>/logs/. Don't work from assumptions — if it's not in the vault or the code, ask.",
    "After EVERY git commit, update the vault (session log + affected notes)."
  ].join(" ");
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: msg
  }
}));
