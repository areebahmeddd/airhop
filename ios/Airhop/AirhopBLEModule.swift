// AirhopBLEModule: dual-role BLE GATT server + central for Airhop mesh.
//
// This module does exactly four things and nothing else:
//   1. Advertise as a GATT Peripheral with the Airhop service UUID.
//   2. Scan as a GATT Central for peers advertising the same UUID.
//   3. Accept incoming writes from connected peers and emit them to TypeScript.
//   4. Write raw bytes from TypeScript to connected peers.
//
// Protocol logic (routing, TTL, deduplication, signing) lives entirely in
// TypeScript (src/core/). This file has no knowledge of packet types.
import CoreBluetooth
import Foundation
import OSLog
import React
import UIKit

// MARK: - Constants

private enum BLEConst {
  // Fixed by PROTOCOLS.md. Changing either partitions the network.
  static let serviceUUID = CBUUID(string: "F47B5E2D-4A9E-4C5A-9B3F-8E1D2C3A4B5C")
  static let characteristicUUID = CBUUID(string: "A1B2C3D4-E5F6-4A5B-8C9D-0E1F2A3B4C5D")

  // State restoration identifiers, required for background BLE operation.
  static let centralRestorationKey = "airhop.ble.central"
  static let peripheralRestorationKey = "airhop.ble.peripheral"

  static let rssiIntervalSec: TimeInterval = 5.0
}

// The one queue every CoreBluetooth callback in this process arrives on.
enum AirhopBLEQueue {
  static let shared = DispatchQueue(label: "airhop.ble", qos: .userInitiated)
}

// MARK: - Events

private enum BLEEvent {
  static let packetReceived = "AirhopBLE.packetReceived"
  static let linkConnected = "AirhopBLE.linkConnected"
  static let linkDisconnected = "AirhopBLE.linkDisconnected"
  static let rssiUpdated = "AirhopBLE.rssiUpdated"
  static let adapterStateChanged = "AirhopBLE.adapterStateChanged"
}

// MARK: - Module

@objc(AirhopBLEModule)
final class AirhopBLEModule: RCTEventEmitter {

  // MARK: State

  private var centralManager: CBCentralManager?
  private var peripheralManager: CBPeripheralManager?
  private var characteristic: CBMutableCharacteristic?

  // linkID -> CBPeripheral (central role connections to remote peripherals).
  // Populated at DISCOVERY time, not connect time: CoreBluetooth abandons a
  // connection attempt if the CBPeripheral is deallocated, and `connect(_:)`
  // does not retain it for us.
  private var centralLinks: [String: CBPeripheral] = [:]
  // bitchat-ios TransportConfig.bleMaxCentralLinks.
  private static let maxCentralLinks = 6
  // Central links whose characteristic is discovered and notifying, i.e. the
  // only ones that can actually carry a write. Retained-but-not-ready links
  // live in centralLinks without appearing here.
  private var readyCentralLinks: Set<String> = []
  // CoreBluetooth never times out a connect, so a peer that leaves mid-dial
  // would hold a slot until Bluetooth restarts. bitchat-ios allows 8s.
  private static let centralReadyTimeoutSec: TimeInterval = 10
  private var centralAttempts: [String: UInt64] = [:]
  private var nextCentralAttempt: UInt64 = 0
  // Off screen a dial is never expired: iOS completes a pending connect when
  // the peer comes back and wakes the app, which is how the mesh reconnects in
  // a pocket. Dials whose deadline passed meanwhile are canceled on return to
  // the foreground, as bitchat-ios's BLERadioController does. Both on `queue`.
  private var appActive = true
  private var overdueDials: Set<String> = []
  // A scan without duplicates reports each peer once, so a central link that
  // drops on screen is not found again until the scan restarts. One restart
  // per interval at most, so a peer that keeps failing is redialed at that
  // pace rather than in a loop. bitchat-ios scans with duplicates on screen
  // to the same end. On `queue`.
  private static let rescanDelaySec: TimeInterval = 5
  private var rescanPending = false
  // linkID -> CBCentral (peripheral role connections from remote centrals)
  private var peripheralLinks: [String: CBCentral] = [:]

  // Per-link RSSI pollers.
  //
  // DispatchSourceTimer, not Timer. These are created from CoreBluetooth
  // delegate callbacks, which arrive on `queue`, a DispatchQueue with no run
  // loop, and Timer.scheduledTimer schedules onto the current run loop, so it
  // would never fire. A dispatch timer needs no run loop and fires on the queue
  // CoreBluetooth expects to be called from.
  private var rssiTimers: [String: DispatchSourceTimer] = [:]
  // The writes each link has not yet handed to the radio, in both roles; see
  // LinkWriteQueue for the rules. A queue per link, so one slow neighbor fills
  // only its own and hears WRITE_BUSY while the others keep moving. Discarded
  // with its link. On `queue`, like all the state here.
  private var writeQueues: [String: LinkWriteQueue] = [:]
  // Central links with an acknowledged write in flight. Nothing more goes down
  // such a link until its didWriteValueFor, which keeps the link's order.
  private var awaitingWriteResponse: Set<String> = []
  // Live media is being sent or watched. See setLiveMediaActive.
  private var liveMediaActive = false

  // What the app wants, kept apart from what CoreBluetooth is currently doing.
  //
  // Intent survives a power cycle. Actual state never does: it is re-derived
  // from the manager's own state on every callback. One flag doing both would,
  // on the way back from a power cycle, believe the service was still up and
  // skip rebuilding it, leaving the device invisible to every peer.
  private var wantScanning = false
  private var wantAdvertising = false
  private var actuallyScanning = false
  private var actuallyAdvertising = false
  // The service has been added to the peripheral manager and is ready to
  // advertise. Cleared on poweredOff, because CoreBluetooth discards it.
  private var serviceRegistered = false

  // Last value reported to JS, so an unchanged state is never sent twice. The
  // mesh reads adapterStateChanged as a radio change and restarts the radios, so
  // a repeat would feed back into another state callback.
  private var lastReportedEnabled: Bool?

