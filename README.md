# CLaude plugins

Personal Claude Code plugin marketplace for Dennis Stedema. Install once per
machine from this repo; updates arrive via `git pull` + `/plugin update`.

## Plugins

- **sharepoint-vault** — read/write the SharePoint-hosted second brain vault.
  Windows and WSL use the local OneDrive-synced folder (WSL via
  `/mnt/c/Users/*/OneDrive - BeBo Vloeren/...`); pure Linux/macOS use the
  Microsoft 365 connector. Ships hooks that enforce two rules: **vault-first** (consult the
  vault at session start, before working) and **update-the-vault after every
  git commit**. Hooks run `node` and inject a reminder into context; they need
  the plugin installed on a real Claude Code CLI (they don't fire in the Agent
  SDK environment, which has no plugin support).
- **bebo-docs** — turn a Markdown file into a Bebo-huisstijl `.html` + `.pdf`
  (red `#E30613` title page, numbered chapters, styled tables) with
  `node scripts/build-bebo-pdf.mjs <doc.md>`. Node only, no dependencies; the
  PDF renders via headless Edge or Chrome. Also carries the document standard:
  the GAC-compatible FO layout and Bebo's internal **FO 1.0 / FO 2.0** pro
  forma, plus an empty FO template.

## Install (per machine)

```
# in Claude Code
/plugin marketplace add <git-url-of-this-repo>
/plugin install sharepoint-vault@jarvis
```

For local development you can point at the folder directly:

```
/plugin marketplace add C:\Jarvis\jarvis-plugins        # Windows
/plugin marketplace add /path/to/jarvis-plugins          # Linux/macOS
```

## Update

```
git -C <repo> pull
/plugin update sharepoint-vault@jarvis
```

## Layout

```
jarvis-plugins/
  .claude-plugin/marketplace.json     # marketplace manifest (lists plugins)
  sharepoint-vault/                   # a plugin
    .claude-plugin/plugin.json        # plugin manifest
    skills/sharepoint-vault/SKILL.md  # the skill
  bebo-docs/
    .claude-plugin/plugin.json
    skills/bebo-docs/SKILL.md
    skills/bebo-docs/scripts/         # build-bebo-pdf.mjs
    skills/bebo-docs/assets/          # bebo-logo.png
    skills/bebo-docs/templates/       # functioneel-ontwerp.md
  README.md
```
