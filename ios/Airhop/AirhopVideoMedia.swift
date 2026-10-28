// AirhopVideoMedia: the VideoToolbox and AVFoundation pieces behind
// AirhopVideoModule. An H.264 encoder, an MP4 writer and the Annex B to AVCC
// plumbing between the wire's bytes and CoreMedia's.
//
// Ported from bitchat-ios's live video media layer, which is public domain, so
// a stream encoded here decodes in bitchat and its recording is the same MP4.
// The wire carries Annex B with 4-byte start codes and SPS + PPS in-band on
// every IDR; CoreMedia wants length-prefixed NAL units and a format
// description built from those parameter sets.
import AVFoundation
import CoreMedia
import Foundation
import VideoToolbox

// MARK: - Annex B and AVCC

enum VideoNAL {
  static let typeSPS: UInt8 = 7
  static let typePPS: UInt8 = 8
  static let typeAUD: UInt8 = 9
  static let typeFiller: UInt8 = 12

  // The length prefix every sample built here uses.
  static let lengthSize = 4
  static let startCode = Data([0, 0, 0, 1])

  static func type(_ nal: Data) -> UInt8 {
    guard let first = nal.first else { return 0 }
    return first & 0x1F
  }

  /// NAL units of an Annex B access unit (3- or 4-byte start codes), without
  /// their start codes. Empty when the buffer does not open with one.
  static func units(inAnnexB data: Data) -> [Data] {
    let bytes = [UInt8](data)
    let count = bytes.count
    var starts: [(codeStart: Int, payloadStart: Int)] = []
    var index = 0
    while index + 2 < count {
      if bytes[index] == 0, bytes[index + 1] == 0 {
        if bytes[index + 2] == 1 {
          let codeStart = index > 0 && bytes[index - 1] == 0 ? index - 1 : index
          starts.append((codeStart, index + 3))
          index += 3
          continue
        }
        if bytes[index + 2] == 0 {
          index += 1
          continue
        }
      }
      index += 1
    }
    guard let first = starts.first, bytes[0..<first.codeStart].allSatisfy({ $0 == 0 }) else {
      return []
    }
    var units: [Data] = []
    for (position, start) in starts.enumerated() {
      var end = position + 1 < starts.count ? starts[position + 1].codeStart : count
      // trailing_zero_8bits belong to the stream, not the NAL.
      while end > start.payloadStart, bytes[end - 1] == 0 { end -= 1 }
      guard end > start.payloadStart else { continue }
      units.append(Data(bytes[start.payloadStart..<end]))
    }
    return units
  }

  static func annexB(from units: [Data]) -> Data {
    var out = Data(capacity: units.reduce(0) { $0 + $1.count + 4 })
    for nal in units {
      out.append(startCode)
      out.append(nal)
    }
    return out
  }

  static func avcc(from units: [Data]) -> Data {
    var out = Data(capacity: units.reduce(0) { $0 + $1.count + 4 })
    for nal in units {
      let length = UInt32(nal.count)
      out.append(UInt8(truncatingIfNeeded: length >> 24))
      out.append(UInt8(truncatingIfNeeded: length >> 16))
      out.append(UInt8(truncatingIfNeeded: length >> 8))
      out.append(UInt8(truncatingIfNeeded: length))
      out.append(nal)
    }
    return out
  }

  /// NAL units of a length-prefixed buffer. Stops at the first malformed
  /// length rather than reading past the end.
  static func units(inAVCC data: Data, lengthSize: Int) -> [Data] {
    guard (1...4).contains(lengthSize) else { return [] }
    let bytes = [UInt8](data)
    var units: [Data] = []
    var offset = 0
    while offset + lengthSize <= bytes.count {
      var length = 0
      for byte in 0..<lengthSize { length = (length << 8) | Int(bytes[offset + byte]) }
      offset += lengthSize
      guard length > 0, offset + length <= bytes.count else { break }
      units.append(Data(bytes[offset..<(offset + length)]))
      offset += length
    }
    return units
  }

  static func parameterSets(in units: [Data]) -> (sps: Data, pps: Data)? {
    guard let sps = units.first(where: { type($0) == typeSPS }),
      let pps = units.first(where: { type($0) == typePPS })
    else { return nil }
    return (sps, pps)
  }

