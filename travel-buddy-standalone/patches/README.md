# Native dependency patches

`react-native-reanimated@4.1.7.patch` changes only Android CMake linking. The
published package imports Worklets from a hard-coded `intermediates/cmake`
directory, but this app's actual Gradle build emits that library under a hashed
`intermediates/cxx` directory. The full isolated app build reproduced the missing
`libworklets.so` failure after Worklets itself had compiled successfully.

The patch consumes Worklets' existing published Prefab target instead. Gradle
already declares the project dependency, and Worklets already publishes its
headers and library through Prefab. No JavaScript API, animation behavior,
compiler safety option or dependency version is changed. pnpm applies and hashes
the patch from `pnpm-workspace.yaml` and the lockfile; do not edit shared installed
dependencies by hand.

Primary upstream context: [Reanimated4.1.7 CMake source](https://github.com/software-mansion/react-native-reanimated/blob/4.1.7/packages/react-native-reanimated/android/CMakeLists.txt),
[Worklets0.5.1 Gradle source](https://github.com/software-mansion/react-native-reanimated/blob/worklets-0.5.1/packages/react-native-worklets/android/build.gradle).

Validation is recorded in `docs/media/completion-work-20261105.md` at the repository
root. Remove this patch only after an upstream version resolves the same linking
path and a clean native build passes without it.
