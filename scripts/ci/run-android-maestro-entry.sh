#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_dir

exec ruby "$script_dir/run-android-maestro-entry.rb"
