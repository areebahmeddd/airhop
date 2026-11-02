// What the home screen widget shows, decided from the app's last snapshot, and
// where that snapshot lives.
//
// Compiled into the app (AirhopAppModule writes the snapshot), the widget
// extension (which reads it) and the test package, so the keys and the App Group
// are named once. Pure apart from UserDefaults, and the same rules as
// MeshWidgetState.kt on Android, so the two widgets cannot disagree about what a
// reading means. Everything else (what to count, when to push) is
// background-notice.ts.
//
// Its own folder because Package.swift builds it, and SwiftPM reads every
// *.lproj under a target path as a resource.
import Foundation

enum MeshWidgetStore {
  // The App Group both the app and AirhopWidget.appex are entitled to. It has to
  // match Airhop.entitlements, AirhopWidget.entitlements and the group
  // registered in Apple Developer.
  static let suiteName = "group.org.onemindlabs.airhop"

  // The widget's kind, which the app names when it asks for a reload.
  static let kind = "AirhopMeshWidget"

  fileprivate enum Key {
    static let count = "count"
    static let meshOn = "meshOn"
    static let bluetoothOff = "bluetoothOff"
    static let atMs = "atMs"
    static let all = [count, meshOn, bluetoothOff, atMs]
  }
}

// The whole of what the app writes: a count, whether the mesh is meant to be
// running, whether Bluetooth is switched off, and when it was counted. No names,
// IDs or unread counts, because the widget sits on a home screen anyone holding
// the phone can read.
struct MeshSnapshot: Equatable {
  let count: Int
  let meshOn: Bool
  let bluetoothOff: Bool
  let atMs: Int64

  // Nil for anything the app cannot have written, so a bad value reads as no
  // snapshot rather than as a number.
  init?(count: Int, meshOn: Bool, bluetoothOff: Bool, atMs: Int64) {
    guard count >= 0, atMs > 0 else { return nil }
    self.count = count
    self.meshOn = meshOn
    self.bluetoothOff = bluetoothOff
    self.atMs = atMs
  }

  // As the bridge hands them over. A JS number that is not finite would trap
  // in the Int conversion.
  init?(fromBridge count: Double, meshOn: Bool, bluetoothOff: Bool, atMs: Double) {
    guard count.isFinite, atMs.isFinite, abs(count) < 1e9, abs(atMs) < 1e15 else { return nil }
    self.init(count: Int(count), meshOn: meshOn, bluetoothOff: bluetoothOff, atMs: Int64(atMs))
  }

  // A value of the wrong type (from some other build, or damaged) reads as no
  // snapshot, which draws "Open Airhop" and is replaced by the next push.
  static func read(from defaults: UserDefaults) -> MeshSnapshot? {
    guard
      let count = defaults.object(forKey: MeshWidgetStore.Key.count) as? Int,
      let meshOn = defaults.object(forKey: MeshWidgetStore.Key.meshOn) as? Bool,
      let bluetoothOff = defaults.object(forKey: MeshWidgetStore.Key.bluetoothOff) as? Bool,
      let atMs = defaults.object(forKey: MeshWidgetStore.Key.atMs) as? Int64
    else { return nil }
    return MeshSnapshot(count: count, meshOn: meshOn, bluetoothOff: bluetoothOff, atMs: atMs)
  }

  func write(to defaults: UserDefaults) {
    defaults.set(count, forKey: MeshWidgetStore.Key.count)
    defaults.set(meshOn, forKey: MeshWidgetStore.Key.meshOn)
    defaults.set(bluetoothOff, forKey: MeshWidgetStore.Key.bluetoothOff)
    defaults.set(atMs, forKey: MeshWidgetStore.Key.atMs)
  }

  static func clear(_ defaults: UserDefaults) {
    for key in MeshWidgetStore.Key.all {
      defaults.removeObject(forKey: key)
    }
  }
}

enum MeshWidgetState: Equatable {
  // Never written, or wiped.
  case unset
  case paused
  case stale
  // Nobody reachable because the phone cannot listen, which "nobody in range"
  // would misreport as an empty room.
  case bluetoothOff
  // Zero included: "nobody in range" is a reading too, and carries its time.
  case counted(count: Int, atMs: Int64)

  // A reading the app has stopped refreshing is retired this long after it was
  // taken. JS refreshes an unchanged one every minute in front and every 45
  // behind, so past this nothing is counting any more. Longer than Android's
  // 15 minutes because WidgetKit's daily reload budget, a few dozen, cannot
  // carry a refresh every few minutes through a day in the background.
  static let staleAfterMs: Int64 = 60 * 60_000

  // `bootMs` is when this boot began on the wall clock. A reading from before it
  // came from a mesh that cannot still be running, whatever its age.
  //
  // Paused outranks age: a paused mesh stays paused across a kill or a reboot,
  // so that line stays true. A reading from the future means the clock moved
  // back, and its time cannot be trusted either. Bluetooth off ages like a
  // count, since it is a reading too, and gives way to one: peers still
  // reachable over Wi-Fi or LAN are a true count worth showing.
  init(_ snapshot: MeshSnapshot?, nowMs: Int64, bootMs: Int64) {
    guard let snapshot else {
      self = .unset
      return
    }
    guard snapshot.meshOn else {
      self = .paused
      return
    }
    let age = nowMs - snapshot.atMs
    if age < 0 || age > Self.staleAfterMs || snapshot.atMs < bootMs {
      self = .stale
    } else if snapshot.bluetoothOff && snapshot.count == 0 {
      self = .bluetoothOff
    } else {
      self = .counted(count: snapshot.count, atMs: snapshot.atMs)
    }
  }

  // When this state turns stale on its own, for the widget's timeline. Nil for
  // the states that hold until the app writes again.
  static func staleAtMs(for snapshot: MeshSnapshot?, state: MeshWidgetState) -> Int64? {
    guard let snapshot else { return nil }
    switch state {
    case .counted, .bluetoothOff:
      return snapshot.atMs + staleAfterMs + 1
    case .unset, .paused, .stale:
      return nil
    }
  }
}

// The widget's strings, behind a protocol so the tests need no bundle.
protocol MeshWidgetCopy {
  // "as of 14:05", for the reading taken at atMs.
  func asOf(atMs: Int64) -> String
  func inRange(count: Int) -> String
  func nobody() -> String
  func paused() -> String
  func unset() -> String
  func stale() -> String
  func bluetoothOff() -> String
}

// `count` and `asOf` are both set or both nil, so no layout can show a count
// without its time. With no count, `caption` is the whole message.
struct MeshWidgetLines: Equatable {
  let count: String?
  let caption: String
  let asOf: String?

  init(count: String?, caption: String, asOf: String?) {
    self.count = count
    self.caption = caption
    self.asOf = asOf
  }

  init(_ state: MeshWidgetState, copy: MeshWidgetCopy) {
    switch state {
    case .unset:
      self.init(count: nil, caption: copy.unset(), asOf: nil)
    case .paused:
      self.init(count: nil, caption: copy.paused(), asOf: nil)
    case .stale:
      self.init(count: nil, caption: copy.stale(), asOf: nil)
    case .bluetoothOff:
      self.init(count: nil, caption: copy.bluetoothOff(), asOf: nil)
    case .counted(let count, let atMs):
      // String(count), not a locale format: the app writes Latin digits in
      // every language.
      self.init(
        count: String(count),
        caption: count == 0 ? copy.nobody() : copy.inRange(count: count),
        asOf: copy.asOf(atMs: atMs)
      )
    }
  }
}
