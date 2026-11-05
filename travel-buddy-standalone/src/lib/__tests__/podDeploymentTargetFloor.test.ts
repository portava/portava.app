/**
 * podDeploymentTargetFloor — the Podfile patch that keeps Xcode 27 building the
 * pod resource bundles (plugins/podDeploymentTargetFloor.js).
 *
 * The fixture is the post_install block of the Podfile `expo prebuild` generated
 * from this app on 2026-11-04 (expo 54 template plus maplibre's own tagged
 * insertion), so the anchor and the indentation are the real ones.
 *
 * Run: node --import tsx --test src/lib/__tests__/podDeploymentTargetFloor.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyPodDeploymentTargetFloor, BEGIN, END } = require('../../../plugins/podDeploymentTargetFloor.js') as {
  applyPodDeploymentTargetFloor: (podfile: string) => string;
  BEGIN: string;
  END: string;
};

const GENERATED = `platform :ios, podfile_properties['ios.deploymentTarget'] || '15.1'

prepare_react_native_project!

target 'Portava' do
  use_expo_modules!

  post_install do |installer|
# @generated begin @maplibre/maplibre-react-native:post-install - expo prebuild (DO NOT MODIFY) sync-6e76c80af0d70c0003d06822dd59b7c729fca472
    $MLRN.post_install(installer)
# @generated end @maplibre/maplibre-react-native:post-install
    react_native_post_install(
      installer,
      config[:reactNativePath],
      :mac_catalyst_enabled => false,
      :ccache_enabled => ccache_enabled?(podfile_properties),
    )
  end
end
`;

describe('applyPodDeploymentTargetFloor', () => {
  it('inserts one tagged block inside post_install, just before react_native_post_install, at its indentation', () => {
    const out = applyPodDeploymentTargetFloor(GENERATED);
    const begin = out.indexOf(BEGIN);
    const end = out.indexOf(END);
    const anchor = out.indexOf('    react_native_post_install(');
    const postInstall = out.indexOf('post_install do |installer|');
    assert.ok(begin > postInstall && end > begin && anchor > end, 'post_install < begin < end < anchor');
    assert.equal(out.split(BEGIN).length - 1, 1);
    assert.match(out, /^    # @generated begin portava-pod-deployment-target-floor/m);
    assert.match(out, /installer\.generated_projects\.each do \|project\|/);
    assert.match(out, /bc\.build_settings\['IPHONEOS_DEPLOYMENT_TARGET'\] = floor\.to_s if current\.nil\? \|\| current\.empty\? \|\| Gem::Version\.new\(current\) < floor/);
    // the floor is the same expression `platform :ios` uses, so the two never disagree
    assert.match(out, /floor = Gem::Version\.new\(podfile_properties\['ios\.deploymentTarget'\] \|\| '15\.1'\)/);
    // everything outside the block is byte-identical
    assert.equal(out.replace(/^    # @generated begin portava-pod-deployment-target-floor[\s\S]*?# @generated end portava-pod-deployment-target-floor\n/m, ''), GENERATED);
  });

  it('is idempotent: a second prebuild keeps exactly one copy', () => {
    const once = applyPodDeploymentTargetFloor(GENERATED);
    assert.equal(applyPodDeploymentTargetFloor(once), once);
  });

  it("leaves a Podfile without Expo's anchor alone rather than guessing where post_install is", () => {
    const foreign = "platform :ios, '15.1'\ntarget 'Portava' do\nend\n";
    assert.equal(applyPodDeploymentTargetFloor(foreign), foreign);
  });
});
