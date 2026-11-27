# >>> jarvis-bridge >>>
# Start claude with the JARVIS channel in an interactive terminal (also what
# VS Code types in "Use Terminal" mode). Left alone: -p/--print, piped input,
# and JARVIS_BRIDGE=0. Once jarvis-bridge@jarvis is on the org's
# allowedChannelPlugins, set JARVIS_BRIDGE_APPROVED=1 to skip the start prompt.
# The flag goes last: it takes every name after it, a prompt included.
claude() {
  local a
  if [ "${JARVIS_BRIDGE:-1}" = 0 ] || [ ! -t 0 ] || [ ! -t 1 ]; then command claude "$@"; return; fi
  for a in "$@"; do
    case "$a" in
      # print mode, help, an own channel choice, "--" (the flag would land after
      # it), and the subcommands: no channel.
      -p|--print|--channels|--channels=*|--dangerously-load-development-channels*|-h|--help|-v|--version|--) command claude "$@"; return ;;
      mcp|plugin|plugins|auth|update|doctor|config|install|setup-token|migrate-installer) command claude "$@"; return ;;
      --*) ;;
      # combined short flags with p (-cp)
      -*p*) command claude "$@"; return ;;
    esac
  done
  if [ "${JARVIS_BRIDGE_APPROVED:-0}" = 1 ]; then
    command claude "$@" --channels plugin:jarvis-bridge@jarvis
  else
    command claude "$@" --dangerously-load-development-channels plugin:jarvis-bridge@jarvis
  fi
}
# <<< jarvis-bridge <<<
