// The native contract for the WebSocket every Nostr relay connection rides on
// iOS, Tor or not. React Native's own WebSocket can neither speak SOCKS5 nor
// bound an incoming message, so a hostile relay could exhaust memory with one
// huge frame; this one can do both.
//
// iOS ONLY, backed by ios/Airhop/AirhopRelaySocket.swift and driven by
// services/relay-websocket.ts. A classic RCTEventEmitter rather than a Codegen
// TurboModule, so it is reached through NativeModules and its events through
// NativeEventEmitter, mirroring NativeAirhopTor.
//
// Absent on Android, where the Tor proxy is installed into the shared OkHttp
// client instead and covers every socket without a shim. Absent too in any
// build where the native file was not compiled in. Callers must gate on
// isRelaySocketNativeAvailable().
import type { EventSubscription } from "react-native";
import { NativeEventEmitter, NativeModules } from "react-native";

interface AirhopRelaySocketModule {
  // Open a socket to `url`, through Arti's SOCKS5 proxy when `viaTor`,
  // identified by `id`. Lifecycle arrives asynchronously as RelaySocketEvent;
  // this call returns void.
  connect(id: string, url: string, viaTor: boolean): void;
  send(id: string, data: string): void;
  close(id: string, code: number, reason: string): void;
}

const nativeModule = NativeModules.AirhopRelaySocket as
  AirhopRelaySocketModule | undefined;

export interface RelaySocketEvent {
  // Connection id, assigned on the JS side by RelayWebSocket.
  id: string;
  type: "open" | "message" | "close" | "error";
  // On "message": the frame payload, JSON text or base64 when binary.
  data?: string;
  binary?: boolean;
  // On "close".
  code?: number;
  reason?: string;
  // On "error".
  message?: string;
}

// Whether the native module is compiled in and callable. Callers check this
// before installing the relay WebSocket implementation, so a missing module
// cannot break Nostr: it stays on React Native's socket.
export function isRelaySocketNativeAvailable(): boolean {
  return nativeModule != null && typeof nativeModule.connect === "function";
}

export const AirhopRelaySocketNative = nativeModule;

// Event name to listener arguments, so addListener types the payload.
type RelaySocketEvents = { RelaySocketEvent: [RelaySocketEvent] };

let emitter: NativeEventEmitter<RelaySocketEvents> | null = null;

// Only call when isRelaySocketNativeAvailable() is true; the emitter needs the
// native module.
export function subscribeRelaySocket(
  listener: (event: RelaySocketEvent) => void,
): EventSubscription {
  if (emitter === null) {
    emitter = new NativeEventEmitter<RelaySocketEvents>(
      NativeModules.AirhopRelaySocket as unknown as ConstructorParameters<
        typeof NativeEventEmitter
      >[0],
    );
  }
  return emitter.addListener("RelaySocketEvent", listener);
}
