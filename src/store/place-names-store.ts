// Human-readable names for geohash cells, e.g. "tdr1k" -> "Kumaraswamy Layout".
//
// A location channel is scoped by a geohash, which is precise but unreadable. We
// reverse-geocode the cell's centre once (best-effort, device-side) and cache
// the result, so the UI can show "~Kumaraswamy Layout" beside the coverage tag,
// matching how bitchat labels its location channels.
//
// Geocoding is best-effort: it needs a network round-trip and a platform
// geocoder, and either can be unavailable. Every failure resolves to no name and
// the UI simply omits it. A successful lookup is cached (a geohash cell maps to
// the same place forever), so we never geocode the same cell twice. Raw
// coordinates never leave the device: only the cell's centre is geocoded, and it
// is derived from the geohash the app already knows. Even that is not asked for
// while the internet is off or Tor is on (see resolve).

import { decodeGeohash } from "@core/nostr/geohash-presence";
import { internetOff, torClaimed } from "@services/network-gate";
import { getLocales } from "expo-localization";
import * as Location from "expo-location";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { getStorage } from "./mmkv";

// Cache keys fold in the language the name was resolved in, so changing the
// phone's language re-resolves a cell and keeps both spellings.
//
// Reverse geocoding is done by the OS in the DEVICE's first language, not the
// app's (iOS CLGeocoder and Android Geocoder both take a locale, but
// `expo-location` exposes neither). So this is the one surface that does not
// follow the in-app picker, and keying on the language is what stops a stale
// spelling outliving the setting that produced it.
export function placeNameKey(geohash: string): string {
  return `${getLocales()[0]?.languageTag ?? "en"}|${geohash}`;
}

interface PlaceNamesState {
  // geohash -> resolved place name.
  names: Record<string, string>;
  // Kick off a best-effort lookup for a cell if we do not already have one.
  resolve: (geohash: string) => void;
  clearAll: () => void;
}

// Cells whose lookup is in flight this session, so concurrent renders of the
// same channel do not each fire a geocode. Not persisted: it is purely a
// de-dupe guard for the current process.
const inFlight = new Set<string>();

// Bumped by clearAll, so a geocode still in flight across a panic wipe drops
// its answer instead of writing a visited place back to disk.
let generation = 0;

// Pick the address component that matches the cell's coverage. A 2-char cell is
// a whole region, a 5-char cell a city, a 7-char cell a block, so the useful
// label differs by length. Mirrors bitchat's per-level naming.
function pickName(
  geohash: string,
  a: Location.LocationGeocodedAddress,
): string | null {
  const n = geohash.length;
  let name: string | null;
  if (n <= 2) name = a.region ?? a.country;
  else if (n <= 4) name = a.region ?? a.subregion ?? a.city;
  else if (n === 5) name = a.city ?? a.subregion ?? a.region;
  else if (n === 6) name = a.district ?? a.city ?? a.subregion;
  else name = a.district ?? a.name ?? a.street ?? a.city;
  const trimmed = name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

const storage = getStorage("place-names-store");

const mmkvStorage = {
  getItem: (name: string): string | null => storage.getString(name) ?? null,
  setItem: (name: string, value: string): void => storage.set(name, value),
  removeItem: (name: string): void => {
    storage.remove(name);
  },
};

export const usePlaceNamesStore = create<PlaceNamesState>()(
  persist(
    (set, get) => ({
      names: {},

      resolve(geohash: string) {
        if (geohash.length === 0) return;
        const key = placeNameKey(geohash);
        if (get().names[key] !== undefined || inFlight.has(key)) return;
        // The geocoder is a system service (Play services, Apple's daemons), so
        // neither the internet switch nor the Tor proxy reaches it: the cell's
        // centre would go out from this device's own address. Nothing is
        // marked in flight, so a later call looks the cell up once allowed.
        if (internetOff() || torClaimed()) return;
        inFlight.add(key);
        const started = generation;
        void (async () => {
          try {
            const { lat, lng } = decodeGeohash(geohash);
            const results = await Location.reverseGeocodeAsync({
              latitude: lat,
              longitude: lng,
            });
            const first = results[0];
            const name = first ? pickName(geohash, first) : null;
            if (name !== null && started === generation) {
              set((state) => ({ names: { ...state.names, [key]: name } }));
            }
          } catch {
            // Geocoder or network unavailable: leave it unresolved so a later
            // session can try again. The UI just omits the name meanwhile.
          } finally {
            if (started === generation) inFlight.delete(key);
          }
        })();
      },

      clearAll() {
        generation++;
        inFlight.clear();
        set({ names: {} });
      },
    }),
    {
      name: "place-names-store",
      storage: createJSONStorage(() => mmkvStorage),
    },
  ),
);
