const test = require('node:test');
const assert = require('node:assert/strict');
const { applySceneLifecycle, sceneManifest } = require('./withPortavaSceneLifecycle');
const template = `import Expo
@UIApplicationMain
public class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    window = UIWindow(frame: UIScreen.main.bounds)
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}`;
test('scene configuration retains one application scene', () => {
  assert.equal(sceneManifest.UIApplicationSupportsMultipleScenes, false);
  assert.equal(sceneManifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication[0].UISceneDelegateClassName, '$(PRODUCT_MODULE_NAME).PortavaSceneDelegate');
});
test('SDK bootstrap transformation is idempotent and preserves original subscriber initialization', () => {
  const transformed = applySceneLifecycle(template);
  assert.equal(applySceneLifecycle(transformed), transformed);
  assert.equal((transformed.match(/return super.application\(application, didFinishLaunchingWithOptions: launchOptions\)/g) ?? []).length, 1);
  assert.match(transformed, /guard !portavaStarted else/);
  assert.match(transformed, /application.applicationState == .background/);
});
test('refuses a changed SDK template instead of emitting an app that cannot start', () => {
  assert.throws(() => applySceneLifecycle('class AppDelegate {}'), /unsupported AppDelegate/);
});
