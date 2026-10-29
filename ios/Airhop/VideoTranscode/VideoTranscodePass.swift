// One transcode pass for AirhopVideoModule: `keepMs` of a video from `startMs`
// as H.264 + AAC in an MP4, at exactly the size, frame rate and bitrates
// TypeScript planned (core/mesh/video/transcode-plan.ts). No decisions here:
// whether to shrink, to what budget, and whether to retry are all TypeScript's.
//
// bitchat-ios's VideoTranscoder pass, with three additions. The video
// composition and the writer both carry BT.709, which is what makes
// AVFoundation tone map an HDR (HLG, Dolby Vision) source to SDR rather than
// pass HDR values through as if they were SDR; the order matters, since a
// 10-bit to 8-bit cut before the colour conversion bands. The pass reports
// progress and can be cancelled, leaving no file behind. And the writer gets no
// metadata, so the source's location, device and dates stay behind.
//
// No React import, so `swift test` covers it on any Mac.
import AVFoundation
import Foundation

struct VideoTranscodeProbe: Equatable {
  let durationMs: Double
  // Upright, the track's rotation applied.
  let width: Int
  let height: Int
  let hasAudio: Bool
}

struct VideoTranscodeOptions: Equatable {
  let startMs: Int
  let keepMs: Int
  let width: Int
  let height: Int
  let fps: Int
  let videoBitrate: Int
  // Zero drops the sound.
  let audioBitrate: Int
  let keyframeIntervalSeconds: Int
}

struct VideoTranscodeResult: Equatable {
  let sizeBytes: Int
  let durationMs: Double
}

enum VideoTranscodeError: Error, Equatable {
  case noVideo
  case unreadable
  case cancelled
  case failed(String)
}

enum VideoTranscodeProbing {
  static func probe(_ url: URL) async throws -> VideoTranscodeProbe {
    let asset = AVURLAsset(url: url)
    let videoTrack: AVAssetTrack?
    let hasAudio: Bool
    let duration: CMTime
    do {
      videoTrack = try await asset.loadTracks(withMediaType: .video).first
      let audioTracks = try await asset.loadTracks(withMediaType: .audio)
      hasAudio = !audioTracks.isEmpty
      duration = try await asset.load(.duration)
    } catch {
      throw VideoTranscodeError.unreadable
    }
    guard let videoTrack else { throw VideoTranscodeError.noVideo }
    let geometry: (CGSize, CGAffineTransform)
    do {
      geometry = try await videoTrack.load(.naturalSize, .preferredTransform)
    } catch {
      throw VideoTranscodeError.unreadable
    }
    let upright = uprightSize(geometry.0, geometry.1)
    let seconds = duration.seconds
    return VideoTranscodeProbe(
      durationMs: seconds.isFinite ? seconds * 1_000 : 0,
      width: Int(upright.width.rounded()),
      height: Int(upright.height.rounded()),
      hasAudio: hasAudio
    )
  }

  static func uprightSize(_ naturalSize: CGSize, _ transform: CGAffineTransform) -> CGSize {
    let rotated = CGRect(origin: .zero, size: naturalSize).applying(transform)
    return CGSize(width: abs(rotated.width), height: abs(rotated.height))
  }
}

final class VideoTranscodePass {
  // The AAC encoder's floor at 16 kHz mono varies by OS; bitchat-ios falls
  // back to its push-to-talk bitrate when the planned one is refused.
  private static let fallbackAudioBitrate = 16_000
  private static let audioSampleRate = 16_000.0
  // Progress is reported in steps of this, not per frame.
  private static let progressStep = 0.01

  private let source: URL
  private let output: URL
  private let options: VideoTranscodeOptions
  // Only ever taken through withLock: encode is async, and Swift forbids bare
  // lock() and unlock() there.
  private let lock = NSLock()
  private var cancelled = false
  private var reader: AVAssetReader?

  init(source: URL, output: URL, options: VideoTranscodeOptions) {
    self.source = source
    self.output = output
    self.options = options
  }

  // Safe from any thread, before, during or after run.
  func cancel() {
    let reader = lock.withLock {
      cancelled = true
      return self.reader
    }
    reader?.cancelReading()
  }

  private var isCancelled: Bool {
    lock.withLock { cancelled }
  }

  func run(onProgress: @escaping (Double) -> Void) async throws -> VideoTranscodeResult {
    removeOutput()
    do {
      let result = try await encode(onProgress: onProgress)
      if isCancelled { throw VideoTranscodeError.cancelled }
      return result
    } catch {
      removeOutput()
      if isCancelled { throw VideoTranscodeError.cancelled }
      throw error
    }
  }

