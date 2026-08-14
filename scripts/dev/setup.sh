#!/usr/bin/env bash
# Prepare a checkout or a git worktree for development.
#
# Run it by hand after a clone, or let a worktree manager run it. It reads no
# tool-specific state: .superset/config.json only names this path.
#
# This repository is deliberately not a package-manager workspace. The root is
# the publishable TypeScript package, and the Ruby gem plus both examples keep
# independent dependency state, so setup installs four separate trees.
#
# Order matters: example/expo resolves the package through "file:../.." and Bun
# snapshots the generated dist/ exports at install time, so the root package
# must be built before the example installs.
#
# Toolchain that is absent is skipped with a warning; a command that runs and
# fails is reported and makes setup exit non-zero.

set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root" || exit 1

failed=""
skipped=""

log() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

run_step() {
  local label="$1"
  shift
  local started=$SECONDS
  log "$label"
  if "$@"; then
    note "done in $((SECONDS - started))s"
  else
    note "FAILED after $((SECONDS - started))s"
    failed="${failed}  - ${label}"$'\n'
  fi
}

skip_step() {
  log "$1"
  note "skipped: $2"
  skipped="${skipped}  - ${1}: ${2}"$'\n'
}

# The main checkout, when this one is a git worktree. DEV_ROOT_CHECKOUT wins;
# a worktree manager can also supply its own variable; git answers otherwise.
root_checkout() {
  local root="${DEV_ROOT_CHECKOUT:-${SUPERSET_ROOT_PATH:-}}"

  if [ -z "$root" ]; then
    root="$(git worktree list --porcelain 2>/dev/null |
      sed -n 's/^worktree //p' | head -1)"
  fi

  [ -n "$root" ] && [ -d "$root" ] && [ "$root" != "$repo_root" ] || return 1
  printf '%s' "$root"
}

# Local env files are gitignored, so a fresh worktree never carries them. Expo
# CLI loads example/expo/.env* itself; the only variable this stack reads is
# EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN, which scripts/dev/run.sh sets on its own.
copy_local_env() {
  local root
  local rel
  local copied=0

  if ! root="$(root_checkout)"; then
    note "no separate main checkout; nothing to copy"
    return 0
  fi

  for rel in .env .env.local example/expo/.env example/expo/.env.local example/rails/.env; do
    if [ -f "$root/$rel" ] && [ ! -e "$repo_root/$rel" ]; then
      cp "$root/$rel" "$repo_root/$rel" || return 1
      note "copied $rel from $root"
      copied=1
    fi
  done

  [ "$copied" -eq 1 ] || note "the main checkout has no local env files"
}

install_package() { bun install --frozen-lockfile; }

build_package() { bun run build; }

install_expo_example() (
  cd "$repo_root/example/expo" && bun install --frozen-lockfile
)

install_gem() (
  cd "$repo_root/rails" &&
    BUNDLE_GEMFILE="$repo_root/rails/Gemfile" bundle install
)

# example/rails owns bin/setup. Use it instead of a second copy of its steps, so
# a change there applies here too. --skip-server keeps it from starting a server:
# the dev server belongs to scripts/dev/run.sh.
install_rails_example() (
  cd "$repo_root/example/rails" &&
    BUNDLE_GEMFILE="$repo_root/example/rails/Gemfile" bin/setup --skip-server
)

if ! command -v bun >/dev/null 2>&1; then
  printf 'bun is required and was not found on PATH. Install Bun 1.3.14 or newer.\n' >&2
  exit 1
fi

run_step "Copy local env files" copy_local_env
run_step "Install the TypeScript package" install_package
run_step "Build dist/ (example/expo installs from it)" build_package

if [ "${EXPO_TURBO_SETUP_SKIP_EXAMPLES:-0}" = "1" ]; then
  skip_step "Install example/expo" "EXPO_TURBO_SETUP_SKIP_EXAMPLES=1"
else
  run_step "Install example/expo" install_expo_example
fi

if ! command -v bundle >/dev/null 2>&1; then
  skip_step "Install the Ruby gem and example/rails" "bundler is not on PATH"
elif [ "${EXPO_TURBO_SETUP_SKIP_RUBY:-0}" = "1" ]; then
  skip_step "Install the Ruby gem and example/rails" "EXPO_TURBO_SETUP_SKIP_RUBY=1"
else
  run_step "Install the Ruby gem (rails/)" install_gem
  if [ "${EXPO_TURBO_SETUP_SKIP_EXAMPLES:-0}" = "1" ]; then
    skip_step "Install example/rails" "EXPO_TURBO_SETUP_SKIP_EXAMPLES=1"
  else
    run_step "Install example/rails" install_rails_example
  fi
fi

printf '\n==> Setup summary\n'
if [ -n "$skipped" ]; then
  printf '    Skipped:\n%s' "$skipped"
fi

if [ -n "$failed" ]; then
  printf '    Failed:\n%s' "$failed"
  printf '\n    The checkout is incomplete. Fix the steps above and run this script again.\n'
  exit 1
fi

printf '    Ready. Checks: "bun run check" here, "bun run examples:check" for both examples.\n'
printf '    Dev stack: ./scripts/dev/run.sh [stack|rails|expo]\n'
