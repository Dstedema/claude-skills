#!/bin/bash
# Configure a machine so every account - present and future - can use one
# shared LM Studio model library, and so LM Studio's own server is up on
# 127.0.0.1:1234 after login.
#
# Deliberately does NOT run llmster under systemd. LM Studio manages llmster
# itself (settings enableLocalService; .internal/llmster-pid.lock is held by
# the app), and a second instance only produces the dialog
# "LM Studio and llmster cannot run at the same time".
#
#   sudo ./setup.sh [--user <name>] [--models-dir <path>] [--no-autostart]
#
# Idempotent. Re-run after adding a user, or let the installed timer do it.
set -euo pipefail

GROUP=lmstudio
MODELS="${MODELS_DIR:-/srv/lmstudio/models}"
MARKETPLACE_REPO="${MARKETPLACE_REPO:-Dstedema/claude-skills}"
PLUGIN="${PLUGIN:-lmstudio-workers@jarvis}"
AUTOSTART_NAME=lm-studio-server.desktop
STAGE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
OWNER=""
AUTOSTART=1
MIN_UID=1000
MAX_UID=65533

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m    ok\033[0m %s\n' "$*"; }
warn() { printf '\033[33m    !\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mABORT: %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --user)        OWNER="${2:-}"; shift 2 ;;
        --models-dir)  MODELS="${2:-}"; shift 2 ;;
        --no-autostart) AUTOSTART=0; shift ;;
        -h|--help)     sed -n '2,16p' "$0"; exit 0 ;;
        *)             die "unknown option: $1" ;;
    esac
done

[ "$(id -u)" -eq 0 ] || die "run with sudo"
OWNER="${OWNER:-${SUDO_USER:-}}"
[ -n "$OWNER" ] || die "cannot tell which user owns the library; pass --user <name>"
id "$OWNER" >/dev/null 2>&1 || die "user $OWNER does not exist"
command -v setfacl >/dev/null || die "setfacl missing: apt install acl"

say "1/5  shared model library at $MODELS"
getent group "$GROUP" >/dev/null || groupadd --system "$GROUP"
install -d -m 0755 "$(dirname "$MODELS")"
install -d -o "$OWNER" -g "$GROUP" -m 2775 "$MODELS"
# setgid fixes the group of new files; the default ACL fixes the write bit,
# which is what actually lets a second user manage what someone else added.
setfacl -R -m "g:$GROUP:rwX" -m "d:g:$GROUP:rwX" "$MODELS"
ok "library ready (setgid + default ACL, group $GROUP)"

say "2/5  new accounts join $GROUP automatically"
CONF=/etc/adduser.conf
if [ -f "$CONF" ]; then
    cp -n "$CONF" "$CONF.bak" 2>/dev/null || true
    grep -qE '^\s*#?\s*EXTRA_GROUPS=' "$CONF" \
        && sed -i -E "s|^\s*#?\s*EXTRA_GROUPS=.*|EXTRA_GROUPS=\"$GROUP\"|" "$CONF" \
        || printf 'EXTRA_GROUPS="%s"\n' "$GROUP" >> "$CONF"
    grep -qE '^\s*#?\s*ADD_EXTRA_GROUPS=' "$CONF" \
        && sed -i -E 's|^\s*#?\s*ADD_EXTRA_GROUPS=.*|ADD_EXTRA_GROUPS=1|' "$CONF" \
        || echo 'ADD_EXTRA_GROUPS=1' >> "$CONF"
    ok "$(grep -hE '^(EXTRA_GROUPS|ADD_EXTRA_GROUPS)=' "$CONF" | tr '\n' ' ')"
else
    warn "no $CONF; the sync timer below covers it"
fi

say "3/5  home template for new accounts"
install -d -m 0755 /etc/skel/.lmstudio
python3 - "/etc/skel/.lmstudio/settings.json" "$MODELS" <<'PY'
import json, os, sys
path, models = sys.argv[1], sys.argv[2]
d = json.load(open(path)) if os.path.exists(path) else {}
d["downloadsFolder"] = models
json.dump(d, open(path, "w"), indent=2)
PY
chmod 0644 /etc/skel/.lmstudio/settings.json
ln -sfn "$MODELS" /etc/skel/.lmstudio/models
if [ "$AUTOSTART" -eq 1 ] && [ -f "$STAGE/$AUTOSTART_NAME" ]; then
    install -d -m 0755 /etc/skel/.config/autostart
    install -m 0644 "$STAGE/$AUTOSTART_NAME" "/etc/skel/.config/autostart/$AUTOSTART_NAME"
fi
ok "/etc/skel seeded"

say "4/5  account sync timer"
# Needed because /etc/adduser.conf only covers `adduser`; the GNOME Users panel
# goes through accountsservice -> useradd and ignores it entirely.
for f in lmstudio-usersync; do
    [ -f "$STAGE/$f" ] || die "$STAGE/$f missing"
    install -m 0755 "$STAGE/$f" /usr/local/bin/
done
sed -e "s|@MODELS@|$MODELS|g" -e "s|@GROUP@|$GROUP|g" \
    "$STAGE/lmstudio-usersync.service" > /etc/systemd/system/lmstudio-usersync.service
install -m 0644 "$STAGE/lmstudio-usersync.timer" /etc/systemd/system/
chmod 0644 /etc/systemd/system/lmstudio-usersync.service
systemctl daemon-reload
systemctl enable --now lmstudio-usersync.timer >/dev/null
ok "timer enabled (boot +2min, then hourly)"

say "5/5  existing accounts + Claude Code plugin declaration"
LMSTUDIO_MODELS="$MODELS" LMSTUDIO_GROUP="$GROUP" \
    LMSTUDIO_AUTOSTART="$([ "$AUTOSTART" -eq 1 ] && echo "$STAGE/$AUTOSTART_NAME" || echo '')" \
    /usr/local/bin/lmstudio-usersync | sed 's/^/    /'
install -d -m 0755 /etc/claude-code
python3 - "/etc/claude-code/managed-settings.json" "$MARKETPLACE_REPO" "$PLUGIN" <<'PY'
import json, os, sys
path, repo, plugin = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    d = json.load(open(path)) if os.path.exists(path) else {}
except (ValueError, OSError):
    d = {}
market = plugin.split("@")[-1] if "@" in plugin else repo.split("/")[-1]
d.setdefault("extraKnownMarketplaces", {})[market] = {
    "source": {"source": "github", "repo": repo}}
d.setdefault("enabledPlugins", {})[plugin] = True
json.dump(d, open(path, "w"), indent=2)
PY
chmod 0644 /etc/claude-code/managed-settings.json
ok "/etc/claude-code/managed-settings.json declares $PLUGIN for all users"

cat <<EOF

$(printf '\033[32m=== done ===\033[0m')

  library : $MODELS  (group $GROUP, shared read+write)
  server  : LM Studio serves 127.0.0.1:1234 itself$([ "$AUTOSTART" -eq 1 ] && echo ", autostarted at login")
  plugin  : declared for every user; each still installs Claude Code and logs
            in personally (curl -fsSL https://claude.ai/install.sh | bash)

A user added to $GROUP must log out and back in once before they can ADD
models. Reading and running inference works immediately.
EOF