  private func encode(onProgress: @escaping (Double) -> Void) async throws
    -> VideoTranscodeResult
  {
    if isCancelled { throw VideoTranscodeError.cancelled }
    let asset = AVURLAsset(url: source)
    guard let videoTrack = try await asset.loadTracks(withMediaType: .video).first else {
      throw VideoTranscodeError.noVideo
    }
    var audioTrack: AVAssetTrack?
    if options.audioBitrate > 0 {
      audioTrack = try? await asset.loadTracks(withMediaType: .audio).first
    }
    let (naturalSize, transform) = try await videoTrack.load(.naturalSize, .preferredTransform)
    let assetDuration = try await asset.load(.duration)
    let sourceSeconds = assetDuration.seconds.isFinite ? assetDuration.seconds : 0
    let startSeconds = Double(options.startMs) / 1_000
    let plannedSeconds = Double(options.keepMs) / 1_000
    let keepSeconds =
      sourceSeconds > 0 ? min(plannedSeconds, sourceSeconds - startSeconds) : plannedSeconds
    guard keepSeconds > 0 else { throw VideoTranscodeError.failed("nothing to keep") }
    let startTime = CMTime(seconds: startSeconds, preferredTimescale: 600)
    let endTime = CMTime(seconds: startSeconds + keepSeconds, preferredTimescale: 600)

    let reader: AVAssetReader
    let writer: AVAssetWriter
    do {
      reader = try AVAssetReader(asset: asset)
      writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
    } catch {
      throw VideoTranscodeError.failed(error.localizedDescription)
    }
    reader.timeRange = CMTimeRange(start: startTime, end: endTime)
    // The index up front, so a player can start before the last byte lands.
    writer.shouldOptimizeForNetworkUse = true

    let videoOutput = AVAssetReaderVideoCompositionOutput(
      videoTracks: [videoTrack],
      videoSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    )
    videoOutput.videoComposition = makeComposition(
      track: videoTrack, naturalSize: naturalSize, transform: transform,
      assetDuration: assetDuration)
    videoOutput.alwaysCopiesSampleData = false
    guard reader.canAdd(videoOutput) else { throw VideoTranscodeError.failed("video output") }
    reader.add(videoOutput)

    let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings())
    videoInput.expectsMediaDataInRealTime = false
    guard writer.canAdd(videoInput) else { throw VideoTranscodeError.failed("video input") }
    writer.add(videoInput)

    var audio: (AVAssetReaderTrackOutput, AVAssetWriterInput)?
    if let audioTrack, let settings = audioSettings(writer: writer) {
      let audioOutput = AVAssetReaderTrackOutput(
        track: audioTrack,
        outputSettings: [
          AVFormatIDKey: kAudioFormatLinearPCM,
          AVSampleRateKey: Self.audioSampleRate,
          AVNumberOfChannelsKey: 1,
          AVLinearPCMBitDepthKey: 16,
          AVLinearPCMIsFloatKey: false,
          AVLinearPCMIsBigEndianKey: false,
          AVLinearPCMIsNonInterleaved: false,
        ])
      audioOutput.alwaysCopiesSampleData = false
      let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
      audioInput.expectsMediaDataInRealTime = false
      // A track neither side can take is dropped, not fatal: the picture is
      // what was asked for, and a silent clip still plays.
      if reader.canAdd(audioOutput), writer.canAdd(audioInput) {
        reader.add(audioOutput)
        writer.add(audioInput)
        audio = (audioOutput, audioInput)
      }
    }

    let cancelledBeforeStart = lock.withLock {
      self.reader = reader
      return cancelled
    }
    if cancelledBeforeStart { throw VideoTranscodeError.cancelled }

    guard reader.startReading() else {
      throw VideoTranscodeError.failed(reader.error?.localizedDescription ?? "startReading")
    }
    guard writer.startWriting() else {
      reader.cancelReading()
      throw VideoTranscodeError.failed(writer.error?.localizedDescription ?? "startWriting")
    }
    // The kept part's first moment becomes the clip's zero.
    writer.startSession(atSourceTime: startTime)