  static func formatDescription(sps: Data, pps: Data) -> CMVideoFormatDescription? {
    var description: CMVideoFormatDescription?
    let status = sps.withUnsafeBytes { spsRaw -> OSStatus in
      pps.withUnsafeBytes { ppsRaw -> OSStatus in
        guard let spsBase = spsRaw.bindMemory(to: UInt8.self).baseAddress,
          let ppsBase = ppsRaw.bindMemory(to: UInt8.self).baseAddress
        else { return -1 }
        let pointers: [UnsafePointer<UInt8>] = [spsBase, ppsBase]
        let sizes = [sps.count, pps.count]
        return CMVideoFormatDescriptionCreateFromH264ParameterSets(
          allocator: kCFAllocatorDefault,
          parameterSetCount: 2,
          parameterSetPointers: pointers,
          parameterSetSizes: sizes,
          nalUnitHeaderLength: Int32(lengthSize),
          formatDescriptionOut: &description
        )
      }
    }
    return status == noErr ? description : nil
  }

  /// SPS then PPS of a format description, and its length-prefix size.
  static func parameterSets(
    of description: CMFormatDescription
  ) -> (sets: [Data], lengthSize: Int)? {
    var count = 0
    var headerLength: Int32 = 0
    guard
      CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        description,
        parameterSetIndex: 0,
        parameterSetPointerOut: nil,
        parameterSetSizeOut: nil,
        parameterSetCountOut: &count,
        nalUnitHeaderLengthOut: &headerLength
      ) == noErr, count > 0
    else { return nil }
    var sets: [Data] = []
    for index in 0..<count {
      var pointer: UnsafePointer<UInt8>?
      var size = 0
      guard
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
          description,
          parameterSetIndex: index,
          parameterSetPointerOut: &pointer,
          parameterSetSizeOut: &size,
          parameterSetCountOut: nil,
          nalUnitHeaderLengthOut: nil
        ) == noErr, let pointer
      else { return nil }
      sets.append(Data(bytes: pointer, count: size))
    }
    return (sets, Int(headerLength))
  }

  /// A ready sample buffer around one AVCC sample. An invalid duration lets
  /// the consumer derive it from the next timestamp.
  static func sampleBuffer(
    avcc: Data,
    format: CMFormatDescription,
    pts: CMTime,
    duration: CMTime = .invalid,
    keyframe: Bool
  ) -> CMSampleBuffer? {
    guard !avcc.isEmpty, let block = blockBuffer(copying: avcc) else { return nil }
    var timing = CMSampleTimingInfo(
      duration: duration, presentationTimeStamp: pts, decodeTimeStamp: .invalid)
    var sampleSize = avcc.count
    var sample: CMSampleBuffer?
    let status = CMSampleBufferCreateReady(
      allocator: kCFAllocatorDefault,
      dataBuffer: block,
      formatDescription: format,
      sampleCount: 1,
      sampleTimingEntryCount: 1,
      sampleTimingArray: &timing,
      sampleSizeEntryCount: 1,
      sampleSizeArray: &sampleSize,
      sampleBufferOut: &sample
    )
    guard status == noErr, let sample else { return nil }
    setAttachment(sample, kCMSampleAttachmentKey_NotSync, !keyframe)
    setAttachment(sample, kCMSampleAttachmentKey_DependsOnOthers, !keyframe)
    return sample
  }

  static func setAttachment(_ sample: CMSampleBuffer, _ key: CFString, _ value: Bool) {
    guard
      let attachments = CMSampleBufferGetSampleAttachmentsArray(
        sample, createIfNecessary: true),
      CFArrayGetCount(attachments) > 0
    else { return }
    let dictionary = unsafeBitCast(
      CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
    let flag: CFBoolean = value ? kCFBooleanTrue : kCFBooleanFalse
    CFDictionarySetValue(
      dictionary,
      Unmanaged.passUnretained(key).toOpaque(),
      Unmanaged.passUnretained(flag).toOpaque()
    )
  }

  /// True unless the sample carries NotSync.
  static func isSync(_ sample: CMSampleBuffer) -> Bool {
    guard
      let attachments = CMSampleBufferGetSampleAttachmentsArray(
        sample, createIfNecessary: false),
      CFArrayGetCount(attachments) > 0
    else { return true }
    let dictionary = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFDictionary.self)
    guard
      let value = CFDictionaryGetValue(
        dictionary,
        Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque()
      )
    else { return true }
    return !CFBooleanGetValue(unsafeBitCast(value, to: CFBoolean.self))
  }

  static func blockBuffer(copying data: Data) -> CMBlockBuffer? {
    var block: CMBlockBuffer?
    guard
      CMBlockBufferCreateWithMemoryBlock(
        allocator: kCFAllocatorDefault,
        memoryBlock: nil,
        blockLength: data.count,
        blockAllocator: kCFAllocatorDefault,
        customBlockSource: nil,
        offsetToData: 0,
        dataLength: data.count,
        flags: kCMBlockBufferAssureMemoryNowFlag,
        blockBufferOut: &block
      ) == noErr, let block
    else { return nil }
    let status = data.withUnsafeBytes { raw -> OSStatus in
      guard let base = raw.baseAddress else { return -1 }
      return CMBlockBufferReplaceDataBytes(
        with: base, blockBuffer: block, offsetIntoDestination: 0, dataLength: data.count)
    }
    return status == noErr ? block : nil
  }

  static func data(of sample: CMSampleBuffer) -> Data? {
    guard let block = CMSampleBufferGetDataBuffer(sample) else { return nil }
    let length = CMBlockBufferGetDataLength(block)
    guard length > 0 else { return nil }
    var data = Data(count: length)
    let status = data.withUnsafeMutableBytes { raw -> OSStatus in
      guard let base = raw.baseAddress else { return -1 }
      return CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: base)
    }
    return status == noErr ? data : nil
  }
}

