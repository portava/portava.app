/**
 * podDeploymentTargetFloor — the Podfile patch behind plugins/withPodDeploymentTargetFloor.js,
 * kept pure (text in, text out) so src/lib/__tests__/podDeploymentTargetFloor.test.ts can
 * cover it without a generated ios/ directory.
 *
 * WHY: Xcode 27 refuses to build pod RESOURCE BUNDLE targets whose
 * IPHONEOS_DEPLOYMENT_TARGET is below iOS 15 — CocoaPods gives each one the
 * floor its podspec declares, not the app's. On 2026-11-04 the SDWebImage,
 * RNSVG, AsyncStorage and react-native-maps bundles stopped a Personal Team
 * build on Xcode 27.2 until IPHONEOS_DEPLOYMENT_TARGET=15.1 was passed to
 * xcodebuild by hand (docs/eas-runbook.md, "Local build with a Personal Team").
 * This raises every pod target below the app's own floor to it at `pod install`,
 * inside the Podfile's post_install, so `expo run:ios`, EAS and xcodebuild all
 * get the same project. Targets already at or above the floor are untouched.
 */
'use strict';

const TAG = 'portava-pod-deployment-target-floor';

/** The Ruby inserted into post_install; `platform :ios` in the same Podfile uses the same expression for the floor. */
const RUBY = `    # Raise every pod target below the app's deployment target to it (Xcode 27 refuses older resource bundles).
    floor = Gem::Version.new(podfile_properties['ios.deploymentTarget'] || '15.1')
    installer.generated_projects.each do |project|
      project.targets.each do |t|
        t.build_configurations.each do |bc|
          current = bc.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
          bc.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = floor.to_s if current.nil? || current.empty? || Gem::Version.new(current) < floor
        end
      end
    end`;

const BEGIN = `# @generated begin ${TAG} - expo prebuild (DO NOT MODIFY)`;
const END = `# @generated end ${TAG}`;
const ANCHOR = /^([ \t]*)react_native_post_install\(/m;

/**
 * Insert the floor loop just before `react_native_post_install(` inside post_install,
 * once: a Podfile that already carries the tagged block is returned unchanged, and a
 * Podfile without the anchor (not Expo's template) is returned unchanged too.
 */
function applyPodDeploymentTargetFloor(podfile) {
  if (podfile.includes(BEGIN)) return podfile;
  const m = ANCHOR.exec(podfile);
  if (!m) return podfile;
  const indent = m[1];
  const block = `${indent}${BEGIN}\n${RUBY}\n${indent}${END}\n`;
  return podfile.slice(0, m.index) + block + podfile.slice(m.index);
}

module.exports = { applyPodDeploymentTargetFloor, TAG, BEGIN, END };
