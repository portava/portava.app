// Single-scene adapter for Expo SDK 54. UIKit still posts application state
// notifications; forward delegate callbacks only (never duplicate notifications).
class PortavaSceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  private var app: AppDelegate? { UIApplication.shared.delegate as? AppDelegate }

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
             options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene, let app else { return }
    var options = app.portavaLaunchOptions ?? [:]
    if let context = connectionOptions.urlContexts.first {
      options[.url] = context.url
      options[.sourceApplication] = context.options.sourceApplication
      options[.annotation] = context.options.annotation
    }
    if let activity = connectionOptions.userActivities.first {
      options[.userActivityDictionary] = [
        "UIApplicationLaunchOptionsUserActivityKey": activity,
        "UIApplicationLaunchOptionsUserActivityTypeKey": activity.activityType
      ]
    }
    if let response = connectionOptions.notificationResponse {
      options[.remoteNotification] = response.notification.request.content.userInfo
    }
    _ = app.startPortavaApplication(UIApplication.shared, windowScene: windowScene, launchOptions: options)
    window = app.window
    window?.windowScene = windowScene
    window?.makeKeyAndVisible()
    // Expo Linking maintains its own initial URL registry in addition to React
    // Native's launchOptions. Seed both through their existing delegates.
    self.scene(scene, openURLContexts: connectionOptions.urlContexts)
    for activity in connectionOptions.userActivities { self.scene(scene, continue: activity) }
  }

  func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
    for context in contexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: context.options.openInPlace]
      options[.sourceApplication] = context.options.sourceApplication
      options[.annotation] = context.options.annotation
      _ = app?.application(UIApplication.shared, open: context.url, options: options)
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    _ = app?.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }

  func sceneDidBecomeActive(_ scene: UIScene) { app?.applicationDidBecomeActive(UIApplication.shared) }
  func sceneWillResignActive(_ scene: UIScene) { app?.applicationWillResignActive(UIApplication.shared) }
  func sceneWillEnterForeground(_ scene: UIScene) { app?.applicationWillEnterForeground(UIApplication.shared) }
  func sceneDidEnterBackground(_ scene: UIScene) { app?.applicationDidEnterBackground(UIApplication.shared) }
}
