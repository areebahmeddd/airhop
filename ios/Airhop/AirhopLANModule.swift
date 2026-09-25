// The LAN transport: Bonjour discovery over ordinary TCP.
//
// The only transport that reaches an Android phone from an iPhone over
// something other than Bluetooth. Wi-Fi Aware cannot: Apple requires a paired
// data path and Android has no way to complete Apple's pairing. This is plain
// IP, so it does not care which phone anyone owns.
//
// Framing and the read loop are the same shapes AirhopWiFiModule uses,
// deliberately: both carry the same length-prefixed Airhop packets and a bug
// fixed in one should be recognisable in the other.
//
// Three things differ from that module, each deliberately:
//
//   * Classic `NWConnection` and `NWListener`, not the iOS 26 generic
//     `NetworkConnection<TCP>`. Wi-Fi Aware needs iOS 26 regardless; this must
//     run on the app's floor, and Bonjour over Network framework has been there
//     since iOS 12. No availability gate anywhere below.
//   * Discovery and dialling are split, because Bonjour returns the whole
//     network and who to dial is a decision. TypeScript makes it
//     (services/lan-dial-policy.ts) and this opens what it is told to.
//   * No token tiebreak. The Wi-Fi module needs one because Apple's discovery is
//     symmetric; here the ring already decides which side dials.
//
// The instance name comes from TypeScript and is never the peer ID. See
// services/lan-controller.ts for why it rotates.
//
// Foreground only, structurally. iOS has no background mode for a listening
// socket, and a suspended app has its listener reclaimed without getting it back
// on resume. Bluetooth keeps the mesh alive with the screen off, and the Network
// screen says so.

import Foundation
import Network
import OSLog
import React

enum LANConst {
  // Must match `SERVICE_TYPE` in AirhopLANModule.kt and the `NSBonjourServices`
  // entry in Info.plist character for character. A mismatch is two apps that
  // cannot see each other.
  //
  // Not Wi-Fi Aware's `_airhop-mesh-v1._tcp`. Two services, named apart so
  // neither reads as a typo of the other: Aware is a radio protocol needing no
  // network, this is mDNS over an ordinary one.
  static let serviceType = "_airhop-lan-v1._tcp"
  static let domain = "local."
}

/// Liveness, the same numbers as the Kotlin side: a zero-length heartbeat every
/// 8 s, and a link that has carried nothing for 30 s is closed. Matters more
/// here than on any other link: a LAN link outranks Bluetooth for a peer held
/// on both, so a dead one would take every DM to that peer until it was noticed.
///
/// The dial timeout matches Android's 5 s. Without it a connect on a network
/// that drops peer traffic (client isolation) sits in `.waiting` for good, and
/// Network framework never fails it on its own.
private enum LANLiveness {
  static let heartbeat: TimeInterval = 8
  static let deadline: TimeInterval = 30
  static let connectTimeoutSeconds = 5
  /// A send the peer has not taken for this long ends the link: the same 30 s
  /// the read side allows, and the Kotlin side's write-stall close.
  static let persistTimeoutSeconds = 30
  /// Inbound caps, matching the Kotlin side: twice MAX_LAN_LINKS in
  /// lan-dial-policy.ts for the mesh, MAX_MOVE_HOSTS for a transfer.
  static let maxInboundLinks = 16
  static let maxInboundMoves = 4
}

private enum LANEvent {
  static let peerDiscovered = "AirhopLAN.peerDiscovered"
  static let peerLost = "AirhopLAN.peerLost"
  static let linkConnected = "AirhopLAN.linkConnected"
  static let linkDisconnected = "AirhopLAN.linkDisconnected"
  static let packetReceived = "AirhopLAN.packetReceived"
  static let availabilityChanged = "AirhopLAN.availabilityChanged"
}

// MARK: - Failures

/// The rejection codes services/lan-controller.ts branches on, shared with
/// AirhopLANModule.kt so one `classify` covers both platforms.
private enum LANFailure: Error {
  /// No network, or not on one that carries peers. Clears on its own.
  case unavailable(String)
  /// Local network access refused. On iOS the prompt is raised by browsing,
  /// and a refusal is only reversible in Settings.
  case permissionDenied
  /// The listener would not start.
  case listenFailed(String)
  case unknownPeer(String)
  case unknownLink(String)
  case connectFailed(String)
  case writeFailed(String)

