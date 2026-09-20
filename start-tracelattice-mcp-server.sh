#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

set -a
. "$script_dir/.env"
set +a

exec bun "$script_dir/dist/cli.js" "$@"
