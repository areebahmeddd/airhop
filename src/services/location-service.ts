// Location for geohash channels and for location pins.
//
// Channels use it to decide which geohash cell the user is in and to pick
// Nostr relays near them; only the truncated geohash is ever published. The
// one time coordinates leave the device is a pin the user confirms, sealed to
// one person.
//
// Deliberately COARSE accuracy, never Highest: a geohash cell is 150 m across
// at its finest here, so GPS-grade precision would buy nothing and cost
// battery and privacy.
//
// Every failure path returns null rather than throwing. Location is optional:
// the app must stay fully usable over BLE with location denied, so a refusal
// degrades geohash channels rather than breaking the app.

import { MAX_USEFUL_ACCURACY_M } from "@core/mesh/wire/location-pin";
import * as Location from "expo-location";

export interface Coords {
  lat: number;
  lng: number;
}

// Re-check position at most this often. Geohash cells are large, so polling
// harder would just drain battery for no behavioural change.
const REFRESH_MS = 5 * 60 * 1000;

let cached: { coords: Coords; atMs: number } | null = null;

// Ask for foreground location. Safe to call repeatedly: the OS only shows the
// prompt once. Returns false if the user declined.
export async function requestLocationPermission(): Promise<boolean> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    return status === Location.PermissionStatus.GRANTED;
  } catch {
    return false;
  }
}

export async function hasLocationPermission(): Promise<boolean> {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    return status === Location.PermissionStatus.GRANTED;
  } catch {
    return false;
  }
}

// The same reading, keeping the distinction a boolean throws away: whether the
// OS will still show its prompt.
//
// The Permissions screen needs this and had no way to get it, so a permanently
// denied location rendered as an ordinary "Allow" whose tap is a silent no-op -
// the one state where the only useful action is a trip to Settings. Everything
// that just wants a yes/no keeps using hasLocationPermission.
export async function locationPermissionState(): Promise<{
  granted: boolean;
  canAskAgain: boolean;
}> {
  try {
    const { status, canAskAgain } =
      await Location.getForegroundPermissionsAsync();
    return {
      granted: status === Location.PermissionStatus.GRANTED,
      canAskAgain,
    };
  } catch {
    // Unreadable. "Can ask again" is the recoverable guess: it offers the
    // prompt, which is harmless if it turns out to be a no-op, where guessing
    // blocked would send someone to Settings for a permission they could have
    // granted in place.
    return { granted: false, canAskAgain: true };
  }
}

// Current coarse position, or null if unavailable/denied.
// Served from a short cache so several callers on one screen don't each
// trigger a separate fix.
export async function getCoarseLocation(
  forceRefresh = false,
): Promise<Coords | null> {
  if (
    !forceRefresh &&
    cached !== null &&
    Date.now() - cached.atMs < REFRESH_MS
  ) {
    return cached.coords;
  }

  if (!(await hasLocationPermission())) return null;

  try {
    const position = await Location.getLastKnownPositionAsync();
    // A last-known fix is instant and plenty accurate for a geohash cell;
    // only pay for a live fix when there's nothing cached on the device.
    const resolved =
      position ??
      (await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      }));
    if (!resolved) return null;

    const coords: Coords = {
      lat: resolved.coords.latitude,
      lng: resolved.coords.longitude,
    };
    cached = { coords, atMs: Date.now() };
    return coords;
  } catch {
    // Location services off at the OS level, or no fix available.
    return null;
  }
}

// A pin says where someone is now, so an old fix is not good enough.
const PIN_MAX_AGE_MS = 60_000;
// A fix that never comes is a sheet that spins forever.
const PIN_FIX_TIMEOUT_MS = 15_000;

export interface PinFix extends Coords {
  // Horizontal accuracy in metres, when the OS gives one.
  accuracyM?: number;
  // When the fix was taken, which is what the pin reports, not when it is sent.
  takenAtMs: number;
}

// Whether a fix is precise enough to pin. An unknown accuracy passes: the card
// says so, where a coarse one would draw an arrow at the wrong place.
function pinnable(position: Location.LocationObject | null): boolean {
  const accuracy = position?.coords.accuracy;
  return (
    position !== null &&
    (accuracy === null ||
      accuracy === undefined ||
      accuracy <= MAX_USEFUL_ACCURACY_M)
  );
}

// A recent fix for a location pin, or null if denied, off, too slow, or too
// coarse to point at anything.
export async function getPinLocation(): Promise<PinFix | null> {
  if (!(await hasLocationPermission())) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const lastKnown = await Location.getLastKnownPositionAsync({
      maxAge: PIN_MAX_AGE_MS,
    });
    // A coarse cached fix (a cell tower's) is worth one live attempt.
    const position = pinnable(lastKnown)
      ? lastKnown
      : await Promise.race([
          Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          }),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), PIN_FIX_TIMEOUT_MS);
          }),
        ]);
    if (position === null || !pinnable(position)) return null;
    return {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracyM: position.coords.accuracy ?? undefined,
      takenAtMs: position.timestamp,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Drop the cached fix. Called on panic wipe so a stale position can't outlive
// the identity that observed it.
export function clearLocationCache(): void {
  cached = null;
}
