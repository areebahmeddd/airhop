// Objective-C bridge for AirhopRelaySocket.swift. connect, send and close are
// fire-and-forget: results and frames come back asynchronously as
// `RelaySocketEvent` emitter events, keyed by connection id.

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(AirhopRelaySocket, RCTEventEmitter)

RCT_EXTERN_METHOD(connect:(NSString *)id
                  url:(NSString *)url
                  viaTor:(BOOL)viaTor)

RCT_EXTERN_METHOD(send:(NSString *)id data:(NSString *)data)

RCT_EXTERN_METHOD(close:(NSString *)id
                  code:(nonnull NSNumber *)code
                  reason:(NSString *)reason)

@end
