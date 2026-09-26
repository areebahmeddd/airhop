// Proximity map for the Mesh tab. Peers sit on three rings by signal strength
// (RSSI), or by how recently they were heard when there is none. The compass is
// decorative: BLE gives proximity, never bearing.

import { Feather } from "@expo/vector-icons";
import { t, useT, useTPlural, type TranslationKey } from "@i18n";
import { acknowledged } from "@platform/haptics";
import { useMeshStateStore, type BleBlocker } from "@store/mesh-state-store";
import { REACHABLE_TTL_MS, type NearbyPeer } from "@store/peer-store";
import Avatar from "@ui/components/avatar";
import StatusDot from "@ui/components/status-dot";
import { useReducedMotion } from "@ui/hooks/use-reduced-motion";
import {
  FontSize,
  FontWeight,
  hitSlopFor,
  MaxFontScale,
  Radius,
  Spacing,
  useThemeColors,
} from "@ui/theme";
import { resolveDisplayName } from "@utils/peer-display-name";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import RelayGlyph from "./relay-glyph";

// What the dial says when there are no peers, per reason.
//
// The banner above the radar carries the button that fixes each of these; this
// is the same fact restated where the user is actually looking. It must never
// say "Scanning..." over a radio that is not scanning.
function blockerHeadline(blocker: BleBlocker): string {
  switch (blocker) {
    case "none":
      return t("mesh.radar.scanning");
    case "starting":
      return t("mesh.radar.starting");
    case "unsupported":
      return t("mesh.radar.no_bluetooth");
    case "adapter-off":
      return t("mesh.radar.bluetooth_off");
    case "permission-denied":
      return t("mesh.radar.permission_needed");
    case "permission-blocked":
      return t("mesh.radar.blocked");
    case "location-permission":
      return t("mesh.radar.location_permission");
    case "location-services-off":
      return t("mesh.radar.location_off");
  }
}

function blockerHint(blocker: BleBlocker): string {
  switch (blocker) {
    case "none":
      return t("mesh.radar.hint_rings");
    case "starting":
      return t("mesh.radar.hint_checking");
    case "unsupported":
      return t("mesh.radar.hint_internet");
    case "adapter-off":
      return t("mesh.radar.hint_turn_on");
    case "permission-denied":
      return t("mesh.radar.hint_allow");
    case "permission-blocked":
      return t("mesh.radar.hint_allow_settings");
    case "location-permission":
      return t("mesh.radar.hint_location_permission");
    case "location-services-off":
      return t("mesh.radar.hint_android_location");
  }
}

// ---- Types ----

interface Props {
  peers: NearbyPeer[];
  now: number;
  onSelectPeer: (peer: NearbyPeer) => void;
}

// ---- Constants ----

// Ring assignment is signal-based when RSSI is known, and falls back to
// recency when it isn't (a peer heard via a multi-hop relay has no RSSI of its
// own, since we never had a direct radio link to measure).
//
// The rings are deliberately labelled by signal strength rather than distance.
// RSSI is not a distance: it swings tens of dB with orientation, bodies, walls
// and radio, so "~5m" was fiction. Presenting it as signal is both honest and
// what the number actually is.
const RSSI_STRONG = -60; // dBm, roughly same-room
const RSSI_MEDIUM = -80; // dBm, beyond that it's the edge of usable range

// Recency fallback thresholds, used only when RSSI is unavailable.
const RING_THRESHOLDS: [number, number] = [15_000, 45_000]; // ms

// Radii as fraction of half the canvas size (C).
const RING_FR: [number, number, number] = [0.3, 0.54, 0.78];
// Keys, not text: evaluated once at import, so translated strings here would
// freeze in whichever language the app started in.
const RING_LABEL_KEYS: [TranslationKey, TranslationKey, TranslationKey] = [
  "mesh.radar.signal_strong",
  "mesh.radar.signal_medium",
  "mesh.radar.signal_weak",
];

// Cardinal letters as data rather than four near-identical JSX blocks with four
// different hand-tuned offset pairs. Each offset is relative to the canvas
// centre and expressed against the outer ring radius, so the set stays put if
// the ring fractions above are ever retuned.
const COMPASS: {
  label: string;
  top: (r: number) => number;
  left: (r: number) => number;
}[] = [
  { label: "N", top: (r) => -r - 20, left: () => -5 },
  { label: "S", top: (r) => r + 7, left: () => -5 },
  { label: "W", top: () => -8, left: (r) => -r - 16 },
  { label: "E", top: () => -8, left: (r) => r + 6 },
];