// MARK: - AAC

/// Live voice's audio format, which live video's audio track shares: raw
/// AAC-LC, 16 kHz mono, 1024 samples a frame.
enum VideoAAC {
  static let sampleRate: Double = 16_000
  static let samplesPerFrame: AVAudioFrameCount = 1024
  static let frameDurationUs = Int64(samplesPerFrame) * 1_000_000 / Int64(sampleRate)

  static var pcmFormat: AVAudioFormat? {
    AVAudioFormat(
      commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)
  }

  static var aacFormat: AVAudioFormat? {
    var desc = AudioStreamBasicDescription(
      mSampleRate: sampleRate,
      mFormatID: kAudioFormatMPEG4AAC,
      mFormatFlags: 0,
      mBytesPerPacket: 0,
      mFramesPerPacket: samplesPerFrame,
      mBytesPerFrame: 0,
      mChannelsPerFrame: 1,
      mBitsPerChannel: 0,
      mReserved: 0
    )
    return AVAudioFormat(streamDescription: &desc)
  }

  /// CoreAudio's magic cookie for this format: an ES_Descriptor around the
  /// AudioSpecificConfig. With the bare 2-byte config AVAssetWriter writes an
  /// esds AVFoundation then refuses to load as a track.
  static let magicCookie: Data = {
    if let pcm = pcmFormat, let aac = aacFormat,
      let converter = AVAudioConverter(from: pcm, to: aac),
      let cookie = converter.magicCookie, !cookie.isEmpty
    {
      return cookie
    }
    // Object type 2 (LC), frequency index 8 (16 kHz), one channel.
    return Data([0x14, 0x08])
  }()

