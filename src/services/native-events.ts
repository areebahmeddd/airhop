// Subscribing to a native module's events so that the module hears about it.
//
// iOS's RCTEventEmitter sends an event only while its listener count is above
// zero, and only the module's own addListener raises that count, which
// NativeEventEmitter calls and DeviceEventEmitter never does. A module heard
// through DeviceEventEmitter alone is silent on iOS, with nothing but a
// "no listeners registered" line in the Xcode console. Android emits without
// the gate, so both platforms take the same path.
//
// Removing a subscription calls removeListeners, so a stopped mesh lets iOS
// stop sending.

import {
  DeviceEventEmitter,
  NativeEventEmitter,
  type EventSubscription,
} from "react-native";

type EmitterModule = ConstructorParameters<typeof NativeEventEmitter>[0];

export interface NativeEvents {
  addListener<T>(
    eventName: string,
    listener: (body: T) => void,
  ): EventSubscription;
}

// A module that is absent, or lacks the listener methods, can raise nothing,
// so DeviceEventEmitter stands in. NativeEventEmitter would throw on iOS for
// the first and warn for the second.
export function nativeEvents(module: object | null | undefined): NativeEvents {
  const methods = module as {
    addListener?: unknown;
    removeListeners?: unknown;
  } | null;
  const counted =
    typeof methods?.addListener === "function" &&
    typeof methods.removeListeners === "function";
  if (!counted) {
    return {
      addListener: (eventName, listener) =>
        DeviceEventEmitter.addListener(
          eventName,
          listener as (...args: unknown[]) => unknown,
        ),
    };
  }
  const emitter = new NativeEventEmitter(module as unknown as EmitterModule);
  return {
    addListener: (eventName, listener) =>
      emitter.addListener(
        eventName,
        listener as unknown as (...args: readonly object[]) => unknown,
      ),
  };
}
