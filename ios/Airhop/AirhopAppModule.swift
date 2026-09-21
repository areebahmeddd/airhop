// AirhopAppModule: process-level operations that belong to no radio.
//
// Only recentLog does anything here, reading back what AirhopLog's categories
// wrote to the log store. restart, setAutoStartOnBoot, copyApkToCache,
// startRingAlert and stopRingAlert reject immediately: iOS has no relaunch
// path, no boot receiver, no sideloading to share an APK into, and no ringtone
// loop outside CallKit, which is for calls. A ring on iOS is the notification
// chain in notification-service.ts.
//
// Bridge file: AirhopAppModule.mm
// TypeScript spec: src/bridge/NativeAirhopApp.ts
import Foundation
import OSLog
import React

@objc(AirhopAppModule)
final class AirhopAppModule: NSObject, RCTBridgeModule {

  // Matches the name AirhopAppModule.mm registers via
  // RCT_EXTERN_REMAP_MODULE, so conformance does not depend on that file.
  static func moduleName() -> String! {
    "AirhopApp"
  }

  static func requiresMainQueueSetup() -> Bool {
    false
  }

  @objc
  func restart(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    reject("UNSUPPORTED", "iOS has no supported way to relaunch itself", nil)
  }

  @objc
  func setAutoStartOnBoot(
    _ enabled: Bool,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    reject("UNSUPPORTED", "no boot receiver on iOS", nil)
  }

  @objc
  func copyApkToCache(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    reject("UNSUPPORTED", "iOS has no sideloading to share an APK into", nil)
  }

  @objc
  func startRingAlert(
    _ durationMs: Double,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    reject("UNSUPPORTED", "iOS cannot loop a ringtone outside a call", nil)
  }

  @objc
  func stopRingAlert(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    reject("UNSUPPORTED", "iOS cannot loop a ringtone outside a call", nil)
  }

  // Last 30 minutes, Airhop's own categories only, oldest first, capped at
  // 3000 lines to match logcat's own -t on Android. A device that refuses
  // the store is a report with no log section, not a failed promise.
  @objc
  func recentLog(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      let store = try OSLogStore(scope: .currentProcessIdentifier)
      let since = store.position(date: Date().addingTimeInterval(-30 * 60))
      let entries = try store.getEntries(at: since)

      let formatter = DateFormatter()
      formatter.dateFormat = "MM-dd HH:mm:ss.SSS"

      var lines: [String] = []
      for entry in entries {
        guard let entry = entry as? OSLogEntryLog,
          entry.subsystem == AirhopLog.subsystem,
          AirhopLog.categories.contains(entry.category)
        else { continue }
        lines.append(
          "\(formatter.string(from: entry.date)) [\(entry.category)] \(entry.composedMessage)")
        if lines.count >= 3000 { break }
      }
      resolve(lines.joined(separator: "\n"))
    } catch {
      AirhopLog.app.warning(
        "could not read the log store: \(error.localizedDescription, privacy: .public)")
      resolve("")
    }
  }
}