  /// One steady-state frame of digital silence, to hold the audio timeline
  /// across frames the mesh lost.
  static let silentFrame: Data? = {
    guard let pcmFormat, let aacFormat,
      let converter = AVAudioConverter(from: pcmFormat, to: aacFormat)
    else { return nil }
    var last: Data?
    // Past the encoder's priming, so the frame is a plain silent one.
    for _ in 0..<4 {
      guard let pcm = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: samplesPerFrame) else {
        return nil
      }
      pcm.frameLength = samplesPerFrame
      if let channel = pcm.floatChannelData?[0] {
        channel.update(repeating: 0, count: Int(samplesPerFrame))
      }
      let compressed = AVAudioCompressedBuffer(
        format: aacFormat, packetCapacity: 4, maximumPacketSize: 1024)
      var supplied = false
      var error: NSError?
      converter.convert(to: compressed, error: &error) { _, status in
        if supplied {
          status.pointee = .noDataNow
          return nil
        }
        supplied = true
        status.pointee = .haveData
        return pcm
      }
      if error == nil, compressed.byteLength > 0 {
        if let descriptions = compressed.packetDescriptions, compressed.packetCount > 0 {
          let d = descriptions[Int(compressed.packetCount) - 1]
          let base = compressed.data.assumingMemoryBound(to: UInt8.self)
          last = Data(bytes: base.advanced(by: Int(d.mStartOffset)), count: Int(d.mDataByteSize))
        } else {
          last = Data(bytes: compressed.data, count: Int(compressed.byteLength))
        }
      }
    }
    return last
  }()

  static func formatDescription() -> CMAudioFormatDescription? {
    var description = AudioStreamBasicDescription(
      mSampleRate: sampleRate,
      mFormatID: kAudioFormatMPEG4AAC,
      mFormatFlags: 0,
      mBytesPerPacket: 0,
      mFramesPerPacket: samplesPerFrame,
      mBytesPerFrame: 0,
      mChannelsPerFrame: 1,
      mBitsPerChannel: 0,
      mReserved: 0
    )
    var format: CMAudioFormatDescription?
    let status = magicCookie.withUnsafeBytes { cookie in
      CMAudioFormatDescriptionCreate(
        allocator: kCFAllocatorDefault,
        asbd: &description,
        layoutSize: 0,
        layout: nil,
        magicCookieSize: cookie.count,
        magicCookie: cookie.baseAddress,
        extensions: nil,
        formatDescriptionOut: &format
      )
    }
    return status == noErr ? format : nil
  }

  static func sample(
    _ aac: Data, ptsUs: Int64, format: CMAudioFormatDescription
  ) -> CMSampleBuffer? {
    guard let block = VideoNAL.blockBuffer(copying: aac) else { return nil }
    var packet = AudioStreamPacketDescription(
      mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(aac.count))
    var sample: CMSampleBuffer?
    let status = CMAudioSampleBufferCreateReadyWithPacketDescriptions(
      allocator: kCFAllocatorDefault,
      dataBuffer: block,
      formatDescription: format,
      sampleCount: 1,
      presentationTimeStamp: CMTime(value: ptsUs, timescale: 1_000_000),
      packetDescriptions: &packet,
      sampleBufferOut: &sample
    )
    return status == noErr ? sample : nil
  }
}

// MARK: - Encoder

/// One encoded access unit, ready for the wire: Annex B, and on a keyframe
/// prefixed with SPS and PPS so any keyframe can start a decoder.
struct VideoEncodedFrame {
  let annexB: Data
  let ptsUs: Int64
  let keyframe: Bool
}

/// Real-time H.264 Constrained Baseline. Any picture is centre-cropped and
/// scaled to width x height NV12 by a pixel transfer session first, so the
/// camera's frames need no resizing of their own.
///
/// `encode`, `setBitrate`, `requestKeyframe`, `finish` and `invalidate` may be
/// called from any thread; `onFrame` is called on the encoder's own serial
/// queue, in output order.
final class VideoH264Encoder {
  let width: Int
  let height: Int
  let fps: Int
  var onFrame: ((VideoEncodedFrame) -> Void)?

  private let callbackQueue = DispatchQueue(
    label: "org.onemindlabs.airhop.video.encoder", qos: .userInitiated)
  private let lock = NSLock()
  private var session: VTCompressionSession?
  private var transfer: VTPixelTransferSession?
  private var pool: CVPixelBufferPool?
  private var forceKeyframe = true
  private var lastPtsUs: Int64 = .min
  private var currentBitrate: Int

