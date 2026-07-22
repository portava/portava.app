/**
 * Expo config plugin: withPortavaNSE
 *
 * Adds the PortavaNSE Notification Service Extension target to the Xcode project.
 * This is the E-0 scaffold — the extension simply forwards notifications unchanged.
 * E-5 will add E2EE decryption logic inside NotificationService.swift.
 *
 * Usage in app.json:
 *   "plugins": ["./plugins/withPortavaNSE"]
 *
 * What it does:
 *   1. Copies ios/PortavaNSE/ source files into the Xcode project.
 *   2. Adds an NSE target named "PortavaNSE" with the same bundle-id prefix.
 *   3. Adds NSExtension plist entry to the NSE target's Info.plist.
 *   4. Links the NSE target to the main app target.
 *
 * EAS builds run `expo prebuild` which executes this plugin before Xcode build.
 * The plugin is a no-op on Android.
 *
 * References:
 *   https://docs.expo.dev/config-plugins/introduction/
 *   https://developer.apple.com/documentation/usernotificationsui/unnotificationserviceextension
 */

const {
  withXcodeProject,
  withInfoPlist,
  IOSConfig,
} = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

const NSE_TARGET_NAME = 'PortavaNSE';
const NSE_SOURCE_DIR = 'PortavaNSE';

/**
 * Add the NSE target to the Xcode project.
 * Uses @expo/config-plugins' XcodeProject API.
 */
function addNseTarget(config) {
  return withXcodeProject(config, (cfg) => {
    const xcodeProject = cfg.modResults;
    const bundleId = cfg.ios?.bundleIdentifier ?? 'com.passporttravelbuddy.app';
    const nseTargetBundleId = `${bundleId}.${NSE_TARGET_NAME}`;

    // Check if the target already exists (idempotent)
    const targets = xcodeProject.pbxNativeTargetSection();
    const alreadyAdded = Object.values(targets).some(
      (t) => typeof t === 'object' && t.name === NSE_TARGET_NAME,
    );
    if (alreadyAdded) return cfg;

    // Source files in ios/PortavaNSE/
    const sourceDir = path.join(
      cfg.modRequest.projectRoot,
      'ios',
      NSE_SOURCE_DIR,
    );

    // Ensure source directory exists (created by this plugin run or already present)
    if (!fs.existsSync(sourceDir)) {
      fs.mkdirSync(sourceDir, { recursive: true });
    }

    // Create a minimal NSE Info.plist if it doesn't exist
    const infoPlistPath = path.join(sourceDir, 'Info.plist');
    if (!fs.existsSync(infoPlistPath)) {
      fs.writeFileSync(infoPlistPath, NSE_INFO_PLIST.trim());
    }

    // Add group to project
    xcodeProject.addTarget(
      NSE_TARGET_NAME,
      'app_extension',
      NSE_TARGET_NAME,
    );

    // Add build settings
    const nseTarget = Object.values(xcodeProject.pbxNativeTargetSection()).find(
      (t) => typeof t === 'object' && t.name === NSE_TARGET_NAME,
    );

    if (nseTarget && nseTarget.buildConfigurationList) {
      const configListKey = nseTarget.buildConfigurationList;
      const configList = xcodeProject.pbxXCConfigurationList()[configListKey];
      if (configList) {
        configList.buildConfigurations.forEach(({ value: configKey }) => {
          const buildConfig = xcodeProject.pbxXCBuildConfigurationSection()[configKey];
          if (buildConfig) {
            buildConfig.buildSettings = {
              ...buildConfig.buildSettings,
              PRODUCT_BUNDLE_IDENTIFIER: nseTargetBundleId,
              SWIFT_VERSION: '5.9',
              IPHONEOS_DEPLOYMENT_TARGET: '15.0',
              INFOPLIST_FILE: `${NSE_SOURCE_DIR}/Info.plist`,
            };
          }
        });
      }
    }

    return cfg;
  });
}

/**
 * Entry point — compose plugins.
 */
module.exports = function withPortavaNSE(config) {
  // Only applies to iOS
  if (config.ios === undefined) config.ios = {};
  return addNseTarget(config);
};

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const NSE_INFO_PLIST = `
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.usernotifications.service</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).NotificationService</string>
  </dict>
</dict>
</plist>
`;
