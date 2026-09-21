// The rules that get a pair of Aware peers onto one socket on this platform:
// the token hello, which connection survives when both ends dialled, and how
// long a device waits before it is dialled again. Pure, and shared with the
// tests, so the module holds only the framework calls around them.
//
// Not the Kotlin AwareDial: Apple's discovery is symmetric with no service
// info to break a tie before connecting, so the tie is settled on the socket
// instead, and Android can never be on the other end of an Apple data path.
import Foundation

enum AwareDial {
  // Regenerated per attach, so it never identifies the device across sessions.
  static let tokenBytes = 8

  // Wait before the next dial to a device whose link ended or whose dial
  // failed, doubling to a minute.
  static let redialFloor: Duration = .seconds(2)
  static let redialCeiling: Duration = .seconds(60)

  static func nextRedial(after delay: Duration?) -> Duration {
    min((delay ?? redialFloor) * 2, redialCeiling)
  }

  // Both ends dial, so each pair opens two connections. The one whose
  // initiator holds the lower token survives; the other end sees the same
  // pair of tokens and reaches the opposite answer.
  static func keeps(localToken: Data, peerToken: Data, weInitiated: Bool) -> Bool {
    weInitiated
      ? isLower(localToken, than: peerToken)
      : isLower(peerToken, than: localToken)
  }

  static func isLower(_ a: Data, than b: Data) -> Bool {
    guard a.count == b.count else { return a.count < b.count }
    for (x, y) in zip(a, b) where x != y { return x < y }
    return false
  }
}