  var code: String {
    switch self {
    case .unavailable: return "LAN_UNAVAILABLE"
    case .permissionDenied: return "PERMISSION_DENIED"
    case .listenFailed: return "LAN_LISTEN_FAILED"
    case .unknownPeer: return "UNKNOWN_PEER"
    case .unknownLink: return "UNKNOWN_LINK"
    case .connectFailed: return "CONNECT_FAILED"
    case .writeFailed: return "WRITE_FAILED"
    }
  }

  var message: String {
    switch self {
    case .unavailable(let detail): return detail
    case .permissionDenied: return "Local network access refused"
    case .listenFailed(let detail): return detail
    case .unknownPeer(let name): return "No discovered peer named \(name)"
    case .unknownLink(let id): return "No active LAN link: \(id)"
    case .connectFailed(let detail): return detail
    case .writeFailed(let detail): return detail
    }
  }
}

// MARK: - Transport

/// Everything with state, confined to one serial queue.
///
/// Network framework delivers its callbacks on whatever queue it was given and
/// bridge methods arrive on React Native's, so the registry and the discovery
/// map are touched from several threads at once. One queue rather than locks:
/// every mutation below is short, and the ordering it gives is what makes a
/// link's connect, ready and cancel sequence readable.
private final class LANTransport {
  private struct Link {
    let connection: NWConnection
    /// The peer this link was dialled for, or nil for one we accepted. An
    /// accepted connection is anonymous until its peer announces, and
    /// nothing here needs the name for anything but answering "already
    /// connected" to a repeat dial.
    let serviceName: String?
    var ready = false
    /// Monotonic, so a clock change cannot trip the deadline.
    var lastReadAt = ProcessInfo.processInfo.systemUptime
    var closing = false
  }

  private let emit: (String, [String: Any]) -> Void
  private let queue = DispatchQueue(label: "org.onemindlabs.airhop.lan")

  private var listener: NWListener?
  private var browser: NWBrowser?
  /// One timer for every link: sends the heartbeats and applies the deadline.
  private var liveness: DispatchSourceTimer?
  private var links: [String: Link] = [:]
  /// Endpoints Bonjour has told us about, by the name they publish. Held
  /// because a dial names a peer, not an address: Bonjour resolves lazily
  /// when the connection is made, which is why nothing above needs a host.
  private var discovered: [String: NWEndpoint] = [:]
  /// linkID by peer name, so a repeat dial for a peer already linked resolves
  /// without opening a second socket. TypeScript walks its dial plan on a
  /// timer, since a link can drop while the peer's Bonjour record stays
  /// visible, and it does not track which names are linked: that is this
  /// module's knowledge.
  private var linkByName: [String: String] = [:]
  private var instanceName: String?
  private var linkSeq = 0
  /// Set when the browser is refused for policy, which is how a denied local
  /// network permission arrives: there is no API to ask, and the prompt is
  /// raised by browsing rather than by declaring the service.
  ///
  /// Read by the NEXT start rather than reported from here, because by the
  /// time it lands the current start has already resolved. The controller's
  /// retry ladder asks again within half a second, and that attempt is the one
  /// that can say why.
  private var policyDenied = false
  /// The in-flight start's promise. Held because a listener is not usable at
  /// the moment it is created: it has to reach `.ready`, and reporting success
  /// before then would tell the controller a transport exists that cannot yet
  /// accept a connection.
  private var pendingStart: ((LANFailure?) -> Void)?
  /// Reported only on transitions. A second `available: false` while already
  /// down resets the controller's backoff, turning its retry ladder into a
  /// tight loop.
  private var lastReportedAvailable: Bool?

  init(emit: @escaping (String, [String: Any]) -> Void) {
    self.emit = emit
  }

  // MARK: Start and stop