const AVATAR_SIZE = 34;
const SELF_SIZE = 42;

// Smallest dial worth drawing. The canvas is sized to the shorter axis of the
// space it is given, which in landscape or a split view can fall to almost
// nothing and leave a blank Mesh tab.
const MIN_CANVAS = 180;

// And a ceiling. Android 16 stopped honouring an orientation lock above 600dp
// and Android 17 removed the opt-out, so a foldable's inner screen hands this
// view ~850dp and an uncapped dial pushes the caption behind the tab bar. A
// phone gives ~390dp, so the cap is inert there.
const MAX_CANVAS = 420;

// ---- Component ----

// Memoised: every render re-buckets every peer and re-lays out every dot, and
// peer-list passes a memoised `peers` and a `now` that ticks once a second, so
// nothing else on the screen should trigger that.
function RadarView({ peers, now, onSelectPeer }: Props): React.JSX.Element {
  const T = useT();
  const TP = useTPlural();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  const [canvasSize, setCanvasSize] = useState(0);
  // "Away" stops the radios, so an empty radar then means paused, not scanning.
  // "Invisible" still scans (it only stops advertising), so it reads as normal.
  const away = useMeshStateStore((s) => s.presenceStatus === "away");
  // One value, so the dial and its caption can never disagree about whether a
  // scan is running.
  const blocker = useMeshStateStore((s) => s.bleBlocker);
  // An endlessly expanding ring is the textbook vestibular trigger, and it
  // carries nothing the status line below the dial does not already say in
  // words. So under "reduce motion" the sweep does not run at all (WCAG 2.3.3)
  // and the centre tap answers with a haptic instead of a wave.
  const reducedMotion = useReducedMotion();
  // The sonar means "a scan is running". It sweeps when one is, and stops when
  // one is not, whichever of the three reasons applies. Anything else is the
  // screen claiming to look for peers while the radio sits idle.
  const scanning = !away && blocker === "none";

  const [ring1] = useState(() => new Animated.Value(0));
  const [ring2] = useState(() => new Animated.Value(0));
  const [ring3] = useState(() => new Animated.Value(0));
  // A one-shot wave fired when the user taps the center.
  const [manualWave] = useState(() => new Animated.Value(0));
  // Center dot press feedback: a small dip, no overshoot.
  const [selfScale] = useState(() => new Animated.Value(1));
  // Handles for the tap animations, so a fast second tap cancels the first
  // rather than leaving two timings fighting over the same Animated.Value.
  const waveAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  const dotAnimRef = useRef<Animated.CompositeAnimation | null>(null);

  const C = canvasSize / 2;

  // Tap the center device for a single sonar wave. Deliberately cosmetic: BLE
  // scanning runs continuously once started and peers arrive on announce
  // events, so a manual rescan would find nothing a moment's wait would not.
  function handleCenterPress(): void {
    if (reducedMotion) {
      // The wave is the whole feedback for this tap, so with motion off the
      // touch still has to land somewhere. A selection tick is the quietest
      // acknowledgement the OS offers, which suits an action that is
      // deliberately cosmetic anyway.
      acknowledged();
      return;
    }
    waveAnimRef.current?.stop();
    manualWave.setValue(0);
    waveAnimRef.current = Animated.timing(manualWave, {
      toValue: 1,
      duration: 1100,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    waveAnimRef.current.start();

    dotAnimRef.current?.stop();
    dotAnimRef.current = Animated.sequence([
      Animated.timing(selfScale, {
        toValue: 0.92,
        duration: 110,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(selfScale, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]);
    dotAnimRef.current.start();
  }

  // Staggered sonar pulse: three expanding rings at the outer boundary.
  // When nothing is scanning, nothing sweeps. The rings are collapsed to zero
  // rather than left frozen mid-bloom: a stalled half-drawn ring reads as the
  // app having hung, an empty dial reads as switched off, which is the truth.
  // The line under the radar says which of the three reasons it is, and the
  // centre tap keeps its own one-shot wave so the screen still answers a touch.
  useEffect(() => {
    if (!scanning || reducedMotion) {
      ring1.setValue(0);
      ring2.setValue(0);
      ring3.setValue(0);
      return;
    }
    function pulse(
      val: Animated.Value,
      delay: number,
    ): Animated.CompositeAnimation {
      val.setValue(0);
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(val, {
            toValue: 1,
            duration: 2800,
            useNativeDriver: true,
          }),
          Animated.timing(val, {
            toValue: 0,
            duration: 0,
            useNativeDriver: true,
          }),
        ]),
      );
    }
    const anim = Animated.parallel([
      pulse(ring1, 0),
      pulse(ring2, 900),
      pulse(ring3, 1800),
    ]);
    anim.start();
    return () => anim.stop();
  }, [ring1, ring2, ring3, scanning, reducedMotion]);

  // Unmounting mid-tap must not leave an animation callback holding a handle to
  // this component.
  useEffect(() => {
    return () => {
      waveAnimRef.current?.stop();
      dotAnimRef.current?.stop();
    };
  }, []);

  // Bucket peers into rings by signal strength, falling back to recency.
  const byRing: [NearbyPeer[], NearbyPeer[], NearbyPeer[]] = [[], [], []];
  for (const peer of peers) {
    if (peer.rssi !== undefined) {
      if (peer.rssi >= RSSI_STRONG) byRing[0].push(peer);
      else if (peer.rssi >= RSSI_MEDIUM) byRing[1].push(peer);
      else byRing[2].push(peer);
    } else {
      const age = now - peer.lastSeenMs;
      if (age < RING_THRESHOLDS[0]) byRing[0].push(peer);
      else if (age < RING_THRESHOLDS[1]) byRing[1].push(peer);
      else byRing[2].push(peer);
    }
  }

  // Stable angle derived from the peer ID.
  //
  // Not `indexInRing / countInRing`, which makes a peer's position a function of
  // how many OTHER peers share its ring: anyone joining or leaving would send
  // every dot to a new angle. Hashing the ID keeps each peer parked in one spot
  // for as long as it's visible.
  function peerAngle(peerID: string): number {
    let hash = 0;
    for (let i = 0; i < peerID.length; i++) {
      hash = (hash * 31 + peerID.charCodeAt(i)) >>> 0;
    }
    return ((hash % 360) / 360) * 2 * Math.PI - Math.PI / 2;
  }

  function peerPos(
    ringIndex: 0 | 1 | 2,
    peerID: string,
  ): { top: number; left: number } {
    const r = C * RING_FR[ringIndex];
    const angle = peerAngle(peerID);
    return {
      top: C + Math.sin(angle) * r - AVATAR_SIZE / 2,
      left: C + Math.cos(angle) * r - AVATAR_SIZE / 2,
    };
  }

  // Outer ring absolute radius in px (for the waves and compass placement).
  const outerR = C * RING_FR[2];

  // Every wave is a circle the size of the outer ring, scaled up from the
  // centre as it fades. The tap wave peaks a little brighter than the ambient
  // ones so a touch reads over the sweep.
  const waveBox = {
    width: outerR * 2,
    height: outerR * 2,
    borderRadius: outerR,
    top: C - outerR,
    left: C - outerR,
  };
  const waveStyle = (val: Animated.Value, peak: number, from: number) => ({
    opacity: val.interpolate({
      inputRange: [0, 0.15, 1],
      outputRange: [0, peak, 0],
    }),
    transform: [
      {
        scale: val.interpolate({ inputRange: [0, 1], outputRange: [from, 1] }),
      },
    ],
  });

  return (
    <View
      style={styles.container}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setCanvasSize(
          Math.max(MIN_CANVAS, Math.min(width - 24, height - 60, MAX_CANVAS)),
        );
      }}
    >
      {canvasSize > 0 && (
        <>
          {/* ---- Radar canvas -------------------------------------------
              The rings, the compass and the sweep are one picture of "who is
              around me", and none of it means anything read out piece by piece:
              a screen reader was stepping through four unlabelled compass
              letters and three ring names before reaching a peer. The canvas is
              therefore hidden as a whole and the individual peers and the centre
              button opt back in below, which leaves a screen reader with
              exactly the actionable elements plus the status line. */}
          {/* `direction: "ltr"` is load-bearing, not decoration.
              Everything inside this canvas is placed by absolute `left` against
              a coordinate system this file computes itself: the compass letters,
              the guide rings, and every peer, whose x is `C + cos(angle) * r`.
              Under an app-wide right-to-left direction Yoga resolves those
              against the inherited direction and mirrors the whole dial, which
              put East on the left and moved every peer to the opposite side of
              the screen from where they physically are.

              The radar is a polar plot of physical space, so it must never
              mirror. Pinning the direction here says that once, in the one place
              the geometry is decided, rather than asking every `left` inside to
              remember. */}
          <View
            style={{ width: canvasSize, height: canvasSize, direction: "ltr" }}
          >
            {[ring1, ring2, ring3].map((val, i) => (
              <Animated.View
                key={i}
                pointerEvents="none"
                style={[styles.wave, waveBox, waveStyle(val, 0.28, 0.05)]}
              />
            ))}
            <Animated.View
              pointerEvents="none"
              style={[styles.wave, waveBox, waveStyle(manualWave, 0.34, 0.06)]}
            />

            {/* Static distance guide rings with labels, and the cardinal
                letters. Both are chart furniture: the rings are named in the
                hint line under the dial and the compass is decorative (BLE
                gives proximity, never bearing), so neither is worth a screen
                reader stop. Capped font scaling because they are absolutely
                positioned against the ring geometry and cannot reflow. */}
            <View
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
              importantForAccessibility="no-hide-descendants"
              accessibilityElementsHidden
            >
              {RING_FR.map((fr, i) => {
                const r = C * fr;
                const d = r * 2;
                return (
                  <React.Fragment key={i}>
                    <View
                      style={[
                        styles.guideRing,
                        {
                          width: d,
                          height: d,
                          borderRadius: r,
                          top: C - r,
                          left: C - r,
                        },
                      ]}
                    />
                    <Text
                      style={[
                        styles.ringLabel,
                        { top: C - r + 5, left: C + r * 0.48 },
                      ]}
                      maxFontSizeMultiplier={MaxFontScale.badge}
                    >
                      {T(RING_LABEL_KEYS[i])}
                    </Text>
                  </React.Fragment>
                );
              })}

              {COMPASS.map(({ label, top, left }) => (
                <Text
                  key={label}
                  style={[
                    styles.compassDir,
                    { top: C + top(outerR), left: C + left(outerR) },
                  ]}
                  maxFontSizeMultiplier={MaxFontScale.badge}
                >
                  {label}
                </Text>
              ))}
            </View>

            {/* Center dot: this device. A tap sends one sonar wave. */}
            <Pressable
              style={[
                styles.selfButton,
                { top: C - SELF_SIZE / 2, left: C - SELF_SIZE / 2 },
              ]}
              onPress={handleCenterPress}
              accessibilityRole="button"
              accessibilityLabel={T("mesh.radar.you_center")}
              // The hint must not promise a rescan: scanning is continuous (see
              // handleCenterPress).
              accessibilityHint={T("mesh.radar.sonar_hint")}
              hitSlop={hitSlopFor(SELF_SIZE)}
            >
              <Animated.View
                style={[styles.selfDot, { transform: [{ scale: selfScale }] }]}
              >
                <Feather name="radio" size={14} color={Colors.textInverse} />
              </Animated.View>
            </Pressable>

            {/* Peer nodes placed on their signal-strength ring */}
            {(byRing as NearbyPeer[][]).map((group, ri) =>
              group.map((peer) => {
                const pos = peerPos(ri as 0 | 1 | 2, peer.peerID);
                return (
                  <PeerNode
                    key={peer.peerID}
                    peer={peer}
                    top={pos.top}
                    left={pos.left}
                    now={now}
                    onPress={() => onSelectPeer(peer)}
                  />
                );
              }),
            )}
          </View>

          {/* ---- Status --------------------------------------------------
              One live region around both lines, so switching Bluetooth off or
              being denied the permission is announced when it happens rather
              than only if the user happens to swipe back down here, and the
              two lines read as one stop. */}
          <View style={styles.status} accessibilityLiveRegion="polite">
            <Text style={styles.statusText}>
              {peers.length > 0
                ? TP("mesh.peers_in_range", peers.length)
                : away
                  ? T("mesh.radar.paused")
                  : blockerHeadline(blocker)}
            </Text>
            <Text style={styles.hintText}>
              {/* Signal strength, NOT distance. RSSI varies by tens of dB with
                orientation, obstacles and radio, so any metre figure derived
                from it would be invented. Ring = signal, and the label says so. */}
              {peers.length > 0
                ? T("mesh.radar.ring_hint")
                : away
                  ? T("mesh.radar.set_online")
                  : blockerHint(blocker)}
            </Text>
          </View>
        </>
      )}
    </View>
  );
}

