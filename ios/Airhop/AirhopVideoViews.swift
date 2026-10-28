// AirhopVideoViews: the two native views live video draws into, and the
// registry that routes decoded units to them.
//
// A surface is an AVSampleBufferDisplayLayer, which decodes H.264 itself, so
// there is no separate decoder to keep in step with it. Units arrive already
// paced by TypeScript and are shown the moment they land. A surface that has
// just mounted, or whose layer failed (the app went to the background), waits
// for the next keyframe rather than painting deltas with nothing under them.
import AVFoundation
import React
import UIKit

// MARK: - Display registry

final class AirhopVideoDisplays {
  static let shared = AirhopVideoDisplays()

  private final class Stream {
    var format: CMVideoFormatDescription?
    var parameters: (sps: Data, pps: Data)?
    var awaitingKeyframe = true
  }

  // Main thread only: the views and their layers live there.
  private var views: [String: WeakSurface] = [:]
  private var streams: [String: Stream] = [:]

  private struct WeakSurface {
    weak var view: AirhopVideoSurfaceView?
  }

  func attach(_ view: AirhopVideoSurfaceView, key: String) {
    views[key] = WeakSurface(view: view)
    streams[key]?.awaitingKeyframe = true
  }

  func detach(_ view: AirhopVideoSurfaceView, key: String) {
    if views[key]?.view === view { views[key] = nil }
  }

  func decode(key: String, annexB: Data, keyframe: Bool) {
    let stream: Stream
    if let known = streams[key] {
      stream = known
    } else {
      stream = Stream()
      streams[key] = stream
    }
    guard let view = views[key]?.view else {
      stream.awaitingKeyframe = true
      return
    }
    let layer = view.displayLayer
    if layer.status == .failed {
      layer.flush()
      stream.awaitingKeyframe = true
    }
    let units = VideoNAL.units(inAnnexB: annexB)
    guard !units.isEmpty else { return }
    if keyframe, let sets = VideoNAL.parameterSets(in: units),
      stream.parameters?.sps != sets.sps || stream.parameters?.pps != sets.pps
    {
      stream.format = VideoNAL.formatDescription(sps: sets.sps, pps: sets.pps)
      stream.parameters = sets
    }
    if stream.awaitingKeyframe {
      guard keyframe else { return }
      stream.awaitingKeyframe = false
    }
    let kept = units.filter {
      let type = VideoNAL.type($0)
      return type != VideoNAL.typeSPS && type != VideoNAL.typePPS && type != VideoNAL.typeAUD
    }
    guard let format = stream.format,
      let sample = VideoNAL.sampleBuffer(
        avcc: VideoNAL.avcc(from: kept), format: format, pts: .zero, keyframe: keyframe)
    else { return }
    VideoNAL.setAttachment(sample, kCMSampleAttachmentKey_DisplayImmediately, true)
    layer.enqueue(sample)
  }

  func release(key: String) {
    streams[key] = nil
    views[key]?.view?.displayLayer.flushAndRemoveImage()
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