  func start(instanceName: String, completion: @escaping (LANFailure?) -> Void) {
    queue.async {
      // Idempotent: the reconciler calls start whenever it is unsure.
      if self.listener != nil {
        completion(nil)
        return
      }
      // A refusal the previous attempt could not report in time.
      if self.policyDenied {
        self.policyDenied = false
        completion(.permissionDenied)
        return
      }
      self.instanceName = instanceName
      self.lastReportedAvailable = nil
      self.pendingStart = completion

      let parameters = self.tcpParameters()

      let listener: NWListener
      do {
        listener = try NWListener(using: parameters)
      } catch {
        self.instanceName = nil
        self.pendingStart = nil
        completion(.listenFailed(String(describing: error)))
        return
      }
      listener.service = NWListener.Service(
        name: instanceName,
        type: LANConst.serviceType
      )
      listener.newConnectionHandler = { [weak self] connection in
        self?.queue.async { self?.adopt(connection, direction: "in") }
      }
      listener.stateUpdateHandler = { [weak self] state in
        guard let self else { return }
        self.queue.async {
          switch state {
          case .failed(let error):
            // Most often no usable network. Whoever is still waiting
            // on start hears why; anyone later hears it as the
            // transport going away.
            self.reportDead(.unavailable(String(describing: error)))
          case .cancelled:
            self.report(available: false)
          case .ready:
            self.settleStart(nil)
            self.report(available: true)
          default:
            break
          }
        }
      }
      self.listener = listener
      listener.start(queue: self.queue)

      self.startBrowsing(parameters: parameters)
      self.startLiveness()
    }
  }