  // Shared, not per-instance: AirhopBLERestoration may create the managers
  // before this module exists, and both must deliver onto the same serial
  // queue or the handover is a data race.
  private let queue = AirhopBLEQueue.shared

  // MARK: RCTEventEmitter

  override init() {
    super.init()
    let center = NotificationCenter.default
    center.addObserver(
      self, selector: #selector(appDidBecomeActive),
      name: UIApplication.didBecomeActiveNotification, object: nil)
    center.addObserver(
      self, selector: #selector(appDidEnterBackground),
      name: UIApplication.didEnterBackgroundNotification, object: nil)
    // A Bluetooth relaunch builds this module in the background, before either
    // notification. Read on main, as UIKit requires; later notifications queue
    // behind it, so the order holds.
    DispatchQueue.main.async { [weak self] in
      let active = UIApplication.shared.applicationState == .active
      self?.queue.async { self?.appActive = active }
    }
  }

  override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! {
    [
      BLEEvent.packetReceived,
      BLEEvent.linkConnected,
      BLEEvent.linkDisconnected,
      BLEEvent.rssiUpdated,
      BLEEvent.adapterStateChanged,
    ]
  }

  // MARK: App state

  @objc private func appDidBecomeActive() {
    queue.async { [weak self] in
      guard let self else { return }
      self.appActive = true
      // A connect whose didConnect is still queued is left to it.
      for linkID in self.overdueDials where self.centralLinks[linkID]?.state != .connected {
        self.expireDial(linkID)
      }
      self.overdueDials.removeAll()
      // A scan without duplicates reports each peer once, so a peer whose dial
      // was canceled is found again only by a fresh scan, as in bitchat-ios.
      self.restartScan()
    }
  }

  @objc private func appDidEnterBackground() {
    queue.async { [weak self] in self?.appActive = false }
  }

  // Must be called on `queue`.
  private func restartScan() {
    guard actuallyScanning, centralManager?.state == .poweredOn else { return }
    centralManager?.stopScan()
    actuallyScanning = false
    applyState()
  }

  // A central link dropped, failed or timed out on screen. Off screen a
  // pending connect is what brings the peer back. Must be called on `queue`.
  private func scheduleRescan() {
    guard appActive, wantScanning, !rescanPending else { return }
    rescanPending = true
    queue.asyncAfter(deadline: .now() + Self.rescanDelaySec) { [weak self] in
      guard let self else { return }
      self.rescanPending = false
      if self.appActive { self.restartScan() }
    }
  }

  // MARK: Peripheral (advertising)

  // Both managers are created exactly once, on first use, and kept for the
  // life of the process. The mesh calls startScanning/startAdvertising on every
  // retry, and a fresh manager against the same restore identifier is an error
  // to CoreBluetooth and abandons the old one mid-connection.
  private func ensureCentralManager() -> CBCentralManager {
    if let existing = centralManager { return existing }
    // Adopt the manager the app delegate built at launch rather than
    // constructing a second against the same restore identifier.
    if let restored = AirhopBLERestoration.shared.takeCentral() {
      restored.delegate = self
      centralManager = restored
      // Must be retained: CoreBluetooth abandons a connection whose
      // CBPeripheral is deallocated.
      for peripheral in AirhopBLERestoration.shared.takeRestoredPeripherals() {
        peripheral.delegate = self
        centralLinks[centralLinkID(for: peripheral)] = peripheral
      }
      // Its poweredOn went to AirhopBLERestoration. Replayed so restored links
      // are rediscovered and JS hears the radio; the handler is idempotent if
      // the real callback is still queued. The peripheral needs no replay: its
      // poweredOn only resets what a power cycle discards.
      if restored.state == .poweredOn {
        centralManagerDidUpdateState(restored)
      }
      return restored
    }
    let manager = CBCentralManager(
      delegate: self,
      queue: queue,
      options: [CBCentralManagerOptionRestoreIdentifierKey: BLEConst.centralRestorationKey]
    )
    centralManager = manager
    return manager
  }

  private func ensurePeripheralManager() -> CBPeripheralManager {
    if let existing = peripheralManager { return existing }
    if let restored = AirhopBLERestoration.shared.takePeripheral() {
      restored.delegate = self
      peripheralManager = restored
      // Already registered by iOS, so adopting it stops applyState()
      // adding a duplicate.
      if let char = AirhopBLERestoration.shared.takeRestoredCharacteristic() {
        characteristic = char
        serviceRegistered = true
      }
      return restored
    }
    let manager = CBPeripheralManager(
      delegate: self,
      queue: queue,
      options: [CBPeripheralManagerOptionRestoreIdentifierKey: BLEConst.peripheralRestorationKey]
    )
    peripheralManager = manager
    return manager
  }

  // Reconcile CoreBluetooth with what the app wants.
  //
  // Every entry point (a JS call, a state callback, a service being added) ends
  // here rather than issuing commands of its own. That is what makes the module
  // idempotent: running it twice with nothing changed does nothing, so no caller
  // has to know what any other caller already did.
  //
  // Must be called on `queue`.
  private func applyState() {
    let centralReady = centralManager?.state == .poweredOn
    let peripheralReady = peripheralManager?.state == .poweredOn

    // Central role.
    if wantScanning, centralReady {
      if !actuallyScanning {
        centralManager?.scanForPeripherals(
          withServices: [BLEConst.serviceUUID],
          options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )
        actuallyScanning = true
      }
    } else if actuallyScanning {
      // Only issue stopScan while the radio is on. Once CoreBluetooth has
      // left poweredOn it rejects these calls as API misuse, and it has
      // already stopped scanning on our behalf.
      if centralReady { centralManager?.stopScan() }
      actuallyScanning = false
    }

    // Peripheral role.
    if wantAdvertising, peripheralReady {
      if !serviceRegistered {
        registerService()
      } else if !actuallyAdvertising {
        startAdvertisingNow()
      }
    } else if actuallyAdvertising {
      if peripheralReady { peripheralManager?.stopAdvertising() }
      actuallyAdvertising = false
    }
  }

