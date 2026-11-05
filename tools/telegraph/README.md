# Local Telegraph verification

All fixtures use synthetic messages, local files and temporary infrastructure. They do not call production or change release flags.

## Browser outbox

Bundle `travel-buddy-standalone/src/features/telegraph/outbox/webStorage.ts` and `engine.ts` with the installed esbuild into a temporary directory, using IIFE globals `OutboxStorage` and `OutboxEngine`. Serve a static HTML page loading those two bundles from localhost. Run:

```
playwright-cli -s=telegraph-outbox open http://127.0.0.1:43195 --browser=chrome
playwright-cli -s=telegraph-outbox run-code --filename=/absolute/checkout/tools/telegraph/outbox-browser-check.js
```

The script exercises actual IndexedDB and WebCrypto: nonextractable keys, encrypted rows, reload/replay, exact prepared payloads, concurrent tab key creation, replacement-session isolation, account clearing during encryption, cancellation during a late write/send, and ciphertext tampering. The fixture does not assert full-screen rendering or native E2EE support in browsers.

## Native SQLCipher engine

Run `native-sqlcipher/prepare.py <installed-op-sqlite-package> <temporary-destination>` to copy the installed package and add the standalone test. Include its `android` directory as `:op-sqlite` in an isolated Expo/React Native validation project, and set that project's package.json to `"op-sqlite": { "sqlcipher": true, "fts5": true }`. Build `:op-sqlite:assembleDebugAndroidTest -PreactNativeArchitectures=arm64-v8a`, install the test APK on the selected synthetic emulator, and run `com.portava.telegraph.validation.CipherEngineTest` using AndroidJUnitRunner.

The instrumentation wrapper links the same compiled engine used by op-sqlite. It proves ciphertext on disk, wrong-key rejection, a real cipher version and correct-key recovery after reopen. It does not certify the app's JSI binding, signed release binary, physical-device lifecycle, or iOS runtime.

## KeyPackage transactions

From `artifacts/api-server`, run:

```
KEY_PACKAGES_POSTGRES_BIN=/opt/homebrew/opt/postgresql@17/bin node --import tsx/esm --test src/test/keyPackages.postgres.test.ts
node --import tsx/esm --test src/test/devicesKeyPackagePoolCounter.test.ts
```

The PostgreSQL suite creates a fresh socket-only cluster, applies the actual migration, and forces concurrent backends to wait on each other. It verifies publication/consume ordering, duplicate retries after consumption, actual inventory counts, rollback and privileges. A missing native binary path explicitly skips the integration suite and is not proof of transaction correctness.

## Native OpenMLS and app registration

The module's own `android/build.gradle` compiles the three supported Rust ABIs, stages `libexpo_openmls.so`, and generates Kotlin bindings with the packaged `uniffi.toml`. In an isolated Expo validation project that includes the copied module as `:expo-openmls`, run:

```
./gradlew :expo-openmls:assembleDebugAndroidTest -PreactNativeArchitectures=arm64-v8a
adb -s <synthetic-emulator> install -r <module>/android/build/outputs/apk/androidTest/debug/expo-openmls-debug-androidTest.apk
adb -s <synthetic-emulator> shell am instrument -w -r -e class expo.modules.openmls.FfiBar2InstrumentedTest expo.modules.openmls.test/androidx.test.runner.AndroidJUnitRunner
```

The five tests require a real Android runtime: they check ABI-compatible libraries inside installed APKs and dynamic loading, generated UniFFI calls, a two-party MLS round trip, and consumed-generation rejection after restoring the returned receive-state snapshot. The final test also requires the next generation to remain readable. Compile success alone is not a passing runtime result.

For iOS, `vendor/expo-openmls/scripts/build-ios.sh` generates Swift bindings and platform-specific static libraries under `ios/Rust/`. Its podspec invokes this before discovering sources and propagates the generated module map and static-library paths to consumers. The library-name configuration ships in the vendored package; generated files remain build artifacts.

App registration can be checked without prebuilding or mutating dependencies:

```
node node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js resolve --platform android --json
node node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js resolve --platform apple --json
node node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js react-native-config --platform android --json
node node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js react-native-config --platform ios --json
```