  /// Shared by the listener, the browser and every dial. `noDelay` because
  /// frames are small and latency matters more than packing; the connect
  /// timeout is the only thing that ends a dial a network is silently
  /// dropping; the persist timeout ends a link whose peer stopped reading,
  /// which otherwise holds every queued send in memory.
  ///
  /// No peer-to-peer (AWDL): the transport is "everyone on this network", and
  /// Android cannot see AWDL services. A link-local address on the joined
  /// network is reachable without it. Cellular is refused because nobody else
  /// is on it, loopback because that is another app on this phone.
  private func tcpParameters() -> NWParameters {
    let parameters = NWParameters.tcp
    if let tcp = parameters.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
      tcp.noDelay = true
      tcp.enableKeepalive = true
      tcp.connectionTimeout = LANLiveness.connectTimeoutSeconds
      tcp.persistTimeout = LANLiveness.persistTimeoutSeconds
    }
    parameters.prohibitedInterfaceTypes = [.cellular, .loopback]
    return parameters
  }

  private func startLiveness() {
    liveness?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + LANLiveness.heartbeat, repeating: LANLiveness.heartbeat)
    timer.setEventHandler { [weak self] in self?.tick() }
    timer.resume()
    liveness = timer
  }

  /// Every link that is up gets a heartbeat; one silent past the deadline is
  /// closed. `send` on a dead connection reports the error, which closes it
  /// the same way.
  private func tick() {
    let now = ProcessInfo.processInfo.systemUptime
    for (linkID, link) in links where link.ready && !link.closing {
      if now - link.lastReadAt > LANLiveness.deadline {
        AirhopLog.lan.notice("LAN link idle past deadline: \(linkID, privacy: .public)")
        closeLink(linkID)
        continue
      }
      link.connection.send(
        content: Framing.encode(Data()),
        completion: .contentProcessed { [weak self] error in
          guard error != nil else { return }
          self?.queue.async { self?.closeLink(linkID) }
        }
      )
    }
  }

  /// Answer the in-flight start exactly once. A listener reports `.ready` and
  /// later `.failed`, and only the first of those is the start's answer.
  private func settleStart(_ failure: LANFailure?) {
    guard let pending = pendingStart else { return }
    pendingStart = nil
    if failure != nil { instanceName = nil }
    pending(failure)
  }

  func stop(completion: @escaping () -> Void) {
    queue.async {
      self.settleStart(.unavailable("stopped"))
      self.teardown()
      completion()
    }
  }

  /// Release everything and forget we are running. Callers are already on
  /// `queue`. Keys copied before closing, matching the Kotlin side, so the
  /// loop does not walk a dictionary its own body is emptying.
  private func teardown() {
    liveness?.cancel()
    liveness = nil
    browser?.cancel()
    browser = nil
    listener?.cancel()
    listener = nil
    instanceName = nil
    discovered.removeAll()
    linkByName.removeAll()
    for id in Array(links.keys) { closeLink(id) }
  }

  /// The listener or the browser died under us.
  ///
  /// Torn down here rather than waiting for the controller's stopLAN, which is
  /// a bridge hop away: `start` is idempotent on `listener != nil`, so one
  /// landing in that window resolves at once over a dead transport.
  private func reportDead(_ failure: LANFailure) {
    settleStart(failure)
    teardown()
    report(available: false)
  }

  private func report(available: Bool) {
    guard lastReportedAvailable != available else { return }
    lastReportedAvailable = available
    emit(LANEvent.availabilityChanged, ["available": available])
  }

  // MARK: Discovery

  private func startBrowsing(parameters: NWParameters) {
    let descriptor = NWBrowser.Descriptor.bonjour(
      type: LANConst.serviceType,
      domain: LANConst.domain
    )
    let browser = NWBrowser(for: descriptor, using: parameters)
    browser.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      self.queue.async {
        if case .failed(let error) = state {
          // Browsing is what raises the local network prompt, so a
          // refusal shows up here rather than at start.
          if case .dns(let code) = error, code == kDNSServiceErr_PolicyDenied {
            self.policyDenied = true
          }
          self.reportDead(.unavailable(String(describing: error)))
        }
      }
    }
    browser.browseResultsChangedHandler = { [weak self] results, _ in
      self?.queue.async { self?.applyBrowseResults(results) }
    }
    self.browser = browser
    browser.start(queue: queue)
  }

  /// Bonjour hands back the whole current set on every change rather than a
  /// delta, so this diffs against what we hold: anything new is announced,
  /// anything gone is retired.
  private func applyBrowseResults(_ results: Set<NWBrowser.Result>) {
    var seen: [String: NWEndpoint] = [:]
    for result in results {
      guard case .service(let name, _, _, _) = result.endpoint else { continue }
      // Our own record comes back off the network like anyone else's.
      if name == instanceName { continue }
      seen[name] = result.endpoint
    }

    for (name, endpoint) in seen where discovered[name] == nil {
      discovered[name] = endpoint
      emit(LANEvent.peerDiscovered, ["serviceName": name])
    }
    for name in discovered.keys where seen[name] == nil {
      discovered.removeValue(forKey: name)
      emit(LANEvent.peerLost, ["serviceName": name])
    }
  }

  // MARK: Links

  func connect(to serviceName: String, completion: @escaping (LANFailure?) -> Void) {
    queue.async {
      guard let endpoint = self.discovered[serviceName] else {
        completion(.unknownPeer(serviceName))
        return
      }
      // Idempotent, for the reason `linkByName` exists.
      if let existing = self.linkByName[serviceName], self.links[existing] != nil {
        completion(nil)
        return
      }
      let connection = NWConnection(to: endpoint, using: self.tcpParameters())
      self.adopt(
        connection,
        direction: "out",
        serviceName: serviceName,
        onReady: completion
      )
    }
  }

  /// Register a connection and follow it to ready or failure.
  ///
  /// `onReady` is the dial's promise and fires exactly once. An inbound
  /// connection has no promise waiting, so it passes nil.
  private func adopt(
    _ connection: NWConnection,
    direction: String,
    serviceName: String? = nil,
    onReady: ((LANFailure?) -> Void)? = nil
  ) {
    // Over the cap an inbound connection is refused at once rather than
    // queued. Accepted links are the ones with no service name.
    if direction == "in",
      links.values.filter({ $0.serviceName == nil }).count >= LANLiveness.maxInboundLinks
    {
      AirhopLog.lan.notice("Refused inbound LAN link, past the cap")
      connection.cancel()
      return
    }
    linkSeq += 1
    let linkID = "lan-\(direction)-\(linkSeq)"
    links[linkID] = Link(connection: connection, serviceName: serviceName)
    if let serviceName { linkByName[serviceName] = linkID }

    var settled = false
    connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      self.queue.async {
        switch state {
        case .ready:
          if !settled {
            settled = true
            onReady?(nil)
          }
          if var link = self.links[linkID] {
            link.ready = true
            link.lastReadAt = ProcessInfo.processInfo.systemUptime
            self.links[linkID] = link
          }
          AirhopLog.lan.notice("LAN link up: \(linkID, privacy: .public)")
          self.emit(LANEvent.linkConnected, ["linkID": linkID])
          self.readFrame(linkID: linkID, connection: connection)
        case .waiting(let error):
          // No path, or a connect the network is dropping. Network
          // framework waits for a better path indefinitely; a link is
          // not one, so this ends here as a failure.
          if !settled {
            settled = true
            onReady?(.connectFailed(String(describing: error)))
          }
          self.closeLink(linkID)
        case .failed(let error):
          if !settled {
            settled = true
            // Most often client isolation, which every guest
            // network enables and which cannot be detected before
            // trying.
            onReady?(.connectFailed(String(describing: error)))
          }
          self.retire(linkID)
        case .cancelled:
          if !settled {
            settled = true
            onReady?(.connectFailed("cancelled"))
          }
          self.retire(linkID)
        default:
          break
        }
      }
    }
    connection.start(queue: queue)
  }

  /// One frame, then schedule the next. Recursive rather than a loop because
  /// `receive` is callback-based: each completion queues the following read.
  private func readFrame(linkID: String, connection: NWConnection) {
    connection.receive(
      minimumIncompleteLength: Framing.prefixBytes,
      maximumLength: Framing.prefixBytes
    ) { [weak self] header, _, isComplete, error in
      guard let self else { return }
      self.queue.async {
        guard error == nil, !isComplete, let header,
          let length = Framing.length(header)
        else {
          self.closeLink(linkID)
          return
        }
        self.noteRead(linkID)
        // A heartbeat carries nothing.
        if length == 0 {
          self.readFrame(linkID: linkID, connection: connection)
          return
        }
        connection.receive(
          minimumIncompleteLength: length,
          maximumLength: length
        ) { payload, _, payloadComplete, payloadError in
          self.queue.async {
            guard payloadError == nil, !payloadComplete, let payload,
              payload.count == length
            else {
              self.closeLink(linkID)
              return
            }
            self.emit(
              LANEvent.packetReceived,
              [
                "linkID": linkID,
                "dataBase64": payload.base64EncodedString(),
              ]
            )
            self.readFrame(linkID: linkID, connection: connection)
          }
        }
      }
    }
  }

  private func noteRead(_ linkID: String) {
    guard var link = links[linkID] else { return }
    link.lastReadAt = ProcessInfo.processInfo.systemUptime
    links[linkID] = link
  }

  func write(
    linkID: String,
    payload: Data,
    completion: @escaping (LANFailure?) -> Void
  ) {
    queue.async {
      guard let link = self.links[linkID], !link.closing else {
        completion(.unknownLink(linkID))
        return
      }
      // `NWConnection.send` serialises on its own: frames queued from one
      // connection go out in order and cannot interleave, which is what
      // the Wi-Fi module needs a SerialSender to guarantee.
      link.connection.send(
        content: Framing.encode(payload),
        completion: .contentProcessed { [weak self] error in
          guard let self else { return }
          self.queue.async {
            if let error {
              // A refused write cannot carry the rest of the
              // transfer either, so tear down here rather than
              // wait for the read loop to notice.
              self.closeLink(linkID)
              completion(.writeFailed(String(describing: error)))
            } else {
              completion(nil)
            }
          }
        }
      )
    }
  }

  /// Ask a link to end. Cancelling drives the state handler, whose `.cancelled`
  /// branch calls `retire`, which is what reports it.
  private func closeLink(_ linkID: String) {
    guard var link = links[linkID], !link.closing else { return }
    link.closing = true
    links[linkID] = link
    link.connection.cancel()
  }

  /// Forget a link and tell TypeScript. Idempotent: a connection can report
  /// failed and then cancelled, and only the first of those retires it.
  private func retire(_ linkID: String) {
    guard let link = links.removeValue(forKey: linkID) else { return }
    // Only if it still points here: a newer link may have claimed the name,
    // and clearing it would make the live one look absent.
    if let name = link.serviceName, linkByName[name] == linkID {
      linkByName.removeValue(forKey: name)
    }
    AirhopLog.lan.notice("LAN link down: \(linkID, privacy: .public)")
    emit(LANEvent.linkDisconnected, ["linkID": linkID])
  }
}

