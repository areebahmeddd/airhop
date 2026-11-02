// AirhopAppModule: process-level operations that belong to no radio.
//
// Two things run here: recentLog, reading back what AirhopLog's categories
// wrote to the log store, and the mesh snapshot the home screen widget draws.
// restart, setAutoStartOnBoot, copyApkToCache, startRingAlert and
// stopRingAlert reject immediately: iOS has no relaunch path, no boot
// receiver, no sideloading to share an APK into, and no ringtone loop outside
// CallKit, which is for calls. A ring on iOS is the notification chain in
// notification-service.ts. openBackgroundNoticeSettings answers false, there
// being no background notice.
//
// Bridge file: AirhopAppModule.mm
// TypeScript spec: src/bridge/NativeAirhopApp.ts
import Foundation
import OSLog
import React
import WidgetKit

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

  // Into the App Group AirhopWidget reads, then a reload. Every reload spends
  // the widget's daily budget, so background-notice.ts decides how often this
  // runs; here it only writes and asks. A build without the App Group
  // entitlement gets the app's own defaults back, and the widget then reads an
  // empty store, which is "Open Airhop" rather than anything false.
  @objc
  func setMeshSnapshot(
    _ count: Double,
    meshOn: Bool,
    bluetoothOff: Bool,
    atMs: Double,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard
      let snapshot = MeshSnapshot(
        fromBridge: count, meshOn: meshOn, bluetoothOff: bluetoothOff, atMs: atMs)
    else {
      reject("INVALID", "Not a snapshot: count \(count), at \(atMs)", nil)
      return
    }
    guard let defaults = UserDefaults(suiteName: MeshWidgetStore.suiteName) else {
      reject("UNSUPPORTED", "no App Group store", nil)
      return
    }
    snapshot.write(to: defaults)
    WidgetCenter.shared.reloadTimelines(ofKind: MeshWidgetStore.kind)
    resolve(nil)
  }

  // For the panic wipe: the widget back to "Open Airhop".
  @objc
  func clearMeshSnapshot(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    if let defaults = UserDefaults(suiteName: MeshWidgetStore.suiteName) {
      MeshSnapshot.clear(defaults)
    }
    WidgetCenter.shared.reloadTimelines(ofKind: MeshWidgetStore.kind)
    resolve(nil)
  }

  @objc
  func openBackgroundNoticeSettings(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(false)
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
