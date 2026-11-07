// One transcode pass for AirhopVideoModule: `keepMs` of a video from `startMs`
// as H.264 + AAC in an MP4, at exactly the size, frame rate and bitrates
// TypeScript planned (core/mesh/video/transcode-plan.ts). No decisions here:
// whether to shrink, to what budget, and whether to retry are all TypeScript's.
//
// bitchat-ios's VideoTranscoder pass, with three additions. The video
// composition and the writer both carry BT.709, which is what makes
// AVFoundation tone map an HDR (HLG, Dolby Vision) source to SDR rather than
// pass HDR values through as if they were SDR; the order matters, since a
// 10-bit to 8-bit cut before the color conversion bands. The pass reports
// progress and can be canceled, leaving no file behind. And the writer gets no
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
  // Set once writing has started, so cancel() never cancels a writer that has
  // not begun.
  private var writer: AVAssetWriter?
  private var pumps: [VideoTranscodePump] = []
  // Where the writer is canceled, one call at a time. cancelWriting blocks
  // until writing stops, and cancel() may be called from a progress callback
  // running on a pump's own queue, so cancel() hands the work here rather than
  // blocking its caller.
  private let control = DispatchQueue(label: "org.onemindlabs.airhop.video.transcode.control")

  init(source: URL, output: URL, options: VideoTranscodeOptions) {
    self.source = source
    self.output = output
    self.options = options
  }

  // Safe from any thread, before, during or after run, and never blocks: the
  // writer is canceled and every pump finished on their own queues, so the
  // pass settles even with an input parked that will never ask for more.
  func cancel() {
    let (reader, writer, pumps) = lock.withLock {
      cancelled = true
      return (self.reader, self.writer, self.pumps)
    }
    reader?.cancelReading()
    control.async {
      if let writer { Self.cancelWriting(writer) }
      for pump in pumps {
        pump.queue.async { pump.finish() }
      }
    }
  }

  // Only a writer still writing: one that failed or completed has nothing to
  // cancel. Must be called on `control`.
  private static func cancelWriting(_ writer: AVAssetWriter) {
    guard writer.status == .writing else { return }
    writer.cancelWriting()
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
    let cancelledBeforeWriting = lock.withLock {
      self.writer = writer
      return cancelled
    }
    if cancelledBeforeWriting {
      reader.cancelReading()
      control.sync { Self.cancelWriting(writer) }
      throw VideoTranscodeError.cancelled
    }
    // The kept part's first moment becomes the clip's zero.
    writer.startSession(atSourceTime: startTime)

    var reported = 0.0
    // Resumed only by the group, which every pump leaves exactly once, so this
    // resumes exactly once.
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let group = DispatchGroup()
      let cancelledCheck = { [weak self] in self?.isCancelled ?? true }
      var pumps = [
        VideoTranscodePump(
          label: "video", output: videoOutput, input: videoInput, reader: reader,
          writer: writer, endTime: endTime, group: group, isCancelled: cancelledCheck
        ) { [weak self] pts in
          let fraction = min(max((pts.seconds - startSeconds) / keepSeconds, 0), 1)
          guard fraction - reported >= Self.progressStep, self?.isCancelled == false else {
            return
          }
          reported = fraction
          onProgress(fraction)
        }
      ]
      if let audio {
        pumps.append(
          VideoTranscodePump(
            label: "audio", output: audio.0, input: audio.1, reader: reader, writer: writer,
            endTime: endTime, group: group, isCancelled: cancelledCheck, onSample: { _ in }))
      }
      // Started, and so in the group, before cancel() can see them: a finish
      // that ran first would leave a group never entered.
      pumps.forEach { $0.start() }
      let cancelledBeforePumps = lock.withLock {
        self.pumps = pumps
        return cancelled
      }
      if cancelledBeforePumps {
        for pump in pumps {
          pump.queue.async { pump.finish() }
        }
      }
      group.notify(queue: .global(qos: .userInitiated)) { continuation.resume() }
    }
    // From here the writer is this task's alone: a cancel() that comes later
    // only marks the pass, and run() discards the file, so it never cancels
    // the writer while finishWriting is under way.
    let cancelledAfterPumps = lock.withLock {
      self.pumps = []
      self.writer = nil
      return cancelled
    }

    if cancelledAfterPumps || reader.status == .failed || reader.status == .cancelled
      || writer.status != .writing
    {
      let writerError = writer.error
      // Behind any cancel() still canceling it, never beside it.
      control.sync { Self.cancelWriting(writer) }
      if cancelledAfterPumps { throw VideoTranscodeError.cancelled }
      if let writerError { throw VideoTranscodeError.failed(writerError.localizedDescription) }
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
  // the track's transform, scales to fill and center-crops, and renders in
  // BT.709 SDR whatever the source's color.
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

  private func removeOutput() {
    try? FileManager.default.removeItem(at: output)
  }
}