// MARK: - Transfer

private enum MoveEvent {
  static let connected = "AirhopLAN.moveConnected"
  static let data = "AirhopLAN.moveData"
  static let closed = "AirhopLAN.moveClosed"
}

/// The transfer socket (services/move-link.ts): same framing and liveness as a
/// mesh link, on its own queue so stopping the mesh never cuts it. No Bonjour:
/// the new phone's code carries its addresses.
private final class MoveTransport {
  private struct Connection {
    let connection: NWConnection
    /// Accepted rather than dialled, for the inbound cap.
    let inbound: Bool
    var ready = false
    var lastReadAt = ProcessInfo.processInfo.systemUptime
    var closing = false
  }

  private let emit: (String, [String: Any]) -> Void
  private let queue = DispatchQueue(label: "org.onemindlabs.airhop.move")
  private var listener: NWListener?
  private var liveness: DispatchSourceTimer?
  private var connections: [String: Connection] = [:]
  private var seq = 0
  /// The port is known only once the listener is ready.
  private var portWaiters: [(UInt16?) -> Void] = []

  init(emit: @escaping (String, [String: Any]) -> Void) {
    self.emit = emit
  }

  /// As LANTransport.tcpParameters. Cellular and loopback are refused here
  /// too: a code names addresses on the local network, and nothing else may
  /// connect in.
  private func parameters() -> NWParameters {
    let parameters = NWParameters.tcp
    if let tcp = parameters.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
      tcp.noDelay = true
      tcp.enableKeepalive = true
      tcp.connectionTimeout = LANLiveness.connectTimeoutSeconds
      tcp.persistTimeout = LANLiveness.persistTimeoutSeconds
    }
    parameters.prohibitedInterfaceTypes = [.cellular, .loopback]
    return parameters
  }

  func startListener(completion: @escaping (UInt16?) -> Void) {
    queue.async {
      if let listener = self.listener {
        if let port = listener.port?.rawValue {
          completion(port)
        } else {
          self.portWaiters.append(completion)
        }
        return
      }
      let listener: NWListener
      do {
        listener = try NWListener(using: self.parameters())
      } catch {
        completion(nil)
        return
      }
      self.portWaiters.append(completion)
      listener.newConnectionHandler = { [weak self] connection in
        self?.queue.async { self?.adopt(connection, direction: "in", onReady: nil) }
      }
      // A stopped listener reports late; it must not touch its successor.
      listener.stateUpdateHandler = { [weak self, weak listener] state in
        guard let self else { return }
        self.queue.async {
          guard let listener, self.listener === listener else { return }
          switch state {
          case .ready:
            self.settlePort(listener.port?.rawValue)
          case .failed, .cancelled:
            self.settlePort(nil)
            self.listener = nil
          default:
            break
          }
        }
      }
      self.listener = listener
      listener.start(queue: self.queue)
      self.startLiveness()
    }
  }

  private func settlePort(_ port: UInt16?) {
    let waiters = portWaiters
    portWaiters.removeAll()
    for waiter in waiters { waiter(port) }
  }

  func stop(completion: @escaping () -> Void) {
    queue.async {
      self.settlePort(nil)
      self.listener?.cancel()
      self.listener = nil
      self.liveness?.cancel()
      self.liveness = nil
      for id in Array(self.connections.keys) { self.close(id) }
      completion()
    }
  }

  func dial(host: String, port: UInt16, completion: @escaping (String?, LANFailure?) -> Void) {
    queue.async {
      guard let nwPort = NWEndpoint.Port(rawValue: port) else {
        completion(nil, .connectFailed("invalid port"))
        return
      }
      let connection = NWConnection(
        host: NWEndpoint.Host(host),
        port: nwPort,
        using: self.parameters()
      )
      if self.liveness == nil { self.startLiveness() }
      self.adopt(connection, direction: "out", onReady: completion)
    }
  }

  private func adopt(
    _ connection: NWConnection,
    direction: String,
    onReady: ((String?, LANFailure?) -> Void)?
  ) {
    let inbound = direction == "in"
    if inbound, connections.values.filter({ $0.inbound }).count >= LANLiveness.maxInboundMoves {
      AirhopLog.lan.notice("Refused inbound transfer connection, past the cap")
      connection.cancel()
      return
    }
    seq += 1
    let id = "move-\(direction)-\(seq)"
    connections[id] = Connection(connection: connection, inbound: inbound)
    var settled = false
    connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      self.queue.async {
        switch state {
        case .ready:
          if !settled {
            settled = true
            onReady?(id, nil)
          }
          if var entry = self.connections[id] {
            entry.ready = true
            entry.lastReadAt = ProcessInfo.processInfo.systemUptime
            self.connections[id] = entry
          }
          self.emit(MoveEvent.connected, ["connectionID": id])
          self.readFrame(id: id, connection: connection)
        case .waiting(let error):
          // Local network privacy leaves the dial waiting while it prompts;
          // the retry after Allow connects.
          if !settled {
            settled = true
            if case .dns(let code) = error, code == kDNSServiceErr_PolicyDenied {
              onReady?(nil, .permissionDenied)
            } else {
              onReady?(nil, .connectFailed(String(describing: error)))
            }
          }
          self.close(id)
        case .failed(let error):
          if !settled {
            settled = true
            onReady?(nil, .connectFailed(String(describing: error)))
          }
          self.retire(id)
        case .cancelled:
          if !settled {
            settled = true
            onReady?(nil, .connectFailed("cancelled"))
          }
          self.retire(id)
        default:
          break
        }
      }
    }
    connection.start(queue: queue)
  }

  private func startLiveness() {
    liveness?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + LANLiveness.heartbeat, repeating: LANLiveness.heartbeat)
    timer.setEventHandler { [weak self] in self?.tick() }
    timer.resume()
    liveness = timer
  }

  private func tick() {
    let now = ProcessInfo.processInfo.systemUptime
    for (id, entry) in connections where entry.ready && !entry.closing {
      if now - entry.lastReadAt > LANLiveness.deadline {
        close(id)
        continue
      }
      entry.connection.send(
        content: Framing.encode(Data()),
        completion: .contentProcessed { [weak self] error in
          guard error != nil else { return }
          self?.queue.async { self?.close(id) }
        }
      )
    }
  }

  private func readFrame(id: String, connection: NWConnection) {
    connection.receive(
      minimumIncompleteLength: Framing.prefixBytes,
      maximumLength: Framing.prefixBytes
    ) { [weak self] header, _, isComplete, error in
      guard let self else { return }
      self.queue.async {
        guard error == nil, !isComplete, let header,
          let length = Framing.length(header)
        else {
          self.close(id)
          return
        }
        if var entry = self.connections[id] {
          entry.lastReadAt = ProcessInfo.processInfo.systemUptime
          self.connections[id] = entry
        }
        if length == 0 {
          self.readFrame(id: id, connection: connection)
          return
        }
        connection.receive(
          minimumIncompleteLength: length,
          maximumLength: length
        ) { payload, _, payloadComplete, payloadError in
          self.queue.async {
            guard payloadError == nil, !payloadComplete, let payload,
              payload.count == length
            else {
              self.close(id)
              return
            }
            self.emit(
              MoveEvent.data,
              ["connectionID": id, "dataBase64": payload.base64EncodedString()]
            )
            self.readFrame(id: id, connection: connection)
          }
        }
      }
    }
  }

  func write(id: String, payload: Data, completion: @escaping (LANFailure?) -> Void) {
    queue.async {
      guard let entry = self.connections[id], !entry.closing else {
        completion(.unknownLink(id))
        return
      }
      entry.connection.send(
        content: Framing.encode(payload),
        completion: .contentProcessed { [weak self] error in
          guard let self else { return }
          self.queue.async {
            if let error {
              self.close(id)
              completion(.writeFailed(String(describing: error)))
            } else {
              completion(nil)
            }
          }
        }
      )
    }
  }

  func closeConnection(id: String, completion: @escaping () -> Void) {
    queue.async {
      self.close(id)
      completion()
    }
  }

  private func close(_ id: String) {
    guard var entry = connections[id], !entry.closing else { return }
    entry.closing = true
    connections[id] = entry
    entry.connection.cancel()
  }

  private func retire(_ id: String) {
    guard connections.removeValue(forKey: id) != nil else { return }
    emit(MoveEvent.closed, ["connectionID": id])
  }

  /// IPv4 on Wi-Fi (en*) and a served hotspot (bridge*). Cellular and tunnels
  /// carry nobody beside us.
  static func localHosts() -> [String] {
    var hosts: [String] = []
    var head: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&head) == 0, let first = head else { return hosts }
    defer { freeifaddrs(head) }
    var cursor: UnsafeMutablePointer<ifaddrs>? = first
    while let ifa = cursor {
      defer { cursor = ifa.pointee.ifa_next }
      let flags = Int32(ifa.pointee.ifa_flags)
      guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0,
        let addr = ifa.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET)
      else { continue }
      let name = String(cString: ifa.pointee.ifa_name)
      guard name.hasPrefix("en") || name.hasPrefix("bridge") else { continue }
      var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      guard
        getnameinfo(
          addr, socklen_t(addr.pointee.sa_len), &buffer, socklen_t(buffer.count),
          nil, 0, NI_NUMERICHOST) == 0
      else { continue }
      let host = String(cString: buffer)
      if host.hasPrefix("169.254.") || hosts.contains(host) { continue }
      hosts.append(host)
    }
    return hosts
  }
}

