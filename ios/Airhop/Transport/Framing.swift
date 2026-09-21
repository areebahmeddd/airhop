// The stream framing every TCP link uses, Wi-Fi Aware and LAN alike: a 4-byte
// big-endian length, then the bytes. An empty frame is the heartbeat. Pure, so
// the read loops and the tests share one definition of a valid prefix.
//
// Big-endian by hand rather than reading a `UInt32`, which comes back in host
// order and is byte-swapped on every device this runs on.
import Foundation

enum Framing {
    // One 64 KiB file chunk plus the length prefix.
    static let maxFrame = 65_544
    static let prefixBytes = 4

    static func encode(_ payload: Data) -> Data {
        let length = UInt32(payload.count)
        var out = Data(capacity: prefixBytes + payload.count)
        out.append(UInt8((length >> 24) & 0xff))
        out.append(UInt8((length >> 16) & 0xff))
        out.append(UInt8((length >> 8) & 0xff))
        out.append(UInt8(length & 0xff))
        out.append(payload)
        return out
    }

    // The body length a prefix announces, or nil when the prefix cannot be
    // trusted: a claim past maxFrame means the stream is not ours or has lost
    // sync.
    static func length(_ prefix: Data) -> Int? {
        guard prefix.count == prefixBytes else { return nil }
        let bytes = [UInt8](prefix)
        let length =
            (Int(bytes[0]) << 24) | (Int(bytes[1]) << 16) | (Int(bytes[2]) << 8) | Int(bytes[3])
        guard length <= maxFrame else { return nil }
        return length
    }
}
