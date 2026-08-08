require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoOpenmls'
  s.version        = package['version']
  s.summary        = package['description']
  s.author         = 'Portava'
  s.homepage       = 'https://portava.com'
  s.license        = 'MIT'
  s.platforms      = { ios: '15.0' }

  # Source: the directory containing this podspec
  s.source         = { path: '.' }

  # Swift sources: UniFFI-generated bindings + Expo module wrapper
  s.source_files   = 'ExpoOpenmls/**/*.{h,m,swift}'

  # Expo modules core dependency (provides Module, ModuleDefinition, etc.)
  s.dependency 'ExpoModulesCore'

  # Static Rust library produced by `cargo build --release --target aarch64-apple-ios`
  # (and lipo'd with x86_64-apple-ios-macabi for simulator).
  #
  # NOTHING CURRENTLY PRODUCES THIS FILE. `scripts/build-rust-ios.sh` would,
  # but nothing invokes it. This comment used to claim "EAS build runs
  # scripts/build-rust-ios.sh in the prebuildCommand" — that was never true and
  # could not have been: `prebuildCommand` overrides the arguments to `expo`,
  # not the shell, so a script path there is expanded into
  # `npx expo bash scripts/... --platform ios` and fails. It killed three
  # Android builds before being removed. Do not restore it.
  #
  # iOS needs the Rust build hooked from the iOS build itself — a podspec
  # `script_phase` here, or an Expo config plugin. Android does the equivalent
  # in android/build.gradle via preBuild.dependsOn buildRustAndroid.
  s.vendored_libraries = 'Rust/libexpo_openmls.a'

  # UniFFI-generated Swift bindings (produced alongside the Rust build)
  s.source_files   = [
    'ExpoOpenmls/**/*.{h,m,swift}',
    'Rust/uniffi/openmls/*.swift',
  ]

  # Swift must be enabled for Expo modules
  s.pod_target_xcconfig = {
    'SWIFT_VERSION'              => '5.9',
    'HEADER_SEARCH_PATHS'        => '"${PODS_ROOT}/Headers/Public/ExpoModulesCore"',
    'OTHER_LDFLAGS'              => '-lc++',
  }
end