// MARK: - Bridge

@objc(AirhopLANModule)
final class AirhopLANModule: RCTEventEmitter {

  private lazy var transport = LANTransport { [weak self] name, body in
    self?.emit(name, body)
  }

  private lazy var move = MoveTransport { [weak self] name, body in
    self?.emit(name, body)
  }

  @objc override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! {
    [
      LANEvent.peerDiscovered,
      LANEvent.peerLost,
      LANEvent.linkConnected,
      LANEvent.linkDisconnected,
      LANEvent.packetReceived,
      LANEvent.availabilityChanged,
      MoveEvent.connected,
      MoveEvent.data,
      MoveEvent.closed,
    ]
  }

  /// Callers are framework callbacks with no bridge above them, and sending
  /// into a departed runtime traps.
  private func emit(_ name: String, _ body: [String: Any]) {
    guard bridge != nil else { return }
    sendEvent(withName: name, body: body)
  }

  // MARK: Exported

  @objc(startLAN:resolver:rejecter:)
  func startLAN(
    instanceName: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    transport.start(instanceName: instanceName) { failure in
      if let failure {
        reject(failure.code, failure.message, nil)
      } else {
        resolve(nil)
      }
    }
  }

  @objc(stopLAN:rejecter:)
  func stopLAN(
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    transport.stop { resolve(nil) }
  }

