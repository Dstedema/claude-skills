#!/bin/bash
# One-file bootstrap for a clean Debian/Ubuntu box: LM Studio + Claude Code +
# the lmstudio-workers plugin + a shared model library for every account.
#
#   sudo bash bootstrap.sh
#   sudo bash bootstrap.sh --model qwen/qwen3-coder-30b
#
# Everything is fetched at run time, so you get current versions rather than
# whatever was frozen onto a stick:
#   * apt              python3, curl, git, acl
#   * lmstudio.ai      the LM Studio installer
#   * claude.ai        the Claude Code installer (always latest)
#   * GitHub           this repo: the plugin and the setup scripts
#   * LM Studio Hub    the model, only when you pass --model
#
# Options:
#   --user <name>        account that owns the library (default: the sudo caller)
#   --model <id>         download this model, e.g. qwen/qwen3-coder-30b.
#                        Omitted by default: models are tens of GB, so it is
#                        your explicit choice, not a side effect.
#   --lmstudio-version   override the LM Studio version to install
#   --models-dir <path>  default /srv/lmstudio/models
#   --skip-lmstudio      LM Studio already installed
#   --skip-claude        no internet for claude.ai, or installing it later
#   --no-autostart       do not autostart LM Studio at login
set -euo pipefail

REPO="${REPO:-Dstedema/claude-skills}"
BRANCH="${BRANCH:-main}"
PLUGIN_NAME=lmstudio-workers
MARKET=jarvis
# LM Studio publishes no "latest" endpoint, so a version is needed to build the
# installer URL. The app auto-updates itself after the first launch, so this
# only decides which build you start from - override with --lmstudio-version.
LMS_VERSION="${LMS_VERSION:-0.4.23-1}"
LMS_URL_BASE=https://installers.lmstudio.ai/linux/x64

OWNER="${SUDO_USER:-}"
MODEL=""
MODELS_DIR=/srv/lmstudio/models
SKIP_LMS=0
SKIP_CLAUDE=0
AUTOSTART_ARG=""

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m    ok\033[0m %s\n' "$*"; }
warn() { printf '\033[33m    !\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mABORT: %s\033[0m\n' "$*" >&2; exit 1; }
asuser() { sudo -u "$OWNER" -H bash -lc "$1"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --user)             OWNER="${2:-}"; shift 2 ;;
        --model)            MODEL="${2:-}"; shift 2 ;;
        --lmstudio-version) LMS_VERSION="${2:-}"; shift 2 ;;
        --models-dir)       MODELS_DIR="${2:-}"; shift 2 ;;
        --skip-lmstudio)    SKIP_LMS=1; shift ;;
        --skip-claude)      SKIP_CLAUDE=1; shift ;;
        --no-autostart)     AUTOSTART_ARG="--no-autostart"; shift ;;
        -h|--help)          sed -n '2,30p' "$0"; exit 0 ;;
        *)                  die "unknown option: $1" ;;
    esac
done

[ "$(id -u)" -eq 0 ] || die "run with sudo"
[ -n "$OWNER" ] || die "cannot tell which user this is for; pass --user <name>"
id "$OWNER" >/dev/null 2>&1 || die "user $OWNER does not exist"

say "0/5  prerequisites from apt"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq 2>/dev/null || warn "apt update failed; continuing with the current index"
apt-get install -y -qq python3 curl git acl ca-certificates >/dev/null 2>&1 \
    || die "could not install prerequisites (python3 curl git acl)"
ok "python3 $(python3 -c 'import sys;print(".".join(map(str,sys.version_info[:3])))'), curl, git, acl"

say "1/5  LM Studio"
if [ "$SKIP_LMS" -eq 1 ]; then
    warn "skipped (--skip-lmstudio)"
elif [ -x /opt/LM-Studio/lm-studio ]; then
    ok "already installed ($(dpkg-query -W -f='${Version}' lm-studio 2>/dev/null || echo present))"
