// The two native views live video draws into, beside NativeAirhopVideo.ts.
//
// Legacy view managers (AirhopVideoSurfaceManager, AirhopCameraPreviewManager)
// resolved through the New Architecture's interop layer, like the modules.
//
// A surface shows whatever NativeAirhopVideo.decodeVideo sends to its key, and
// every surface mounted under one key shows it, each from its own next
// keyframe: a stream plays in its bubble and its full-screen viewer at once. A
// preview shows the camera startCamera opened, mirrored for the front camera
// as a mirror would be. Neither does anything on its own.
import { requireNativeComponent, type ViewProps } from "react-native";

// The picture fills the view, cropped to it; callers size the view to the
// stream's aspect.
export interface VideoSurfaceProps extends ViewProps {
  surfaceKey: string;
}

export const AirhopVideoSurface =
  requireNativeComponent<VideoSurfaceProps>("AirhopVideoSurface");

export const AirhopCameraPreview = requireNativeComponent<ViewProps>(
  "AirhopCameraPreview",
);
