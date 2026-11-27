# jarvis-bridge

A Claude Code **channel** between a session on Dennis' dev machine and JARVIS,
his control room. With it, JARVIS can:

- put a message (and a screenshot) into a running session, also one that waits;
- show permission prompts and answer them (allow / deny); the prompt stays in
  the terminal too, and whichever answer comes first counts.

JARVIS reaches the machine over its own SSH key, which may only run
`jarvis-remote`; that script writes into `~/.claude/jarvis-bridge/<session>/`
and this server passes it on. Nothing listens on the network.

## Setup on the dev machine

1. Install: `claude plugin install jarvis-bridge@jarvis`.
2. Channels must be on for the organisation (`channelsEnabled`).
3. Add `shell/claude-bridge.sh` to `~/.bashrc`, so `claude` in a terminal
   starts with the channel. In VS Code set `claudeCode.useTerminal: true`:
   channels don't work in the VS Code panel (SDK mode).
4. Until `jarvis-bridge@jarvis` is on the org's `allowedChannelPlugins`, every
   start asks once to confirm "Loading development channels" (Enter). After
   that, set `JARVIS_BRIDGE_APPROVED=1`.

Sessions without the channel flag load the server too, but it stays a quiet
MCP server without tools.

Tests: `node --test test/`.
