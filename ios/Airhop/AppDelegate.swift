internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Before JS runs, so no store is written into a folder a backup would take.
    Self.excludeFromBackup(.documentDirectory, "mmkv")
    Self.excludeFromBackup(.applicationSupportDirectory, "airhop")

    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    #if os(iOS) || os(tvOS)
      window = UIWindow(frame: UIScreen.main.bounds)
      factory.startReactNative(
        withModuleName: "main",
        in: window,
        launchOptions: launchOptions)
    #endif

    #if os(iOS)
      // Bluetooth state restoration, only on a restoration launch.
      //
      // iOS expects the manager with the matching restore identifier to exist
      // before this method returns, which React Native cannot do: the BLE module
      // is built by the bridge and its managers later still. Creating them here
      // unconditionally would raise the Bluetooth prompt on the splash screen, so
      // this is gated on the launch keys, which are present only when iOS is
      // waking us for BLE and therefore only when the permission already exists.
      // See AirhopBLERestoration in AirhopBLEModule.swift.
      if launchOptions?[.bluetoothCentrals] != nil
        || launchOptions?[.bluetoothPeripherals] != nil
      {
        AirhopBLERestoration.shared.prepare()
      }
    #endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Local state stays on this phone. MMKV (chat history, contacts, group and
  // channel keys) lives under Documents and Arti's guards and consensus under
  // Application Support, both of which iOS copies into iCloud and iTunes
  // backups by default. Restoring one would not bring Airhop back anyway, since
  // the identity is a this-device-only keychain item, so a backup only copies
  // the data off the phone. Moving phones belongs to an in-app transfer that
  // moves the identity rather than cloning it.
  //
  // Apple documents the flag per item and lets some file operations reset it,
  // so it goes on the folder and on everything already inside, every launch.
  private static func excludeFromBackup(_ base: FileManager.SearchPathDirectory, _ path: String) {
    let fileManager = FileManager.default
    guard
      let parent = try? fileManager.url(
        for: base,
        in: .userDomainMask,
        appropriateFor: nil,
        create: true
      )
    else { return }
    let root = parent.appendingPathComponent(path, isDirectory: true)
    try? fileManager.createDirectory(at: root, withIntermediateDirectories: true)

    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var items = [root]
    if let inside = fileManager.enumerator(at: root, includingPropertiesForKeys: nil) {
      for case let url as URL in inside {
        items.append(url)
      }
    }
    for var url in items {
      try? url.setResourceValues(values)
    }
  }

  // What the app switcher shows in place of the conversation.
  private var privacyCover: UIView?

  // Cover the window before iOS photographs it for the app switcher.
  //
  // Backgrounding, never `willResignActive`: a permission prompt, a share sheet
  // and Control Center all resign active with the app still on screen, and
  // covering there dimmed the app behind every onboarding prompt. iOS takes the
  // snapshot after this returns, so there is no gap to be caught in.
  //
  // App-delegate lifecycle, which UIKit calls only while there is no scene
  // manifest. Adopting UIScene moves this to sceneDidEnterBackground.
  public override func applicationDidEnterBackground(_ application: UIApplication) {
    super.applicationDidEnterBackground(application)
    guard privacyCover == nil, let window = window else { return }
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

  public override func applicationWillEnterForeground(_ application: UIApplication) {
    super.applicationWillEnterForeground(application)
    privacyCover?.removeFromSuperview()
    privacyCover = nil
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options)
      || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(
      application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(
      application, continue: userActivity, restorationHandler: restorationHandler) || result
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
    #if DEBUG
      return RCTBundleURLProvider.sharedSettings().jsBundleURL(
        forBundleRoot: ".expo/.virtual-metro-entry")
    #else
      return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
    #endif
  }
}
