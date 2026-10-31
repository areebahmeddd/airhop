// Which surfaces a stream key draws on, and which of them still wait for a
// keyframe.
//
// Every surface attached under a key gets that key's units, so one stream can
// show in its chat bubble and in the full-screen viewer at once, each layer
// decoding on its own. One leaving never takes the picture from another. A
// surface that joins, or whose layer lost its picture, waits for the next
// keyframe rather than painting deltas with nothing under them. Held weakly,
// since a view UIKit frees without a detach must not be kept by its key.
//
// Main thread only, like the views it holds.
final class SurfaceRegistry<Surface: AnyObject> {
  private final class Entry {
    weak var surface: Surface?
    var awaitingKeyframe = true

    init(_ surface: Surface) { self.surface = surface }
  }

  private var entries: [String: [Entry]] = [:]

  init() {}

  // Attaching a surface already attached keeps it as it is, mid-stream.
  func attach(_ surface: Surface, key: String) {
    var list = (entries[key] ?? []).filter { $0.surface != nil }
    if !list.contains(where: { $0.surface === surface }) { list.append(Entry(surface)) }
    entries[key] = list
  }

  func detach(_ surface: Surface, key: String) {
    guard let list = entries[key] else { return }
    let kept = list.filter { $0.surface != nil && $0.surface !== surface }
    entries[key] = kept.isEmpty ? nil : kept
  }

  func surfaces(for key: String) -> [Surface] {
    entries[key]?.compactMap(\.surface) ?? []
  }

  // The surfaces a unit goes to: every one for a keyframe, and for a delta
  // only those already showing a picture to lay it over.
  func receivers(key: String, keyframe: Bool) -> [Surface] {
    var out: [Surface] = []
    for entry in entries[key] ?? [] {
      guard let surface = entry.surface else { continue }
      if entry.awaitingKeyframe {
        guard keyframe else { continue }
        entry.awaitingKeyframe = false
      }
      out.append(surface)
    }
    return out
  }

  // The surface's picture is gone; it waits for the next keyframe.
  func resync(_ surface: Surface, key: String) {
    entries[key]?.first(where: { $0.surface === surface })?.awaitingKeyframe = true
  }
}