    var reported = 0.0
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let group = DispatchGroup()
      pump(videoOutput, into: videoInput, label: "video", endTime: endTime, group: group) {
        [weak self] pts in
        let fraction = min(max((pts.seconds - startSeconds) / keepSeconds, 0), 1)
        guard fraction - reported >= Self.progressStep, self?.isCancelled == false else { return }
        reported = fraction
        onProgress(fraction)
      }
      if let audio {
        pump(audio.0, into: audio.1, label: "audio", endTime: endTime, group: group) { _ in }
      }
      group.notify(queue: .global(qos: .userInitiated)) { continuation.resume() }
    }

    if isCancelled || reader.status == .failed || reader.status == .cancelled {
      writer.cancelWriting()
      if isCancelled { throw VideoTranscodeError.cancelled }
      throw VideoTranscodeError.failed(reader.error?.localizedDescription ?? "read")
    }
    await writer.finishWriting()
    guard writer.status == .completed else {
      throw VideoTranscodeError.failed(writer.error?.localizedDescription ?? "finish")
    }
    let attributes = try? FileManager.default.attributesOfItem(atPath: output.path)
    let size = (attributes?[.size] as? NSNumber)?.intValue ?? 0
    return VideoTranscodeResult(sizeBytes: size, durationMs: keepSeconds * 1_000)
  }

  // Upright frames at the planned size and frame rate: the composition applies
  // the track's transform, scales to fill and centre-crops, and renders in
  // BT.709 SDR whatever the source's colour.
  private func makeComposition(
    track: AVAssetTrack, naturalSize: CGSize, transform: CGAffineTransform,
    assetDuration: CMTime
  ) -> AVMutableVideoComposition {
    let target = CGSize(width: options.width, height: options.height)
    let rotated = CGRect(origin: .zero, size: naturalSize).applying(transform)
    let upright = VideoTranscodeProbing.uprightSize(naturalSize, transform)
    let scale = max(target.width / max(upright.width, 1), target.height / max(upright.height, 1))
    let placement =
      transform
      .concatenating(CGAffineTransform(translationX: -rotated.minX, y: -rotated.minY))
      .concatenating(CGAffineTransform(scaleX: scale, y: scale))
      .concatenating(
        CGAffineTransform(
          translationX: (target.width - upright.width * scale) / 2,
          y: (target.height - upright.height * scale) / 2
        ))

    let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: track)
    layer.setTransform(placement, at: .zero)
    let instruction = AVMutableVideoCompositionInstruction()
    // The whole source timeline, not just the kept part, or frames past the
    // instruction render black.
    instruction.timeRange = CMTimeRange(start: .zero, duration: assetDuration)
    instruction.layerInstructions = [layer]

    let composition = AVMutableVideoComposition()
    composition.renderSize = target
    composition.frameDuration = CMTime(value: 1, timescale: CMTimeScale(options.fps))
    composition.instructions = [instruction]
    composition.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
    composition.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
    composition.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2
    return composition
  }

  private func videoSettings() -> [String: Any] {
    [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: options.width,
      AVVideoHeightKey: options.height,
      AVVideoColorPropertiesKey: [
        AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
        AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
        AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
      ],
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: options.videoBitrate,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264BaselineAutoLevel,
        AVVideoMaxKeyFrameIntervalKey: options.fps * options.keyframeIntervalSeconds,
        AVVideoAllowFrameReorderingKey: false,
        AVVideoExpectedSourceFrameRateKey: options.fps,
      ],
    ]
  }

  private func audioSettings(writer: AVAssetWriter) -> [String: Any]? {
    for bitrate in [options.audioBitrate, Self.fallbackAudioBitrate] {
      let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: Self.audioSampleRate,
        AVNumberOfChannelsKey: 1,
        AVEncoderBitRateKey: bitrate,
      ]
      if writer.canApply(outputSettings: settings, forMediaType: .audio) { return settings }
    }
    return nil
  }

  // Copies samples until the reader runs dry, passes the kept length, or is
  // cancelled, driven by the input's own readiness; leaves `group` once.
  private func pump(
    _ output: AVAssetReaderOutput,
    into input: AVAssetWriterInput,
    label: String,
    endTime: CMTime,
    group: DispatchGroup,
    onSample: @escaping (CMTime) -> Void
  ) {
    group.enter()
    let queue = DispatchQueue(label: "org.onemindlabs.airhop.video.transcode.\(label)")
    var finished = false
    input.requestMediaDataWhenReady(on: queue) { [weak self] in
      guard !finished else { return }
      while input.isReadyForMoreMediaData {
        guard self?.isCancelled == false,
          let sample = output.copyNextSampleBuffer()
        else {
          finished = true
          input.markAsFinished()
          group.leave()
          return
        }
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        guard pts < endTime, input.append(sample) else {
          finished = true
          input.markAsFinished()
          group.leave()
          return
        }
        onSample(pts)
      }
    }
  }

  private func removeOutput() {
    try? FileManager.default.removeItem(at: output)
  }
}
