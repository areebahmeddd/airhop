// Teleport to a geohash: open a public location channel for a cell you are not
// physically in. The user picks the cell on the globe or types its geohash, we
// normalise and validate it exactly as bitchat does, then hand it to
// mesh-service, which joins the cell as a `geohash:<gh>` channel and brings up
// its Nostr subscription. The channel then appears under Your Rooms and
// interoperates with bitchat clients in the same cell.
//
// Every way in (the globe, the field, a nearby cell, a saved place) ends in
// openGeohash, so one rule decides between the user's own named channel and a
// teleport.

import { t, useT, type TranslationKey } from "@i18n";
import { chevronForward } from "@i18n/layout";
import { Feather } from "@react-native-vector-icons/feather/static";
import {
  GEO_CHANNEL_PRECISION,
  geohashLevelName,
  isValidGeohash,
  normalizeGeohash,
} from "@services/geohash-channel-service";
import { getMeshService } from "@services/mesh-service";
import { useGeohashBookmarksStore } from "@store/geohash-bookmarks-store";
import { placeNameKey, usePlaceNamesStore } from "@store/place-names-store";
import BottomSheet from "@ui/components/bottom-sheet";
import UpperText from "@ui/components/upper-text";
import {
  BUTTON_HEIGHT,
  FontFamily,
  FontSize,
  FontWeight,
  HIT_SLOP,
  hitSlopFor,
  LineHeight,
  Radius,
  Spacing,
  useThemeColors,
} from "@ui/theme";
import {
  geohashNeighbours,
  type NeighbourDirection,
} from "@utils/geohash-grid";
import { useEffect, useMemo, useState } from "react";
import {
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { GeohashPicker, globeAvailable } from "./geohash-picker";

// How long typing has to stop before the cell's name is looked up. Long enough
// that a six-character geohash costs one lookup rather than six.
const NAME_LOOKUP_DEBOUNCE_MS = 500;

const REMOVE_ICON_SIZE = 15;

// Keyed the way `geohashNeighbours` names the eight cells. The chip shows the
// short point; the label is a whole sentence per direction, since the
// direction word takes a different case or preposition in most languages.
const DIRECTION_KEYS: Record<
  NeighbourDirection,
  { short: TranslationKey; open: TranslationKey }
> = {
  N: { short: "chat.jump.dir.n", open: "chat.jump.open_n" },
  NE: { short: "chat.jump.dir.ne", open: "chat.jump.open_ne" },
  E: { short: "chat.jump.dir.e", open: "chat.jump.open_e" },
  SE: { short: "chat.jump.dir.se", open: "chat.jump.open_se" },
  S: { short: "chat.jump.dir.s", open: "chat.jump.open_s" },
  SW: { short: "chat.jump.dir.sw", open: "chat.jump.open_sw" },
  W: { short: "chat.jump.dir.w", open: "chat.jump.open_w" },
  NW: { short: "chat.jump.dir.nw", open: "chat.jump.open_nw" },
};

interface Props {
  visible: boolean;
  // Dismiss entirely: backdrop tap or system back.
  onClose: () => void;
  // Step back to whatever opened this sheet, for the Back button.
  onBack: () => void;
  onJoined: (channel: string) => void;
}

export function GeohashJumpSheet({
  visible,
  onClose,
  onBack,
  onJoined,
}: Props) {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);

  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  // The globe opens over this sheet, as bitchat's does, so closing it comes
  // back to the sheet as it was left, typing and all.
  const [picking, setPicking] = useState(false);
  // Go closes the globe at once instead of sliding it away. The sheet closes
  // right behind it, and iOS ignores closing a sheet whose globe is still
  // mid-slide, which would leave an invisible window over the app.
  const [globeSlides, setGlobeSlides] = useState(true);
  // A phone without Vulkan or Metal is offered the field alone. Read while
  // open only: the sheet is mounted from launch, and Skia probes the GPU on
  // its first read.
  const canPick = visible && globeAvailable();

  // The cell this phone is standing in, at neighbourhood precision. Null with
  // no location grant, which is why every part of this sheet that uses it is
  // conditional rather than assumed.
  const homeCell = visible
    ? (getMeshService()?.getChannelGeohash("#neighborhood") ?? null)
    : null;

  // The eight cells touching yours, one tap each: people most often want the
  // next street or the next town over. The globe and the field cover anywhere
  // further.
  const neighbours = useMemo(
    () => (homeCell ? geohashNeighbours(homeCell) : []),
    [homeCell],
  );

  const bookmarks = useGeohashBookmarksStore((s) => s.bookmarks);
  const placeNames = usePlaceNamesStore((s) => s.names);
  // Resolve names for saved places so the list reads "~Kumaraswamy Layout"
  // rather than a bare geohash. Best-effort and cached in the store.
  useEffect(() => {
    if (!visible) return;
    for (const gh of bookmarks) usePlaceNamesStore.getState().resolve(gh);
  }, [visible, bookmarks]);

  // And for the cells around you, which is what makes Nearby readable: "N ·
  // Jayanagar" is a place, "N · #tdr1kz" is a string. Eight lookups on open,
  // once ever, since the store caches a cell's name forever.
  useEffect(() => {
    if (!visible) return;
    for (const n of neighbours)
      usePlaceNamesStore.getState().resolve(n.geohash);
  }, [visible, neighbours]);

  // The typed cell, once it is long enough to mean somewhere. Debounced:
  // resolving on every keystroke would geocode "r", "rd", "rdr" and so on,
  // which is five wasted round trips and five prefixes of your destination
  // handed to the platform geocoder for no reason.
  useEffect(() => {
    if (!visible || !isValidGeohash(input)) return;
    const timer = setTimeout(() => {
      usePlaceNamesStore.getState().resolve(input);
    }, NAME_LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [visible, input]);

  const valid = isValidGeohash(input);
  const level = valid ? geohashLevelName(input) : null;
  // Undefined until the lookup lands, or forever if it cannot: the hint reads
  // fine either way.
  const typedName = valid ? placeNames[placeNameKey(input)] : undefined;
  // If the entered cell is one the user is already standing in, "Go" opens that
  // existing channel rather than a duplicate teleported room. Read live from the
  // mesh service; it only changes when the user physically moves.
  const localChannel = valid
    ? (getMeshService()?.localGeoChannelFor(input) ?? null)
    : null;

  function reset() {
    setInput("");
    setError(null);
    setPicking(false);
  }

  // The one way from this sheet into a cell: reuse the channel the user is
  // already in if this is their current cell, otherwise teleport into it. A
  // failure leaves the cell in the field with the reason under it.
  function openGeohash(geohash: string) {
    const svc = getMeshService();
    const channel =
      svc?.localGeoChannelFor(geohash) ?? svc?.joinGeohash(geohash);
    if (channel === undefined) {
      setPicking(false);
      setInput(geohash);
      setError(t("chat.jump.failed"));
      return;
    }
    reset();
    onJoined(channel);
  }

  function handleGo() {
    if (valid) openGeohash(input);
  }

  // The cells this phone is standing in, for the globe's fallback start (it
  // takes the coarsest). Empty with no location grant.
  function ownCells(): string[] {
    const svc = getMeshService();
    const cells: string[] = [];
    for (const channel of Object.keys(GEO_CHANNEL_PRECISION)) {
      const gh = svc?.getChannelGeohash(channel);
      if (gh) cells.push(gh);
    }
    return cells;
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleBack() {
    reset();
    onBack();
  }

  return (
    <BottomSheet
      visible={visible}
      onClose={handleClose}
      sheetStyle={styles.sheet}
      scrollable
    >
      <Text style={styles.title}>{T("chat.jump.title")}</Text>
      {/* The same card as the other chooser destinations. */}
      <View style={styles.privacyNote}>
        <View style={styles.privacyNoteRow}>
          <Feather
            name="map-pin"
            size={14}
            color={Colors.textMuted}
            style={styles.noteIcon}
          />
          <Text style={styles.privacyNoteText}>{T("chat.jump.anywhere")}</Text>
        </View>
        <View style={styles.privacyNoteRow}>
          <Feather
            name="hash"
            size={14}
            color={Colors.textMuted}
            style={styles.noteIcon}
          />
          <Text style={styles.privacyNoteText}>
            {T("chat.jump.geohash_note")}
          </Text>
        </View>
        <View style={styles.privacyNoteRow}>
          <Feather
            name="globe"
            size={14}
            color={Colors.textMuted}
            style={styles.noteIcon}
          />
          <Text style={styles.privacyNoteText}>
            {T("chat.jump.teleport_note")}
          </Text>
        </View>
      </View>

      {canPick && (
        <Pressable
          style={({ pressed }) => [styles.globeRow, pressed && styles.pressed]}
          onPress={() => {
            // Typing stays in the field; the keyboard would otherwise sit
            // over the globe.
            Keyboard.dismiss();
            setGlobeSlides(true);
            setPicking(true);
          }}
          accessibilityRole="button"
          accessibilityLabel={T("chat.jump.globe")}
          accessibilityHint={T("chat.jump.globe_note")}
        >
          <Feather name="map" size={18} color={Colors.textPrimary} />
          <View style={styles.globeText}>
            <Text style={styles.globeTitle}>{T("chat.jump.globe")}</Text>
            <Text style={styles.globeNote}>{T("chat.jump.globe_note")}</Text>
          </View>
          <Feather name={chevronForward} size={18} color={Colors.textMuted} />
        </Pressable>
      )}

      <View style={styles.inputRow}>
        <Text style={styles.inputPrefix}>#</Text>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={(v) => {
            setInput(normalizeGeohash(v));
            setError(null);
          }}
          placeholder="geohash"
          placeholderTextColor={Colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          onSubmitEditing={handleGo}
          selectionColor={Colors.selection}
        />
      </View>
      {/* No length hint: the disabled Go button already enforces it. */}
      {(localChannel !== null || level !== null) && (
        <Text style={styles.hint}>
          {localChannel !== null
            ? T("chat.jump.already_here", { name: localChannel })
            : // The name is appended, never substituted: the level is always
              // true, and the name is a best-effort lookup that is simply
              // absent offline or where the geocoder has nothing to say.
              `${t("chat.jump.level_cell", { level: level ?? "" })}${
                typedName !== undefined ? ` · ~${typedName}` : ""
              }`}
        </Text>
      )}
      {error !== null && <Text style={styles.error}>{error}</Text>}

      {neighbours.length > 0 && (
        <View style={styles.saved}>
          <UpperText style={styles.savedLabel}>
            {T("chat.jump.nearby")}
          </UpperText>
          <View style={styles.nearbyWrap}>
            {neighbours.map((n) => (
              <Pressable
                key={n.geohash}
                style={({ pressed }) => [
                  styles.nearbyChip,
                  pressed && styles.pressed,
                ]}
                onPress={() => openGeohash(n.geohash)}
                accessibilityRole="button"
                accessibilityLabel={T(DIRECTION_KEYS[n.direction].open)}
              >
                <Text style={styles.nearbyDir}>
                  {T(DIRECTION_KEYS[n.direction].short)}
                </Text>
                <Text style={styles.nearbyHash} numberOfLines={1}>
                  {placeNames[placeNameKey(n.geohash)] ?? `#${n.geohash}`}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {bookmarks.length > 0 && (
        <View style={styles.saved}>
          <UpperText style={styles.savedLabel}>
            {T("chat.jump.saved")}
          </UpperText>
          <ScrollView
            style={styles.savedList}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {bookmarks.map((gh) => {
              const name = placeNames[placeNameKey(gh)];
              return (
                <Pressable
                  key={gh}
                  style={styles.savedRow}
                  onPress={() => openGeohash(gh)}
                  accessibilityRole="button"
                  accessibilityLabel={T("chat.jump.open_place", {
                    name: name ?? gh,
                  })}
                >
                  <Feather name="map-pin" size={15} color={Colors.textMuted} />
                  <View style={styles.savedText}>
                    <Text style={styles.savedGeohash} numberOfLines={1}>
                      #{gh}
                    </Text>
                    <Text style={styles.savedSub} numberOfLines={1}>
                      {name !== undefined
                        ? `~${name}  ·  ${geohashLevelName(gh)}`
                        : geohashLevelName(gh)}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() =>
                      useGeohashBookmarksStore.getState().remove(gh)
                    }
                    // Inside the row's own target, so it grows in height
                    // only: 44pt tall within the row, and sideways no further
                    // than the gap before the place name.
                    hitSlop={{
                      ...hitSlopFor(REMOVE_ICON_SIZE),
                      left: HIT_SLOP.left,
                      right: HIT_SLOP.right,
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={T("chat.jump.remove_place", {
                      name: name ?? gh,
                    })}
                  >
                    <Feather
                      name="x"
                      size={REMOVE_ICON_SIZE}
                      color={Colors.textMuted}
                    />
                  </Pressable>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}

      <Text style={styles.footNote}>{T("chat.jump.how")}</Text>

      <View style={styles.actions}>
        <Pressable
          style={styles.cancel}
          onPress={handleBack}
          accessibilityRole="button"
          accessibilityLabel={t("common.back")}
        >
          <Text style={styles.cancelText}>{t("common.back")}</Text>
        </Pressable>
        <Pressable
          style={[styles.confirm, !valid && styles.confirmDisabled]}
          onPress={handleGo}
          disabled={!valid}
          accessibilityRole="button"
          accessibilityLabel={T("chat.jump.go")}
          // Without this a screen reader user taps into what sounds like
          // plain text.
          accessibilityState={{ disabled: !valid }}
        >
          <Text style={styles.confirmText}>{T("chat.jump.go")}</Text>
        </Pressable>
      </View>

      {/* Inside the sheet, so iOS presents it over the sheet rather than
          beside it, which it would refuse while the sheet is up. */}
      <GeohashPicker
        visible={picking}
        animated={globeSlides}
        initialGeohash={valid ? input : null}
        nearby={picking ? ownCells() : []}
        onSelect={(geohash) => {
          setGlobeSlides(false);
          openGeohash(geohash);
        }}
        onClose={() => setPicking(false)}
      />
    </BottomSheet>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    sheet: {
      paddingHorizontal: Spacing.xl,
      paddingBottom: Spacing.xl,
      gap: Spacing.md,
      maxHeight: "88%",
    },
    title: {
      fontSize: FontSize.md,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
    },
    privacyNote: {
      gap: Spacing.sm,
      backgroundColor: Colors.surfaceRaised,
      borderRadius: Radius.lg,
      padding: Spacing.md,
    },
    privacyNoteRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.sm,
    },
    // Nudge the leading icon down so it optically centers on the first text line.
    noteIcon: {
      marginTop: Spacing["2xs"],
    },
    privacyNoteText: {
      flex: 1,
      fontSize: FontSize.sm,
      color: Colors.textSecondary,
      lineHeight: LineHeight.sm,
    },
    // A full row in the field's own surface and radius rather than an icon
    // squeezed into the field: for most places it is the way in.
    globeRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      minHeight: BUTTON_HEIGHT,
      paddingVertical: Spacing.md,
      paddingHorizontal: Spacing.base,
      borderRadius: Radius.xl,
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    pressed: {
      backgroundColor: Colors.surfacePressed,
    },
    globeText: {
      flex: 1,
      gap: Spacing["2xs"],
    },
    globeTitle: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.medium,
      color: Colors.textPrimary,
    },
    globeNote: {
      fontSize: FontSize.xs,
      lineHeight: LineHeight.xs,
      color: Colors.textMuted,
    },
    inputRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: Colors.surfaceRaised,
      borderRadius: Radius.xl,
      borderWidth: 1,
      borderColor: Colors.border,
      paddingHorizontal: Spacing.base,
    },
    inputPrefix: {
      fontSize: FontSize.base,
      color: Colors.textMuted,
      fontFamily: FontFamily.mono,
      marginEnd: Spacing.xs,
    },
    input: {
      flex: 1,
      paddingVertical: Spacing.md,
      color: Colors.textPrimary,
      fontSize: FontSize.base,
      fontFamily: FontFamily.mono,
      letterSpacing: 1,
    },
    hint: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
      marginTop: -Spacing.xs,
    },
    error: {
      fontSize: FontSize.sm,
      color: Colors.danger,
    },
    // ---- Saved places (bookmarks) ----
    // flexShrink, so with the keyboard up the list yields height rather than
    // pushing Back and Go out of the clipped sheet.
    saved: {
      gap: Spacing.sm,
      flexShrink: 1,
    },
    savedLabel: {
      fontSize: FontSize.xs,
      fontWeight: FontWeight.semibold,
      color: Colors.textMuted,
      letterSpacing: 0.8,
    },
    savedList: {
      maxHeight: 168,
      flexShrink: 1,
    },
    savedRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      paddingVertical: Spacing.sm,
    },
    savedText: {
      flex: 1,
      gap: 1,
    },
    savedGeohash: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.medium,
      color: Colors.textPrimary,
      fontFamily: FontFamily.mono,
    },
    savedSub: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
    },
    nearbyWrap: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: Spacing.xs,
    },
    nearbyChip: {
      minWidth: 76,
      maxWidth: 132,
      alignItems: "center",
      gap: 1,
      paddingVertical: Spacing.xs,
      paddingHorizontal: Spacing.sm,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: Colors.border,
      backgroundColor: Colors.surfaceRaised,
    },
    nearbyDir: {
      fontSize: FontSize.xs,
      fontWeight: FontWeight.semibold,
      color: Colors.textSecondary,
      letterSpacing: 0.5,
    },
    nearbyHash: {
      fontSize: FontSize.xs,
      fontFamily: FontFamily.mono,
      color: Colors.textMuted,
    },
    footNote: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
      lineHeight: LineHeight.xs,
    },
    actions: {
      flexDirection: "row",
      gap: Spacing.sm,
      marginTop: Spacing.xs,
    },
    cancel: {
      flex: 1,
      minHeight: BUTTON_HEIGHT,
      backgroundColor: Colors.surfaceRaised,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
    },
    cancelText: {
      fontSize: FontSize.base,
      color: Colors.textPrimary,
      fontWeight: FontWeight.semibold,
    },
    confirm: {
      flex: 1,
      minHeight: BUTTON_HEIGHT,
      backgroundColor: Colors.accent,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
    },
    confirmDisabled: { opacity: 0.4 },
    confirmText: {
      fontSize: FontSize.base,
      color: Colors.textInverse,
      fontWeight: FontWeight.semibold,
    },
  });
}
