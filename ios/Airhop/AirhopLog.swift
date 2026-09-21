// Shared os_log categories for Airhop's native modules, one per module,
// mirroring AirhopAppModule.kt's LOG_TAGS allowlist. AirhopAppModule reads
// these back for the diagnostics export.
//
// A logged value needs `privacy: .public` to survive a release build: the
// unified log redacts interpolated values by default. Mark public only what
// cannot identify a peer, device, or key, the bar AirhopBLEModule.kt's
// linkID meets on Android.
import Foundation
import OSLog

enum AirhopLog {
  static let subsystem = Bundle.main.bundleIdentifier ?? "org.onemindlabs.airhop"

  static let ble = Logger(subsystem: subsystem, category: "AirhopBLEModule")
  static let wifi = Logger(subsystem: subsystem, category: "AirhopWiFiModule")
  static let lan = Logger(subsystem: subsystem, category: "AirhopLANModule")
  static let tor = Logger(subsystem: subsystem, category: "AirhopTorModule")
  static let iptProxy = Logger(subsystem: subsystem, category: "AirhopIPtProxy")
  static let voice = Logger(subsystem: subsystem, category: "AirhopVoiceModule")
  static let app = Logger(subsystem: subsystem, category: "AirhopAppModule")

  // What recentLog() reads back. Any other subsystem or category entry in
  // the store, ours or another process's, is dropped.
  static let categories: Set<String> = [
    "AirhopBLEModule", "AirhopWiFiModule", "AirhopLANModule",
    "AirhopTorModule", "AirhopIPtProxy", "AirhopVoiceModule", "AirhopAppModule",
  ]
}
