internal import Expo
import React
import UIKit

// The window, and what the app switcher sees of it. ExpoAppSceneDelegate
// creates the window, starts React Native and forwards scene events.
@objc(SceneDelegate)
class SceneDelegate: ExpoAppSceneDelegate {
  // What the app switcher shows in place of the conversation.
  private var privacyCover: UIView?

  override func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard
      let windowScene = scene as? UIWindowScene,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factoryDelegate = appDelegate.reactNativeDelegate,
      let rootView = appDelegate.takeSceneLessRootView()
    else {
      super.scene(scene, willConnectTo: session, options: connectionOptions)
      return
    }
    // A Bluetooth relaunch already runs React Native in a view no window holds
    // (AppDelegate.startReactNativeWithoutScene), so show it rather than start
    // a second surface. JS is up, so links take the running app's path.
    let window = UIWindow(windowScene: windowScene)
    let controller = factoryDelegate.createRootViewController()
    factoryDelegate.setRootView(rootView, toRootViewController: controller)
    window.rootViewController = controller
    self.window = window
    appDelegate.window = window
    window.makeKeyAndVisible()

    if !connectionOptions.urlContexts.isEmpty {
      self.scene(scene, openURLContexts: connectionOptions.urlContexts)
    }
    for activity in connectionOptions.userActivities {
      self.scene(scene, continue: activity)
    }
  }

  // Cover the window before iOS photographs it for the app switcher.
  //
  // Backgrounding, never `sceneWillResignActive`: a permission prompt, a share
  // sheet and Control Center all resign active with the app still on screen,
  // and covering there dimmed the app behind every onboarding prompt. iOS takes
  // the snapshot after this returns, so there is no gap to be caught in.
  override func sceneDidEnterBackground(_ scene: UIScene) {
    super.sceneDidEnterBackground(scene)
    guard privacyCover == nil, let window else { return }
    // The launch storyboard, so the switcher shows what opening the app shows:
    // the mark on the system background, in the current appearance. No second
    // asset, and nothing to keep in step with the theme.
    guard
      let cover = UIStoryboard(name: "SplashScreen", bundle: nil)
        .instantiateInitialViewController()?.view
    else { return }
    cover.frame = window.bounds
    cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    window.addSubview(cover)
    privacyCover = cover
  }

  override func sceneWillEnterForeground(_ scene: UIScene) {
    super.sceneWillEnterForeground(scene)
    privacyCover?.removeFromSuperview()
    privacyCover = nil
  }
}
