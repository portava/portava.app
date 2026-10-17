#!/bin/bash
set -euo pipefail
module_root="$(cd "$(dirname "$0")/.." && pwd)"
build_root="${1:?Pass an empty absolute output directory outside the checkout}"
case "$build_root" in /*) ;; *) printf 'An absolute output directory is required\n' >&2; exit 2 ;; esac
if [ -e "$build_root" ]; then
  printf 'Output directory must not already exist: %s\n' "$build_root" >&2
  exit 2
fi
mkdir -p "$build_root"
xcrun swiftc -swift-version 5 -O -module-cache-path "$build_root/module-cache" \
  "$module_root/ios/VideoCompressionCore.swift" "$module_root/ios/VideoCompressionScheduler.swift" \
  "$module_root/tests/NativeFixtureHarness.swift" \
  -o "$build_root/native-fixtures" > "$build_root/compile.log" 2>&1
"$build_root/native-fixtures" "$build_root/fixtures"
for sdk in iphoneos iphonesimulator; do
  target="arm64-apple-ios15.1"
  if [ "$sdk" = iphonesimulator ]; then target="$target-simulator"; fi
  xcrun --sdk "$sdk" swiftc -swift-version 5 -parse-as-library -whole-module-optimization -emit-object \
    -sdk "$(xcrun --sdk "$sdk" --show-sdk-path)" -target "$target" \
    -module-cache-path "$build_root/$sdk-cache" \
    "$module_root/ios/VideoCompressionCore.swift" "$module_root/ios/VideoCompressionScheduler.swift" \
    -o "$build_root/core-$sdk.o" \
    > "$build_root/compile-$sdk.log" 2>&1
  printf 'PASS actual %s SDK core object compile\n' "$sdk"
done
