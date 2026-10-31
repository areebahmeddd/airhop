// AirhopVideoViews: the two native views live video draws into, and the
// registry that routes decoded units to them.
//
// A surface is an AVSampleBufferDisplayLayer, which decodes H.264 itself, so
// there is no separate decoder to keep in step with it. Units arrive already
// paced by TypeScript and are shown the moment they land. Every surface under
// a key gets them (SurfaceRegistry), so a stream plays in its bubble and its
// full-screen viewer at once.
import AVFoundation
import React
import UIKit

// MARK: - Display registry

final class AirhopVideoDisplays {
  static let shared = AirhopVideoDisplays()

  // A stream's parameter sets, shared by every layer showing it.
  private final class Stream {
    var format: CMVideoFormatDescription?
    var parameters: (sps: Data, pps: Data)?
  }

  // Main thread only: the views and their layers live there.
  private let surfaces = SurfaceRegistry<AirhopVideoSurfaceView>()
  private var streams: [String: Stream] = [:]

  func attach(_ view: AirhopVideoSurfaceView, key: String) {
    surfaces.attach(view, key: key)
  }

  func detach(_ view: AirhopVideoSurfaceView, key: String) {
    surfaces.detach(view, key: key)
  }

  func decode(key: String, annexB: Data, keyframe: Bool) {
    let stream: Stream
    if let known = streams[key] {
      stream = known
    } else {
      stream = Stream()
      streams[key] = stream
    }
    // A layer that failed (the app went to the background) starts again at
    // the next keyframe.
    for view in surfaces.surfaces(for: key) where view.displayLayer.status == .failed {
      view.displayLayer.flush()
      surfaces.resync(view, key: key)
    }
    let units = VideoNAL.units(inAnnexB: annexB)
    guard !units.isEmpty else { return }
    let targets = surfaces.receivers(key: key, keyframe: keyframe)
    guard !targets.isEmpty else { return }
    if keyframe, let sets = VideoNAL.parameterSets(in: units),
      stream.parameters?.sps != sets.sps || stream.parameters?.pps != sets.pps
    {
      stream.format = VideoNAL.formatDescription(sps: sets.sps, pps: sets.pps)
      stream.parameters = sets
    }
    let kept = units.filter {
      let type = VideoNAL.type($0)
      return type != VideoNAL.typeSPS && type != VideoNAL.typePPS && type != VideoNAL.typeAUD
    }
    guard let format = stream.format else { return }
    let avcc = VideoNAL.avcc(from: kept)
    // A sample buffer each: a layer owns what it is given.
    for view in targets {
      let sample = VideoNAL.sampleBuffer(avcc: avcc, format: format, pts: .zero, keyframe: keyframe)
      guard let sample else { continue }
      VideoNAL.setAttachment(sample, kCMSampleAttachmentKey_DisplayImmediately, true)
      view.displayLayer.enqueue(sample)
    }
  }

  func release(key: String) {
    streams[key] = nil
    for view in surfaces.surfaces(for: key) {
      view.displayLayer.flushAndRemoveImage()
      surfaces.resync(view, key: key)
    }
  }
}

// MARK: - Surface

final class AirhopVideoSurfaceView: UIView {
  override class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }

  var displayLayer: AVSampleBufferDisplayLayer {
    layer as! AVSampleBufferDisplayLayer
  }

  @objc var surfaceKey: NSString = "" {
    didSet {
      let previous = oldValue as String
      if !previous.isEmpty { AirhopVideoDisplays.shared.detach(self, key: previous) }
      attachIfWindowed()
    }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    displayLayer.videoGravity = .resizeAspectFill
    clipsToBounds = true
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not used")
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    let key = surfaceKey as String
    guard !key.isEmpty else { return }
    if window == nil {
      AirhopVideoDisplays.shared.detach(self, key: key)
    } else {
      attachIfWindowed()
    }
  }

  private func attachIfWindowed() {
    let key = surfaceKey as String
    guard !key.isEmpty, window != nil else { return }
    AirhopVideoDisplays.shared.attach(self, key: key)
  }
}

@objc(AirhopVideoSurfaceManager)
final class AirhopVideoSurfaceManager: RCTViewManager {
  override static func requiresMainQueueSetup() -> Bool { true }
  override func view() -> UIView! { AirhopVideoSurfaceView() }
}

// MARK: - Camera preview

/// What the camera sees, mirrored for the front camera as a mirror would be.
/// The encoded stream is not mirrored, so text reads the right way round for
/// viewers.
final class AirhopCameraPreviewView: UIView {
  override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

  private var previewLayer: AVCaptureVideoPreviewLayer {
    layer as! AVCaptureVideoPreviewLayer
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    previewLayer.videoGravity = .resizeAspectFill
    previewLayer.session = AirhopVideoCamera.shared.session
    clipsToBounds = true
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not used")
  }
}

@objc(AirhopCameraPreviewManager)
final class AirhopCameraPreviewManager: RCTViewManager {
  override static func requiresMainQueueSetup() -> Bool { true }
  override func view() -> UIView! { AirhopCameraPreviewView() }
}
