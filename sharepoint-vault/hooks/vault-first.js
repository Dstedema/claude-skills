// SessionStart hook — inject the vault-first standing rule into context.
// Fires when a new Claude window/session starts.
const msg = [
  "sharepoint-vault rule — VAULT-FIRST: before planning, reasoning, or writing code,",
  "consult the SharePoint second-brain vault FIRST. Read the vault root CLAUDE.md,",
  "the relevant <project>/Index.md and <project>/architecture/, and the most recent",
  "<project>/logs/ (or global logs/). Only then act. Don't work from assumptions —",
  "if it's not in the vault or the code, ask.",
  "Vault location: Windows = %OneDriveCommercial%\\ai-development - claude-memory",
  "(or the Documents\\vault junction); Linux/other = via the Microsoft 365 connector",
  "(sharepoint_search on a distinctive title -> real driveId -> read_resource).",
  "Also: after EVERY git commit, update the vault (session log + affected notes)."
].join(" ");

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: msg
  }
}));
