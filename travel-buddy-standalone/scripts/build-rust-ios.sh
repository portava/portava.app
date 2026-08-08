#!/usr/bin/env bash
# Build the OpenMLS Rust staticlib for iOS and generate the Swift bindings.
#
# Referenced by vendor/expo-openmls/ios/ExpoOpenmls.podspec, which expects
# Rust/libexpo_openmls.a and Rust/uniffi/openmls/*.swift to exist.
#
# THIS SCRIPT DID NOT EXIST. The podspec named it, nothing provided it, so the
# staticlib and the Swift bindings were never produced — the iOS module called
# functions that were never generated.
#
# Runs on EAS build workers (macOS) via eas.json -> prebuildCommand.
# NOTE: eas.json is deployment config and is intentionally NOT modified here;
# wiring this script into the prebuild command is a separate, explicit change.

set -euo pipefail

MODULE_DIR="$(cd "$(dirname "$0")/../vendor/expo-openmls" && pwd)"
OUT_DIR="$MODULE_DIR/ios/Rust"

cd "$MODULE_DIR"

if ! command -v cargo &>/dev/null; then
  echo "[build-rust-ios] cargo not found — run scripts/eas-install-rust.sh first" >&2
  exit 1
fi

TARGETS=(aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios)

echo "[build-rust-ios] building ${#TARGETS[@]} targets..."
for t in "${TARGETS[@]}"; do
  cargo build --release --target "$t"
done

mkdir -p "$OUT_DIR"

# Device slice; the simulator slices are lipo'd separately by the caller if needed.
cp "target/aarch64-apple-ios/release/libexpo_openmls.a" "$OUT_DIR/libexpo_openmls.a"

echo "[build-rust-ios] generating Swift bindings..."
cargo run --quiet --bin uniffi-bindgen -- \
  generate src/openmls.udl \
  --language swift \
  --out-dir "$OUT_DIR/uniffi/openmls"

echo "[build-rust-ios] done: $OUT_DIR"
