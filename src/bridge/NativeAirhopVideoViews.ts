// The two native views live video draws into, beside NativeAirhopVideo.ts.
//
// Legacy view managers (AirhopVideoSurfaceManager, AirhopCameraPreviewManager)
// resolved through the New Architecture's interop layer, like the modules.
//
// A surface shows whatever NativeAirhopVideo.decodeVideo sends to its key, and
// a preview shows the camera startCamera opened, mirrored for the front camera
// as a mirror would be. Neither does anything on its own.
import { requireNativeComponent, type ViewProps } from "react-native";

export interface VideoSurfaceProps extends ViewProps {
  surfaceKey: string;
  // "cover" crops to fill, "contain" letterboxes.
  resizeMode?: "cover" | "contain";
}

export const AirhopVideoSurface =
  requireNativeComponent<VideoSurfaceProps>("AirhopVideoSurface");

export const AirhopCameraPreview = requireNativeComponent<ViewProps>(
  "AirhopCameraPreview",
);
