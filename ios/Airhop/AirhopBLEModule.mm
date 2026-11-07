// Objective-C bridge for AirhopBLEModule.swift. The Swift class is found through
// the generated Airhop-Swift.h header.
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// REMAP, not RCT_EXTERN_MODULE. The plain macro passes an empty JS name, so React
// Native falls back to the Objective-C class name, stripping an "RCT" or "RK"
// prefix but never a "Module" suffix. The spec (src/bridge/NativeAirhopBLE.ts) and
// the Android module both use "AirhopBLE".
@interface RCT_EXTERN_REMAP_MODULE(AirhopBLE, AirhopBLEModule, RCTEventEmitter)

RCT_EXTERN_METHOD(startAdvertising:(NSString *)serviceUUID
                  localName:(NSString *)localName
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopAdvertising:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startScanning:(NSArray<NSString *> *)serviceUUIDs
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopScanning:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// The radio, the authorization, and (for parity with Android) the two location
// facts that gate scanning there.
RCT_EXTERN_METHOD(getRadioState:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(requestEnableBluetooth:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(openLocationSettings:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// Both no-ops on iOS: background BLE comes from UIBackgroundModes, and
// CoreBluetooth has no scan-rate control. Declared so the shared reconciler has
// one code path across both platforms.
RCT_EXTERN_METHOD(setPowerMode:(NSString *)mode
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setBackgroundServiceEnabled:(BOOL)enabled
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// Resolves with the writes on the link not yet handed to the radio, this one
// included. ttlMs > 0 drops a write still queued that long, at the head or
// when a later write is queued; 0 or less never expires.
RCT_EXTERN_METHOD(writeToLink:(NSString *)linkID
                  dataBase64:(NSString *)dataBase64
                  ttlMs:(double)ttlMs
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// Low connection latency for subscribed centrals while live media runs; the
// central role has no equivalent call.
RCT_EXTERN_METHOD(setLiveMediaActive:(BOOL)active
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
