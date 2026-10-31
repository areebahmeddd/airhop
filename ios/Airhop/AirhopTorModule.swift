// AirhopTorModule.swift
//
// React Native TurboModule exposing AirhopTorManager to JavaScript.
// This is a separate native module from AirhopBLEModule. Tor and BLE
// are independent concerns and should not share a module boundary.
//
// Bridge file: AirhopTorModule.mm
// TypeScript spec: src/bridge/NativeAirhopTor.ts

import Foundation
import React

@objc(AirhopTorModule)
final class AirhopTorModule: RCTEventEmitter {

  // The single JS event emitted when Tor status changes.
  static let torStatusEvent = "TorStatusChanged"

  private var hasListeners = false
  private var statusObservers: [NSObjectProtocol] = []

  override init() {
    super.init()
    subscribeToTorNotifications()
  }

  override static func requiresMainQueueSetup() -> Bool {
    // Init touches no UI; run on any thread.
    return false
  }

  override func supportedEvents() -> [String]! {
    return [AirhopTorModule.torStatusEvent]
  }

  override func startObserving() {
    hasListeners = true
  }

  override func stopObserving() {
    hasListeners = false
  }

  // MARK: - JS-callable methods

  /// Enable and start Arti. Resolves when the start has been initiated
  /// (not necessarily when bootstrap is complete; use awaitTorReady for that).
  @objc
  func startTor(
    _ bridgeLines: NSString,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Task { @MainActor in
      let manager = AirhopTorManager.shared
      // A stop JS did not wait for (the internet switched off and straight
      // back on) is let finish first. One asked for after this start
      // withdraws it: nothing starts, and the stop has already said so.
      let generation = manager.stopGeneration
      if let stop = manager.pendingStop { await stop.value }
      guard generation == manager.stopGeneration else {
        resolve(nil)
        return
      }
      manager.enableAutoStart(bridgeLines: bridgeLines as String)
      // Resolved from the completion so the promise means "the native
      // client answered", as it does on Android. tor-routing.ts holds its
      // start marker across exactly this window.
      manager.startIfNeeded { failure in
        guard let failure else {
          resolve(nil)
          return
        }
        let rejection = AirhopTorModule.rejection(for: failure)
        reject(rejection.code, rejection.message, nil)
      }
    }
  }

  /// The rejection codes tor-routing.ts branches on, matching TorStartFailure
  /// in ArtiNative.kt. Only the failures with a different remedy are told
  /// apart: bridge lines Arti refused, which retrying cannot fix, and a SOCKS
  /// port another Tor client holds.
  private static func rejection(
    for failure: AirhopTorStartFailure
  ) -> (code: String, message: String) {
    switch failure {
    case .transports:
      return ("tor_transport_failed", "pluggable transports did not start")
    case .arti(let rc):
      switch rc {
      case AirhopTorRC.bridgeLine, AirhopTorRC.bridgeTransport:
        return ("tor_bridge_rejected", "arti refused the bridge lines (rc=\(rc))")
      case AirhopTorRC.bind:
        return ("tor_port_busy", "the Tor port is in use (rc=\(rc))")
      default:
        return ("tor_start_failed", "arti start failed (rc=\(rc))")
      }
    }
  }

  /// Stop Arti. Resolves once it and its transports are down, so a start that
  /// follows (a bridge change) cannot meet a stop still in flight.
  /// `keepHeld` is Android's: this platform holds no route natively.
  @objc
  func stopTor(
    _ keepHeld: Bool,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Task { @MainActor in
      await AirhopTorManager.shared.shutdownCompletely()
      resolve(nil)
    }
  }

  /// Stop Arti and destroy its on-disk state. Panic wipe only.
  @objc
  func wipeTorState(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Task { @MainActor in
      await AirhopTorManager.shared.wipeState()
      resolve(nil)
    }
  }

  /// A no-op here. Android holds its HTTP stack on a dead proxy; on iOS only
  /// the Nostr WebSocket is proxied, and it is held in JS, while the wallet and
  /// the update check already refuse while Tor is on.
  @objc
  func holdRoute(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(nil)
  }

  /// iOS suspends the process in the background, so circuits and guard
  /// connections do not survive a long spell there. Both edges are needed: the
  /// background one sleeps Arti, the foreground one wakes it. No-ops when Tor
  /// was never started.
  @objc
  func setAppForeground(
    _ foreground: Bool,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Task { @MainActor in
      let manager = AirhopTorManager.shared
      manager.setAppForeground(foreground)
      if foreground {
        manager.ensureRunningOnForeground()
      } else {
        manager.goDormantOnBackground()
      }
      resolve(nil)
    }
  }

  /// The status JS sees, read from the native client rather than from the
  /// manager's published copy.
  ///
  /// The manager lowers its own `isReady` on the way to the background without
  /// asking Arti, because whether circuits survived a suspension is not
  /// knowable until it wakes. Reporting that copy lets an ordinary resume read
  /// as a failure, since app-foreground and the JS status re-check fire
  /// un-awaited on the same tick. Kotlin answers from the same source.
  private static func statusPayload() -> [String: Any] {
    let status = ArtiStatus.current
    return [
      "isReady": status.ready,
      // Running, not yet carrying traffic, and not stuck. Blocked is
      // not "starting": the banner has to be able to say the
      // network refused rather than spinning forever.
      "isStarting": status.running && !status.ready && !status.blocked,
      "port": status.ready ? AirhopTorEndpoint.socksPort : 0,
      "progress": status.progress,
      "bootstrapSummary": ArtiStatus.summary,
    ]
  }

  @objc
  func getTorStatus(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(AirhopTorModule.statusPayload())
  }

  /// Block until Arti is bootstrapped and SOCKS-ready (or timeout expires).
  /// Resolves with `true` if ready, `false` on timeout.
  @objc
  func awaitTorReady(
    _ timeoutSeconds: Double,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Task {
      let ready = await AirhopTorManager.shared.awaitReady(timeout: timeoutSeconds)
      resolve(ready)
    }
  }

  // MARK: - Status event relay

  /// One observer per notification, never `forName: nil`.
  ///
  /// A catch-all is invoked for every notification posted anywhere in the
  /// process, UIKit's keyboard and scene changes included, to filter three out.
  /// Ready and stall are the load-bearing pair: without the stall, JS cannot
  /// tell "still forming" from "gave up".
  private func subscribeToTorNotifications() {
    let nc = NotificationCenter.default
    let names: [Notification.Name] = [
      .AirhopTorWillStart,
      .AirhopTorDidBecomeReady,
      .AirhopTorDidStall,
    ]
    statusObservers = names.map { name in
      nc.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
        self?.emitStatus()
      }
    }
  }

  private func emitStatus() {
    guard hasListeners else { return }
    sendEvent(
      withName: AirhopTorModule.torStatusEvent,
      body: AirhopTorModule.statusPayload()
    )
  }

  deinit {
    let nc = NotificationCenter.default
    for obs in statusObservers { nc.removeObserver(obs) }
  }
}
