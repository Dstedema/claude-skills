# JARVIS plugins

Personal Claude Code plugin marketplace for Dennis Stedema. Install once per
machine from this repo; updates arrive via `git pull` + `/plugin update`.

## Plugins

- **sharepoint-vault** — read/write the SharePoint-hosted second brain vault.
  Windows uses the local OneDrive-synced folder; Linux/macOS use the Microsoft
  365 connector.

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
  README.md
```
