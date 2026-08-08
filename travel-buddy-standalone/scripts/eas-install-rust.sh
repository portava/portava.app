#!/usr/bin/env bash
# E-1 EAS Rust toolchain hook: install Rust + cross-compilation targets for OpenMLS.
#
# HOW THIS IS INVOKED: via the `eas-build-pre-install` npm lifecycle hook in
# package.json. It is deliberately NOT referenced from eas.json.
#
# `prebuildCommand` in eas.json is an override for the *arguments to `expo`*,
# not a shell command: the build engine runs `npx expo <prebuildCommand>` and
# appends `--platform <p> --non-interactive`. Putting `bash scripts/...` there
# produced `npx expo bash scripts/eas-install-rust.sh --platform android`,
# which is not a command and failed every build. Keep the install here, in the
# lifecycle hook, and in exactly one place.
#
# Targets installed:
#   Android: aarch64-linux-android (arm64), armv7-linux-androideabi (arm),
#            x86_64-linux-android + i686-linux-android (emulators)
#   iOS:     aarch64-apple-ios (device), aarch64-apple-ios-sim (M1 simulator),
#            x86_64-apple-ios (Intel simulator) — macOS workers only
#
# If cargo is already installed (e.g. cached EAS worker), the rustup calls are
# fast no-ops. This script exits 0 ONLY with a toolchain it has verified works.

set -euo pipefail

fail() {
  echo "[eas-install-rust] FATAL: $*" >&2
  exit 1
}

echo "[eas-install-rust] Checking for Rust toolchain..."

if ! command -v cargo &>/dev/null; then
  echo "[eas-install-rust] cargo not found — installing rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path \
    || fail "rustup installer failed"
  [ -f "$HOME/.cargo/env" ] || fail "rustup installer left no $HOME/.cargo/env"
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
else
  echo "[eas-install-rust] cargo already installed at $(command -v cargo)"
fi

# Verify the toolchain actually WORKS before reporting success.
#
# These checks used to be written `echo "... $(rustc --version)"`. A non-zero
# exit inside a command substitution that only feeds `echo`'s arguments is
# swallowed — `echo` itself succeeds, so `set -e` never fires and the script
# printed "Done." over a compiler that could not run. Assign first, check the
# status, then print.
for tool in rustc cargo rustup; do
  command -v "$tool" &>/dev/null || fail "$tool is not on PATH after install"
done

rustc_version="$(rustc --version)" || fail "rustc --version failed — toolchain is unusable"
cargo_version="$(cargo --version)" || fail "cargo --version failed — toolchain is unusable"
[ -n "$rustc_version" ] || fail "rustc --version produced no output"
[ -n "$cargo_version" ] || fail "cargo --version produced no output"

echo "[eas-install-rust] Rust version: $rustc_version"
echo "[eas-install-rust] Cargo version: $cargo_version"

# Android cross-compilation targets (always safe to add)
echo "[eas-install-rust] Adding Android targets..."
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android \
  || fail "rustup target add failed for the Android targets"

# iOS targets — only meaningful on macOS EAS workers
if [[ "$(uname)" == "Darwin" ]]; then
  echo "[eas-install-rust] macOS detected — adding iOS targets..."
  rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios \
    || fail "rustup target add failed for the iOS targets"
else
  echo "[eas-install-rust] Non-macOS host — skipping iOS targets"
fi

installed_targets="$(rustup target list --installed)" \
  || fail "rustup target list --installed failed"

echo "[eas-install-rust] Installed targets:"
echo "$installed_targets"

# Confirm the targets the Android build actually compiles against are present.
# `rustup target add` succeeding is not by itself proof they landed, and a
# target missing here surfaces much later as an opaque cargo error.
for target in aarch64-linux-android armv7-linux-androideabi x86_64-linux-android; do
  grep -qx "$target" <<<"$installed_targets" \
    || fail "required Android target missing after install: $target"
done

echo "[eas-install-rust] Done — toolchain verified."