  init?(width: Int, height: Int, fps: Int, bitrate: Int, keyframeIntervalSeconds: Int) {
    guard width >= 16, height >= 16, width % 2 == 0, height % 2 == 0, fps > 0 else { return nil }
    self.width = width
    self.height = height
    self.fps = fps
    self.currentBitrate = bitrate

    var created: VTCompressionSession?
    let status = VTCompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      width: Int32(width),
      height: Int32(height),
      codecType: kCMVideoCodecType_H264,
      encoderSpecification: nil,
      imageBufferAttributes: Self.pixelBufferAttributes(width: width, height: height)
        as CFDictionary,
      compressedDataAllocator: nil,
      outputCallback: nil,
      refcon: nil,
      compressionSessionOut: &created
    )
    guard status == noErr, let session = created else { return nil }

    Self.set(session, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue)
    // Constrained Baseline is what every Android decoder takes; an encoder
    // that lacks it falls back to plain Baseline.
    if VTSessionSetProperty(
      session, key: kVTCompressionPropertyKey_ProfileLevel,
      value: kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel) != noErr
    {
      Self.set(
        session, kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_Baseline_AutoLevel)
    }
    Self.set(session, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse)
    Self.set(
      session, kVTCompressionPropertyKey_MaxKeyFrameInterval,
      NSNumber(value: max(1, fps * keyframeIntervalSeconds)))
    Self.set(
      session, kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
      NSNumber(value: max(1, keyframeIntervalSeconds)))
    Self.set(session, kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: fps))
    Self.applyBitrate(bitrate, to: session)
    VTCompressionSessionPrepareToEncodeFrames(session)

    var transferSession: VTPixelTransferSession?
    guard
      VTPixelTransferSessionCreate(
        allocator: kCFAllocatorDefault, pixelTransferSessionOut: &transferSession) == noErr,
      let transferSession
    else {
      VTCompressionSessionInvalidate(session)
      return nil
    }
    // Trim keeps the aspect ratio and crops to fill: a centre crop.
    Self.set(transferSession, kVTPixelTransferPropertyKey_ScalingMode, kVTScalingMode_Trim)

    var createdPool: CVPixelBufferPool?
    CVPixelBufferPoolCreate(
      kCFAllocatorDefault,
      [kCVPixelBufferPoolMinimumBufferCountKey: 3] as CFDictionary,
      Self.pixelBufferAttributes(width: width, height: height) as CFDictionary,
      &createdPool
    )
    self.session = session
    self.transfer = transferSession
    self.pool = createdPool
  }

  deinit {
    invalidate()
  }

  /// `ptsUs` must rise; a frame at or before the last one is dropped, as
  /// VideoToolbox would.
  func encode(_ pixelBuffer: CVPixelBuffer, ptsUs: Int64) {
    lock.lock()
    defer { lock.unlock() }
    guard let session, ptsUs > lastPtsUs, let input = prepare(pixelBuffer) else { return }
    lastPtsUs = ptsUs
    var properties: CFDictionary?
    if forceKeyframe {
      forceKeyframe = false
      properties = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
    }
    let status = VTCompressionSessionEncodeFrame(
      session,
      imageBuffer: input,
      presentationTimeStamp: CMTime(value: ptsUs, timescale: 1_000_000),
      duration: CMTime(value: 1, timescale: CMTimeScale(fps)),
      frameProperties: properties,
      infoFlagsOut: nil
    ) { [weak self] status, flags, sample in
      self?.handleOutput(status: status, flags: flags, sample: sample)
    }
    if status != noErr {
      AirhopLog.video.error("Encode failed (\(status, privacy: .public))")
    }
  }

  func setBitrate(_ bitrate: Int) {
    lock.lock()
    defer { lock.unlock() }
    guard bitrate > 0, bitrate != currentBitrate, let session else { return }
    currentBitrate = bitrate
    Self.applyBitrate(bitrate, to: session)
  }

  func requestKeyframe() {
    lock.lock()
    forceKeyframe = true
    lock.unlock()
  }

  /// Flushes every pending frame and waits until `onFrame` has seen them all.
  func finish() {
    lock.lock()
    if let session {
      VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
    }
    lock.unlock()
    callbackQueue.sync {}
  }

  func invalidate() {
    lock.lock()
    let session = self.session
    let transfer = self.transfer
    self.session = nil
    self.transfer = nil
    self.pool = nil
    lock.unlock()
    if let session { VTCompressionSessionInvalidate(session) }
    if let transfer { VTPixelTransferSessionInvalidate(transfer) }
  }

  private func prepare(_ pixelBuffer: CVPixelBuffer) -> CVPixelBuffer? {
    let format = CVPixelBufferGetPixelFormatType(pixelBuffer)
    if CVPixelBufferGetWidth(pixelBuffer) == width,
      CVPixelBufferGetHeight(pixelBuffer) == height,
      format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        || format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
    {
      return pixelBuffer
    }
    guard let transfer else { return nil }
    var output: CVPixelBuffer?
    if let pool { CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &output) }
    if output == nil {
      CVPixelBufferCreate(
        kCFAllocatorDefault, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        Self.pixelBufferAttributes(width: width, height: height) as CFDictionary, &output)
    }
    guard let output,
      VTPixelTransferSessionTransferImage(transfer, from: pixelBuffer, to: output) == noErr
    else { return nil }
    return output
  }

  // On a VideoToolbox thread. Converted here, since the sample's memory is the
  // encoder's, then handed to the serial queue.
  private func handleOutput(status: OSStatus, flags: VTEncodeInfoFlags, sample: CMSampleBuffer?) {
    guard status == noErr, !flags.contains(.frameDropped), let sample,
      let frame = Self.annexBFrame(from: sample)
    else { return }
    callbackQueue.async { [weak self] in
      self?.onFrame?(frame)
    }
  }

  static func annexBFrame(from sample: CMSampleBuffer) -> VideoEncodedFrame? {
    guard CMSampleBufferDataIsReady(sample),
      let format = CMSampleBufferGetFormatDescription(sample),
      let data = VideoNAL.data(of: sample),
      let parameters = VideoNAL.parameterSets(of: format)
    else { return nil }
    let keyframe = VideoNAL.isSync(sample)
    var units = VideoNAL.units(inAVCC: data, lengthSize: parameters.lengthSize)
      .filter { VideoNAL.type($0) != VideoNAL.typeFiller }
    guard !units.isEmpty else { return nil }
    if keyframe {
      // In-band SPS and PPS let a viewer start at any keyframe.
      units.removeAll { [VideoNAL.typeSPS, VideoNAL.typePPS].contains(VideoNAL.type($0)) }
      units.insert(contentsOf: parameters.sets, at: 0)
    }
    let pts = CMSampleBufferGetPresentationTimeStamp(sample)
    let ptsUs =
      pts.isValid
      ? CMTimeConvertScale(pts, timescale: 1_000_000, method: .roundHalfAwayFromZero).value : 0
    return VideoEncodedFrame(annexB: VideoNAL.annexB(from: units), ptsUs: ptsUs, keyframe: keyframe)
  }

  private static func applyBitrate(_ bitrate: Int, to session: VTCompressionSession) {
    set(session, kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitrate))
    // Each second capped at 1.5x the average: the mesh has no spare capacity
    // for the bursts unconstrained VBR produces.
    let bytesPerSecond = max(1, bitrate * 3 / 2 / 8)
    set(
      session, kVTCompressionPropertyKey_DataRateLimits,
      [NSNumber(value: bytesPerSecond), NSNumber(value: 1)] as CFArray)
  }

  private static func set(_ session: VTSession, _ key: CFString, _ value: CFTypeRef?) {
    let status = VTSessionSetProperty(session, key: key, value: value)
    if status != noErr {
      AirhopLog.video.debug("VideoToolbox refused a property (\(status, privacy: .public))")
    }
  }

  private static func pixelBufferAttributes(width: Int, height: Int) -> [CFString: Any] {
    [
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelBufferWidthKey: width,
      kCVPixelBufferHeightKey: height,
      kCVPixelBufferIOSurfacePropertiesKey: [String: Any](),
    ]
  }
}