  @objc(connectToPeer:resolver:rejecter:)
  func connectToPeer(
    serviceName: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    transport.connect(to: serviceName) { failure in
      if let failure {
        reject(failure.code, failure.message, nil)
      } else {
        resolve(nil)
      }
    }
  }

  @objc(writeToLANLink:dataBase64:resolver:rejecter:)
  func writeToLANLink(
    linkID: String,
    dataBase64: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let payload = Data(base64Encoded: dataBase64) else {
      reject("INVALID_DATA", "Invalid base64 payload", nil)
      return
    }
    guard payload.count <= Framing.maxFrame - Framing.prefixBytes else {
      reject(
        "FRAME_TOO_LARGE",
        "Frame of \(payload.count) exceeds the peer's read limit",
        nil
      )
      return
    }
    // The empty frame is the heartbeat.
    guard !payload.isEmpty else {
      reject("INVALID_DATA", "Empty frame", nil)
      return
    }
    transport.write(linkID: linkID, payload: payload) { failure in
      if let failure {
        reject(failure.code, failure.message, nil)
      } else {
        resolve(nil)
      }
    }
  }

  // MARK: Transfer

  @objc(startMoveListener:rejecter:)
  func startMoveListener(
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    move.startListener { port in
      guard let port else {
        reject("MOVE_LISTEN_FAILED", "Could not open the move socket", nil)
        return
      }
      resolve(["port": Int(port), "hosts": MoveTransport.localHosts()])
    }
  }

