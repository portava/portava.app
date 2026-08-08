# The EAS build — the gate between "wired" and "works"

**Status: not triggered. Requires an owner decision and an Expo account.**
Date: 2026-08-08

Everything from the Rust module to the UI call sites is wired and green in CI.
None of it has ever executed. This build is the single thing standing between
those two states.

---

## 1. What triggering it involves

### Prerequisite you must supply

**An Expo account with EAS access.** There is no way around this: EAS builds run
on Expo's cloud workers and require authentication. Concretely:

- `npx eas login` — interactive, needs the account's credentials.
- The project must be linked to an EAS project id (`eas init` if
  `app.json → expo.extra.eas.projectId` is not set).
- **iOS additionally needs an Apple Developer account** ($99/yr) for signing,
  even for an internal-distribution development build. EAS can manage
  credentials for you, but it needs the Apple ID.
- Android needs no external account — EAS generates a keystore.

**I cannot do any of this**, and would not without being asked: it authenticates
as you, spends build minutes, and produces artefacts under your account.

### The command

```bash
cd travel-buddy-standalone

# Android first — cheaper, faster, no Apple account needed.
npx eas build --profile development --platform android

# iOS once Android is green.
npx eas build --profile development --platform ios
```

`development` is the right profile: `developmentClient: true` produces a dev
build that Metro can attach to, which is what the two-device runbook assumes.

### Duration

- **Android: ~20–35 min.** Rust cross-compiles three targets from scratch on a
  cold worker; OpenMLS and its dependency tree are not small.
- **iOS: ~30–50 min.** Three more Rust targets plus a full Xcode build.
- Queue time on the free tier can exceed build time. Paid tiers are ~immediate.

Expect the **first** build to fail. Nothing in this toolchain has ever run.

### What it produces

- Android: an `.apk`/`.aab` installable on a device, downloadable from the
  build page.
- iOS: an `.ipa` for internal distribution, installable on registered devices.
- **Full build logs — which are the actual deliverable here.** The artefact
  matters less than whether `cargo build` and `uniffi-bindgen` succeeded, and
  the logs are where that is visible.

---

## 2. One change to `eas.json` you must make — I have not made it

`eas.json` is deployment config and is outside what I was permitted to change,
so this is specified rather than applied.

All three profiles currently run:

```json
"prebuildCommand": "bash scripts/eas-install-rust.sh"
```

That script installs the Rust toolchain and cross-compilation targets. **It does
not build anything.** Android is fine — `android/build.gradle` runs `cargo build`
and then `uniffi-bindgen` itself. **iOS has no equivalent**: the podspec expects
`ios/Rust/libexpo_openmls.a` and `ios/Rust/uniffi/openmls/*.swift`, and nothing
produces them.

`scripts/build-rust-ios.sh` (added this session) does produce them. For the iOS
build to work, the prebuild command must also run it:

```json
"prebuildCommand": "bash scripts/eas-install-rust.sh && bash scripts/build-rust-ios.sh"
```

`build-rust-ios.sh` exits 0 immediately on non-macOS, so this is safe to apply
to all profiles — the Android worker will skip it.

**Do the Android build first without this change** — it isolates the Rust
compile from the iOS packaging, so a failure points at one thing rather than two.

---

## 3. What a green build DOES prove

- The Rust compiles for real mobile targets (arm64/armv7 Android, arm64 iOS) —
  not just x86-64 Linux, which is all that has been shown so far.
- `uniffi-bindgen` runs in the real build and emits Swift/Kotlin.
- The generated bindings **compile** under Xcode/Kotlin. That is genuinely new:
  they have only ever been generated, never compiled.
- The static/shared library links into the app.
- Expo autolinking finds the module (this needed `expo-module.config.json`,
  which did not exist until this session — see §5).

## 4. What a green build does NOT prove

**A green build means "the bindings load", not "encryption works."** It is
necessary and nowhere near sufficient. Specifically it does not prove:

- That `generate_key_package` → `create_group` → `process_welcome` →
  `encrypt_message` → `decrypt_message` works **across the FFI boundary**. The
  Rust round trip passes in `cargo test`, in-process, with no UniFFI marshalling
  involved. Every string crossing that boundary is converted, and conversion
  bugs are invisible until executed.
- That two *devices* can talk. All 8 Rust tests run both sides in one process.
  Nothing has ever exchanged an MLS message between two machines.
- That state survives a real app lifecycle — the SecureStore round trip, process
  death, reinstall.
- That the safety number matches on two devices. That is runbook step 9 and it
  is the whole basis for turning verification UI back on.
- That any of the failure paths behave on device the way they do against the
  stub port.

**The build is the gate; the two-device runbook
(`docs/security/e2ee-verification-runbook.md`) is the proof.** A green build
means the runbook can finally be attempted.

---

## 5. Gaps found while preparing this, now fixed

Both would have failed the build, and neither was visible from CI:

1. **`expo-module.config.json` did not exist.** Expo autolinking uses it to
   discover a module's native code. Without it the module is never linked and
   `requireNativeModule('ExpoOpenmls')` throws — after a *successful* Rust
   build, which would have been a confusing failure to diagnose.
2. **`package.json` `main` pointed at `build/index.js`**, produced by a `build`
   script that is never run and a directory that does not exist. So
   `require('expo-openmls')` failed at the **JavaScript** layer, entirely
   independently of the native side. Now points at `src/index.ts`, which Metro
   transpiles directly.

That is the sixth and seventh "assumed-done that wasn't" in this workstream.
Both were found by reading the build path rather than by running anything, and
there is no reason to believe the list is complete — which is the argument for
running the Android build early and cheaply rather than perfecting more layers
first.