// MARK: - MP4 writer

/// Muxes encoded H.264 and raw AAC into an MP4 without re-encoding. Built for
/// what a lossy mesh delivers:
///
/// - nothing is written before a keyframe with SPS and PPS, which sets the
///   track format and starts the session at its pts;
/// - a sample at or before its track's last pts is dropped;
/// - a video sample lasts until the next, so lost frames play back as a held
///   picture, and lost audio is filled with encoded silence (AVAssetWriter
///   would otherwise close the gap and pull the sound ahead of the picture).
///
/// Lock-protected; call from one serial queue.
final class VideoMp4Writer {
  private static let readyTimeout: TimeInterval = 0.25
  // The last video sample has no successor to take its length from.
  private static let fallbackFrameDurationUs: Int64 = 66_666
  // About two minutes; a longer dropout ends the stream anyway.
  private static let maxSilenceFrames = 2_000

  let url: URL
  private let hasAudio: Bool
  private let lock = NSLock()
  private var writer: AVAssetWriter?
  private var videoInput: AVAssetWriterInput?
  private var audioInput: AVAssetWriterInput?
  private var videoFormat: CMVideoFormatDescription?
  private var videoParameters: (sps: Data, pps: Data)?
  private var audioFormat: CMAudioFormatDescription?
  private var failed = false
  private var finished = false
  private var pendingVideo: (avcc: Data, ptsUs: Int64, keyframe: Bool)?
  private var lastVideoPtsUs: Int64 = .min
  private var lastAudioPtsUs: Int64 = .min
  private var lastVideoDurationUs: Int64 = fallbackFrameDurationUs
  private var startPtsUs: Int64 = 0
  private var endPtsUs: Int64 = 0
  private var videoSamples = 0

