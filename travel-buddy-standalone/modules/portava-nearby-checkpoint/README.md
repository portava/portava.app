# Foreground trip nearby checkpoints

`PortavaNearbyCheckpoint` is an Expo local module for a direct Bluetooth GATT
exchange between explicitly opted-in members of the same trip. It supplies
observations to the authenticated server controller; it does not resolve people
offline, relay messages between peers, supply GPS coordinates, award stamps or
prove physical presence.

## Contract

- `capabilities()` reports hardware support separately from permission, radio
  state and usable scan/advertise support. It never requests permission. The iOS
  simulator is unsupported. iOS radio state is unknown until explicit start.
- `start({serviceUuid, characteristicUuid, token, expiresAtMs})` replaces the
  previous lease. Service must be a lowercase UUIDv4, characteristic must be
  `8c541bd6-c12b-4f73-8f4f-568b374daf25`, token must be64 lowercase hexadecimal
  bytes, and expiry must be a finite integral timestamp at most60seconds ahead.
  Promise resolves after advertising and scanning start; denial/failure rejects.
- `stop()` retires permission/start callbacks and releases managers, scans,
  advertisements, GATT connections and timeouts. Background/destruction also
  stop. A foreground return never restarts a session.
- `onCheckpoint` contains only `{token,rssi,observedAtMs}`. RSSI is a noisy input
  to server bucketing, not a distance measurement. `onState` contains `state`
  (`running`, `stopped`, `unavailable`) and an optional coarse `reason`.

The advertisement contains only the random service UUID. The token is a
read-only GATT characteristic. There is no device name, user/trip ID, GPS field,
bonding, background service, disk journal or analytics payload. Transient OS
peer identifiers only bound connections and duplicate work within one lease.
Two outgoing connections,64 peers, bounded reads and five-second connection
timeouts limit work. Both wall time and monotonic time constrain expiry.
Late callbacks are rejected by lease identity and lifecycle generation.

Android asks for Nearby Devices and location permission only on explicit start.
It intentionally does **not** assert `neverForLocation`, because proximity is
location related; this module does not request or read a GPS fix. iOS uses the
Bluetooth purpose string in app.json and no background Bluetooth capability.

## Local verification

November5: actual Expo54/ModulesCore3.0.30 Android bridge compilation, four JVM
policy tests and three Android36 emulator lifecycle tests pass. The instrumented
tests exercise expiration, idempotent stop, retired scan callbacks and unavailable
radio refusal. They cannot verify a physical BLE exchange.

The full Swift module, including its real Expo bridge and CoreBluetooth engine,
compiled to an iOS-simulator object against the rebuilt current-compiler Expo
core. Four host Swift policy fixtures pass. Autolinking resolves both platforms.
Evidence with source hashes:

- `/tmp/portava-android-toolchain/nearby-proof-2/evidence.json`
- `/tmp/portava-nearby-ios-validation/nearby-proof-1/evidence.json`
- Android bridge log: `/tmp/portava-nearby-android-build.log`

Repeatable fixture runners take an existing approved SDK and fresh output paths:

```sh
python3 tests/run-android-fixtures.py --output /tmp/new-nearby-proof \
  --sdk "$ANDROID_SDK_ROOT" --java-home "$JAVA_HOME" \
  --gradle /path/to/gradlew --gradle-cache /tmp/gradle-cache \
  --serial emulator-5580 --adb-server-port 5040
python3 tests/run-ios-fixtures.py --output /tmp/new-nearby-ios-proof \
  --expo-products /path/to/Debug-iphonesimulator/ExpoModulesCore \
  --clang-response-file /path/to/ExpoModulesCore/Objects-normal/arm64/common-args.resp
```

The Android runner refuses physical device serials, copies the production core,
checks exact executed-test counts and does not install SDKs or accept licenses.
The separate Expo project compile includes the bridge. The iOS runner compiles
the actual bridge, not an Expo stub; its dependency build must match Swift.

## Release acceptance

Keep `trip_nearby_checkpoints_enabled` off until migration4013 and compatible
server/client release are reviewed. A physical iOS/Android pair must verify real
same-trip exchange, permission denial and mid-prompt cancellation, Bluetooth off,
rotation, other-trip isolation, expiry, blur/background, account replacement and
server revocation. Emulator/compiler checks do not promote radio census rows.

Platform references: [Android permissions](https://developer.android.com/develop/connectivity/bluetooth/bt-permissions),
[Android GATT callbacks](https://developer.android.com/reference/android/bluetooth/BluetoothGattServerCallback),
[Apple peripheral-role constraints](https://developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/CoreBluetooth_concepts/PerformingCommonPeripheralRoleTasks/PerformingCommonPeripheralRoleTasks.html),
[Expo module lifecycle](https://docs.expo.dev/modules/module-api/).
