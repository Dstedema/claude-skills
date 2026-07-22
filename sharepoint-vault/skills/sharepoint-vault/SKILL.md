---
name: sharepoint-vault
description: >-
  Read and write Dennis' second brain / instruction vault directly in
  SharePoint (Microsoft 365 connector), so the same vault is the source of
  truth across every machine. Use this whenever the task involves the vault,
  the "second brain", saving/recalling notes, project context, or standing
  instructions — instead of the local filesystem or the local memory MCP.
---

# SharePoint Vault — Dennis' second brain

The vault is a tree of Markdown notes that lives in **SharePoint / OneDrive for
Business** (tenant `bebovloeren.nl`), not on any single machine's local disk.
Reading and writing it through the Microsoft 365 connector means the same
second brain and standing instructions follow Dennis to every system.

## Where the vault lives

The vault is a SharePoint teamsite folder, surfaced two ways — **pick by
platform**:

- **Windows (PRIMARY) — local OneDrive-synced path:**
  `%OneDriveCommercial%\ai-development - claude-memory`
  (PowerShell: `$env:OneDriveCommercial`; expands per-user, e.g. Dennis =
  `C:\Users\dennis.stedema\OneDrive - BeBo Vloeren\...`). **Do not hardcode a
  username** — always resolve the env var so the path works for any user who
  has the shortcut synced. If `%OneDriveCommercial%` is empty, fall back to
  `%OneDrive%`, else `%USERPROFILE%\OneDrive - BeBo Vloeren`. This is an "Add
  shortcut to OneDrive" of the SharePoint folder, synced to disk. Read/write it
  with the normal file tools (Read/Write/Edit/Glob) — the OneDrive client syncs
  changes up to SharePoint automatically. No connector, no search index, no
  `driveId` needed. Prefer this whenever the path resolves and exists.