  init(url: URL, hasAudio: Bool) {
    self.url = url
    self.hasAudio = hasAudio
  }

  var durationMs: Int64 {
    lock.lock()
    defer { lock.unlock() }
    return max(0, endPtsUs - startPtsUs) / 1_000
  }

  func writeVideo(annexB: Data, ptsUs: Int64, keyframe: Bool) {
    lock.lock()
    defer { lock.unlock() }
    guard !failed, !finished, ptsUs > lastVideoPtsUs else { return }
    let units = VideoNAL.units(inAnnexB: annexB)
    guard !units.isEmpty else { return }
    if writer == nil {
      guard keyframe, let sets = VideoNAL.parameterSets(in: units),
        start(sps: sets.sps, pps: sets.pps, ptsUs: ptsUs)
      else { return }
    }
    // Parameter sets live in the track format; kept in-band only if the
    // encoder changed them mid-stream.
    let setsMatch =
      VideoNAL.parameterSets(in: units).map {
        $0.sps == videoParameters?.sps && $0.pps == videoParameters?.pps
      } ?? true
    let kept = units.filter { nal in
      switch VideoNAL.type(nal) {
      case VideoNAL.typeAUD, VideoNAL.typeFiller: return false
      case VideoNAL.typeSPS, VideoNAL.typePPS: return !setsMatch
      default: return true
      }
    }
    guard !kept.isEmpty else { return }
    if let previous = pendingVideo {
      let duration = ptsUs - previous.ptsUs
      appendVideo(previous, durationUs: duration)
      lastVideoDurationUs = duration
    }
    pendingVideo = (VideoNAL.avcc(from: kept), ptsUs, keyframe)
    lastVideoPtsUs = ptsUs
  }

  func writeAudio(aac: Data, ptsUs: Int64) {
    lock.lock()
    defer { lock.unlock() }
    guard hasAudio, !failed, !finished, !aac.isEmpty,
      let writer, writer.status == .writing,
      let audioInput, let audioFormat,
      ptsUs >= startPtsUs, ptsUs > lastAudioPtsUs
    else { return }
    let frameUs = VideoAAC.frameDurationUs
    if lastAudioPtsUs != .min, let silence = VideoAAC.silentFrame {
      var expected = lastAudioPtsUs + frameUs
      var inserted = 0
      while ptsUs - expected >= frameUs / 2, inserted < Self.maxSilenceFrames {
        guard let filler = VideoAAC.sample(silence, ptsUs: expected, format: audioFormat),
          append(filler, to: audioInput)
        else { break }
        expected += frameUs
        inserted += 1
      }
    }
    guard let sample = VideoAAC.sample(aac, ptsUs: ptsUs, format: audioFormat),
      append(sample, to: audioInput)
    else { return }
    lastAudioPtsUs = ptsUs
    endPtsUs = max(endPtsUs, ptsUs + frameUs)
  }

