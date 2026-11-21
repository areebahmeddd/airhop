// The WebSocket every Nostr relay connection rides on iOS, Tor or not:
// URLSessionWebSocketTask, whose receive fails once a message passes
// `maximumMessageSize`. React Native's own WebSocket (SocketRocket) buffers a
// message of any declared length, so a hostile relay could exhaust memory with
// one huge frame, and it cannot speak SOCKS5 either. Each socket's lifecycle
// reaches JS as `RelaySocketEvent`s keyed by a per-connection id.
//
// Two sessions: one through Arti's SOCKS5 proxy, one direct. JS names the route
// per connection (tor-routing.ts is the one place that decides it), since iOS
// has no process-wide proxy hook. While Tor is wanted, the relay pool is held
// until a circuit exists, so nothing reaches the direct session in its name.
// Everything else iOS sends is issued from TypeScript and sits outside the
// tunnel, which is why the wallet mint gate and the update check refuse rather
// than route while Tor is on.
//
// Bridge file: AirhopRelaySocket.mm
// TypeScript spec: src/bridge/NativeAirhopRelaySocket.ts
// JS WebSocket shim: src/services/relay-websocket.ts
//
// Security:
//  - TLS is validated end to end to the relay by URLSession's default trust
//    evaluation. There is deliberately no urlSession(_:didReceive:), so there is
//    no certificate bypass: SOCKS only tunnels the TCP stream; the wss://
//    handshake and certificate check still happen against the real relay.
//  - Both sessions are ephemeral, so no cookies, cache or credentials persist to
//    disk that could correlate one Tor circuit with another.
//  - waitsForConnectivity is off: if Arti's SOCKS port is not listening the
//    connect fails fast and is reported as an error + close. The JS layer keeps
//    Tor selected and retries; it never silently falls back to the clear net.

import Foundation
import React

@objc(AirhopRelaySocket)
final class AirhopRelaySocket: RCTEventEmitter, URLSessionWebSocketDelegate {

  private static let eventName = "RelaySocketEvent"

  // The largest message a relay may send. Every event Airhop sends or expects
  // is a few KiB, and public relays refuse events far smaller than this. Set
  // explicitly because Apple documents no default.
  private static let maxMessageBytes = 1 << 20

  // Guards `tasks` and `sessions`, which are touched from both the JS method
  // queue (connect / send / close) and the sessions' delegate queue (receive /
  // delegate).
  private let lock = NSLock()
  private var tasks: [String: URLSessionWebSocketTask] = [:]
  // Keyed by route, created on first use. A session holds its delegate
  // strongly, so each is invalidated with the module.
  private var sessions: [Bool: URLSession] = [:]
  private var hasListeners = false

  // Serialized delegate queue keeps receive callbacks and delegate events off
  // the main thread and ordered, so a socket's frames arrive in sequence.
  private lazy var delegateQueue: OperationQueue = {
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    queue.name = "org.onemindlabs.airhop.relaysocket"
    return queue
  }()

  private func session(viaTor: Bool) -> URLSession {
    lock.lock()
    defer { lock.unlock() }
    if let session = sessions[viaTor] { return session }
    let cfg = URLSessionConfiguration.ephemeral
    cfg.waitsForConnectivity = false
    if viaTor {
      cfg.connectionProxyDictionary = [
        "SOCKSEnable": 1,
        "SOCKSProxy": AirhopTorEndpoint.socksHost,
        "SOCKSPort": AirhopTorEndpoint.socksPort,
      ]
    }
    let session = URLSession(configuration: cfg, delegate: self, delegateQueue: delegateQueue)
    sessions[viaTor] = session
    return session
  }

  // MARK: - RCTEventEmitter

  override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! { [AirhopRelaySocket.eventName] }

  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  private func emit(_ id: String, _ type: String, _ extra: [String: Any] = [:]) {
    guard hasListeners else { return }
    var body: [String: Any] = ["id": id, "type": type]
    for (key, value) in extra { body[key] = value }
    sendEvent(withName: AirhopRelaySocket.eventName, body: body)
  }

  // MARK: - Task registry (atomic claim so exactly one path reports close)

  private func store(_ id: String, _ task: URLSessionWebSocketTask) {
    lock.lock()
    defer { lock.unlock() }
    tasks[id] = task
  }

  private func peek(_ id: String) -> URLSessionWebSocketTask? {
    lock.lock()
    defer { lock.unlock() }
    return tasks[id]
  }