// Copies one reader output into one writer input until the reader runs dry,
// passes the kept length, or the pass is canceled, driven by the input's own
// readiness. Leaves its group exactly once however it ends.
//
// An input asks for more only while its writer is writing, so one parked
// waiting for room when the writer fails (disk full, an encoder reset) is
// never asked again, and would hold the group, and every transcode queued
// behind this one, forever. A watchdog on the pump's queue finishes it once
// the writer or reader has stopped. All of a pump's state is touched only on
// its queue.
final class VideoTranscodePump {
  // How often the watchdog looks. A failure is rare and final, so half a
  // second late costs nothing.
  private static let watchdogInterval: DispatchTimeInterval = .milliseconds(500)

  let queue: DispatchQueue
  private let output: AVAssetReaderOutput
  private let input: AVAssetWriterInput
  private let reader: AVAssetReader
  private let writer: AVAssetWriter
  private let endTime: CMTime
  private let group: DispatchGroup
  private let isCancelled: () -> Bool
  private let onSample: (CMTime) -> Void
  private var finished = false
  private var watchdog: DispatchSourceTimer?

  init(
    label: String,
    output: AVAssetReaderOutput,
    input: AVAssetWriterInput,
    reader: AVAssetReader,
    writer: AVAssetWriter,
    endTime: CMTime,
    group: DispatchGroup,
    isCancelled: @escaping () -> Bool,
    onSample: @escaping (CMTime) -> Void
  ) {
    queue = DispatchQueue(label: "org.onemindlabs.airhop.video.transcode.\(label)")
    self.output = output
    self.input = input
    self.reader = reader
    self.writer = writer
    self.endTime = endTime
    self.group = group
    self.isCancelled = isCancelled
    self.onSample = onSample
  }

  // Enters the group now, on the caller's thread, so a group.notify registered
  // after this waits for the pump.
  func start() {
    group.enter()
    queue.async {
      guard !self.finished else { return }
      let timer = DispatchSource.makeTimerSource(queue: self.queue)
      timer.schedule(
        deadline: .now() + Self.watchdogInterval, repeating: Self.watchdogInterval)
      timer.setEventHandler { self.check() }
      self.watchdog = timer
      timer.resume()
      // Weak: the pump holds the input, and a canceled writer may keep this
      // block, since only markAsFinished is documented to let it go.
      self.input.requestMediaDataWhenReady(on: self.queue) { [weak self] in
        self?.pumpSamples()
      }
    }
  }

  // Must be called on `queue`. Idempotent.
  func finish() {
    guard !finished else { return }
    finished = true
    watchdog?.cancel()
    watchdog = nil
    // A failed or canceled writer has nothing left to flush.
    if writer.status == .writing { input.markAsFinished() }
    group.leave()
  }

  private func pumpSamples() {
    guard !finished else { return }
    while input.isReadyForMoreMediaData {
      guard !isCancelled(), let sample = output.copyNextSampleBuffer() else {
        finish()
        return
      }
      let pts = CMSampleBufferGetPresentationTimeStamp(sample)
      guard pts < endTime, input.append(sample) else {
        finish()
        return
      }
      onSample(pts)
    }
  }

  private func check() {
    let writerStopped = writer.status == .failed || writer.status == .cancelled
    let readerStopped = reader.status == .failed || reader.status == .cancelled
    if isCancelled() || writerStopped || readerStopped { finish() }
  }
}