  /// Finalizes synchronously. False, and no file left, when no picture was
  /// written or the writer failed.
  func finish() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !finished else { return false }
    finished = true
    guard let writer else { return false }
    if let last = pendingVideo {
      appendVideo(last, durationUs: lastVideoDurationUs)
      pendingVideo = nil
    }
    guard !failed, writer.status == .writing, videoSamples > 0 else {
      writer.cancelWriting()
      try? FileManager.default.removeItem(at: url)
      return false
    }
    videoInput?.markAsFinished()
    audioInput?.markAsFinished()
    writer.endSession(
      atSourceTime: CMTime(value: max(endPtsUs, startPtsUs + 1), timescale: 1_000_000))
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()
    guard writer.status == .completed else {
      try? FileManager.default.removeItem(at: url)
      return false
    }
    return true
  }

  func cancel() {
    lock.lock()
    defer { lock.unlock() }
    finished = true
    writer?.cancelWriting()
    try? FileManager.default.removeItem(at: url)
  }

  private func start(sps: Data, pps: Data, ptsUs: Int64) -> Bool {
    guard let format = VideoNAL.formatDescription(sps: sps, pps: pps) else { return false }
    do {
      try? FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? FileManager.default.removeItem(at: url)
      let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
      let video = AVAssetWriterInput(
        mediaType: .video, outputSettings: nil, sourceFormatHint: format)
      video.expectsMediaDataInRealTime = true
      guard writer.canAdd(video) else {
        failed = true
        return false
      }
      writer.add(video)
      if hasAudio, let audioFormat = VideoAAC.formatDescription() {
        let audio = AVAssetWriterInput(
          mediaType: .audio, outputSettings: nil, sourceFormatHint: audioFormat)
        audio.expectsMediaDataInRealTime = true
        if writer.canAdd(audio) {
          writer.add(audio)
          self.audioInput = audio
          self.audioFormat = audioFormat
        }
      }
      guard writer.startWriting() else {
        failed = true
        return false
      }
      writer.startSession(atSourceTime: CMTime(value: ptsUs, timescale: 1_000_000))
      self.writer = writer
      self.videoInput = video
      self.videoFormat = format
      self.videoParameters = (sps, pps)
      self.startPtsUs = ptsUs
      self.endPtsUs = ptsUs
      return true
    } catch {
      AirhopLog.video.error("MP4 writer unavailable")
      failed = true
      return false
    }
  }

  private func appendVideo(
    _ sample: (avcc: Data, ptsUs: Int64, keyframe: Bool), durationUs: Int64
  ) {
    guard let videoInput, let videoFormat,
      let buffer = VideoNAL.sampleBuffer(
        avcc: sample.avcc,
        format: videoFormat,
        pts: CMTime(value: sample.ptsUs, timescale: 1_000_000),
        duration: CMTime(value: max(1, durationUs), timescale: 1_000_000),
        keyframe: sample.keyframe
      ),
      append(buffer, to: videoInput)
    else { return }
    videoSamples += 1
    endPtsUs = max(endPtsUs, sample.ptsUs + max(1, durationUs))
  }

  private func append(_ sample: CMSampleBuffer, to input: AVAssetWriterInput) -> Bool {
    guard let writer, writer.status == .writing else {
      markFailedIfNeeded()
      return false
    }
    let deadline = Date().addingTimeInterval(Self.readyTimeout)
    while !input.isReadyForMoreMediaData {
      guard writer.status == .writing, Date() < deadline else {
        markFailedIfNeeded()
        return false
      }
      Thread.sleep(forTimeInterval: 0.002)
    }
    guard input.append(sample) else {
      markFailedIfNeeded()
      return false
    }
    return true
  }

  private func markFailedIfNeeded() {
    guard let writer, writer.status == .failed, !failed else { return }
    failed = true
    AirhopLog.video.error("MP4 writer failed")
  }
}
