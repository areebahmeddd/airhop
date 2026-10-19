import CoreBluetooth
internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {
  // Created by SceneDelegate, which mirrors it here.
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  // React Native started for a Bluetooth relaunch, before any scene, waiting
  // for SceneDelegate to put it on screen.
  private var sceneLessRootView: UIView?

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

    #if os(iOS)
      // Bluetooth state restoration, once permission exists: a manager raises
      // the prompt otherwise. See AirhopBLERestoration in AirhopBLEModule.swift.
      if CBManager.authorization == .allowedAlways {
        AirhopBLERestoration.shared.prepare { [weak self] in
          self?.startReactNativeWithoutScene()
        }
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

  // The mesh starts when the root component mounts, and iOS may relaunch for
  // Bluetooth without connecting a scene, so React Native starts here in a view
  // no window holds yet. The first scene adopts it rather than mounting the app
  // a second time. A scene already up owns the start instead.
  private func startReactNativeWithoutScene() {
    guard
      sceneLessRootView == nil,
      UIApplication.shared.connectedScenes.isEmpty,
      let factory = reactNativeFactory
    else { return }
    sceneLessRootView = factory.rootViewFactory.view(
      withModuleName: reactNativeFactoryModuleName,
      initialProperties: nil,
      launchOptions: nil,
      bundleConfiguration: factory.bundleConfiguration,
      devMenuConfiguration: factory.devMenuConfiguration ?? RCTDevMenuConfiguration.default())
  }

  // Hands the scene-less view to the first scene, at most once.
  func takeSceneLessRootView() -> UIView? {
    defer { sceneLessRootView = nil }
    return sceneLessRootView
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