  // Must be called on `queue`, with the peripheral manager powered on.
  private func registerService() {
    guard let manager = peripheralManager else { return }
    // Remove first so a rebuild after a power cycle cannot land on top of a
    // stale registration. Mirrors bitchat-ios (BLEService+LinkLayerPeripheralRole).
    manager.removeAllServices()

    let char = CBMutableCharacteristic(
      type: BLEConst.characteristicUUID,
      properties: [.read, .write, .writeWithoutResponse, .notify],
      value: nil,
      permissions: [.readable, .writeable]
    )
    characteristic = char

    let service = CBMutableService(type: BLEConst.serviceUUID, primary: true)
    service.characteristics = [char]
    manager.add(service)
    // serviceRegistered is set in didAdd, not here: until the service is
    // actually accepted there is nothing to advertise.
  }

  private func startAdvertisingNow() {
    guard let manager = peripheralManager, manager.state == .poweredOn else { return }
    // Service UUID only. A local name would be a stable identifier broadcast to
    // every passive scanner in radio range, and nothing would read it: the iOS
    // central here dedups on the CBPeripheral identifier, and the Android
    // central reads the 8-byte peer ID out of scan-response service data.
    //
    // bitchat-ios does the same (BLERadioController.advertisementData()). It
    // costs the ability to dedup an iPhone before connecting to it, which the
    // mesh tolerates: one peer on two links.
    //
    // The localName parameter stays on the bridge method, since Android uses it
    // and the two platforms keep one signature.
    manager.startAdvertising([
      CBAdvertisementDataServiceUUIDsKey: [BLEConst.serviceUUID]
    ])
    actuallyAdvertising = true
  }

  @objc
  func startAdvertising(
    _ serviceUUID: String,
    localName: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async { [weak self] in
      guard let self else { return }
      // Unused here; see startAdvertisingNow.
      _ = localName
      let manager = self.ensurePeripheralManager()

      // Refuse rather than resolve when we cannot advertise, so the caller
      // retries instead of believing the mesh is up.
      //
      // The latch is set per branch, not up front: applyState() runs on
      // every state change, so one left behind by a REFUSED start would
      // advertise once the radio returned with nothing having asked for
      // it. The transient states keep it because .unknown is the normal
      // cold-start answer. A mesh already running latched on .poweredOn,
      // so autonomous resume after a power cycle is unaffected.
      switch manager.state {
      case .poweredOn:
        self.wantAdvertising = true
        self.applyState()
        resolve(nil)
      case .resetting, .unknown:
        self.wantAdvertising = true
        reject("RADIO_OFF", "Bluetooth is not ready yet", nil)
      case .unauthorized:
        self.wantAdvertising = false
        reject("PERMISSION_DENIED", "Bluetooth permission was denied", nil)
      case .unsupported:
        self.wantAdvertising = false
        reject("UNSUPPORTED", "This device does not support Bluetooth LE", nil)
      case .poweredOff:
        self.wantAdvertising = false
        reject("RADIO_OFF", "Bluetooth is switched off", nil)
      @unknown default:
        self.wantAdvertising = false
        reject("RADIO_OFF", "Bluetooth is not ready yet", nil)
      }
    }
  }

  @objc
  func stopAdvertising(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async { [weak self] in
      guard let self else { return }
      self.wantAdvertising = false
      self.applyState()
      self.discardWritesIfMeshStopped()
      resolve(nil)
    }
  }

  // MARK: Central (scanning)

  @objc
  func startScanning(
    _ serviceUUIDs: [String],
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async { [weak self] in
      guard let self else { return }
      let manager = self.ensureCentralManager()

      // Latched per branch, for the reason given in startAdvertising.
      switch manager.state {
      case .poweredOn:
        self.wantScanning = true
        self.applyState()
        resolve(nil)
      case .resetting, .unknown:
        self.wantScanning = true
        reject("RADIO_OFF", "Bluetooth is not ready yet", nil)
      case .unauthorized:
        self.wantScanning = false
        reject("PERMISSION_DENIED", "Bluetooth permission was denied", nil)
      case .unsupported:
        self.wantScanning = false
        reject("UNSUPPORTED", "This device does not support Bluetooth LE", nil)
      case .poweredOff:
        self.wantScanning = false
        reject("RADIO_OFF", "Bluetooth is switched off", nil)
      @unknown default:
        self.wantScanning = false
        reject("RADIO_OFF", "Bluetooth is not ready yet", nil)
      }
    }
  }

  // Also cancels every link this side dialed, pending dials included, as
  // bitchat-ios's BLEService does when it stops. Otherwise an Away phone stays
  // connected to its neighbors and is woken by their traffic, and after a
  // panic wipe the new identity announces down the connection that carried
  // the old one's LEAVE. Invisible only stops advertising, so it keeps them.
  @objc
  func stopScanning(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async { [weak self] in
      guard let self else { return }
      self.wantScanning = false
      self.applyState()
      // Outside poweredOn CoreBluetooth rejects the cancel as API misuse, and
      // the state callback has already retired the links.
      if let central = self.centralManager, central.state == .poweredOn {
        for peripheral in self.centralLinks.values {
          central.cancelPeripheralConnection(peripheral)
        }
      }
      // Reported here rather than left to didDisconnect: a canceled pending
      // connect may never call back.
      self.retireAllCentralLinks()
      self.discardWritesIfMeshStopped()
      resolve(nil)
    }
  }

  // Both roles stopped is the mesh stopping. A central still subscribed to this
  // side keeps its link, but nothing queued for it may go out afterwards.
  // Invisible keeps scanning, so its peripheral links keep their queues. Must
  // be called on `queue`.
  private func discardWritesIfMeshStopped() {
    guard !wantScanning, !wantAdvertising else { return }
    writeQueues.removeAll()
    awaitingWriteResponse.removeAll()
  }

