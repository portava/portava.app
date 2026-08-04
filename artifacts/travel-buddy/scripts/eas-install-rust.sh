#!/usr/bin/env bash
# E-1 EAS prebuild hook: install Rust + cross-compilation targets for OpenMLS.
#
# This script runs on EAS build workers (Linux x86_64) before expo prebuild.
# It is referenced in eas.json → build.[profile].prebuildCommand.
#
# Targets installed:
#   iOS:     aarch64-apple-ios (device), aarch64-apple-ios-sim (M1 simulator),
#            x86_64-apple-ios (Intel simulator)
#   Android: aarch64-linux-android (arm64), armv7-linux-androideabi (arm),
#            x86_64-linux-android (x86_64 emulator)
#
# If cargo is already installed (e.g. cached EAS worker), the rustup calls are
# fast no-ops. The script exits 0 on success, non-zero on any failure.

set -euo pipefail

echo "[eas-install-rust] Checking for Rust toolchain..."

if ! command -v cargo &>/dev/null; then
  echo "[eas-install-rust] cargo not found — installing rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
else
  echo "[eas-install-rust] cargo already installed at $(command -v cargo)"
fi

echo "[eas-install-rust] Rust version: $(rustc --version)"
echo "[eas-install-rust] Cargo version: $(cargo --version)"

# Android cross-compilation targets (always safe to add)
echo "[eas-install-rust] Adding Android targets..."
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android

# iOS targets — only meaningful on macOS EAS workers
if [[ "$(uname)" == "Darwin" ]]; then
  echo "[eas-install-rust] macOS detected — adding iOS targets..."
  rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
else
  echo "[eas-install-rust] Non-macOS host — skipping iOS targets"
fi

echo "[eas-install-rust] Installed targets:"
rustup target list --installed

echo "[eas-install-rust] Done."