- **Linux / macOS / no local sync — Microsoft 365 connector:**
  Site `ai-development`, library `Gedeelde documenten`, folder `claude-memory`
  (https://hn5ad06de859a14.sharepoint.com/sites/ai-development/Gedeelde%20documenten/claude-memory).
  Two gotchas learned the hard way:
  1. `sharepoint_folder_search` for `claude-memory` may return the **OneDrive
     shortcut** in Dennis' personal drive, not the real folder. That shortcut
     item is a `remoteItem` and is **NOT traversable** via `read_resource`
     ("neither file nor folder"). Don't rely on it.
  2. Reach the real content instead via `sharepoint_search` (query = a
     distinctive note title/word). The returned hit carries the **real
     `driveId` + item id** of the ai-development site library — use those with
     `read_resource` (read) and `sharepoint_upload_file` /
     `sharepoint_update_file` (write). Cache that `driveId` for the session.
  3. This only works once the site has been **crawled into the search index**.
     A freshly-created/just-populated site can lag hours. If search returns
     nothing from the vault yet, say so and retry later — don't fabricate.

**Keep the existing vault structure** — this mirrors Dennis' local Obsidian
vault at `%USERPROFILE%\Documents\vault`. Do NOT invent a new layout;
replicate this tree and add to it in the same shape:

```
claude-memory/                 # = the vault root in SharePoint
  CLAUDE.md                    # vault-wide standing instructions (authoritative)
  templates/                   # note templates: permanent-note, session-log,
                               #   architecture-note, feature-note
  permanent/                   # permanent / evergreen notes
  logs/                        # session logs: YYYY-MM-DD-HHmm-<slug>.md
  chats/code/                  # raw Claude conversation exports
  <project>/                   # one folder per project (e.g. bebo, BC-Extentie)
    README.md | Index.md | Claude.md   # project entry point / instructions
    architecture/              # architecture & context notes
      (or Context/)            #   — BC-Extentie uses Context/ for the same role
      dependencies/.ai-summaries/   # generated dependency summaries (.json)
    Decisions/                 # decisions taken (one per note)
    Mistakes/                  # pitfalls / troubleshooting write-ups
    logs/                      # per-project session logs
    templates/                 # per-project templates
```

When creating a new note, place it in the folder its type dictates within the
relevant project (architecture → `architecture/`, a decision → `Decisions/`, a
session log → `logs/YYYY-MM-DD-HHmm-<slug>.md`, etc.), following the templates
in `templates/`. Do not migrate `.obsidian/` (per-machine app config).

## Tools (Microsoft 365 connector)

- `sharepoint_folder_search` — find the vault root / a subfolder by name.
- `sharepoint_search` — find a note by content/filename/metadata.
- `read_resource` — read full content from a URI returned by the searches.
- `sharepoint_create_folder` — make a new subfolder.
- `sharepoint_upload_file` — create a new note (new file).
- `sharepoint_update_file` — overwrite/append to an existing note.
- `sharepoint_rename_item` / `sharepoint_move_item` / `sharepoint_copy_item`
  / `sharepoint_delete_item` — housekeeping.

These are deferred tools — load their schemas with ToolSearch
(`select:mcp__claude_ai_Microsoft_365__sharepoint_search,...`) before calling.

## Read workflow (Windows primary = local path)

1. Glob/Grep/Read under the local vault root above (e.g. `**/*.md`, or a
   project subfolder like `bebo/`).
2. Answer from what you actually read — never invent vault content.
3. Connector path (Linux etc.): `sharepoint_search` → `read_resource` on the
   real file URI (see the gotchas above).

## Write workflow (Windows primary = local path)

1. Write/Edit the file directly under the local vault root; OneDrive syncs it up.
2. Place notes by type/project (architecture → `architecture/`, decision →
   `Decisions/`, session log → `logs/YYYY-MM-DD-HHmm-<slug>.md`), following the
   `templates/` shapes.
3. Use kebab-case filenames, `.md` extension; keep one idea per note and
   cross-link with `[[note-name]]`.
4. For anything destructive (delete/overwrite of a note you didn't just create),
   confirm with Dennis first.
5. Connector path (Linux etc.): `sharepoint_upload_file` (new) /
   `sharepoint_update_file` (existing, merge — don't clobber).

## Note format

Follow the vault's own `templates/` (permanent-note, session-log,
architecture-note, feature-note). Keep whatever frontmatter those templates use;
preserve `[[cross-links]]`. Don't impose a different schema on notes that
already have one.

## Instructions

`CLAUDE.md` at the vault root holds vault-wide standing instructions; each
project may also have its own `CLAUDE.md` / `Claude.md` / `README.md` /
`Index.md`. When starting substantive work, read the root `CLAUDE.md` and the
relevant project's entry note. Treat them as authoritative user guidance, second
only to what Dennis says in the live conversation.

## Migrating local → SharePoint

Lift the local second brain into the SharePoint vault by **mirroring the tree
verbatim** — same folders, same relative paths, same filenames. Do not
reshape it. It is idempotent-ish: re-running skips notes already present unless
content changed.

**Before anything: ASK for the source vault path.** Do not assume a location.
Ask Dennis where the source vault lives, offering `%USERPROFILE%\Documents\vault`
as the likely default, and use whatever he confirms. Only proceed once you have
an explicit path.

**Sources to sweep (in priority order):**
1. Local vault — the path Dennis just gave (default suggestion
   `%USERPROFILE%\Documents\vault`; already has the canonical structure above).
2. Local auto-memory — `~/.claude/projects/<project>/memory/*.md`. Fold these
   into the vault structure: `type: project` → the matching project's
   `architecture/` or a project note; `feedback`/instructions → root/project
   `CLAUDE.md` (append, don't clobber); `reference` → `permanent/`.
3. Session artifacts — notes/decisions/logs produced this session not yet saved.

**Procedure:**
0. Confirm the source vault path with Dennis (see above) before touching files.
1. On Windows: `robocopy "<source-vault>" "<synced-folder>" /E /XD .obsidian` copies the
   whole tree, structure preserved, in one shot. Elsewhere, resolve the vault
   root via the connector and recreate each file's relative path (create missing
   folders per level; treat "already exists" as success). Abort with a clear
   message if the root can't be resolved (e.g. site not yet indexed) — never
   fabricate success.
2. Preserve each file's existing frontmatter and `[[cross-links]]` byte-for-byte
   — no reformatting. **Skip `.obsidian/`** and other per-machine config/binaries.
3. Via connector: before uploading a file, check existence with
   `sharepoint_search`; if it exists, read it and `sharepoint_update_file` with
   a merge rather than overwriting.
4. Leave the vault's own `CLAUDE.md` / `Index.md` / `README.md` as the index —
   don't invent a separate one.
5. Report a summary: N files migrated, folders created, anything skipped/merged.
   Do **not** delete the local originals unless Dennis explicitly asks — leave
   them as a fallback until he confirms the SharePoint vault is good.

**Scope guard:** if the local set is large, `log`/report the count first and
migrate in batches; SharePoint writes are rate-limited, so pace uploads and
retry on throttling rather than failing the whole run.

## Caveats

- The connector is interactively authenticated; in headless/cron runs it may be
  unavailable. If so, say so plainly and fall back to local memory rather than
  fabricating vault data.
- If both a local vault and the SharePoint vault exist, SharePoint is the source
  of truth. Migrate local notes up rather than diverging.