  // Everything the device will tell us about whether BLE can run right now,
  // matching the Android module field for field.
  //
  // Brings up the central manager, the same single instance everything else
  // uses: the mesh asks before it scans, and without a manager the answer on
  // every cold launch would be "Bluetooth off" on a healthy iPhone.
  // CBManager.authorization is a static property and needs no manager at all, so
  // a denied permission is reported as denied rather than as an absent radio,
  // which send the user to different places.
  @objc
  func getRadioState(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async { [weak self] in
      guard let self else {
        resolve([
          "supported": false,
          "poweredOn": false,
          "authorization": "unknown",
          "locationRequiredForScan": false,
          "locationServicesEnabled": true,
          // Present here as well as in the full answer below: the
          // reconciler reads every field, and a missing one arrives in
          // JS as undefined rather than as an error anyone would see.
          "batteryPercent": -1,
          "charging": false,
          "powerSaveMode": false,
        ])
        return
      }
      let manager = self.ensureCentralManager()

      let authorization: String
      switch CBManager.authorization {
      case .allowedAlways: authorization = "granted"
      // iOS never re-prompts once denied, so "denied" here is permanent
      // and maps to the blocked banner, whose only route out is Settings.
      case .denied: authorization = "blocked"
      case .restricted: authorization = "blocked"
      case .notDetermined: authorization = "unknown"
      @unknown default: authorization = "unknown"
      }

      // A .unknown manager state means CoreBluetooth has not reported yet,
      // which is not the same as unsupported, so `supported` stays true until
      // the platform actually says otherwise.
      resolve([
        "supported": manager.state != .unsupported,
        "poweredOn": manager.state == .poweredOn,
        "authorization": authorization,
        // Both are Android concerns. CoreBluetooth has no location
        // coupling to assert away, so there is nothing here for the
        // shared blocker logic to weigh: `locationRequiredForScan` false
        // is what stops it inventing a blocker that cannot apply on this
        // platform, and the toggle beside it is then never read.
        "locationRequiredForScan": false,
        "locationServicesEnabled": true,
        // Android-only inputs to the power policy. CoreBluetooth
        // exposes no scan-rate control, so a battery reading here would
        // have nothing to drive; -1 tells the policy to leave the mode
        // alone rather than infer a flat battery. Low Power Mode is left
        // out for the same reason: the OS already throttles BLE under it,
        // and reporting it would only raise a "scanning less often"
        // banner for a change this module cannot make.
        "batteryPercent": -1,
        "charging": false,
        "powerSaveMode": false,
      ])
    }
  }

  // iOS has no API to turn the radio on from inside an app, by design. Resolve
  // false and let the caller fall back to opening Settings, rather than
  // pretending to offer something the platform will not do.
  @objc
  func requestEnableBluetooth(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(false)
  }

  // Android-only; location never gates BLE scanning here.
  @objc
  func openLocationSettings(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(false)
  }

  // Android turns the scan rate, advertise rate, TX power and RSSI cadence
  // down together as the battery falls. CoreBluetooth offers none of those
  // knobs: it decides scan scheduling itself and already throttles background
  // BLE hard on the app's behalf. Declared so the shared reconciler has one code
  // path rather than a platform branch.
  @objc
  func setPowerMode(
    _ mode: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(nil)
  }

  // Android runs a foreground service to survive backgrounding. On iOS the
  // equivalent is granted declaratively through UIBackgroundModes
  // (bluetooth-central / bluetooth-peripheral, in Info.plist), so there is
  // nothing to start or stop. Declared for the same reason as setPowerMode.
  @objc
  func setBackgroundServiceEnabled(
    _ enabled: Bool,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(nil)
  }

  // Asks every subscribed central for a short connection interval while live
  // media is sent or watched, as bitchat raises connection priority for a
  // stream, and for .medium afterwards: CoreBluetooth cannot withdraw a
  // request, so a central asked once keeps .medium for the rest of that
  // connection rather than whatever it chose itself. Only the peripheral role
  // has this call; CoreBluetooth gives a central no say over the interval.
  @objc
  func setLiveMediaActive(
    _ active: Bool,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async { [weak self] in
      guard let self else {
        resolve(nil)
        return
      }
      self.liveMediaActive = active
      for central in self.peripheralLinks.values {
        self.applyConnectionLatency(to: central)
      }
      resolve(nil)
    }
  }

  // Must be called on `queue`.
  private func applyConnectionLatency(to central: CBCentral) {
    // Outside poweredOn CoreBluetooth rejects the call as API misuse.
    guard let manager = peripheralManager, manager.state == .poweredOn else { return }
    manager.setDesiredConnectionLatency(liveMediaActive ? .low : .medium, for: central)
  }

  // MARK: I/O

  // Queues the bytes on the link and hands the radio what it will take now.
  //
  // Resolves with how many writes on this link the radio has not yet taken,
  // this one included (0 when it went straight out), so the sender sees a
  // backlog build rather than only a refusal once it is full. WRITE_BUSY means
  // this link's queue is full. `ttlMs` > 0 drops the write unsent once it has
  // been queued that long, found at the head or when a later write is queued;
  // TypeScript sets it for live media, and nothing here reads the bytes to
  // decide.
  @objc
  func writeToLink(
    _ linkID: String,
    dataBase64: String,
    ttlMs: Double,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    queue.async { [weak self] in
      guard let self,
        let data = Data(base64Encoded: dataBase64)
      else {
        reject("INVALID_DATA", "Invalid base64 payload", nil)
        return
      }

      let centralRole: Bool
      if let peripheral = self.centralLinks[linkID] {
        guard self.readyCentralLinks.contains(linkID),
          self.cachedCharacteristic(on: peripheral) != nil
        else {
          reject("NOT_READY", "Link \(linkID) is not notifying yet", nil)
          return
        }
        centralRole = true
      } else if self.peripheralLinks[linkID] != nil, self.characteristic != nil {
        centralRole = false
      } else {
        reject("UNKNOWN_LINK", "No active link with ID \(linkID)", nil)
        return
      }

      // Queued even when the radio has room, so a write never passes one
      // already waiting on the link: fragments arrive in order or not at all.
      let accepted = self.writeQueues[linkID, default: LinkWriteQueue()]
        .append(data, ttlMs: ttlMs, now: Self.monotonicNow())
      guard accepted else {
        reject("WRITE_BUSY", "Write queue full for link \(linkID)", nil)
        return
      }
      if centralRole {
        self.drainCentralLink(linkID)
      } else {
        self.drainPeripheralLinks()
      }
      resolve(self.writeQueues[linkID]?.depth ?? 0)
    }
  }

