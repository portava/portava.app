#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Runs the repo on the Node major it deploys and CI tests on, then installs both
# workspaces. The major is read from .replit (`modules = ["nodejs-N", …]`),
# the same source every workflow's NODE_VERSION follows, so there is no second
# pin here to drift. src/test/nodeRuntimePin.test.ts (api-server) checks that.
#
# Why: the cloud container's default Node is 22. On Node 22 the api-server
# suite cannot load travel-buddy-standalone modules that import one another
# (discoveryClientRouteE2E fails with a misleading "does not provide an export
# named" error), and the standalone's node:test files do not load at all
# (census-discovery §76.5).
#
# Idempotent: a Node already installed under the cache directory is reused.
# Never blocks the session: if Node cannot be fetched it warns and leaves the
# existing runtime in place, and the runtime-pin test names the problem.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

warn() { echo "session-start: $*" >&2; }

PIN=$(sed -n 's/^modules[[:space:]]*=.*"nodejs-\([0-9][0-9]*\)".*/\1/p' .replit | head -n 1)
if [ -z "$PIN" ]; then
  warn '.replit declares no "nodejs-N" module; leaving Node as is.'
  exit 0
fi

current_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# Put Node $PIN first on PATH, from the cache or nodejs.org. Returns non-zero,
# after saying why, when it cannot; the caller then keeps the current runtime.
use_pinned_node() {
  local arch cache dir version tarball tmp
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) warn "unsupported architecture $(uname -m)."; return 1 ;;
  esac
  cache="${XDG_CACHE_HOME:-$HOME/.cache}/portava-node"
  mkdir -p "$cache" || { warn "cannot create $cache."; return 1; }
  dir=$(ls -d "$cache"/node-v"$PIN".*-linux-"$arch" 2>/dev/null | sort -V | tail -n 1 || true)
  if [ -z "$dir" ]; then
    version=$(curl -fsSL https://nodejs.org/dist/index.json \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).find(v=>v.version.startsWith("v"+process.argv[1]+"."));if(r)console.log(r.version)})' "$PIN" \
      || true)
    if [ -z "$version" ]; then warn "could not resolve the latest Node $PIN.x from nodejs.org."; return 1; fi
    tarball="node-$version-linux-$arch.tar.xz"
    tmp=$(mktemp -d)
    if ! curl -fsSL -o "$tmp/$tarball" "https://nodejs.org/dist/$version/$tarball" \
      || ! curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/$version/SHASUMS256.txt"; then
      rm -rf "$tmp"; warn "could not download Node $version."; return 1
    fi
    if ! (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c --status); then
      rm -rf "$tmp"; warn "Node $version failed its sha256 check; not installing it."; return 1
    fi
    tar -xJf "$tmp/$tarball" -C "$cache" || { rm -rf "$tmp"; warn "could not unpack Node $version."; return 1; }
    rm -rf "$tmp"
    dir="$cache/node-$version-linux-$arch"
  fi
  export PATH="$dir/bin:$PATH"
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$dir/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  fi
}

if [ "$(current_major)" != "$PIN" ] && ! use_pinned_node; then
  warn "staying on Node $(node --version); the api-server runtime-pin test will fail until Node $PIN is used."
fi

echo "session-start: node $(node --version) (pin: nodejs-$PIN from .replit)"

# pnpm is pinned by the root package.json's packageManager field.
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable --install-directory "$(dirname "$(command -v node)")" pnpm
fi

# Two independent workspace roots (docs/ci/README.md § "Runtime environment"):
# the repo root, and travel-buddy-standalone with its own lockfile.
pnpm install --frozen-lockfile
(cd travel-buddy-standalone && pnpm install --frozen-lockfile)
