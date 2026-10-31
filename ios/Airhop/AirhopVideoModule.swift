// AirhopVideoModule: live video, and the transcode that fits a video to a
// mesh transfer.
//
// iOS counterpart of AirhopVideoModule.kt, with the same contract: the camera
// becomes a stream of H.264 access units, units become pictures on a surface,
// units plus AAC frames become an MP4, and a file becomes a smaller one to the
// plan it is handed (VideoTranscode/). No protocol, no pacing, no packet
// knowledge, no sizing decisions: those live in core/mesh/video/,
// live-video-*.ts and video-prepare.ts.
//
// Units cross the bridge as base64 Annex B with SPS and PPS on every keyframe,
// exactly the LIVE_VIDEO_V1 unit format. Audio is not captured here; the
// microphone belongs to AirhopVoiceModule, whose frames TypeScript hands back
// for the recording.
//
// Threading: every exported method returns at once. The camera has its own
// session queue, recordings their own serial queue, display work runs on the
// main thread with the layers it feeds, and transcodes run one after another
// as tasks off it.
//
// Events emitted to TypeScript:
//   AirhopVideo.encoded            { dataBase64, ptsMs, keyframe }
//   AirhopVideo.cameraError        { message }
//   AirhopVideo.transcodeProgress  { jobKey, fraction }
import AVFoundation
import Foundation
import React
import UIKit

private enum VideoEvent {
  static let encoded = "AirhopVideo.encoded"
  static let cameraError = "AirhopVideo.cameraError"
  static let transcodeProgress = "AirhopVideo.transcodeProgress"
}

// MARK: - Camera