  private static func monotonicNow() -> UInt64 {
    DispatchTime.now().uptimeNanoseconds
  }

  // Hands one central link's queue to its peripheral while CoreBluetooth will
  // take it. Must be called on `queue`.
  private func drainCentralLink(_ linkID: String) {
    guard !awaitingWriteResponse.contains(linkID),
      readyCentralLinks.contains(linkID),
      let peripheral = centralLinks[linkID],
      let characteristic = cachedCharacteristic(on: peripheral)
    else { return }
    let now = Self.monotonicNow()
    while let data = writeQueues[linkID]?.head(now: now) {
      // A .withoutResponse write larger than the negotiated limit is silently
      // discarded by CoreBluetooth. Mesh frames run up to 512 B and the
      // unacknowledged limit is often smaller, so such a write goes
      // acknowledged, and the next one waits for its didWriteValueFor.
      if data.count > peripheral.maximumWriteValueLength(for: .withoutResponse) {
        writeQueues[linkID]?.removeHead()
        awaitingWriteResponse.insert(linkID)
        peripheral.writeValue(data, for: characteristic, type: .withResponse)
        return
      }
      // CoreBluetooth also discards an unacknowledged write issued while its
      // transmit queue is full, and says so only through this flag.
      // peripheralIsReady(toSendWriteWithoutResponse:) resumes the drain.
      guard peripheral.canSendWriteWithoutResponse else { return }
      writeQueues[linkID]?.removeHead()
      peripheral.writeValue(data, for: characteristic, type: .withoutResponse)
    }
  }

  // Hands the peripheral links' queues to their centrals while CoreBluetooth
  // takes them. A notify goes to its link's central only: nil would fan it out
  // to every subscriber, leaking a unicast DM and wasting airtime.
  //
  // One write per link per pass, since the transmit queue is shared: a link
  // with a long backlog cannot take every free slot while its neighbors wait.
  // A refused link keeps its head for the next readiness callback or write,
  // and drops out of the pass rather than ending it, so a central that refuses
  // for a reason of its own cannot hold up the rest.
  // Must be called on `queue`.
  private func drainPeripheralLinks() {
    guard let manager = peripheralManager, manager.state == .poweredOn,
      let char = characteristic
    else { return }
    let now = Self.monotonicNow()
    var pending = Array(peripheralLinks.keys)
    while !pending.isEmpty {
      var again: [String] = []
      for linkID in pending {
        guard let central = peripheralLinks[linkID],
          let data = writeQueues[linkID]?.head(now: now)
        else { continue }
        guard manager.updateValue(data, for: char, onSubscribedCentrals: [central]) else {
          continue
        }
        writeQueues[linkID]?.removeHead()
        again.append(linkID)
      }
      pending = again
    }
  }

  // The link is gone or stopped: what it had queued goes nowhere. Must be
  // called on `queue`.
  private func discardWrites(_ linkID: String) {
    writeQueues.removeValue(forKey: linkID)
    awaitingWriteResponse.remove(linkID)
  }

  private func cachedCharacteristic(on peripheral: CBPeripheral) -> CBCharacteristic? {
    return peripheral.services?
      .first(where: { $0.uuid == BLEConst.serviceUUID })?
      .characteristics?
      .first(where: { $0.uuid == BLEConst.characteristicUUID })
  }

  // MARK: Link ID helpers

  private func centralLinkID(for peripheral: CBPeripheral) -> String {
    return "c:\(peripheral.identifier.uuidString)"
  }

  private func peripheralLinkID(for central: CBCentral) -> String {
    return "p:\(central.identifier.uuidString)"
  }
}

// MARK: - CBCentralManagerDelegate

extension AirhopBLEModule: CBCentralManagerDelegate {

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    reportAdapterState(central.state == .poweredOn)

