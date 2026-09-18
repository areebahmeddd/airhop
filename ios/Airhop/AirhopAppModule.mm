// AirhopAppModule.mm
//
// Objective-C bridge for AirhopAppModule.swift.
//
// REMAP, not RCT_EXTERN_MODULE: the plain macro would register this as
// "AirhopAppModule", the Obj-C class name. The spec (src/bridge/NativeAirhopApp.ts)
// and the Android module both use "AirhopApp".
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_REMAP_MODULE(AirhopApp, AirhopAppModule, NSObject)

RCT_EXTERN_METHOD(restart:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setAutoStartOnBoot:(BOOL)enabled
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(recentLog:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