/// One camera for the whole app: the studio's preview and the encoder share
/// its session, and only one stream is ever live.
final class AirhopVideoCamera: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  static let shared = AirhopVideoCamera()

  let session = AVCaptureSession()
  var onFrame: ((VideoEncodedFrame) -> Void)?
  var onError: ((String) -> Void)?

  private let sessionQueue = DispatchQueue(
    label: "org.onemindlabs.airhop.video.camera", qos: .userInitiated)
  private let frameQueue = DispatchQueue(
    label: "org.onemindlabs.airhop.video.frames", qos: .userInitiated)
  private let output = AVCaptureVideoDataOutput()
  private var input: AVCaptureDeviceInput?
  private var outputAdded = false
  private var observers: [NSObjectProtocol] = []

  // Frame-queue state.
  private var encoder: VideoH264Encoder?
  private var originSeconds: Double = 0
  private var lastFrameSeconds: Double = 0
  private var fps = 8

  // MARK: Lifecycle

  func start(facing: String, fps: Int, completion: @escaping (Error?) -> Void) {
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
      completion(VideoError.permission)
      return
    }
    frameQueue.sync { self.fps = max(1, fps) }
    sessionQueue.async {
      do {
        try self.configure(facing: facing)
        if !self.session.isRunning { self.session.startRunning() }
        guard self.session.isRunning else { throw VideoError.camera }
        self.observeInterruptions()
        Self.keepScreenOn(true)
        completion(nil)
      } catch {
        completion(error)
      }
    }
  }

  func setFacing(_ facing: String, completion: @escaping (Error?) -> Void) {
    sessionQueue.async {
      do {
        self.session.beginConfiguration()
        defer { self.session.commitConfiguration() }
        try self.installInput(facing: facing)
        self.orientConnection()
        // A new camera starts a new picture: viewers need a keyframe for it.
        self.frameQueue.async { self.encoder?.requestKeyframe() }
        completion(nil)
      } catch {
        completion(error)
      }
    }
  }

  // Queued on the session queue at once, not after the encoder's flush, so a
  // start that follows straight away (going live again) runs after this stop
  // rather than being undone by it.
  func stop(completion: @escaping () -> Void) {
    stopEncoding {}
    sessionQueue.async {
      self.removeObservers()
      if self.session.isRunning { self.session.stopRunning() }
      Self.keepScreenOn(false)
      completion()
    }
  }

  // A studio is a camera people prop up and leave. Auto-lock would send the
  // app to the background, which ends the stream. Dispatched from the session
  // queue, so a start and a stop reach the main queue in the order they ran.
  private static func keepScreenOn(_ on: Bool) {
    DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = on }
  }

  // MARK: Encoding

  func startEncoding(width: Int, height: Int, bitrate: Int, keyframeIntervalSeconds: Int) -> Bool {
    frameQueue.sync {
      self.encoder?.invalidate()
      guard
        let encoder = VideoH264Encoder(
          width: width, height: height, fps: fps, bitrate: bitrate,
          keyframeIntervalSeconds: keyframeIntervalSeconds)
      else {
        self.encoder = nil
        return false
      }
      encoder.onFrame = { [weak self] frame in self?.onFrame?(frame) }
      encoder.onError = { [weak self] in self?.onError?("encoder failed") }
      self.encoder = encoder
      self.originSeconds = CMClockGetTime(CMClockGetHostTimeClock()).seconds
      self.lastFrameSeconds = 0
      return true
    }
  }

  /// Flushes the encoder; every unit it held is emitted before `completion`.
  func stopEncoding(completion: @escaping () -> Void) {
    frameQueue.async {
      let encoder = self.encoder
      self.encoder = nil
      encoder?.finish()
      encoder?.invalidate()
      completion()
    }
  }

  func setBitrate(_ bitrate: Int) {
    frameQueue.async { self.encoder?.setBitrate(bitrate) }
  }

  func requestKeyframe() {
    frameQueue.async { self.encoder?.requestKeyframe() }
  }

  // Frame queue. Frames past the preset's rate are dropped here, 15% early
  // allowed so a 30 fps camera reliably yields the target.
  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    guard let encoder, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    let seconds = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
    guard seconds.isFinite else { return }
    let interval = 1 / Double(fps)
    if lastFrameSeconds != 0, seconds - lastFrameSeconds < interval * 0.85 { return }
    lastFrameSeconds = seconds
    let ptsUs = Int64(max(0, seconds - originSeconds) * 1_000_000)
    encoder.encode(pixels, ptsUs: ptsUs)
  }

  // MARK: Session queue

  private func configure(facing: String) throws {
    session.beginConfiguration()
    defer { session.commitConfiguration() }
    // 640x480 covers the largest preset (480x640 portrait) without paying for
    // a full-resolution capture.
    if session.canSetSessionPreset(.vga640x480) {
      session.sessionPreset = .vga640x480
    } else if session.canSetSessionPreset(.medium) {
      session.sessionPreset = .medium
    }
    try installInput(facing: facing)
    if !outputAdded {
      let nv12 = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
      if output.availableVideoPixelFormatTypes.contains(nv12) {
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: nv12]
      }
      output.alwaysDiscardsLateVideoFrames = true
      output.setSampleBufferDelegate(self, queue: frameQueue)
      guard session.canAddOutput(output) else { throw VideoError.camera }
      session.addOutput(output)
      outputAdded = true
    }
    orientConnection()
  }

  private func installInput(facing: String) throws {
    let position: AVCaptureDevice.Position = facing == "back" ? .back : .front
    guard
      let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position)
        ?? AVCaptureDevice.default(for: .video)
    else { throw VideoError.camera }
    if let input, input.device.uniqueID == device.uniqueID { return }
    let next = try AVCaptureDeviceInput(device: device)
    if let input { session.removeInput(input) }
    guard session.canAddInput(next) else {
      if let input, session.canAddInput(input) { session.addInput(input) }
      throw VideoError.camera
    }
    session.addInput(next)
    input = next
    capFrameRate(device)
  }

  /// Upright portrait frames, since every preset is 3:4 portrait, and never
  /// mirrored: viewers see the scene as it is.
  private func orientConnection() {
    guard let connection = output.connection(with: .video) else { return }
    if #available(iOS 17.0, *) {
      if connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
    } else if connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
    }
    if connection.isVideoMirroringSupported {
      connection.automaticallyAdjustsVideoMirroring = false
      connection.isVideoMirrored = false
    }
  }

  private func capFrameRate(_ device: AVCaptureDevice) {
    let target = CMTime(value: 1, timescale: 30)
    let supported = device.activeFormat.videoSupportedFrameRateRanges.contains {
      $0.minFrameDuration <= target && target <= $0.maxFrameDuration
    }
    guard supported, (try? device.lockForConfiguration()) != nil else { return }
    device.activeVideoMinFrameDuration = target
    device.unlockForConfiguration()
  }

  private func observeInterruptions() {
    removeObservers()
    let center = NotificationCenter.default
    let report: (Notification) -> Void = { [weak self] _ in
      self?.frameQueue.async {
        guard self?.encoder != nil else { return }
        self?.onError?("camera interrupted")
      }
    }
    observers = [
      center.addObserver(
        forName: AVCaptureSession.wasInterruptedNotification, object: session, queue: nil,
        using: report),
      center.addObserver(
        forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil,
        using: report),
    ]
  }

  private func removeObservers() {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers.removeAll()
  }
}

enum VideoError: Error {
  case permission
  case camera
  case encoder
}

// MARK: - Module

@objc(AirhopVideoModule)
final class AirhopVideoModule: RCTEventEmitter {
  private let recordingQueue = DispatchQueue(label: "org.onemindlabs.airhop.video.recording")
  // Recording-queue state.
  private var recordings: [String: VideoMp4Writer] = [:]
  // Its own lock: the recording queue can be busy finishing a file.
  private let optionsLock = NSLock()
  private var cameraOptions: NSDictionary?
  // Guards both: passes by job key, and the last one queued, which the next
  // waits for.
  private let transcodeLock = NSLock()
  private var transcodes: [String: VideoTranscodePass] = [:]
  private var transcodeTail: Task<Void, Never>?