The app explicitly searches `./vendor` before recursive installed dependencies, ensuring patched OpenMLS is selected even when local dependency storage contains an older copy. Expo also discovers the local `modules/` directory: speech, Nearby and compression on both platforms, plus Android background upload. Their native source trees are re-included in Git. SQLCipher is enabled by the app package's `op-sqlite` configuration; the installed package remains unchanged. A real app build must use its own clean dependency installation: the SQLCipher iOS podspec locates app configuration by walking upward from the dependency's physical path, so dependencies symlinked from another checkout can read that other checkout's manifest. Runtime cipher capability still fails closed.

## Isolated full-app build

Use `stage-native-app.py <app-source> /tmp/<fresh-app-directory>` to capture current tracked and untracked source while excluding credentials, dotenv files, installed dependencies and native build outputs. It records source SHA-256 values. Then, inside that new directory:

```
pnpm install --frozen-lockfile --ignore-scripts --offline
node scripts/check-native-package-config.mjs
CI=1 EXPO_NO_TELEMETRY=1 EXPO_NO_DOTENV=1 node node_modules/expo/bin/cli prebuild --platform android --no-install
```

The native-config guard invokes the actual Expo and React Native resolvers, requires all local module registrations and patched vendored OpenMLS, and mirrors op-sqlite's physical-path manifest lookup. It refuses another checkout's manifest and refuses SQLCipher/FTS5 being disabled. It is also an EAS post-install hook, before native prebuild. `node --test scripts/check-native-package-config.test.mjs` exercises correct installation, shared-checkout symlinks, and missing cipher/search support. If an offline install lacks packages, fetch only declared public dependencies in this isolated directory with the same frozen lockfile; never install into shared node_modules.

Set the local `android/local.properties` SDK path and use the approved JDK/SDK/Gradle cache. For the November 5 local run, an isolated Gradle init script configured both `com.android.application` and `com.android.library` projects to use the already installed NDK `27.1.12297006`; op-sqlite otherwise requested AGP's absent `27.0.12077973` default. This validation-only override is passed with `-I /tmp/portava-integrated-native-init.gradle`, and does not modify installed dependency source or release configuration. Run `:app:assembleDebug -PreactNativeArchitectures=arm64-v8a --no-daemon --max-workers=2` with `SENTRY_DISABLE_AUTO_UPLOAD=true`. Keep source feature flags unchanged. Debug build signing uses generated local test credentials; no production signing or deployment is involved. Full app launch or JS bundle checks must use local/synthetic endpoints and no real account. Compiler outputs and a preflight success are distinct from passing installed-app runtime tests.

## Installed full-app runtime entry

`native-app-runtime.tsx` is a synthetic entry for the isolated copies above, never a shipped app entry. Copy it to the staging app root, back up that stage's package.json, and temporarily set `main` to that copied file. Start Expo's development server on loopback with `EXPO_NO_DOTENV=1 EXPO_OFFLINE=1 CI=1`, `--dev-client --localhost --port <port> --clear --max-workers 2`. CI disables file watching: restart with `--clear` after changing the fixture. Use ADB reverse for the selected Android emulator and launch its development-client URI; on iOS the development launcher accepts `simctl launch <device> com.passporttravelbuddy.app --initialUrl http://127.0.0.1:<port>`.

The installed app executes actual Hermes → Expo → UniFFI → Rust calls, and actual op-sqlite JSI calls. It verifies three native registrations, the cipher version, wrong-key refusal and reopen, credential-derived owners, safety-number agreement, exact Unicode/NUL plaintext, replay refusal from restored receive state, and a reply. iOS additionally opens a synthetic self-link and requires React Native Linking to receive it through the scene delegate. These are 11 Android / 12 iOS assertions. Generated private keys remain in RAM; the disposable encrypted database is deleted. Logs contain only names/results and the synthetic fixture URL. Stop Metro and restore the original stage manifest when finished.

The November 5 run also observed React Native AppState active → inactive → background → active while launching Settings and returning to the same iOS process. Both integrated debug builds and ordinary Expo Router bundles passed. Evidence, runtime results, source/binary hashes and screenshots are in `docs/telegraph/native-validation-20261105/`. This is not signed-release, physical-device, cold universal-link, push notification, or production-service certification.
