import AVFoundation
import ImageIO
import XCTest

@testable import AirhopVideoTranscode

// Real encode passes over clips written here: rotation, trimming, sound,
// metadata and cancellation, as a device would meet them.
final class VideoTranscodePassTests: XCTestCase {
  private var scratch: URL!

  override func setUpWithError() throws {
    scratch = FileManager.default.temporaryDirectory
      .appendingPathComponent("transcode-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: scratch)
  }

  private func options(
    startMs: Int = 0, keepMs: Int = 60_000, width: Int = 144, height: Int = 192,
    audioBitrate: Int = 12_000
  ) -> VideoTranscodeOptions {
    VideoTranscodeOptions(
      startMs: startMs, keepMs: keepMs, width: width, height: height, fps: 15,
      videoBitrate: 60_000,
      audioBitrate: audioBitrate, keyframeIntervalSeconds: 3)
  }

  func testProbeReportsTheUprightSizeLengthAndSound() async throws {
    let source = try SyntheticClip.write(
      to: scratch.appendingPathComponent("portrait.mp4"), seconds: 2, rotated: true,
      withAudio: true)

    let probe = try await VideoTranscodeProbing.probe(source)

    XCTAssertEqual(probe.width, 480)
    XCTAssertEqual(probe.height, 640)
    XCTAssertTrue(probe.hasAudio)
    XCTAssertEqual(probe.durationMs, 2_000, accuracy: 150)
  }

  func testProbeRefusesAFileWithNoPicture() async throws {
    let garbage = scratch.appendingPathComponent("garbage.mp4")
    try Data(repeating: 7, count: 4_096).write(to: garbage)

    do {
      _ = try await VideoTranscodeProbing.probe(garbage)
      XCTFail("probe opened a file with no video in it")
    } catch let error as VideoTranscodeError {
      XCTAssertTrue(error == .noVideo || error == .unreadable)
    }
  }

  func testARotatedSourceComesOutUprightAtThePlannedSize() async throws {
    let source = try SyntheticClip.write(
      to: scratch.appendingPathComponent("portrait.mp4"), seconds: 2, rotated: true,
      withAudio: true)
    let output = scratch.appendingPathComponent("out.mp4")

    let result = try await VideoTranscodePass(source: source, output: output, options: options())
      .run { _ in }

    let asset = AVURLAsset(url: output)
    let videoTracks = try await asset.loadTracks(withMediaType: .video)
    let track = try XCTUnwrap(videoTracks.first)
    let (size, transform) = try await track.load(.naturalSize, .preferredTransform)
    let audioTracks = try await asset.loadTracks(withMediaType: .audio)
    XCTAssertEqual(size, CGSize(width: 144, height: 192))
    XCTAssertTrue(transform.isIdentity)
    XCTAssertEqual(audioTracks.count, 1)
    XCTAssertGreaterThan(result.sizeBytes, 0)
    XCTAssertEqual(result.durationMs, 2_000, accuracy: 150)
  }

  func testOnlyTheKeptLengthIsEncoded() async throws {
    let source = try SyntheticClip.write(
      to: scratch.appendingPathComponent("long.mp4"), seconds: 3, rotated: false, withAudio: false)
    let output = scratch.appendingPathComponent("out.mp4")

    let result = try await VideoTranscodePass(
      source: source, output: output, options: options(keepMs: 1_500, width: 192, height: 144)
    ).run { _ in }

    let seconds = try await AVURLAsset(url: output).load(.duration).seconds
    XCTAssertEqual(seconds, 1.5, accuracy: 0.2)
    XCTAssertEqual(result.durationMs, 1_500, accuracy: 1)
  }

  func testATrimmedPartStartsTheClipAtZero() async throws {
    let source = try SyntheticClip.write(
      to: scratch.appendingPathComponent("long.mp4"), seconds: 3, rotated: false, withAudio: true)
    let output = scratch.appendingPathComponent("out.mp4")

    let result = try await VideoTranscodePass(
      source: source, output: output,
      options: options(startMs: 1_000, keepMs: 1_000, width: 192, height: 144)
    ).run { _ in }

    let seconds = try await AVURLAsset(url: output).load(.duration).seconds
    XCTAssertEqual(seconds, 1, accuracy: 0.2)
    XCTAssertEqual(result.durationMs, 1_000, accuracy: 1)
  }

  func testFramesAreUprightAndSkipWhatCannotBeGrabbed() async throws {
    let source = try SyntheticClip.write(
      to: scratch.appendingPathComponent("portrait.mp4"), seconds: 2, rotated: true,
      withAudio: false)
    let outputs = (0..<2).map { scratch.appendingPathComponent("frame-\($0).jpg") }

    await VideoFrames.write(
      source: source, timesMs: [0, 1_000], maxEdge: 96, outputs: outputs)

    for output in outputs {
      let image = try XCTUnwrap(
        CGImageSourceCreateWithURL(output as CFURL, nil).flatMap {
          CGImageSourceCreateImageAtIndex($0, 0, nil)
        })
      XCTAssertGreaterThan(image.height, image.width)
      XCTAssertLessThanOrEqual(max(image.width, image.height), 96)
    }

    let missing = scratch.appendingPathComponent("none.jpg")
    await VideoFrames.write(
      source: scratch.appendingPathComponent("absent.mp4"), timesMs: [0], maxEdge: 96,
      outputs: [missing])
    XCTAssertFalse(FileManager.default.fileExists(atPath: missing.path))
  }

  func testNoSoundWhenThePlanDropsIt() async throws {
    let source = try SyntheticClip.write(
      to: scratch.appendingPathComponent("loud.mp4"), seconds: 1, rotated: false, withAudio: true)
    let output = scratch.appendingPathComponent("out.mp4")

    _ = try await VideoTranscodePass(
      source: source, output: output, options: options(width: 192, height: 144, audioBitrate: 0)
    ).run { _ in }

    let audioTracks = try await AVURLAsset(url: output).loadTracks(withMediaType: .audio)
    XCTAssertEqual(audioTracks.count, 0)
  }

  func testTheSourceLocationIsNotCarriedOver() async throws {
    let source = try SyntheticClip.write(
      to: scratch.appendingPathComponent("located.mov"), seconds: 1, rotated: false,
      withAudio: false, location: "+48.8577+002.2950/")
    let sourceMetadata = try await AVURLAsset(url: source).load(.metadata)
    XCTAssertFalse(sourceMetadata.isEmpty, "the test clip should carry a location")
    let output = scratch.appendingPathComponent("out.mp4")

    _ = try await VideoTranscodePass(
      source: source, output: output, options: options(width: 192, height: 144)
    ).run { _ in }

    let metadata = try await AVURLAsset(url: output).load(.metadata)
    XCTAssertTrue(metadata.isEmpty)
  }

  func testProgressRisesToTheEnd() async throws {
    let source = try SyntheticClip.write(
      to: scratch.appendingPathComponent("clip.mp4"), seconds: 2, rotated: false, withAudio: false)
    let output = scratch.appendingPathComponent("out.mp4")
    let seen = Fractions()

    _ = try await VideoTranscodePass(
      source: source, output: output, options: options(width: 192, height: 144)
    ).run { seen.append($0) }

    let fractions = seen.values
    XCTAssertFalse(fractions.isEmpty)
    XCTAssertEqual(fractions, fractions.sorted())
    XCTAssertGreaterThan(fractions.last ?? 0, 0.8)
    XCTAssertLessThanOrEqual(fractions.last ?? 2, 1)
  }

  func testCancelLeavesNoFile() async throws {
    let source = try SyntheticClip.write(
      to: scratch.appendingPathComponent("clip.mp4"), seconds: 3, rotated: false, withAudio: true)
    let output = scratch.appendingPathComponent("out.mp4")
    let pass = VideoTranscodePass(
      source: source, output: output, options: options(width: 192, height: 144))
    pass.cancel()

    do {
      _ = try await pass.run { _ in }
      XCTFail("a cancelled pass finished")
    } catch let error as VideoTranscodeError {
      XCTAssertEqual(error, .cancelled)
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
  }

  func testCancelMidPassLeavesNoFile() async throws {
    let source = try SyntheticClip.write(
      to: scratch.appendingPathComponent("clip.mp4"), seconds: 3, rotated: false, withAudio: true)
    let output = scratch.appendingPathComponent("out.mp4")
    let pass = VideoTranscodePass(
      source: source, output: output, options: options(width: 192, height: 144))

    do {
      _ = try await pass.run { fraction in
        if fraction > 0.2 { pass.cancel() }
      }
      XCTFail("a cancelled pass finished")
    } catch let error as VideoTranscodeError {
      XCTAssertEqual(error, .cancelled)
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
  }
}

private final class Fractions: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: [Double] = []

  func append(_ value: Double) {
    lock.lock()
    stored.append(value)
    lock.unlock()
  }

  var values: [Double] {
    lock.lock()
    defer { lock.unlock() }
    return stored
  }
}

// A short H.264 clip, 640x480 at 24 fps, optionally turned to portrait with a
// track transform the way a phone records one, with a tone, and with a
// location in its metadata.
private enum SyntheticClip {
  static let fps: Int32 = 24
  static let sampleRate = 44_100.0

  static func write(
    to url: URL, seconds: Int, rotated: Bool, withAudio: Bool, location: String? = nil
  ) throws -> URL {
    try? FileManager.default.removeItem(at: url)
    // A located clip is a QuickTime movie, as an iPhone records one.
    let writer = try AVAssetWriter(outputURL: url, fileType: location == nil ? .mp4 : .mov)
    if let location {
      let item = AVMutableMetadataItem()
      item.identifier = .quickTimeMetadataLocationISO6709
      item.value = location as NSString
      item.dataType = kCMMetadataBaseDataType_UTF8 as String
      writer.metadata = [item]
    }

    let video = AVAssetWriterInput(
      mediaType: .video,
      outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: 640,
        AVVideoHeightKey: 480,
      ])
    video.expectsMediaDataInRealTime = false
    if rotated { video.transform = CGAffineTransform(rotationAngle: .pi / 2) }
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
      assetWriterInput: video,
      sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: 640,
        kCVPixelBufferHeightKey as String: 480,
      ])
    writer.add(video)

