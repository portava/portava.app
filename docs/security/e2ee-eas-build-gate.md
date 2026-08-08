# The EAS build — the gate between "wired" and "works"

**Status: triggered. Three Android builds run on 2026-08-08. None has yet
produced a verdict on the FFI boundary — see §6 for what each one actually
proved.**
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

## 2. `eas.json` — what must NOT go in it

> **This section previously told you to set `prebuildCommand`, and to extend it
> with a second script. That advice was wrong. Every build that followed it
> died in 46 seconds.** It is corrected below rather than deleted, because the
> wrong version was acted on and the reasoning matters.

**Do not set `prebuildCommand`. It is not a shell command.**

All three profiles used to carry:

```json
"prebuildCommand": "bash scripts/eas-install-rust.sh"
```

`prebuildCommand` overrides the *arguments passed to `expo`* — it does not give
you a shell to run in. eas-cli's own schema
(`packages/eas-json/schema/eas.schema.json`) states it plainly:

> Optional override of the prebuild command used by EAS. For example, you can
> specify `prebuild --template example-template`. `--platform` and
> `--non-interactive` will be added automatically by the build engine.

So the worker actually ran:

```
npx expo bash scripts/eas-install-rust.sh --platform android --non-interactive
```

which is not a command. Builds `e13073e9` and `581b033a` errored in the
**Prebuild** phase after 46 and 47 seconds, before a line of Rust compiled.
Neither was evidence about the FFI boundary; they never reached it.

**Where the toolchain install actually belongs:** the `eas-build-pre-install`
npm lifecycle hook in `travel-buddy-standalone/package.json`. It runs before
dependency install, and therefore before both prebuild and Gradle. It is
already there, and it is the only place it should be. Do not duplicate it.

### iOS is still not wired — and `prebuildCommand` is not the way to wire it

`scripts/eas-install-rust.sh` installs the toolchain and cross-compilation
targets. **It builds nothing.**

Android is covered: `vendor/expo-openmls/android/build.gradle` runs
`cargo build` and then `uniffi-bindgen` — and as of 2026-08-08 it is actually
attached to `preBuild`, so it runs at all. Before that it was a declared task
nothing depended on, and it had never executed.

**iOS has no equivalent.** The podspec expects `ios/Rust/libexpo_openmls.a` and
`ios/Rust/uniffi/openmls/*.swift`; `scripts/build-rust-ios.sh` produces them,
and nothing invokes it. It has to be hooked from the iOS build itself — a
podspec `script_phase`, or an Expo config plugin — **not** from
`prebuildCommand`.

**Do the Android build first.** It isolates the Rust compile from iOS
packaging, so a failure points at one thing rather than two.

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

---

## 6. Build record — 2026-08-08

Running the build early was the right call. It found three more.

| Build | Commit | Result | What it proved |
|---|---|---|---|
| `581b033a`, `e13073e9` | `5ca920fe` | errored in **Prebuild**, 46s / 47s | Nothing. `prebuildCommand` was expanded into `npx expo bash scripts/... --platform android`. See §2. |
| `0ff04c94` | `da562281` | errored in **Build success hook**, 24m — *after* producing an APK | Prebuild is fixed and Rust 1.97.1 installs on the worker. Nothing about the FFI boundary. |

**Build `0ff04c94` is the one to understand.** It produced a complete 323 MB
APK and was still marked ERRORED, because `eas-build-on-success` ran
`npx sentry-expo-upload-sourcemaps dist` and exited 1. Three separate facts,
which must not be merged:

1. The `prebuildCommand` fix worked — Prebuild passed, the toolchain installed.
2. The native build succeeded; the *build status* was errored by an unrelated
   post-build telemetry hook.
3. **The APK contained none of the E2EE code.** Had the hook not failed, this
   would have been a green build proving nothing.

Point 3 was established from the artefact, not inferred: no
`libexpo_openmls.so` among its 136 native libraries, and zero `openmls` or
`uniffi` symbols across its ten dex files (control: `expo/modules/av`, 253
hits). In the 594 KB build log, `cargo build` appears **zero** times and
`openmls` appears **once** — inside the echoed `package.json`.

Three more assumed-done-that-wasn't, all found this way:

8. **The module's native code was never committed.**
   `travel-buddy-standalone/.gitignore` carried bare `ios/` and `android/`
   patterns, which match a directory of that name at *any* depth — including
   `vendor/expo-openmls/ios/` and `vendor/expo-openmls/android/`.
   `git log --all` over those paths returned nothing. EAS uploaded the tracked
   part of the module, autolinking found a module declaring an Android target
   with no `android/` directory, and skipped it in silence.
9. **`buildRustAndroid` was declared but never scheduled.** Nothing depended on
   it. A task that exists is not a task that runs.
10. **Its `cargo not found` branch printed a message and returned 0** — the same
    false-green as the install script in §5's lineage.

### Reading a build result honestly

- A failure in **Prebuild**, **Install dependencies** or the **success hook** is
  a configuration failure. It says nothing about Rust or the FFI boundary.
- Only a failure inside `cargo build`, `uniffi-bindgen`, or the Kotlin/Swift
  compile of the generated bindings is a verdict on the integration approach.
- **A green build is not sufficient evidence on its own.** Confirm the artefact
  contains `lib/*/libexpo_openmls.so` and that `uniffi` symbols are present in
  the dex before believing it. Build `0ff04c94` is the reason that check exists.
- `eas build:view` lagged reality by roughly two hours on `0ff04c94`, reporting
  `in progress` long after the build finished. **Treat the artefact and the
  build logs as authoritative**, not the CLI status.

Build logs are fetchable without a browser:

```bash
curl -s -X POST https://api.expo.dev/graphql \
  -H "Content-Type: application/json" -H "Authorization: Bearer $EXPO_TOKEN" \
  -d '{"query":"query($id:ID!){builds{byId(buildId:$id){status logFiles}}}","variables":{"id":"<build-id>"}}'
```

The returned URL serves brotli-encoded JSON lines — fetch with `curl --compressed`.