  @objc override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! {
    [VideoEvent.encoded, VideoEvent.cameraError, VideoEvent.transcodeProgress]
  }

  // A JS reload or teardown: the camera goes off and no recording or
  // transcode is left open.
  override func invalidate() {
    AirhopVideoCamera.shared.stop {}
    recordingQueue.async {
      self.recordings.values.forEach { $0.cancel() }
      self.recordings.removeAll()
    }
    transcodeLock.lock()
    transcodes.values.forEach { $0.cancel() }
    transcodeLock.unlock()
    super.invalidate()
  }

  override init() {
    super.init()
    let camera = AirhopVideoCamera.shared
    camera.onFrame = { [weak self] frame in
      self?.sendEvent(
        withName: VideoEvent.encoded,
        body: [
          "dataBase64": frame.annexB.base64EncodedString(),
          "ptsMs": Double(frame.ptsUs / 1_000),
          "keyframe": frame.keyframe,
        ])
    }
    camera.onError = { [weak self] message in
      self?.sendEvent(withName: VideoEvent.cameraError, body: ["message": message])
    }
  }

  // MARK: Display

  @objc func decodeVideo(_ surfaceKey: String, dataBase64: String, keyframe: Bool) {
    guard let data = Data(base64Encoded: dataBase64) else { return }
    DispatchQueue.main.async {
      AirhopVideoDisplays.shared.decode(key: surfaceKey, annexB: data, keyframe: keyframe)
    }
  }

  @objc func releaseDecoder(_ surfaceKey: String) {
    DispatchQueue.main.async { AirhopVideoDisplays.shared.release(key: surfaceKey) }
  }

  // MARK: Recording

  @objc func startRecording(
    _ recordingKey: String,
    path: String,
    width: Double,
    height: Double,
    hasAudio: Bool,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let url = Self.fileURL(path) else {
      reject("BAD_PATH", "not a file URL", nil)
      return
    }
    recordingQueue.async {
      self.recordings[recordingKey]?.cancel()
      self.recordings[recordingKey] = VideoMp4Writer(url: url, hasAudio: hasAudio)
      resolve(nil)
    }
  }

  @objc func appendVideo(
    _ recordingKey: String, dataBase64: String, ptsMs: Double, keyframe: Bool
  ) {
    guard let data = Data(base64Encoded: dataBase64) else { return }
    recordingQueue.async {
      self.recordings[recordingKey]?.writeVideo(
        annexB: data, ptsUs: Int64(ptsMs * 1_000), keyframe: keyframe)
    }
  }

  @objc func appendAudio(_ recordingKey: String, dataBase64: String, ptsMs: Double) {
    guard let data = Data(base64Encoded: dataBase64) else { return }
    recordingQueue.async {
      self.recordings[recordingKey]?.writeAudio(aac: data, ptsUs: Int64(ptsMs * 1_000))
    }
  }

  @objc func finishRecording(
    _ recordingKey: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    recordingQueue.async {
      guard let writer = self.recordings.removeValue(forKey: recordingKey), writer.finish() else {
        resolve(NSNull())
        return
      }
      let attributes = try? FileManager.default.attributesOfItem(atPath: writer.url.path)
      let size = (attributes?[.size] as? NSNumber)?.intValue ?? 0
      resolve(["durationMs": Double(writer.durationMs), "sizeBytes": Double(size)])
    }
  }

  @objc func cancelRecording(_ recordingKey: String) {
    recordingQueue.async {
      self.recordings.removeValue(forKey: recordingKey)?.cancel()
    }
  }

  // MARK: Transcode

  @objc func probeVideo(
    _ uri: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let url = Self.fileURL(uri) else {
      reject("BAD_PATH", "not a file URL", nil)
      return
    }
    Task.detached(priority: .userInitiated) {
      do {
        let probe = try await VideoTranscodeProbing.probe(url)
        resolve([
          "durationMs": probe.durationMs,
          "width": probe.width,
          "height": probe.height,
          "hasAudio": probe.hasAudio,
        ])
      } catch VideoTranscodeError.noVideo {
        reject("NO_VIDEO", "no video track", nil)
      } catch {
        reject("UNREADABLE", "cannot open the video", error)
      }
    }
  }

