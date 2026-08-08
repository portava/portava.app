#!/usr/bin/env bash
# EAS `eas-build-on-success` hook: upload source maps to Sentry, if — and only
# if — Sentry is actually configured to receive them.
#
# WHY THIS EXISTS
#
# The hook used to be `npx sentry-expo-upload-sourcemaps dist`, unconditional.
# It failed on every native build:
#
#   Could not resolve Sentry configuration. Set SENTRY_ORG, SENTRY_PROJECT and
#   SENTRY_URL environment variables ...
#   ELIFECYCLE Command failed with exit code 1.
#
# `eas-build-on-success` runs AFTER the APK has been built and uploaded, so the
# artefact was fine — but a non-zero exit here marks the whole build ERRORED.
# Build 0ff04c94 produced a perfectly good APK and reported failure for this
# reason alone. That destroys the signal: you cannot tell a real build failure
# from a telemetry hiccup when every build reports failure.
#
# `dist` was wrong too. It is the web/EAS-Update export directory and does not
# exist for a native build.
#
# WHY THIS ONE IS ALLOWED TO SKIP AND EXIT 0 — AND THE RUST BUILD IS NOT
#
# Source-map upload is telemetry about the artefact, not part of it. A build
# that skips it is still a correct build. A build that skips the Rust compile
# is an app with no encryption in it that looks shipped — which is why
# android/build.gradle now throws instead of skipping.
#
# The rule is not "never exit 0 early". It is "never claim you did something you
# did not do". So this skips loudly, names exactly what is missing, and never
# pretends an upload happened.

set -euo pipefail

note() { echo "[eas-upload-sourcemaps] $*"; }

# Sentry needs an auth token plus an org/project to attribute the upload to.
missing=()
[ -n "${SENTRY_AUTH_TOKEN:-}" ] || missing+=("SENTRY_AUTH_TOKEN")
[ -n "${SENTRY_ORG:-}" ]        || missing+=("SENTRY_ORG")
[ -n "${SENTRY_PROJECT:-}" ]    || missing+=("SENTRY_PROJECT")

if [ ${#missing[@]} -gt 0 ]; then
  note "SKIPPED — source maps were NOT uploaded."
  note "Missing: ${missing[*]}"
  note "Set them as EAS secrets (eas env:create) to enable upload."
  note "The build artefact is unaffected; this hook is telemetry only."
  exit 0
fi

# Only the web/EAS-Update export produces a `dist` directory. Native builds get
# their source maps from the Gradle/Xcode Sentry integration instead, which is
# configured through the @sentry/react-native Expo plugin — not from here.
if [ ! -d dist ]; then
  note "SKIPPED — source maps were NOT uploaded."
  note "No 'dist' directory: this is a native build, and native source maps are"
  note "uploaded by the @sentry/react-native Gradle/Xcode integration, not by"
  note "this hook. Nothing to do."
  exit 0
fi

note "Uploading source maps from ./dist to Sentry (${SENTRY_ORG}/${SENTRY_PROJECT})..."
if npx sentry-expo-upload-sourcemaps dist; then
  note "Upload complete."
else
  # Still non-fatal — a telemetry failure must not mark a good artefact as a
  # failed build — but say so unmistakably rather than swallowing it.
  note "WARNING: source-map upload FAILED. The build artefact is unaffected."
  note "Stack traces from this build will not be symbolicated in Sentry."
fi
