#!/usr/bin/env bash
# Build the OpenMLS Rust staticlib for iOS and generate the UniFFI Swift bindings.
#
# WHY THIS EXISTS, AND WHY IT LIVES *INSIDE* THE MODULE (2026-08-29)
# -----------------------------------------------------------------
# ExpoOpenmlsModule.swift calls eight free functions — generateIdentityKeyPair,
# generateDeviceKeyPair, generateKeyPackage, createGroup, processWelcome,
# encryptMessage, decryptMessage, deriveSafetyNumber. None of them are written by
# hand. They exist only in ios/Rust/uniffi/openmls/openmls.swift, which UniFFI
# generates from src/openmls.udl.
#
# ios/Rust/ is listed in this module's .gitignore, so it is never committed. The
# podspec globs `Rust/uniffi/openmls/*.swift` into source_files and expects
# `Rust/libexpo_openmls.a`. Nothing produced either. A fresh checkout therefore
# compiled ExpoOpenmlsModule.swift with the bindings absent and failed with
# "cannot find 'generateIdentityKeyPair' in scope" eight times over. Builds only
# ever worked on a machine where someone had generated ios/Rust/ by hand.
#
# The repo already had travel-buddy-standalone/scripts/build-rust-ios.sh, but it
# sits in the APP, not the module, so the copy of this package under node_modules
# never carried it — and nothing invoked it in any case. This script lives inside
# the module so it survives the copy into node_modules, which is where CocoaPods
# actually evaluates the podspec.
#
# Android solves the same problem in android/build.gradle
# (preBuild.dependsOn buildRustAndroid). This is the iOS counterpart.
#
# PATH: ~/.cargo/bin is NOT on PATH under Xcode's build environment or under a
# CocoaPods subshell. android/build.gradle resolves cargo explicitly for exactly
# this reason; so does this script. Do not replace it with a bare `cargo`.

set -euo pipefail

MODULE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$MODULE_DIR/ios/Rust"
UNIFFI_DIR="$OUT_DIR/uniffi/openmls"

log() { echo "[expo-openmls/build-ios] $*"; }

# --- resolve cargo -----------------------------------------------------------
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
if command -v cargo >/dev/null 2>&1; then
  CARGO="$(command -v cargo)"
elif [ -x "$CARGO_HOME_DIR/bin/cargo" ]; then
  CARGO="$CARGO_HOME_DIR/bin/cargo"
else
  echo "[expo-openmls/build-ios] FATAL: cargo not found." >&2
  echo "  looked on PATH and at $CARGO_HOME_DIR/bin/cargo" >&2
  echo "  install with travel-buddy-standalone/scripts/eas-install-rust.sh," >&2
  echo "  or set CARGO_HOME." >&2
  exit 1
fi
export PATH="$(dirname "$CARGO"):$PATH"

# --- which slices? -----------------------------------------------------------
# Xcode exports PLATFORM_NAME when this runs from a build phase. When it does
# not (pod install, manual run) build both so either destination links.
#
# Slices are kept in per-platform directories rather than lipo'd together: device
# and Apple-silicon simulator are BOTH arm64, so a single fat archive cannot hold
# them. The podspec selects with LIBRARY_SEARCH_PATHS=.../$(PLATFORM_NAME).
declare -a PLATFORMS
case "${EXPO_OPENMLS_IOS_PLATFORMS:-${PLATFORM_NAME:-all}}" in
  iphonesimulator) PLATFORMS=(iphonesimulator) ;;
  iphoneos)        PLATFORMS=(iphoneos) ;;
  *)               PLATFORMS=(iphonesimulator iphoneos) ;;
esac

triple_for() {
  case "$1" in
    iphonesimulator) echo "aarch64-apple-ios-sim" ;;
    iphoneos)        echo "aarch64-apple-ios" ;;
  esac
}

cd "$MODULE_DIR"

# --- up-to-date check --------------------------------------------------------
# The podspec runs this on every `pod install`; a full OpenMLS release build is
# minutes, so skipping a no-op matters. Newest source vs oldest required output.
newest_src=$(find src build.rs uniffi-bindgen.rs Cargo.toml Cargo.lock -type f -newer /dev/null -print0 2>/dev/null \
  | xargs -0 stat -f %m 2>/dev/null | sort -rn | head -1 || echo 0)
needs_build=0
[ -f "$UNIFFI_DIR/openmls.swift" ] || needs_build=1
[ -f "$UNIFFI_DIR/openmlsFFI.h" ] || needs_build=1
[ -f "$UNIFFI_DIR/openmlsFFI.modulemap" ] || needs_build=1
for p in "${PLATFORMS[@]}"; do
  [ -f "$OUT_DIR/$p/libexpo_openmls.a" ] || needs_build=1
done
if [ "$needs_build" -eq 0 ] && [ -n "$newest_src" ] && [ "$newest_src" != "0" ]; then
  oldest_out=$(find "$OUT_DIR" -name "*.a" -o -name "openmls.swift" 2>/dev/null \
    | xargs stat -f %m 2>/dev/null | sort -n | head -1 || echo 0)
  if [ -n "$oldest_out" ] && [ "$oldest_out" -gt "$newest_src" ]; then
    log "up to date — skipping (sources older than generated output)"
    exit 0
  fi
fi

# --- build -------------------------------------------------------------------
for p in "${PLATFORMS[@]}"; do
  triple="$(triple_for "$p")"
  log "cargo build --release --target $triple"
  "$CARGO" build --release --target "$triple"
  mkdir -p "$OUT_DIR/$p"
  cp "target/$triple/release/libexpo_openmls.a" "$OUT_DIR/$p/libexpo_openmls.a"
  log "  -> ios/Rust/$p/libexpo_openmls.a"
done

# --- generate the Swift bindings --------------------------------------------
# Architecture-independent, so generated once regardless of platform count.
log "generating UniFFI Swift bindings from src/openmls.udl"
mkdir -p "$UNIFFI_DIR"
"$CARGO" run --quiet --bin uniffi-bindgen -- \
  generate src/openmls.udl --language swift --out-dir "$UNIFFI_DIR"

# Fail loudly rather than let CocoaPods glob an empty directory and hand Xcode a
# module with no function definitions — the exact silent failure this fixes.
for required in openmls.swift openmlsFFI.h openmlsFFI.modulemap; do
  [ -f "$UNIFFI_DIR/$required" ] || {
    echo "[expo-openmls/build-ios] FATAL: uniffi-bindgen did not produce $required" >&2
    exit 1
  }
done

log "done: $OUT_DIR"