else
    DEB="/tmp/LM-Studio-${LMS_VERSION}-x64.deb"
    URL="$LMS_URL_BASE/${LMS_VERSION}/LM-Studio-${LMS_VERSION}-x64.deb"
    echo "    downloading $URL"
    curl -fL --retry 3 -o "$DEB" "$URL" \
        || die "download failed. Check the version, or grab the .deb from
     https://lmstudio.ai/download and re-run with --skip-lmstudio after installing it."
    apt-get install -y -qq "$DEB" >/dev/null 2>&1 || { dpkg -i "$DEB" >/dev/null 2>&1; apt-get -f install -y -qq >/dev/null 2>&1; }
    [ -x /opt/LM-Studio/lm-studio ] || die "LM Studio did not install; try: apt install $DEB"
    rm -f "$DEB"
    ok "installed $LMS_VERSION (it will keep itself up to date from here)"
fi

say "2/5  this repo (plugin + setup scripts)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if git clone --depth 1 -b "$BRANCH" -q "https://github.com/$REPO.git" "$WORK/repo" 2>/dev/null; then
    ok "cloned $REPO@$BRANCH"
elif curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" \
      | tar -xz -C "$WORK" 2>/dev/null && mv "$WORK"/*-"$BRANCH" "$WORK/repo"; then
    ok "downloaded $REPO@$BRANCH as a tarball"
else
    die "could not fetch https://github.com/$REPO - no network?"
fi
SETUP="$WORK/repo/$PLUGIN_NAME/setup"
[ -x "$SETUP/setup.sh" ] || die "$PLUGIN_NAME/setup/setup.sh missing from the repo"

say "3/5  Claude Code"
if [ "$SKIP_CLAUDE" -eq 1 ]; then
    warn "skipped (--skip-claude)"
elif asuser 'command -v claude' >/dev/null 2>&1; then
    ok "already installed: $(asuser 'claude --version' 2>/dev/null | head -1)"
elif asuser 'curl -fsSL https://claude.ai/install.sh | bash' >/dev/null 2>&1; then
    ok "installed latest"
else
    warn "install failed. Later, as $OWNER: curl -fsSL https://claude.ai/install.sh | bash"
fi

say "4/5  machine-wide configuration"
MODELS_DIR="$MODELS_DIR" bash "$SETUP/setup.sh" --user "$OWNER" \
    --models-dir "$MODELS_DIR" $AUTOSTART_ARG

say "5/5  plugin and model"
if asuser 'command -v claude' >/dev/null 2>&1; then
    # Declared machine-wide by setup.sh; installing here makes it usable in this
    # account right away instead of at the next session.
    asuser "claude plugin marketplace add $REPO" >/dev/null 2>&1 || true
    if asuser "claude plugin install $PLUGIN_NAME@$MARKET" >/dev/null 2>&1; then
        ok "$PLUGIN_NAME installed for $OWNER (latest from $MARKET)"
    else
        warn "plugin install failed; as $OWNER run: claude plugin install $PLUGIN_NAME@$MARKET"
    fi
else
    warn "no claude yet; the plugin is declared and installs once it is present"
fi

if [ -z "$MODEL" ]; then
    warn "no --model given, so nothing was downloaded. Pick one in the LM Studio"
    warn "  app, or re-run with e.g. --model qwen/qwen3-coder-30b"
else
    echo "    downloading $MODEL - this is tens of GB and takes a while"
    if asuser "\$HOME/.lmstudio/bin/lms get '$MODEL' -y" 2>/dev/null; then
        ok "$MODEL downloaded into $MODELS_DIR"
    else
        warn "download failed. Open LM Studio once (it installs the lms CLI), then:"
        warn "  lms get $MODEL -y"
    fi
fi

cat <<EOF

$(printf '\033[32m=== done ===\033[0m')

As $OWNER:
  1. Open LM Studio once. It installs its CLI, picks a runtime for this
     hardware, and starts its server on 127.0.0.1:1234 by itself.
  2. Download a chat model if you have not: any instruct/coder model.
  3. claude  ->  /login
  4. Ask Claude to run worker_models to verify the workers.

Every account on this machine shares $MODELS_DIR. Someone added to the
lmstudio group must log out and back in once before they can ADD models.
EOF
