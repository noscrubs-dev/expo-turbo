#!/usr/bin/env bash

set -euo pipefail

export LC_ALL=C

usage() {
  echo "Usage: $0 <tests_root> <keep_count> <apply|dry-run>" >&2
}

if [ "$#" -ne 3 ]; then
  usage
  exit 2
fi

readonly tests_root="$1"
readonly keep_count="$2"
readonly mode="$3"

case "$keep_count" in
  ''|*[!0-9]*|0)
    echo "Refusing to prune: keep_count must be a positive integer." >&2
    exit 2
    ;;
esac

case "$mode" in
  apply|dry-run) ;;
  *)
    echo "Refusing to prune: mode must be exactly apply or dry-run." >&2
    exit 2
    ;;
esac

case "$tests_root" in
  /*) ;;
  *)
    echo "Refusing to prune: tests_root must be absolute." >&2
    exit 2
    ;;
esac

if [ "${tests_root##*/}" != "tests" ]; then
  echo "Refusing to prune: tests_root basename must be tests." >&2
  exit 2
fi

tests_parent="${tests_root%/*}"
readonly tests_parent
case "${tests_parent##*/}" in
  maestro|.maestro) ;;
  *)
    echo "Refusing to prune: tests_root parent must be maestro or .maestro." >&2
    exit 2
    ;;
esac

if [ -L "$tests_root" ]; then
  echo "Refusing to prune: tests_root must not be a symlink." >&2
  exit 2
fi

if [ ! -e "$tests_root" ]; then
  exit 0
fi

if [ ! -d "$tests_root" ]; then
  echo "Refusing to prune: tests_root must be a directory." >&2
  exit 2
fi

timestamp_names=()
for entry in "$tests_root"/*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  [ -d "$entry" ] || continue
  [ ! -L "$entry" ] || continue

  name="${entry##*/}"
  if printf '%s\n' "$name" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}$'; then
    timestamp_names+=("$name")
  fi
done

readonly timestamp_count="${#timestamp_names[@]}"
remove_count=$((timestamp_count - keep_count))
if [ "$remove_count" -lt 0 ]; then
  remove_count=0
fi
readonly remove_count

removed=0
if [ "$remove_count" -gt 0 ]; then
  while IFS= read -r name; do
    [ "$removed" -lt "$remove_count" ] || break
    candidate="$tests_root/$name"

    # Recheck the exact name and object type immediately before removal. This
    # keeps a changed entry or a symlink outside the deletion boundary.
    if ! printf '%s\n' "$name" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}$' ||
      [ ! -d "$candidate" ] || [ -L "$candidate" ]; then
      echo "WARNING: skipped changed Maestro entry: $candidate" >&2
      continue
    fi

    echo "Prune Maestro test directory: $candidate"
    if [ "$mode" = "apply" ]; then
      rm -rf -- "$candidate"
    fi
    removed=$((removed + 1))
  done < <(printf '%s\n' "${timestamp_names[@]}" | sort)
fi

root_kib="$(du -sk "$tests_root" 2>/dev/null | awk 'NR == 1 { print $1 }')"
case "$root_kib" in
  ''|*[!0-9]*)
    echo "WARNING: could not measure Maestro test storage: $tests_root" >&2
    ;;
  *)
    if [ "$root_kib" -gt 524288 ]; then
      echo "WARNING: Maestro test storage exceeds 512 MB after the retention check: $tests_root (${root_kib} KiB). No extra entries were deleted." >&2
    fi
    ;;
esac

exit 0
