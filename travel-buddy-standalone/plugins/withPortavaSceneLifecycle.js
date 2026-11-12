/** Expo SDK 54 single-window scene lifecycle adapter; see plugins/README-scenes.md. */
'use strict';
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const marker = '// @generated Portava scene lifecycle';
const launchSignature = `  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {`;
const sceneManifest = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [{
      UISceneConfigurationName: 'Portava',
      UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).PortavaSceneDelegate',
    }],
  },
};
function applySceneLifecycle(source) {
  if (source.includes(marker)) return source;
  if (!source.includes(launchSignature) || !source.includes('window = UIWindow(frame: UIScreen.main.bounds)')) {
    throw new Error('Portava scene plugin: unsupported AppDelegate bootstrap. Review the SDK template before building.');
  }
  const replacement = `${marker}
  var portavaLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?
  private var portavaStarted = false

${launchSignature}
    portavaLaunchOptions = launchOptions
    // Background notification/location launches may have no scene. Preserve
    // Expo's initialization in that case; a later scene reuses the same factory.
    if application.applicationState == .background {
      return startPortavaApplication(application, windowScene: nil, launchOptions: launchOptions)
    }
    return true
  }

  func startPortavaApplication(
    _ application: UIApplication,
    windowScene: UIWindowScene?,
    launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    guard !portavaStarted else { return true }
    portavaStarted = true
    portavaLaunchOptions = nil`;
  return source.replace(launchSignature, replacement)
    .replace('window = UIWindow(frame: UIScreen.main.bounds)',
      'window = windowScene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: UIScreen.main.bounds)')
    + '\n' + readFileSync(join(__dirname, 'PortavaSceneDelegate.swift'), 'utf8');
}
function withPortavaSceneLifecycle(config) {
  config = withInfoPlist(config, c => {
    c.modResults.UIApplicationSceneManifest = sceneManifest;
    return c;
  });
  return withAppDelegate(config, c => {
    if (c.modResults.language !== 'swift') throw new Error('Portava scene lifecycle requires the Swift Expo AppDelegate.');
    c.modResults.contents = applySceneLifecycle(c.modResults.contents);
    return c;
  });
}
module.exports = withPortavaSceneLifecycle;
module.exports.applySceneLifecycle = applySceneLifecycle;
module.exports.sceneManifest = sceneManifest;
