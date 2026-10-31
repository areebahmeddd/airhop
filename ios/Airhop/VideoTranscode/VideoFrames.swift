// Stills for the trimmer's filmstrip: one small upright JPEG per requested
// time. A filmstrip needs a picture near each time, not the exact frame, so the
// generator may take the nearest keyframe, which decodes without its
// neighbours and keeps a long 4K source quick to strip.
import AVFoundation
import Foundation
import ImageIO

enum VideoFrames {
  private static let jpegQuality = 0.7

  // A frame that cannot be grabbed or written is skipped; the strip shows its
  // background there.
  static func write(source: URL, timesMs: [Double], maxEdge: Int, outputs: [URL]) async {
    let generator = AVAssetImageGenerator(asset: AVURLAsset(url: source))
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: maxEdge, height: maxEdge)
    generator.requestedTimeToleranceBefore = .positiveInfinity
    generator.requestedTimeToleranceAfter = .positiveInfinity
    for (timeMs, output) in zip(timesMs, outputs) {
      let time = CMTime(value: CMTimeValue(timeMs.rounded()), timescale: 1_000)
      guard let frame = try? await generator.image(at: time) else { continue }
      writeJPEG(frame.image, to: output)
    }
  }

  private static func writeJPEG(_ image: CGImage, to url: URL) {
    guard
      let destination = CGImageDestinationCreateWithURL(
        url as CFURL, "public.jpeg" as CFString, 1, nil)
    else { return }
    let properties = [kCGImageDestinationLossyCompressionQuality: jpegQuality] as CFDictionary
    CGImageDestinationAddImage(destination, image, properties)
    CGImageDestinationFinalize(destination)
  }
}