    switch central.state {
    case .poweredOn:
      // Links restored into a new process have no characteristic yet.
      // Without rediscovery they sit connected-but-unusable until the peer
      // gives up. Done here rather than in willRestoreState because
      // commands issued before poweredOn are dropped.
      for peripheral in centralLinks.values where peripheral.state == .connected {
        peripheral.discoverServices([BLEConst.serviceUUID])
      }
      // Restored links, pending connects included, get deadlines too.
      for (linkID, peripheral) in centralLinks
      where !readyCentralLinks.contains(linkID) && centralAttempts[linkID] == nil {
        armCentralDeadline(linkID, dialing: peripheral.state != .connected)
      }
      applyState()

    case .poweredOff:
      // CoreBluetooth has already invalidated every peripheral we hold and
      // has left poweredOn, so issuing cancelPeripheralConnection now would
      // be rejected as API misuse. Retire the state locally instead, and
      // tell JS, which otherwise keeps addressing links that cannot carry
      // anything.
      retireAllCentralLinks()
      actuallyScanning = false

    case .unauthorized:
      // The user denied Bluetooth. Distinct from the radio being off, and
      // reported as such so the banner sends them to Settings rather than
      // to a Control Center toggle that is already on.
      retireAllCentralLinks()
      actuallyScanning = false

    case .unsupported:
      actuallyScanning = false

    case .resetting:
      // The stack is restarting; another update follows. Treat it like a
      // power cycle so nothing is left addressing a dead link.
      retireAllCentralLinks()
      actuallyScanning = false

    case .unknown:
      break

    @unknown default:
      break
    }
  }

  private func reportAdapterState(_ enabled: Bool) {
    guard lastReportedEnabled != enabled else { return }
    lastReportedEnabled = enabled
    sendEvent(withName: BLEEvent.adapterStateChanged, body: ["enabled": enabled])
  }

  // Drop every central-role link and say so, so JS stops routing to peers that
  // are gone rather than learning it from failed writes.
  private func retireAllCentralLinks() {
    for linkID in centralLinks.keys {
      sendEvent(withName: BLEEvent.linkDisconnected, body: ["linkID": linkID])
      discardWrites(linkID)
    }
    centralLinks.removeAll()
    readyCentralLinks.removeAll()
    centralAttempts.removeAll()
    overdueDials.removeAll()
    for timer in rssiTimers.values { timer.cancel() }
    rssiTimers.removeAll()
  }

  func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    let linkID = centralLinkID(for: peripheral)
    guard centralLinks[linkID] == nil else { return }
    // Ceiling on simultaneous central-role links, matching bitchat-ios
    // TransportConfig.bleMaxCentralLinks. A phone in a crowded room that
    // dials every advertiser it sees exhausts the controller and thrashes;
    // flood routing reaches the rest of the room through the links it has.
    guard centralLinks.count < Self.maxCentralLinks else { return }
    // Retain before connecting. CoreBluetooth does not hold a strong
    // reference during the attempt, so a peripheral that is only referenced
    // locally gets deallocated and the connection silently never completes.
    peripheral.delegate = self
    centralLinks[linkID] = peripheral
    central.connect(peripheral, options: nil)
    armCentralDeadline(linkID, dialing: true)
  }

  // Armed at the dial and again at connect, so a peer that connects but never
  // subscribes is freed too. The attempt number stops a stale deadline.
  private func armCentralDeadline(_ linkID: String, dialing: Bool) {
    nextCentralAttempt &+= 1
    let attempt = nextCentralAttempt
    centralAttempts[linkID] = attempt
    queue.asyncAfter(deadline: .now() + Self.centralReadyTimeoutSec) { [weak self] in
      guard let self, self.centralAttempts[linkID] == attempt else { return }
      guard let peripheral = self.centralLinks[linkID] else { return }
      // A woken app can see an overdue dial deadline and its connect at once.
      // didConnect re-arms.
      if dialing && peripheral.state == .connected { return }
      if dialing && !self.appActive {
        self.overdueDials.insert(linkID)
        return
      }
      self.expireDial(linkID)
    }
  }

  // Frees a link that never became ready, leaving it to rediscovery.
  private func expireDial(_ linkID: String) {
    guard let peripheral = centralLinks[linkID], !readyCentralLinks.contains(linkID) else { return }
    centralAttempts.removeValue(forKey: linkID)
    AirhopLog.ble.notice("BLE link timed out before ready (central)")
    centralManager?.cancelPeripheralConnection(peripheral)
    // A canceled pending connect may never call back.
    centralLinks.removeValue(forKey: linkID)
    discardWrites(linkID)
    rssiTimers[linkID]?.cancel()
    rssiTimers.removeValue(forKey: linkID)
    scheduleRescan()
  }

  func centralManager(
    _ central: CBCentralManager,
    didConnect peripheral: CBPeripheral
  ) {
    AirhopLog.ble.notice("BLE link up (central)")
    let linkID = centralLinkID(for: peripheral)
    centralLinks[linkID] = peripheral
    overdueDials.remove(linkID)
    armCentralDeadline(linkID, dialing: false)
    // linkConnected is deliberately not emitted here: the characteristic is
    // not discovered yet, so any write JS makes in response would fail. It
    // is emitted from didUpdateNotificationStateFor once the link can
    // actually carry traffic (mirrors the Android CCCD-confirmed gating).
    peripheral.discoverServices([BLEConst.serviceUUID])

    // Start periodic RSSI polling. Replaces any poller left over from an
    // earlier connection to the same peripheral, so a reconnect cannot end
    // up with two timers reading the same link.
    rssiTimers[linkID]?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(
      deadline: .now() + BLEConst.rssiIntervalSec,
      repeating: BLEConst.rssiIntervalSec)
    timer.setEventHandler { [weak peripheral] in
      guard let peripheral, peripheral.state == .connected else { return }
      peripheral.readRSSI()
    }
    timer.resume()
    rssiTimers[linkID] = timer
  }

  func centralManager(
    _ central: CBCentralManager,
    didFailToConnect peripheral: CBPeripheral,
    error: Error?
  ) {
    AirhopLog.ble.notice("BLE link failed (central)")
    // Release the retain so a later advertisement can retry this peer.
    let linkID = centralLinkID(for: peripheral)
    centralLinks.removeValue(forKey: linkID)
    readyCentralLinks.remove(linkID)
    discardWrites(linkID)
    centralAttempts.removeValue(forKey: linkID)
    overdueDials.remove(linkID)
    scheduleRescan()
  }

  func centralManager(
    _ central: CBCentralManager,
    didDisconnectPeripheral peripheral: CBPeripheral,
    error: Error?
  ) {
    AirhopLog.ble.notice("BLE link down (central)")
    let linkID = centralLinkID(for: peripheral)
    // Absent when retireAllCentralLinks already retired it and said so, or
    // expireDial freed it before JS ever heard it connect.
    let wasLinked = centralLinks.removeValue(forKey: linkID) != nil
    readyCentralLinks.remove(linkID)
    discardWrites(linkID)
    centralAttempts.removeValue(forKey: linkID)
    overdueDials.remove(linkID)
    rssiTimers[linkID]?.cancel()
    rssiTimers.removeValue(forKey: linkID)
    if wasLinked {
      sendEvent(withName: BLEEvent.linkDisconnected, body: ["linkID": linkID])
    }
    scheduleRescan()
  }

  func centralManager(
    _ central: CBCentralManager,
    willRestoreState dict: [String: Any]
  ) {
    if let peripherals = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] {
      for peripheral in peripherals {
        peripheral.delegate = self
        centralLinks[centralLinkID(for: peripheral)] = peripheral
      }
    }
  }
}

// MARK: - CBPeripheralDelegate

extension AirhopBLEModule: CBPeripheralDelegate {

  func peripheral(
    _ peripheral: CBPeripheral,
    didDiscoverServices error: Error?
  ) {
    guard error == nil else { return }
    peripheral.services?.forEach { service in
      if service.uuid == BLEConst.serviceUUID {
        peripheral.discoverCharacteristics([BLEConst.characteristicUUID], for: service)
      }
    }
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didDiscoverCharacteristicsFor service: CBService,
    error: Error?
  ) {
    guard error == nil else { return }
    service.characteristics?.forEach { char in
      if char.uuid == BLEConst.characteristicUUID {
        peripheral.setNotifyValue(true, for: char)
      }
    }
  }

