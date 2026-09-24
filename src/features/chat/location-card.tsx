// A place, rendered inside a message bubble.
//
// No map, by design. Tiles are an HTTP call to somebody's server: a
// fingerprint, a dependency, and a grey square in exactly the conditions this
// app exists for. What a person in a crowd needs is a direction and a distance,
// which is what this draws.
//
// The arrow points against true north marked on the card, not against how the
// phone is held: a compass heading would need a subscription and would swing
// while it is read. "Open in Maps" is a handoff the user chooses. Our own pin
// has no arrow: the distance to where we just were says nothing.

import { Feather } from "@expo/vector-icons";
import { t, useT } from "@i18n";
import {
  getCoarseLocation,
  hasLocationPermission,
} from "@services/location-service";
import type { ChatMessage } from "@store/chat-store";
import {
  FontFamily,
  FontSize,
  FontWeight,
  Radius,
  Spacing,
  useThemeColors,
} from "@ui/theme";
import { formatAgo, formatNumber } from "@utils/format";
import {
  bearingDegrees,
  compassPoint,
  distanceMeters,
  roundedDistance,
  type Point,
} from "@utils/geo";
import React, { useEffect, useMemo, useState } from "react";
import {
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

type Pin = NonNullable<ChatMessage["locationPin"]>;

// SI symbols read the same in every language; the number follows the locale.
function formatMeters(meters: number): string {
  const { value, unit } = roundedDistance(meters);
  return `${formatNumber(value)} ${unit}`;
}

// Keyed the way `compassPoint` names them, so this is a lookup rather than a
// switch that can fall out of step with the eight points.
const DIRECTION_KEYS = {
  n: "chat.location.direction.n",
  ne: "chat.location.direction.ne",
  e: "chat.location.direction.e",
  se: "chat.location.direction.se",
  s: "chat.location.direction.s",
  sw: "chat.location.direction.sw",
  w: "chat.location.direction.w",
  nw: "chat.location.direction.nw",
} as const;

export default function LocationCard({
  pin,
  isMine,
}: {
  pin: Pin;
  isMine: boolean;
}): React.JSX.Element {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  // Where the reader is, for the arrow. Null until it resolves, and null for
  // good without a location grant.
  const [here, setHere] = useState<Point | null>(null);

  // Read once per card, and only against an existing grant. Never prompts:
  // somebody else's pin is theirs to read, not a reason to raise a permission
  // dialog, and the card says what is missing instead. `getCoarseLocation`
  // caches for five minutes, so several cards in a thread cost one fix.
  useEffect(() => {
    if (isMine) return;
    let alive = true;
    void (async () => {
      if (!(await hasLocationPermission())) return;
      const coords = await getCoarseLocation();
      if (alive && coords !== null) setHere(coords);
    })();
    return () => {
      alive = false;
    };
  }, [isMine]);

  const relative = useMemo(() => {
    if (here === null) return null;
    const target: Point = { lat: pin.lat, lng: pin.lng };
    const bearing = bearingDegrees(here, target);
    return {
      bearing,
      direction: compassPoint(bearing),
      distance: formatMeters(distanceMeters(here, target)),
    };
  }, [here, pin.lat, pin.lng]);

  // A geo: URI opens whichever maps app the user has chosen on Android. iOS
  // registers no handler for it, so Apple Maps is named there.
  function openInMaps(): void {
    const point = `${String(pin.lat)},${String(pin.lng)}`;
    const url =
      Platform.OS === "ios"
        ? `https://maps.apple.com/?ll=${point}&q=${point}`
        : `geo:${point}?q=${point}`;
    Linking.openURL(url).catch(() => {});
  }
  const fg = isMine ? Colors.myBubbleText : Colors.accent;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        {/* A ring with a north mark and an arrow rotated to the bearing, so
            the drawing carries the same fact the words do. */}
        <View style={styles.dial}>
          <Text style={styles.northMark}>N</Text>
          <View
            style={[
              styles.arrow,
              relative !== null
                ? { transform: [{ rotate: `${relative.bearing}deg` }] }
                : null,
            ]}
          >
            <Feather
              name={relative !== null ? "arrow-up" : "map-pin"}
              size={18}
              color={fg}
            />
          </View>
        </View>

        <View style={styles.text}>
          <Text style={styles.title}>{T("chat.location.title")}</Text>
          {isMine ? null : relative !== null ? (
            <Text style={styles.distance}>
              {t("chat.location.away", {
                distance: relative.distance,
                direction: t(DIRECTION_KEYS[relative.direction]),
              })}
            </Text>
          ) : (
            // No fix of our own, so nothing to measure from. Said plainly
            // rather than drawn as an arrow pointing nowhere.
            <Text style={styles.muted}>{T("chat.location.no_fix")}</Text>
          )}
          {/* The age of the fix, not of the message, and its accuracy when
              the OS gave one: a stale or approximate point is the one way
              this card can mislead. */}
          <Text style={styles.muted}>
            {pin.accuracyM === undefined
              ? formatAgo(pin.takenAtMs)
              : `${formatAgo(pin.takenAtMs)} · ${t("chat.location.accuracy", {
                  distance: formatMeters(pin.accuracyM),
                })}`}
          </Text>
        </View>
      </View>

      {/* Both sides: checking what you sent is as reasonable as opening what
          you were sent. */}
      <Pressable
        style={styles.action}
        onPress={openInMaps}
        accessibilityRole="button"
        accessibilityLabel={T("chat.location.open_maps")}
      >
        <Feather name="external-link" size={13} color={fg} />
        <Text style={[styles.actionText, isMine ? styles.actionMine : null]}>
          {T("chat.location.open_maps")}
        </Text>
      </Pressable>
    </View>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    card: {
      minWidth: 200,
      gap: Spacing.sm,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
    },
    dial: {
      width: 44,
      height: 44,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: Colors.border,
      alignItems: "center",
      justifyContent: "center",
    },
    northMark: {
      position: "absolute",
      top: 2,
      fontFamily: FontFamily.mono,
      fontSize: 8,
      color: Colors.textMuted,
    },
    arrow: {
      alignItems: "center",
      justifyContent: "center",
    },
    text: {
      flex: 1,
      gap: 1,
    },
    title: {
      fontSize: FontSize.xs,
      fontWeight: FontWeight.medium,
      color: Colors.textMuted,
      textTransform: "uppercase",
      letterSpacing: 0.6,
    },
    distance: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.medium,
      color: Colors.textPrimary,
    },
    muted: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
    },
    action: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      paddingTop: Spacing.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: Colors.border,
    },
    actionText: {
      fontSize: FontSize.sm,
      color: Colors.accent,
    },
    actionMine: {
      color: Colors.myBubbleText,
    },
  });
}