  @objc(stopMove:rejecter:)
  func stopMove(
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    move.stop { resolve(nil) }
  }

  @objc(dialMove:port:resolver:rejecter:)
  func dialMove(
    host: String,
    port: Double,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard port >= 1, port <= 65_535 else {
      reject("CONNECT_FAILED", "Port out of range", nil)
      return
    }
    move.dial(host: host, port: UInt16(port)) { id, failure in
      if let id {
        resolve(id)
      } else {
        let failure = failure ?? .connectFailed("unknown")
        reject(failure.code, failure.message, nil)
      }
    }
  }

  @objc(writeMove:dataBase64:resolver:rejecter:)
  func writeMove(
    connectionID: String,
    dataBase64: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let payload = Data(base64Encoded: dataBase64), !payload.isEmpty else {
      reject("INVALID_DATA", "Invalid base64 payload", nil)
      return
    }
    guard payload.count <= Framing.maxFrame - Framing.prefixBytes else {
      reject("FRAME_TOO_LARGE", "Frame of \(payload.count) exceeds the peer's read limit", nil)
      return
    }
    move.write(id: connectionID, payload: payload) { failure in
      if let failure {
        reject(failure.code, failure.message, nil)
      } else {
        resolve(nil)
      }
    }
  }

  @objc(closeMove:resolver:rejecter:)
  func closeMove(
    connectionID: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    move.closeConnection(id: connectionID) { resolve(nil) }
  }

  // MARK: Lifecycle

  /// Every link exists to hand bytes to a runtime that is gone, and a listener
  /// nobody hears is a socket left open.
  override func invalidate() {
    transport.stop {}
    move.stop {}
    super.invalidate()
  }
}