    var audio: AVAssetWriterInput?
    if withAudio {
      let input = AVAssetWriterInput(
        mediaType: .audio,
        outputSettings: [
          AVFormatIDKey: kAudioFormatMPEG4AAC,
          AVSampleRateKey: sampleRate,
          AVNumberOfChannelsKey: 2,
          AVEncoderBitRateKey: 96_000,
        ])
      input.expectsMediaDataInRealTime = false
      writer.add(input)
      audio = input
    }

    guard writer.startWriting() else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
    writer.startSession(atSourceTime: .zero)

    // Each track is fed as the writer asks for it, as the pass itself does: the
    // writer interleaves, so all the video first would stall waiting for sound.
    let group = DispatchGroup()
    let frames = Int(fps) * seconds
    var frameIndex = 0
    feed(video, label: "video", group: group) {
      guard frameIndex < frames,
        let buffer = try? pixelBuffer(
          pool: adaptor.pixelBufferPool, shade: UInt8(frameIndex * 7 % 255))
      else { return false }
      _ = adaptor.append(
        buffer, withPresentationTime: CMTime(value: CMTimeValue(frameIndex), timescale: fps))
      frameIndex += 1
      return true
    }
    if let audio {
      let chunk = 1_024
      let total = Int(sampleRate) * seconds
      var start = 0
      feed(audio, label: "audio", group: group) {
        guard start < total,
          let tone = try? toneBuffer(start: start, frames: min(chunk, total - start))
        else { return false }
        _ = audio.append(tone)
        start += chunk
        return true
      }
    }
    group.wait()

    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()
    guard writer.status == .completed else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
    return url
  }

  // Appends while the input is ready and `next` has more, then finishes the
  // input and leaves `group` once.
  private static func feed(
    _ input: AVAssetWriterInput, label: String, group: DispatchGroup,
    next: @escaping () -> Bool
  ) {
    group.enter()
    var finished = false
    input.requestMediaDataWhenReady(on: DispatchQueue(label: "synthetic.\(label)")) {
      guard !finished else { return }
      while input.isReadyForMoreMediaData {
        guard next() else {
          finished = true
          input.markAsFinished()
          group.leave()
          return
        }
      }
    }
  }

  private static func pixelBuffer(pool: CVPixelBufferPool?, shade: UInt8) throws -> CVPixelBuffer {
    var buffer: CVPixelBuffer?
    if let pool {
      CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
    } else {
      CVPixelBufferCreate(nil, 640, 480, kCVPixelFormatType_32BGRA, nil, &buffer)
    }
    guard let buffer else { throw CocoaError(.fileWriteUnknown) }
    CVPixelBufferLockBaseAddress(buffer, [])
    if let base = CVPixelBufferGetBaseAddress(buffer) {
      let length = CVPixelBufferGetBytesPerRow(buffer) * CVPixelBufferGetHeight(buffer)
      memset(base, Int32(shade), length)
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    return buffer
  }

  // Stereo 16-bit PCM, a 440 Hz tone.
  private static func toneBuffer(start: Int, frames: Int) throws -> CMSampleBuffer {
    var samples = [Int16](repeating: 0, count: frames * 2)
    for frame in 0..<frames {
      let value = Int16(sin(Double(start + frame) * 2 * .pi * 440 / sampleRate) * 8_000)
      samples[frame * 2] = value
      samples[frame * 2 + 1] = value
    }
    var description = AudioStreamBasicDescription(
      mSampleRate: sampleRate, mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
      mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 2,
      mBitsPerChannel: 16, mReserved: 0)
    var format: CMAudioFormatDescription?
    CMAudioFormatDescriptionCreate(
      allocator: nil, asbd: &description, layoutSize: 0, layout: nil, magicCookieSize: 0,
      magicCookie: nil, extensions: nil, formatDescriptionOut: &format)

    let byteCount = samples.count * MemoryLayout<Int16>.size
    var block: CMBlockBuffer?
    CMBlockBufferCreateWithMemoryBlock(
      allocator: nil, memoryBlock: nil, blockLength: byteCount, blockAllocator: nil,
      customBlockSource: nil, offsetToData: 0, dataLength: byteCount,
      flags: kCMBlockBufferAssureMemoryNowFlag,
      blockBufferOut: &block)
    guard let block, let format else { throw CocoaError(.fileWriteUnknown) }
    samples.withUnsafeBytes { bytes in
      _ = CMBlockBufferReplaceDataBytes(
        with: bytes.baseAddress!, blockBuffer: block, offsetIntoDestination: 0,
        dataLength: byteCount)
    }

    var sample: CMSampleBuffer?
    CMAudioSampleBufferCreateReadyWithPacketDescriptions(
      allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: frames,
      presentationTimeStamp: CMTime(value: CMTimeValue(start), timescale: CMTimeScale(sampleRate)),
      packetDescriptions: nil, sampleBufferOut: &sample)
    guard let sample else { throw CocoaError(.fileWriteUnknown) }
    return sample
  }
}