  // Notifications are live on this link: only now can it carry traffic, so
  // this is where the link is announced to JS.
  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateNotificationStateFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    guard characteristic.uuid == BLEConst.characteristicUUID else { return }
    let linkID = centralLinkID(for: peripheral)

    guard error == nil, characteristic.isNotifying else {
      // Subscription failed: the link cannot receive, so tear it down
      // rather than leaving a half-open connection that looks healthy.
      readyCentralLinks.remove(linkID)
      discardWrites(linkID)
      centralManager?.cancelPeripheralConnection(peripheral)
      return
    }

    guard !readyCentralLinks.contains(linkID) else { return }
    readyCentralLinks.insert(linkID)
    centralAttempts.removeValue(forKey: linkID)
    sendEvent(
      withName: BLEEvent.linkConnected,
      body: ["linkID": linkID, "role": "central", "rssi": -99])
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    guard error == nil,
      characteristic.uuid == BLEConst.characteristicUUID,
      let data = characteristic.value
    else { return }

    let linkID = centralLinkID(for: peripheral)
    sendEvent(
      withName: BLEEvent.packetReceived,
      body: ["linkID": linkID, "dataBase64": data.base64EncodedString()])
  }

  // Not peripheralDidUpdateRSSI(_:error:), which pairs with the deprecated
  // `peripheral.rssi` property and never fires here.
  func peripheral(
    _ peripheral: CBPeripheral,
    didReadRSSI RSSI: NSNumber,
    error: Error?
  ) {
    guard error == nil else { return }
    let linkID = centralLinkID(for: peripheral)
    sendEvent(
      withName: BLEEvent.rssiUpdated,
      body: ["linkID": linkID, "rssi": RSSI.intValue])
  }

  // The transmit queue has room for an unacknowledged write again.
  func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
    drainCentralLink(centralLinkID(for: peripheral))
  }

  // Fires only for acknowledged writes. A failed one is not retried, since its
  // promise has already settled.
  func peripheral(
    _ peripheral: CBPeripheral,
    didWriteValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    guard characteristic.uuid == BLEConst.characteristicUUID else { return }
    let linkID = centralLinkID(for: peripheral)
    awaitingWriteResponse.remove(linkID)
    drainCentralLink(linkID)
  }
}

// MARK: - CBPeripheralManagerDelegate

extension AirhopBLEModule: CBPeripheralManagerDelegate {

  // Every state does its own cleanup, and the decision about whether to
  // advertise belongs to applyState(). See wantAdvertising.
  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    switch peripheral.state {
    case .poweredOn:
      // CoreBluetooth discards registered services across a power cycle,
      // so the flag has to go with them or applyState() would advertise a
      // service that no longer exists.
      serviceRegistered = false
      actuallyAdvertising = false
      applyState()

    case .poweredOff:
      retireAllCentralSubscribers()
      serviceRegistered = false
      actuallyAdvertising = false
      characteristic = nil

    case .unauthorized:
      retireAllCentralSubscribers()
      serviceRegistered = false
      actuallyAdvertising = false
      characteristic = nil

    case .unsupported:
      actuallyAdvertising = false

    case .resetting:
      retireAllCentralSubscribers()
      serviceRegistered = false
      actuallyAdvertising = false
      characteristic = nil

    case .unknown:
      break

    @unknown default:
      break
    }
  }

  // Subscribed centrals do not survive a power cycle, and a queued notify to
  // one of them would be delivered to nobody.
  private func retireAllCentralSubscribers() {
    for linkID in peripheralLinks.keys {
      sendEvent(withName: BLEEvent.linkDisconnected, body: ["linkID": linkID])
      discardWrites(linkID)
    }
    peripheralLinks.removeAll()
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    didAdd service: CBService,
    error: Error?
  ) {
    guard error == nil else {
      // The service was refused. Leave serviceRegistered false so the next
      // reconcile tries again rather than advertising nothing.
      serviceRegistered = false
      return
    }
    serviceRegistered = true
    applyState()
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didSubscribeTo characteristic: CBCharacteristic
  ) {
    AirhopLog.ble.notice("BLE link up (peripheral)")
    let linkID = peripheralLinkID(for: central)
    peripheralLinks[linkID] = central
    if liveMediaActive { applyConnectionLatency(to: central) }
    sendEvent(
      withName: BLEEvent.linkConnected,
      body: ["linkID": linkID, "role": "peripheral", "rssi": -99])
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didUnsubscribeFrom characteristic: CBCharacteristic
  ) {
    AirhopLog.ble.notice("BLE link down (peripheral)")
    let linkID = peripheralLinkID(for: central)
    peripheralLinks.removeValue(forKey: linkID)
    discardWrites(linkID)
    sendEvent(withName: BLEEvent.linkDisconnected, body: ["linkID": linkID])
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    didReceiveWrite requests: [CBATTRequest]
  ) {
    // respond() must be called on the FIRST request only, and only when
    // there is one, since indexing [0] on an empty array would crash.
    guard let first = requests.first else { return }

    // A frame longer than MTU-3 arrives as a long write, in chunks; joined
    // here, or each chunk reaches JS as a packet that fails to decode.
    let ours = requests.filter { $0.characteristic.uuid == BLEConst.characteristicUUID }
    let frames: [LongWrite.Frame<UUID>]
    switch LongWrite.join(
      ours.map { (key: $0.central.identifier, offset: $0.offset, data: $0.value ?? Data()) })
    {
    case .frames(let joined): frames = joined
    case .gap:
      peripheral.respond(to: first, withResult: .invalidOffset)
      return
    case .oversized:
      peripheral.respond(to: first, withResult: .invalidAttributeValueLength)
      return
    }
    var centrals: [UUID: CBCentral] = [:]
    for request in ours { centrals[request.central.identifier] = request.central }

    // A remote central that writes before subscribing still needs a link
    // entry, otherwise its packets arrive under a linkID JS has never seen.
    for frame in frames {
      guard let central = centrals[frame.key] else { continue }
      let linkID = peripheralLinkID(for: central)
      if peripheralLinks[linkID] == nil {
        peripheralLinks[linkID] = central
      }
      sendEvent(
        withName: BLEEvent.packetReceived,
        body: ["linkID": linkID, "dataBase64": frame.data.base64EncodedString()])
    }
    peripheral.respond(to: first, withResult: .success)
  }

  // CoreBluetooth has room in its transmit queue again: resume every
  // peripheral link's queue, in order, until it refuses once more.
  func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
    drainPeripheralLinks()
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    willRestoreState dict: [String: Any]
  ) {
    // iOS relaunched us into a session that already has our service
    // registered. Adopt it rather than adding a duplicate: `serviceRegistered`
    // is what stops applyState() calling add() for a service CoreBluetooth is
    // already advertising on our behalf.
    if let services = dict[CBPeripheralManagerRestoredStateServicesKey] as? [CBMutableService] {
      for service in services where service.uuid == BLEConst.serviceUUID {
        service.characteristics?.compactMap { $0 as? CBMutableCharacteristic }.forEach { char in
          if char.uuid == BLEConst.characteristicUUID {
            self.characteristic = char
            self.serviceRegistered = true
          }
        }
      }
    }
  }
}