  @objc func transcodeVideo(
    _ jobKey: String,
    source: String,
    output: String,
    options: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let sourceURL = Self.fileURL(source), let outputURL = Self.fileURL(output) else {
      reject("BAD_PATH", "not a file URL", nil)
      return
    }
    let number = { (key: String) -> Int in (options[key] as? NSNumber)?.intValue ?? 0 }
    let pass = VideoTranscodePass(
      source: sourceURL,
      output: outputURL,
      options: VideoTranscodeOptions(
        startMs: number("startMs"),
        keepMs: number("keepMs"),
        width: number("width"),
        height: number("height"),
        fps: number("fps"),
        videoBitrate: number("videoBitrate"),
        audioBitrate: number("audioBitrate"),
        keyframeIntervalSeconds: number("keyframeIntervalSeconds")
      ))
    transcodeLock.lock()
    transcodes[jobKey]?.cancel()
    transcodes[jobKey] = pass
    let previous = transcodeTail
    let task = Task.detached(priority: .userInitiated) { [weak self] in
      await previous?.value
      do {
        let result = try await pass.run { fraction in
          self?.sendEvent(
            withName: VideoEvent.transcodeProgress,
            body: ["jobKey": jobKey, "fraction": fraction])
        }
        resolve(["sizeBytes": Double(result.sizeBytes), "durationMs": result.durationMs])
      } catch VideoTranscodeError.cancelled {
        reject("CANCELLED", "transcode cancelled", nil)
      } catch {
        // Domain and code only: an NSError's description carries the file path.
        let nsError = error as NSError
        let code = "\(nsError.domain) \(nsError.code)"
        AirhopLog.video.error("Transcode failed (\(code, privacy: .public))")
        reject("TRANSCODE_FAILED", "transcode failed", error)
      }
      self?.finishTranscode(jobKey, pass)
    }
    transcodeTail = task
    transcodeLock.unlock()
  }

  @objc func cancelTranscode(_ jobKey: String) {
    transcodeLock.lock()
    let pass = transcodes[jobKey]
    transcodeLock.unlock()
    pass?.cancel()
  }

  @objc func extractFrames(
    _ source: String,
    timesMs: [NSNumber],
    maxEdge: Double,
    outputs: [String],
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let outputURLs = outputs.compactMap(Self.fileURL)
    guard let sourceURL = Self.fileURL(source), outputURLs.count == outputs.count else {
      reject("BAD_PATH", "not a file URL", nil)
      return
    }
    Task.detached(priority: .utility) {
      await VideoFrames.write(
        source: sourceURL, timesMs: timesMs.map(\.doubleValue), maxEdge: Int(maxEdge),
        outputs: outputURLs)
      resolve(nil)
    }
  }

  private func finishTranscode(_ jobKey: String, _ pass: VideoTranscodePass) {
    transcodeLock.lock()
    if transcodes[jobKey] === pass { transcodes.removeValue(forKey: jobKey) }
    transcodeLock.unlock()
  }

  // MARK: Capture

  @objc func startCamera(
    _ options: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    optionsLock.lock()
    cameraOptions = options
    optionsLock.unlock()
    let facing = options["facing"] as? String ?? "front"
    let fps = (options["fps"] as? NSNumber)?.intValue ?? 8
    AirhopVideoCamera.shared.start(facing: facing, fps: fps) { error in
      if let error {
        let code = error is VideoError ? "CAMERA_UNAVAILABLE" : "CAMERA_FAILED"
        reject(code, "camera unavailable", error)
      } else {
        resolve(nil)
      }
    }
  }

  @objc func setFacing(
    _ facing: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    AirhopVideoCamera.shared.setFacing(facing) { error in
      if let error {
        reject("CAMERA_FAILED", "could not switch camera", error)
      } else {
        resolve(nil)
      }
    }
  }

  @objc func startEncoding(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    optionsLock.lock()
    let options = cameraOptions
    optionsLock.unlock()
    let number = { (key: String, fallback: Int) -> Int in
      (options?[key] as? NSNumber)?.intValue ?? fallback
    }
    let started = AirhopVideoCamera.shared.startEncoding(
      width: number("width", 144),
      height: number("height", 192),
      bitrate: number("bitrate", 18_000),
      keyframeIntervalSeconds: number("keyframeIntervalSeconds", 2)
    )
    if started { resolve(nil) } else { reject("ENCODER_FAILED", "H.264 encoder unavailable", nil) }
  }

  @objc func stopEncoding(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    AirhopVideoCamera.shared.stopEncoding { resolve(nil) }
  }

  @objc func setBitrate(_ bitrate: Double) {
    AirhopVideoCamera.shared.setBitrate(Int(bitrate))
  }

  @objc func requestKeyframe() {
    AirhopVideoCamera.shared.requestKeyframe()
  }

  @objc func stopCamera(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    AirhopVideoCamera.shared.stop { resolve(nil) }
  }

  private static func fileURL(_ path: String) -> URL? {
    if let url = URL(string: path), url.isFileURL { return url }
    return path.hasPrefix("/") ? URL(fileURLWithPath: path) : nil
  }
}
