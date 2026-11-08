#!/usr/bin/env bash
set -euo pipefail

# Install ccusage globally using the runtime already available on this computer.
if command -v bun >/dev/null 2>&1; then
  echo "Installing ccusage globally with Bun..."
  bun install -g ccusage
  export MYTOKEN_RUNTIME="bun"
elif command -v npm >/dev/null 2>&1; then
  echo "Installing ccusage globally with npm..."
  npm install -g ccusage
  export MYTOKEN_RUNTIME="npm"
else
  echo "Bun or npm is required. Install Bun or Node.js with npm, then rerun this command." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to download the local analyzer." >&2
  exit 1
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/mytoken.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
site_origin="${MYTOKEN_SITE_ORIGIN:-https://mytoken.gay}"
analyzer_url="${site_origin%/}/scripts/usage-audit.mjs"

curl -fsSL "$analyzer_url" -o "$work_dir/usage-audit.mjs"

if command -v bun >/dev/null 2>&1; then
  bun run "$work_dir/usage-audit.mjs"
elif command -v node >/dev/null 2>&1; then
  node "$work_dir/usage-audit.mjs"
else
  echo "No JavaScript runtime was found after installing ccusage." >&2
  exit 1
fi
