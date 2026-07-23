// PostToolUse (Bash) hook — after a git commit, remind Claude to update the vault.
// Reads the tool-call JSON on stdin; only fires when the command was a git commit.
let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  let cmd = "";
  try {
    const clean = data.replace(/^﻿/, "").trim() || "{}";
    const input = JSON.parse(clean);
    cmd = (input.tool_input && input.tool_input.command) || "";
  } catch {
    // not parseable — do nothing
  }

  const isCommit = /\bgit\b[\s\S]*\bcommit\b/.test(cmd);
  const isNoop = /--dry-run/.test(cmd);
  if (!isCommit || isNoop) return;

  const msg = [
    "You just ran a git commit. sharepoint-vault rule — UPDATE THE VAULT NOW,",
    "before continuing: add a session-log entry at",
    "<project>/logs/YYYY-MM-DD-HHMM-<slug>.md (commit hash + summary + decisions",
    "taken + open items), and update any affected architecture/ Decisions/ Mistakes/",
    "notes with wikilinks. New knowledge not derivable from code -> a note."
  ].join(" ");

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: msg
    }
  }));
});