// MARK: - Launch-time state restoration

// Holds the CoreBluetooth managers between process start and this module
// existing.
//
// iOS relaunches a terminated app when a restorable BLE session sees an event,
// and expects the manager with the matching restore identifier to be recreated
// inside application(_:didFinishLaunchingWithOptions:). React Native cannot:
// the module is built by the bridge and its managers later still, on the first
// call from JS, by which point the restoration callback has been delivered to
// nobody.
//
// The scene life cycle leaves launchOptions nil, so nothing at launch says
// whether this is such a relaunch. The app delegate therefore calls prepare()
// on every launch once Bluetooth is authorized (never before, since allocating
// a manager raises the permission prompt), and willRestoreState is the signal:
// iOS delivers it only to a relaunch that has state to hand back.
//
// Everything here runs on AirhopBLEQueue.shared, so the handover needs no
// locking: prepare() is enqueued from didFinishLaunching and the take* calls
// later, and a serial queue preserves that order.
final class AirhopBLERestoration: NSObject {
  static let shared = AirhopBLERestoration()

  private var central: CBCentralManager?
  private var peripheral: CBPeripheralManager?
  private var restoredPeripherals: [CBPeripheral] = []
  private var restoredCharacteristic: CBMutableCharacteristic?
  private var onRestore: (@MainActor () -> Void)?

  // Deliberately no private init: NSObject is required for the CoreBluetooth
  // delegate protocols, and narrowing an inherited initializer's access is
  // not portable across Swift versions. Nothing else constructs this type.

  // Called from the app delegate at launch. `onRestore` runs on the main
  // thread when iOS hands back state, so a relaunch can start what consumes it.
  // The options match the module's own managers, which these stand in for.
  func prepare(onRestore: @escaping @MainActor () -> Void) {
    AirhopBLEQueue.shared.async {
      self.onRestore = onRestore
      if self.central == nil {
        self.central = CBCentralManager(
          delegate: self,
          queue: AirhopBLEQueue.shared,
          options: [
            CBCentralManagerOptionRestoreIdentifierKey:
              BLEConst.centralRestorationKey
          ]
        )
      }
      if self.peripheral == nil {
        self.peripheral = CBPeripheralManager(
          delegate: self,
          queue: AirhopBLEQueue.shared,
          options: [
            CBPeripheralManagerOptionRestoreIdentifierKey:
              BLEConst.peripheralRestorationKey
          ]
        )
      }
    }
  }

  private func notifyRestored() {
    guard let onRestore else { return }
    Task { @MainActor in onRestore() }
  }

  // Hand ownership to the module and clear it here, so a second module (a dev
  // reload) builds its own rather than adopting ones whose delegate points at
  // a dead instance. Must be called on AirhopBLEQueue.shared.

  func takeCentral() -> CBCentralManager? {
    defer { central = nil }
    return central
  }

  func takePeripheral() -> CBPeripheralManager? {
    defer { peripheral = nil }
    return peripheral
  }

  func takeRestoredPeripherals() -> [CBPeripheral] {
    defer { restoredPeripherals = [] }
    return restoredPeripherals
  }

  func takeRestoredCharacteristic() -> CBMutableCharacteristic? {
    defer { restoredCharacteristic = nil }
    return restoredCharacteristic
  }
}

// Both delegates receive one callback each and buffer what it carries. The
// state callbacks are required by the protocols and do nothing: this type holds
// what arrived before anyone was listening, and answers nothing.
extension AirhopBLERestoration: CBCentralManagerDelegate {
  func centralManagerDidUpdateState(_ central: CBCentralManager) {}

  func centralManager(
    _ central: CBCentralManager,
    willRestoreState dict: [String: Any]
  ) {
    notifyRestored()
    guard
      let peripherals = dict[CBCentralManagerRestoredStatePeripheralsKey]
        as? [CBPeripheral]
    else { return }
    // Appended, not assigned: iOS may restore more than once before the
    // module attaches, and replacing would drop a live connection.
    restoredPeripherals.append(contentsOf: peripherals)
  }
}

extension AirhopBLERestoration: CBPeripheralManagerDelegate {
  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {}

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    willRestoreState dict: [String: Any]
  ) {
    notifyRestored()
    guard
      let services = dict[CBPeripheralManagerRestoredStateServicesKey]
        as? [CBMutableService]
    else { return }
    for service in services where service.uuid == BLEConst.serviceUUID {
      service.characteristics?
        .compactMap { $0 as? CBMutableCharacteristic }
        .forEach { char in
          if char.uuid == BLEConst.characteristicUUID {
            restoredCharacteristic = char
          }
        }
    }
  }
}
