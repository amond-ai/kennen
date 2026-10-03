#!/bin/sh
# Runs the kennen CLI from the Claude Code project directory so .kennen.yaml
# discovery walks upward from the project root, the same way hooks written by
# `kennen install --client claude` resolve the vault.
#
# Usage: kennen.sh <project-dir> mcp
#        kennen.sh <project-dir> hooks <event>
#
# Hook events exit 0 without output when kennen is not installed or no
# .kennen.yaml is found, so the plugin stays inert in projects without a vault.
set -u

project_dir=${1:-}
shift

if [ -n "$project_dir" ] && ! cd "$project_dir" 2>/dev/null; then
  [ "${1:-}" = hooks ] && exit 0
  echo "kennen: cannot enter project directory $project_dir" >&2
  exit 1
fi

# Project-local installs (`npm install -D @amond-ai/kennen`) resolve first,
# nearest node_modules/.bin winning, so a workspace package also finds a
# binary hoisted to the workspace root.
local_bins=
dir=$(pwd -P)
while :; do
  [ -d "$dir/node_modules/.bin" ] && local_bins="$local_bins:$dir/node_modules/.bin"
  [ "$dir" = / ] && break
  dir=$(dirname "$dir")
done
PATH="${local_bins#:}${local_bins:+:}$PATH"
export PATH

has_vault() {
  dir=$(pwd -P)
  while :; do
    [ -f "$dir/.kennen.yaml" ] && return 0
    [ "$dir" = / ] && return 1
    dir=$(dirname "$dir")
  done
}

# Yarn PnP installs have no node_modules/.bin, so dispatch through
# `yarn run -T`, the launch shape `kennen install` writes for Yarn PnP
# projects. The marker search stops at $HOME, matching the installer's detection.
uses_yarn_pnp() {
  command -v yarn >/dev/null 2>&1 || return 1
  dir=$(pwd -P)
  while :; do
    [ -f "$dir/.pnp.cjs" ] || [ -f "$dir/.pnp.loader.mjs" ] && return 0
    [ "$dir" = "${HOME:-/}" ] || [ "$dir" = / ] && return 1
    dir=$(dirname "$dir")
  done
}

has_kennen() {
  uses_yarn_pnp || command -v kennen >/dev/null 2>&1
}

run_kennen() {
  if uses_yarn_pnp; then
    exec yarn run -T kennen "$@"
  fi
  exec kennen "$@"
}

if [ "${1:-}" = hooks ]; then
  has_kennen || exit 0
  has_vault || exit 0
  run_kennen "$@"
fi

if ! has_kennen; then
  echo "kennen: command not found. Install it with 'npm install -g @amond-ai/kennen' (or as a project dependency) and restart Claude Code." >&2
  exit 127
fi
run_kennen "$@"
