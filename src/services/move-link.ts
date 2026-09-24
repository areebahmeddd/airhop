// The transfer socket: a typed face over the move half of AirhopLAN. Bytes in,
// bytes out; every decision lives in move-sender.ts and move-receiver.ts.

import NativeAirhopLAN from "@bridge/NativeAirhopLAN";
import { base64ToBytes, bytesToBase64 } from "@core/encoding/base64";
import { DeviceEventEmitter, type EventSubscription } from "react-native";

export type MoveLinkEvent =
  | { kind: "connected"; connectionID: string }
  | { kind: "data"; connectionID: string; bytes: Uint8Array }
  | { kind: "closed"; connectionID: string };

// `permission` is iOS refusing local network access, the one cause the person
// can fix.
export type MoveDialFailure = "permission" | "unreachable";

export class MoveDialError extends Error {
  constructor(readonly failure: MoveDialFailure) {
    super(failure);
  }
}

export function isMoveLinkAvailable(): boolean {
  return NativeAirhopLAN !== null;
}

export function subscribeMoveLink(
  listener: (event: MoveLinkEvent) => void,
): () => void {
  const subs: EventSubscription[] = [
    DeviceEventEmitter.addListener(
      "AirhopLAN.moveConnected",
      (e: { connectionID: string }) =>
        listener({ kind: "connected", connectionID: e.connectionID }),
    ),
    DeviceEventEmitter.addListener(
      "AirhopLAN.moveData",
      (e: { connectionID: string; dataBase64: string }) => {
        let bytes: Uint8Array;
        try {
          bytes = base64ToBytes(e.dataBase64);
        } catch {
          return;
        }
        listener({ kind: "data", connectionID: e.connectionID, bytes });
      },
    ),
    DeviceEventEmitter.addListener(
      "AirhopLAN.moveClosed",
      (e: { connectionID: string }) =>
        listener({ kind: "closed", connectionID: e.connectionID }),
    ),
  ];
  return () => {
    for (const sub of subs) sub.remove();
  };
}

export async function startMoveListener(): Promise<{
  port: number;
  hosts: string[];
}> {
  if (NativeAirhopLAN === null) throw new Error("move-link-unavailable");
  return NativeAirhopLAN.startMoveListener();
}

export async function stopMoveLink(): Promise<void> {
  await NativeAirhopLAN?.stopMove().catch(() => undefined);
}

export async function dialMove(host: string, port: number): Promise<string> {
  if (NativeAirhopLAN === null) throw new MoveDialError("unreachable");
  try {
    return await NativeAirhopLAN.dialMove(host, port);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new MoveDialError(
      code === "PERMISSION_DENIED" ? "permission" : "unreachable",
    );
  }
}

// Resolves once native has written the frame, so awaiting each call keeps the
// stream in order: Android writes from a thread pool and would otherwise race.
export async function writeMove(
  connectionID: string,
  bytes: Uint8Array,
): Promise<void> {
  if (NativeAirhopLAN === null) throw new Error("move-link-unavailable");
  await NativeAirhopLAN.writeMove(connectionID, bytesToBase64(bytes));
}

export function closeMove(connectionID: string): void {
  void NativeAirhopLAN?.closeMove(connectionID).catch(() => undefined);
}
