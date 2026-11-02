// Objective-C bridge for AirhopTorSocket.swift. connect, send and close are
// fire-and-forget: results and frames come back asynchronously as
// `TorSocketEvent` emitter events, keyed by connection id.

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(AirhopTorSocket, RCTEventEmitter)

RCT_EXTERN_METHOD(connect:(NSString *)id url:(NSString *)url)

RCT_EXTERN_METHOD(send:(NSString *)id data:(NSString *)data)

RCT_EXTERN_METHOD(close:(NSString *)id
                  code:(nonnull NSNumber *)code
                  reason:(NSString *)reason)

@end
