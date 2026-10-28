// Obj-C++ bridge: exposes AirhopVideoModule and its two view managers (Swift)
// to React Native. Same pattern as AirhopVoiceModule.mm, and the same method
// set as AirhopVideoModule.kt on Android, so one spec
// (src/bridge/NativeAirhopVideo.ts) covers both platforms.
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTViewManager.h>

@interface RCT_EXTERN_REMAP_MODULE(AirhopVideo, AirhopVideoModule, RCTEventEmitter)

RCT_EXTERN_METHOD(decodeVideo:(NSString *)surfaceKey
                  dataBase64:(NSString *)dataBase64
                  keyframe:(BOOL)keyframe)

RCT_EXTERN_METHOD(releaseDecoder:(NSString *)surfaceKey)

RCT_EXTERN_METHOD(startRecording:(NSString *)recordingKey
                  path:(NSString *)path
                  width:(double)width
                  height:(double)height
                  hasAudio:(BOOL)hasAudio
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(appendVideo:(NSString *)recordingKey
                  dataBase64:(NSString *)dataBase64
                  ptsMs:(double)ptsMs
                  keyframe:(BOOL)keyframe)

RCT_EXTERN_METHOD(appendAudio:(NSString *)recordingKey
                  dataBase64:(NSString *)dataBase64
                  ptsMs:(double)ptsMs)

RCT_EXTERN_METHOD(finishRecording:(NSString *)recordingKey
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(cancelRecording:(NSString *)recordingKey)

RCT_EXTERN_METHOD(startCamera:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setFacing:(NSString *)facing
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startEncoding:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopEncoding:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setBitrate:(double)bitrate)

RCT_EXTERN_METHOD(requestKeyframe)

RCT_EXTERN_METHOD(stopCamera:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end

@interface RCT_EXTERN_MODULE(AirhopVideoSurfaceManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(surfaceKey, NSString)

@end

@interface RCT_EXTERN_MODULE(AirhopCameraPreviewManager, RCTViewManager)
@end
