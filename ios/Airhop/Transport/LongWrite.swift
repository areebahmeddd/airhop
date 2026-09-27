// Joins the chunks of a GATT long write back into the frames that were written.
// A frame longer than MTU-3 reaches the peripheral as prepared chunks, handed
// over together in one didReceiveWrite call, in order, each with its offset.
// Pure, so the peripheral delegate and the tests share one definition of a
// valid write.
//
// Offset 0 starts a new frame, so plain writes batched into one call stay
// separate. The call is atomic: a gap or an oversized frame refuses all of it.
import Foundation

enum LongWrite {
  // The largest frame this app puts on the radio, mirroring MAX_BLE_FRAME in
  // core/mesh/fragment-manager.ts, and the ATT ceiling on an attribute value.
  static let maxFrame = 512

  enum Outcome<Key: Hashable>: Equatable {
    case frames([Frame<Key>])
    // A chunk that does not continue the frame its writer has open.
    case gap
    case oversized
  }

  struct Frame<Key: Hashable>: Equatable {
    let key: Key
    var data: Data
  }

  static func join<Key: Hashable>(_ chunks: [(key: Key, offset: Int, data: Data)])
    -> Outcome<Key>
  {
    var frames: [Frame<Key>] = []
    var open: [Key: Int] = [:]
    for chunk in chunks {
      if chunk.offset == 0 {
        frames.append(Frame(key: chunk.key, data: chunk.data))
        open[chunk.key] = frames.count - 1
      } else if let index = open[chunk.key], chunk.offset == frames[index].data.count {
        frames[index].data.append(chunk.data)
      } else {
        return .gap
      }
      if let index = open[chunk.key], frames[index].data.count > maxFrame {
        return .oversized
      }
    }
    return .frames(frames.filter { !$0.data.isEmpty })
  }
}