  // Remove and return the task for `id`, or nil if it was already claimed. The
  // caller that gets a non-nil result owns emitting the single close event.
  private func claim(_ id: String) -> URLSessionWebSocketTask? {
    lock.lock()
    defer { lock.unlock() }
    let task = tasks[id]
    tasks[id] = nil
    return task
  }

  private func claim(byTask task: URLSessionTask) -> String? {
    lock.lock()
    defer { lock.unlock() }
    guard let id = tasks.first(where: { $0.value === task })?.key else { return nil }
    tasks[id] = nil
    return id
  }

  private func id(forTask task: URLSessionTask) -> String? {
    lock.lock()
    defer { lock.unlock() }
    return tasks.first(where: { $0.value === task })?.key
  }

  // MARK: - JS API

  @objc(connect:url:viaTor:)
  func connect(_ id: String, url urlString: String, viaTor: Bool) {
    guard let url = URL(string: urlString),
      let scheme = url.scheme?.lowercased(),
      scheme == "wss" || scheme == "ws"
    else {
      emit(id, "error", ["message": "invalid websocket url"])
      emit(id, "close", ["code": 1006, "reason": "invalid websocket url"])
      return
    }
    let task = session(viaTor: viaTor).webSocketTask(with: url)
    task.maximumMessageSize = AirhopRelaySocket.maxMessageBytes
    store(id, task)
    task.resume()
    receive(id)
  }

  @objc(send:data:)
  func send(_ id: String, data: String) {
    guard let task = peek(id) else {
      emit(id, "error", ["message": "send on closed socket"])
      return
    }
    task.send(.string(data)) { [weak self] error in
      if let error = error {
        self?.emit(id, "error", ["message": error.localizedDescription])
      }
    }
  }

  @objc(close:code:reason:)
  func close(_ id: String, code: NSNumber, reason: String) {
    guard let task = claim(id) else { return }
    let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code.intValue) ?? .normalClosure
    task.cancel(with: closeCode, reason: reason.data(using: .utf8))
    // A locally-initiated cancel does not always fire didCloseWith, so emit the
    // close here. `claim` guarantees this fires exactly once for the socket.
    emit(id, "close", ["code": code.intValue, "reason": reason])
  }

  // MARK: - Receive loop

  private func receive(_ id: String) {
    guard let task = peek(id) else { return }
    task.receive { [weak self] result in
      guard let self = self else { return }
      switch result {
      case .failure(let error):
        // Terminal for this socket, a message past maximumMessageSize included.
        // Report + close once (claim wins the race with any concurrent delegate
        // callback), and drop the connection so it holds nothing open.
        if let claimed = self.claim(id) {
          claimed.cancel()
          self.emit(id, "error", ["message": error.localizedDescription])
          self.emit(id, "close", ["code": 1006, "reason": "receive failed"])
        }
      case .success(let message):
        switch message {
        case .string(let text):
          self.emit(id, "message", ["data": text])
        case .data(let data):
          // Nostr frames are JSON text; a binary frame is unexpected but passes
          // through base64-encoded so the JS side can decode if it must.
          self.emit(id, "message", ["data": data.base64EncodedString(), "binary": true])
        @unknown default:
          break
        }
        self.receive(id)
      }
    }
  }

  // MARK: - URLSessionWebSocketDelegate

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocolName: String?
  ) {
    if let id = id(forTask: webSocketTask) {
      emit(id, "open")
    }
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    guard let id = claim(byTask: webSocketTask) else { return }
    let reasonStr = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    emit(id, "close", ["code": closeCode.rawValue, "reason": reasonStr])
  }

  // Surface transport-level failures, including SOCKS/connect errors when Arti
  // is not yet listening, as an error + close so the JS relay can retry.
  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    guard let error = error, let id = claim(byTask: task) else { return }
    emit(id, "error", ["message": error.localizedDescription])
    emit(id, "close", ["code": 1006, "reason": error.localizedDescription])
  }

  // MARK: - Teardown

  override func invalidate() {
    let live: [URLSessionWebSocketTask]
    let open: [URLSession]
    lock.lock()
    live = Array(tasks.values)
    tasks.removeAll()
    open = Array(sessions.values)
    sessions.removeAll()
    lock.unlock()
    for task in live { task.cancel(with: .goingAway, reason: nil) }
    // Releases the strong reference each session holds to this module.
    for session in open { session.finishTasksAndInvalidate() }
    super.invalidate()
  }
}
