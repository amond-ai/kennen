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
pnp_root() {
  dir=$(pwd -P)
  while :; do
    if [ -f "$dir/.pnp.cjs" ] || [ -f "$dir/.pnp.loader.mjs" ]; then
      echo "$dir"
      return 0
    fi
    [ "$dir" = "${HOME:-/}" ] || [ "$dir" = / ] && return 1
    dir=$(dirname "$dir")
  done
}

# Sets kennen_cmd to `yarn` when the PnP workspace resolves kennen, else to
# `kennen` when it is on PATH (a global install), else leaves it empty.
resolve_kennen() {
  kennen_cmd=
  if command -v yarn >/dev/null 2>&1 && root=$(pnp_root) &&
    (cd "$root" && yarn bin kennen >/dev/null 2>&1); then
    kennen_cmd=yarn
  elif command -v kennen >/dev/null 2>&1; then
    kennen_cmd=kennen
  fi
}

run_kennen() {
  if [ "$kennen_cmd" = yarn ]; then
    exec yarn run -T kennen "$@"
  fi
  exec kennen "$@"
}

if [ "${1:-}" = hooks ]; then
  has_vault || exit 0
  resolve_kennen
  [ -n "$kennen_cmd" ] || exit 0
  run_kennen "$@"
fi

resolve_kennen
if [ -z "$kennen_cmd" ]; then
  echo "kennen: command not found. Install it with 'npm install -g @amond-ai/kennen' (or as a project dependency) and restart Claude Code." >&2
  exit 127
fi
run_kennen "$@"