// ---- Peer node ----

interface PeerNodeProps {
  peer: NearbyPeer;
  top: number;
  left: number;
  now: number;
  onPress: () => void;
}

// Presence comes from peer-store's REACHABLE_TTL_MS, so the same peer cannot
// read "online" here and "offline" in the peer list.
function PeerNode({
  peer,
  top,
  left,
  now,
  onPress,
}: PeerNodeProps): React.JSX.Element {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  const username = resolveDisplayName(peer.peerID);
  const isOnline = now - peer.lastSeenMs < REACHABLE_TTL_MS;
  return (
    <Pressable
      style={[styles.peerNode, { top, left }]}
      onPress={onPress}
      // The node draws at 34pt so a dial full of peers stays readable; the slop
      // brings the target to the 44pt floor without moving anything.
      hitSlop={hitSlopFor(AVATAR_SIZE)}
      accessibilityRole="button"
      // The glyph is what tells a sighted user this is equipment, so the label
      // has to say it too or the dial reads as one more person.
      accessibilityLabel={T(
        peer.isInfrastructure === true
          ? isOnline
            ? "mesh.radar.relay_in_range"
            : "mesh.radar.relay_recent"
          : isOnline
            ? "mesh.radar.peer_in_range"
            : "mesh.radar.peer_recent",
        { name: username },
      )}
      accessibilityHint={T("mesh.radar.peer_hint")}
    >
      {peer.isInfrastructure === true ? (
        <RelayGlyph size={AVATAR_SIZE} />
      ) : (
        <Avatar username={username} peerID={peer.peerID} size={AVATAR_SIZE} />
      )}
      <View style={styles.statusBadge}>
        <StatusDot status={isOnline ? "online" : "offline"} size={7} />
      </View>
      <Text
        style={styles.peerLabel}
        numberOfLines={1}
        maxFontSizeMultiplier={MaxFontScale.badge}
      >
        {username.split("-")[0]}
      </Text>
    </Pressable>
  );
}

