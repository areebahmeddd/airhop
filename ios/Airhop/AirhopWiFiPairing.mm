// Objective-C bridge for AirhopWiFiPairing.swift. iOS only, for the reason given
// there.
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(AirhopWiFiPairing, RCTEventEmitter)

RCT_EXTERN_METHOD(getPairingState:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(presentPairing:(NSString *)mode
                  labels:(NSDictionary *)labels
                  colors:(NSDictionary *)colors
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
