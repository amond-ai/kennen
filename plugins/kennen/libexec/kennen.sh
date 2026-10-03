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

# Project-local installs (`npm install -D @amond-ai/kennen`) resolve first.
PATH="$(pwd -P)/node_modules/.bin:$PATH"
export PATH

has_vault() {
  dir=$(pwd -P)
  while :; do
    [ -f "$dir/.kennen.yaml" ] && return 0
    [ "$dir" = / ] && return 1
    dir=$(dirname "$dir")
  done
}

if [ "${1:-}" = hooks ]; then
  command -v kennen >/dev/null 2>&1 || exit 0
  has_vault || exit 0
  exec kennen "$@"
fi

if ! command -v kennen >/dev/null 2>&1; then
  echo "kennen: command not found. Install it with 'npm install -g @amond-ai/kennen' and restart Claude Code." >&2
  exit 127
fi
exec kennen "$@"