export default React.memo(RadarView);

// ---- Styles ----

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    container: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: Colors.bg,
      gap: Spacing.sm,
      paddingBottom: Spacing.xl,
    },
    wave: {
      position: "absolute",
      borderWidth: 1.5,
      borderColor: Colors.accent,
    },
    guideRing: {
      position: "absolute",
      borderWidth: 1,
      borderColor: Colors.borderStrong,
    },
    ringLabel: {
      position: "absolute",
      fontSize: FontSize["2xs"],
      color: Colors.textMuted,
      letterSpacing: 0.2,
    },
    compassDir: {
      position: "absolute",
      fontSize: FontSize["2xs"],
      fontWeight: FontWeight.semibold,
      color: Colors.textMuted,
      letterSpacing: 0.5,
    },
    selfButton: {
      position: "absolute",
      width: SELF_SIZE,
      height: SELF_SIZE,
    },
    selfDot: {
      width: SELF_SIZE,
      height: SELF_SIZE,
      borderRadius: Radius.full,
      backgroundColor: Colors.accent,
      alignItems: "center",
      justifyContent: "center",
      elevation: 3,
      shadowColor: Colors.accent,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.3,
      shadowRadius: 6,
    },
    peerNode: {
      position: "absolute",
      width: AVATAR_SIZE,
      alignItems: "center",
      gap: Spacing["2xs"],
    },
    statusBadge: {
      position: "absolute",
      top: AVATAR_SIZE - 9,
      left: AVATAR_SIZE - 9,
      backgroundColor: Colors.bg,
      borderRadius: Radius.full,
      padding: 1,
    },
    // Physical marginLeft on purpose: the radar maps real positions and never
    // mirrors. The label is 16pt wider than its avatar, pulled back by half to
    // centre over it.
    peerLabel: {
      fontSize: FontSize["2xs"],
      color: Colors.textMuted,
      textAlign: "center",
      width: AVATAR_SIZE + 16,
      marginLeft: -8,
    },
    status: {
      alignSelf: "stretch",
      gap: Spacing.xs,
      paddingHorizontal: Spacing.base,
    },
    statusText: {
      fontSize: FontSize.sm,
      color: Colors.textSecondary,
      textAlign: "center",
      letterSpacing: 0.1,
    },
    hintText: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
      textAlign: "center",
      letterSpacing: 0.1,
    },
  });
}
