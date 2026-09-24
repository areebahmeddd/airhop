// Peer list screen: Mesh tab.
//
// Everyone a signed ANNOUNCE has been heard from, on the radar (default) or a
// flat list. One list whatever carried it: the store is fed by mesh-service,
// which binds a peer to a link without recording which transport it was.
//
// Tapping a peer opens their detail sheet with no separate "add contact" step,
// since a peer visible here is already reachable.

import { Feather } from "@expo/vector-icons";
import { t, useT, useTPlural } from "@i18n";
import { arrowForward } from "@i18n/layout";
import { getMeshService, type MeshPingResult } from "@services/mesh-service";
import { describePayResult, payPerson } from "@services/payment-router";
import { showAlert } from "@store/alert-store";
import { useBlockedStore } from "@store/blocked-store";
import { useChatStore } from "@store/chat-store";
import { useContactsStore } from "@store/contacts-store";
import {
  type NearbyPeer,
  REACHABLE_TTL_MS,
  usePeerStore,
} from "@store/peer-store";
import Avatar from "@ui/components/avatar";
import BottomSheet from "@ui/components/bottom-sheet";
import CopyGlyph from "@ui/components/copy-glyph";
import EmptyState from "@ui/components/empty-state";
import StatusDot from "@ui/components/status-dot";
import { useCopy } from "@ui/hooks/use-copy";
import {
  DISABLED_OPACITY,
  FontFamily,
  FontSize,
  FontWeight,
  HIT_SLOP,
  Radius,
  Spacing,
  TAB_BAR_CLEARANCE,
  useThemeColors,
} from "@ui/theme";
import { amountParts, formatAgo, parseWholeNumber } from "@utils/format";
import {
  resolveDisplayName,
  resolvePeerOwnName,
} from "@utils/peer-display-name";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import AddContactScreen from "../contacts/add-contact-screen";
import RadarView from "./radar-view";
import RelayGlyph from "./relay-glyph";

type ViewMode = "list" | "radar";

// `no-reply` is its own value rather than a null result: the service resolves
// null on timeout, null already means "not asked", and collapsing the two would
// render a silent peer as an untouched button after a ten-second wait.
type ProbeState = MeshPingResult | "pending" | "no-reply" | null;

// One height for every control in the send-sats row: the amount field and both
// icon buttons. Referenced once each, so the row cannot drift out of alignment.
const SEND_SATS_ROW_HEIGHT = 44;

interface Props {
  onOpenDM?: (channel: string) => void;
  viewMode: ViewMode;
  // Increment this to programmatically open the add-contact QR scanner (e.g.
  // from the App.tsx header's add-contact button). Counter pattern avoids
  // boolean edge cases.
  addContactTrigger?: number;
}

export default function PeerList({
  onOpenDM,
  viewMode,
  addContactTrigger,
}: Props): React.JSX.Element {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  // Selected, not whole-store. Subscribing to the stores wholesale meant this
  // screen re-rendered on every change either one made - and `addChannel` from
  // the chat store meant EVERY INBOUND MESSAGE re-rendered the radar, which has
  // nothing to do with peers. In a crowded room, with announces and per-link
  // RSSI polls arriving continuously, that is the one place in the app with real
  // render-thrash exposure.
  const peers = usePeerStore((s) => s.peers);
  const evictStale = usePeerStore((s) => s.evictStale);
  const addChannel = useChatStore((s) => s.addChannel);
  const isBlocked = useBlockedStore((s) => s.isBlocked);
  const [now, setNow] = useState(() => Date.now());
  const [showQRScan, setShowQRScan] = useState(false);
  const [selectedPeer, setSelectedPeer] = useState<NearbyPeer | null>(null);
  // The sheet reads the live entry, so a rename, a new direct link or a fresh
  // announce shows while it is open. The last live entry is the fallback once
  // the peer ages out of the store, which is what lets the sheet say when they
  // were last seen instead of vanishing under the user's thumb.
  const livePeer = selectedPeer ? peers.get(selectedPeer.peerID) : undefined;
  const shownPeer = livePeer ?? selectedPeer;
  // Kept current while live, or the fallback would date "last seen" from the
  // tap rather than from the last announce. Adjusted during render, React's
  // pattern for state derived from a changing input.
  if (livePeer !== undefined && livePeer !== selectedPeer) {
    setSelectedPeer(livePeer);
  }
  const [sendSatsAmount, setSendSatsAmount] = useState("");
  const [showSendSats, setShowSendSats] = useState(false);
  // Set while a send is in flight. Quoting involves an await, so without this a
  // double tap starts two sends; the second now loses the reservation race and
  // reports a confusing "those coins were just used" instead of doing nothing.
  const [sendingSats, setSendingSats] = useState(false);
  const { copied: copiedPeerID, copy } = useCopy();

  // Outcome of a mesh ping against the open peer.
  //
  // Keyed by peer ID because this sheet is mounted once and reused: a bare
  // result would show the previous person's hop count until the next probe
  // answered.
  const [probe, setProbe] = useState<{
    peerID: string;
    result: ProbeState;
  } | null>(null);

  // Refresh "last seen" every 10 seconds and evict stale peers.
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      evictStale();
    }, 10_000);
    return () => clearInterval(timer);
  }, [evictStale]);

  // Watch the trigger counter from App.tsx header button.
  const prevAddTrigger = useRef(addContactTrigger ?? 0);
  useEffect(() => {
    if (
      addContactTrigger !== undefined &&
      addContactTrigger > prevAddTrigger.current
    ) {
      prevAddTrigger.current = addContactTrigger;
      setShowQRScan(true);
    }
  }, [addContactTrigger]);

  // Belt-and-suspenders: mesh-service already keeps a blocked peer's
  // announces out of the store, but filtering here too means a peer
  // blocked mid-session (already cached before the block) disappears
  // immediately instead of waiting for TTL eviction.
  // Memoised: this spread + filter + sort ran on every render, and its result is
  // handed straight to RadarView, so an unmemoised array also forced the radar
  // to re-bucket every peer each time.
  const peerList = useMemo(
    () =>
      [...peers.values()]
        .filter((p) => !isBlocked(p.peerID))
        .sort((a, b) => b.lastSeenMs - a.lastSeenMs),
    [peers, isBlocked],
  );

  function isOnline(peer: NearbyPeer): boolean {
    return now - peer.lastSeenMs < REACHABLE_TTL_MS;
  }

  function handleSendDM(peer: NearbyPeer): void {
    const channel = `dm:${peer.peerID}`;
    // Messaging someone saves them as a contact (Signal-style: people you talk
    // to are kept), so the thread and their identity survive them going out of
    // range. Unverified until a QR card confirms the keys.
    useContactsStore
      .getState()
      .saveIfAbsent(peer.peerID, peer.nickname, peer.noisePubKeyHex);
    addChannel(channel);
    closeSheet();
    onOpenDM?.(channel);
  }

  // Reset all peer-detail sheet state and close.
  function closeSheet(): void {
    setSelectedPeer(null);
    setShowSendSats(false);
    setSendSatsAmount("");
    setProbe(null);
  }

  // How far away a peer is, in hops rather than metres.
  //
  // Hops is the honest measure. RSSI swings tens of dB with orientation, bodies
  // and walls, which is why the radar labels its rings by signal; a hop count is
  // a fact about the network and means the same in a field and in a crowd.
  //
  // Only ever run on request. A ping floods at TTL 7, so firing one per sheet
  // open would put a packet across the whole mesh per tap, which is the airtime
  // a crowded room cannot spare. Never run for a direct neighbour: `isDirect` is
  // bound to a GATT link we hold, so the answer is one hop without asking.
  async function handleCheckDistance(peerID: string): Promise<void> {
    if (probe?.peerID === peerID && probe.result === "pending") return;
    setProbe({ peerID, result: "pending" });
    const answer = await getMeshService()?.sendMeshPing(peerID);
    // Nothing inside the timeout, or no mesh service. Both are "asked and got
    // nothing", which is an answer and has to read as one.
    const result: ProbeState = answer ?? "no-reply";
    // The sheet may have moved on or been dismissed during the round trip.
    // A stale answer on the wrong person is worse than none.
    setProbe((current) =>
      current?.peerID === peerID ? { peerID, result } : current,
    );
  }

  // Ecash hand-off to a peer standing next to you. All of the proof handling
  // (selection, fees, reserving so an undelivered token can be reclaimed) lives
  // in the shared transfer service; this only supplies who and how much.
  async function handleSendSats(peer: NearbyPeer): Promise<void> {
    const amount = parsedSats;
    if (amount === null || sendingSats) return;

    setSendingSats(true);
    let result;
    try {
      result = await payPerson({
        peerID: peer.peerID,
        amount,
        recipientName: peer.nickname,
      });
    } finally {
      setSendingSats(false);
    }
    if (!result) return;

    setSendSatsAmount("");
    setShowSendSats(false);
    closeSheet();
    onOpenDM?.(`dm:${peer.peerID}`);
    // The thread we just opened shows the bubble, so only speak up when the
    // token did not go straight out. A peer standing next to you normally takes
    // the radio rail, which needs no explanation.
    if (result.rail !== "mesh") {
      showAlert(
        t("wallet.pay.sent_title", {
          ...amountParts(result.amount, result.unit),
          name: peer.nickname,
        }),
        describePayResult(result),
      );
    }
  }

  // The typed amount as a number, or null when it is not a spendable one.
  //
  // Parsed here rather than inside handleSendSats, which can only silently
  // `return` on anything invalid while the confirm button greys out on an EMPTY
  // field alone. A "0", a stray "-" or a pasted "12.5" then leaves an enabled
  // arrow that does nothing when tapped: the worst class of dead control, since
  // the user has
  // no way to tell it from a failed send. One source of validity now drives
  // both the button's disabled state and the send.
  const parsedSats = useMemo(() => {
    return parseWholeNumber(sendSatsAmount);
  }, [sendSatsAmount]);

  function handleQRScanned(peerID: string): void {
    const channel = `dm:${peerID}`;
    addChannel(channel);
    setShowQRScan(false);
    setSelectedPeer(null);
    onOpenDM?.(channel);
  }

  return (
    <View style={styles.container}>
      {viewMode === "radar" ? (
        <RadarView peers={peerList} now={now} onSelectPeer={setSelectedPeer} />
      ) : (
        <FlatList
          data={peerList}
          keyExtractor={(item) => item.peerID}
          // Every row is in range. The store evicts a peer at the same 60 s
          // cutoff that decides reachability, on the same tick that refreshes
          // `now`, so an offline row never renders; the detail sheet is where
          // a peer who has left can still be seen, from its snapshot.
          renderItem={({ item }) => {
            const username = resolveDisplayName(item.peerID);

            return (
              <Pressable
                style={({ pressed }) => [
                  styles.row,
                  pressed && styles.rowPressed,
                ]}
                onPress={() => setSelectedPeer(item)}
                accessibilityRole="button"
                // Relay appended rather than substituted: whether the box on the
                // pole is still answering matters as much as whether a person
                // is, so it keeps the same online/offline label a peer gets.
                accessibilityLabel={`${t("mesh.peer.view_peer_online", {
                  name: username,
                })}${
                  item.isInfrastructure === true
                    ? `, ${t("mesh.peer.relay")}`
                    : ""
                }`}
              >
                <View style={styles.avatarWrapper}>
                  {item.isInfrastructure === true ? (
                    <RelayGlyph size={46} />
                  ) : (
                    <Avatar
                      username={username}
                      peerID={item.peerID}
                      size={46}
                    />
                  )}
                  <View style={styles.rowStatusBadge}>
                    <StatusDot status="online" size={10} />
                  </View>
                </View>

                <View style={styles.rowContent}>
                  <Text style={styles.rowUsername} numberOfLines={1}>
                    {username}
                  </Text>
                  {/* A relay's ID is of no use to anyone: it will never be a
                      contact and there is nothing to look it up against. The
                      word earns the line more than sixteen hex characters. */}
                  {item.isInfrastructure === true ? (
                    <Text style={styles.rowRelay}>{T("mesh.peer.relay")}</Text>
                  ) : (
                    <Text style={styles.rowPeerID}>
                      {item.peerID.slice(0, 8)}
                      {" · "}
                      {item.peerID.slice(8)}
                    </Text>
                  )}
                </View>

                <View style={styles.rowRight}>
                  <Text style={styles.rowLastSeen}>{T("format.just_now")}</Text>
                </View>
              </Pressable>
            );
          }}
          ItemSeparatorComponent={() => <View style={styles.rowSeparator} />}
          ListEmptyComponent={
            <EmptyState
              icon="radio"
              title={T("mesh.peer.none")}
              subtitle={T("mesh.peer.none_desc")}
            />
          }
          contentContainerStyle={styles.list}
        />
      )}

      {/* Peer detail sheet */}
      <BottomSheet
        visible={selectedPeer !== null}
        onClose={closeSheet}
        sheetStyle={styles.sheet}
      >
        {shownPeer && (
          <>
            {/* Identity */}
            <View style={styles.sheetIdentity}>
              {shownPeer.isInfrastructure === true ? (
                <RelayGlyph size={64} />
              ) : (
                <Avatar
                  username={resolveDisplayName(shownPeer.peerID)}
                  peerID={shownPeer.peerID}
                  size={64}
                />
              )}
              <Text style={styles.sheetUsername}>
                {resolveDisplayName(shownPeer.peerID)}
              </Text>
              {/* Only when the title is a name the user chose. Unrenamed, the
                  title already IS what they call themselves, and repeating it
                  underneath would be the same word twice. */}
              {resolveDisplayName(shownPeer.peerID) !==
                resolvePeerOwnName(shownPeer.peerID) && (
                <Text style={styles.sheetOwnName}>
                  {t("mesh.peer.their_name", {
                    name: resolvePeerOwnName(shownPeer.peerID),
                  })}
                </Text>
              )}
              {/* Same copy affordance as the contact sheet: one tap, and the
                  glyph turns into a check in place. Hand-selecting the ID
                  would fight this sheet's pan-to-dismiss gesture. */}
              <Pressable
                style={styles.sheetPeerIDRow}
                onPress={() => copy(shownPeer.peerID)}
                hitSlop={HIT_SLOP}
                accessibilityRole="button"
                // The ID itself is 16 characters of hex, which a screen reader
                // spells out one character at a time. The label states the
                // action; the value is not something anyone listens to.
                accessibilityLabel={
                  copiedPeerID
                    ? T("mesh.peer.id_copied")
                    : T("mesh.peer.copy_id")
                }
              >
                <Text style={styles.sheetPeerID}>{shownPeer.peerID}</Text>
                <CopyGlyph
                  copied={copiedPeerID}
                  size={13}
                  color={Colors.textMuted}
                />
              </Pressable>
              <View style={styles.sheetStatusRow}>
                <StatusDot
                  status={isOnline(shownPeer) ? "online" : "offline"}
                  size={8}
                />
                <Text style={styles.sheetStatusText}>
                  {isOnline(shownPeer)
                    ? T("mesh.peer.in_range")
                    : t("mesh.peer.last_seen_at", {
                        ago: formatAgo(shownPeer.lastSeenMs, now),
                      })}
                </Text>
              </View>
              {/* In range only: a peer nobody has heard from in a minute has
                  nothing to answer a ping with, and a relay is a box on a pole
                  rather than somebody you are trying to find. */}
              {shownPeer.isInfrastructure !== true && isOnline(shownPeer) && (
                <DistanceRow
                  isDirect={shownPeer.isDirect === true}
                  probe={
                    probe?.peerID === shownPeer.peerID ? probe.result : null
                  }
                  onCheck={() => void handleCheckDistance(shownPeer.peerID)}
                />
              )}
            </View>

            {/* A relay gets an explanation where a person gets actions. Both
                would be dead controls: nobody reads the messages, and there is
                no wallet to receive sats. Saying what the thing is answers the
                question that made the user tap it. */}
            {shownPeer.isInfrastructure === true ? (
              <View style={styles.relayNote}>
                <Text style={styles.relayNoteTitle}>
                  {T("mesh.peer.relay")}
                </Text>
                <Text style={styles.relayNoteBody}>
                  {T("mesh.peer.relay_body")}
                </Text>
              </View>
            ) : (
              /* Message + Send sats: a tight pair of actions, not spread
                  apart by the sheet's larger identity/actions rhythm. */
              <View style={styles.sheetActions}>
                <Pressable
                  style={styles.sheetMessageBtn}
                  onPress={() => handleSendDM(shownPeer)}
                  accessibilityRole="button"
                  accessibilityLabel={T("mesh.peer.send_dm")}
                >
                  <Feather
                    name="message-circle"
                    size={18}
                    color={Colors.textInverse}
                  />
                  <Text style={styles.sheetMessageBtnText}>
                    {T("mesh.peer.message")}
                  </Text>
                </Pressable>

                {!showSendSats ? (
                  <Pressable
                    style={styles.sheetSatsBtn}
                    onPress={() => setShowSendSats(true)}
                    accessibilityRole="button"
                    accessibilityLabel={T("mesh.peer.send_sats")}
                  >
                    <Feather
                      name="zap"
                      size={16}
                      color={Colors.textSecondary}
                    />
                    <Text style={styles.sheetSatsBtnText}>
                      {T("mesh.peer.send_sats")}
                    </Text>
                  </Pressable>
                ) : (
                  <View style={styles.sendSatsRow}>
                    <TextInput
                      style={styles.sendSatsInput}
                      value={sendSatsAmount}
                      onChangeText={setSendSatsAmount}
                      placeholder={T("mesh.peer.amount_placeholder")}
                      placeholderTextColor={Colors.textMuted}
                      keyboardType="number-pad"
                      returnKeyType="send"
                      autoFocus
                      selectionColor={Colors.selection}
                      onSubmitEditing={() => void handleSendSats(shownPeer)}
                    />
                    <Pressable
                      style={[
                        styles.sendSatsConfirm,
                        (parsedSats === null || sendingSats) &&
                          styles.sendSatsConfirmDisabled,
                      ]}
                      onPress={() => void handleSendSats(shownPeer)}
                      disabled={parsedSats === null || sendingSats}
                      accessibilityRole="button"
                      accessibilityLabel={
                        parsedSats === null
                          ? T("mesh.peer.amount_first")
                          : t("mesh.peer.send_amount", { amount: parsedSats })
                      }
                      accessibilityState={{
                        disabled: parsedSats === null || sendingSats,
                        busy: sendingSats,
                      }}
                    >
                      {/* Quoting the token is a network round trip, so a send can
                        sit for a second or two. A frozen arrow gave no sign the
                        tap had registered, which is what invites the double tap
                        the `sendingSats` guard exists to survive. */}
                      {sendingSats ? (
                        <ActivityIndicator
                          size="small"
                          color={Colors.textInverse}
                        />
                      ) : (
                        <Feather
                          name={arrowForward}
                          size={16}
                          color={Colors.textInverse}
                        />
                      )}
                    </Pressable>
                    <Pressable
                      style={styles.sendSatsCancel}
                      onPress={() => {
                        setShowSendSats(false);
                        setSendSatsAmount("");
                      }}
                      disabled={sendingSats}
                      accessibilityRole="button"
                      accessibilityLabel={T("mesh.peer.cancel_send")}
                    >
                      <Feather
                        name="x"
                        size={16}
                        color={Colors.textSecondary}
                      />
                    </Pressable>
                  </View>
                )}
              </View>
            )}
          </>
        )}
      </BottomSheet>

      {/* QR scanner */}
      <AddContactScreen
        visible={showQRScan}
        onClose={() => setShowQRScan(false)}
        onPeerFound={handleQRScanned}
      />
    </View>
  );
}

// "How far away is this person", answered in hops.
//
// The split between the first two states is the design: a direct neighbour is
// answered from what the radio already holds, and only a relayed peer costs a
// packet. See handleCheckDistance.
//
//   direct     a GATT link we hold. One hop, stated, nothing sent
//   idle       relayed, offers to ask
//   pending    a ping is out, up to ten seconds before it gives up
//   answered   a hop count and a round trip, or no reply
function DistanceRow({
  isDirect,
  probe,
  onCheck,
}: {
  isDirect: boolean;
  probe: ProbeState;
  onCheck: () => void;
}): React.JSX.Element {
  const T = useT();
  const TP = useTPlural();
  const Colors = useThemeColors();
  const styles = useMemo(() => createDistanceStyles(Colors), [Colors]);

  if (isDirect) {
    return (
      <View style={styles.row}>
        <Feather name="zap" size={12} color={Colors.online} />
        <Text style={styles.text}>{T("mesh.peer.direct")}</Text>
      </View>
    );
  }

  if (probe === "pending") {
    return (
      <View style={styles.row}>
        <ActivityIndicator size="small" color={Colors.textMuted} />
        <Text style={styles.text}>{T("mesh.peer.checking")}</Text>
      </View>
    );
  }

  // Asked, heard nothing. bitchat-android answers no ping at all, so silence is
  // as likely to be which app they run as how far away they are. Tapping
  // retries.
  if (probe === "no-reply") {
    return (
      <Pressable
        style={styles.row}
        onPress={onCheck}
        hitSlop={HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel={T("mesh.peer.check_distance")}
      >
        <Feather name="help-circle" size={12} color={Colors.textMuted} />
        <Text style={styles.text}>{T("mesh.peer.no_reply")}</Text>
        <Text style={styles.detail}>{T("mesh.peer.no_reply_hint")}</Text>
      </Pressable>
    );
  }

  if (probe !== null) {
    return (
      <Pressable
        style={styles.row}
        onPress={onCheck}
        hitSlop={HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel={T("mesh.peer.check_distance")}
      >
        <Feather name="git-commit" size={12} color={Colors.textMuted} />
        <Text style={styles.text}>
          {/* Hops is null when the pong's TTL arithmetic does not resolve, so
              the round trip carries the row rather than the row vanishing. */}
          {probe.hops !== null
            ? TP("mesh.peer.hops_away", probe.hops)
            : t("mesh.peer.rtt", { ms: String(probe.rttMs) })}
        </Text>
        {probe.hops !== null && (
          <Text style={styles.detail}>
            {t("mesh.peer.rtt", { ms: String(probe.rttMs) })}
          </Text>
        )}
      </Pressable>
    );
  }

  return (
    <Pressable
      style={styles.row}
      onPress={onCheck}
      hitSlop={HIT_SLOP}
      accessibilityRole="button"
    >
      <Feather name="git-commit" size={12} color={Colors.accent} />
      <Text style={styles.action}>{T("mesh.peer.check_distance")}</Text>
    </Pressable>
  );
}

function createDistanceStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      minHeight: 20,
    },
    text: {
      fontSize: FontSize.sm,
      color: Colors.textMuted,
    },
    // Prose, not data: both users of this are catalog sentences. The monospace
    // has glyphs for three of the thirteen scripts Airhop ships, and digits are
    // pinned to Latin anyway (see `@utils/format`).
    detail: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
    },
    action: {
      fontSize: FontSize.sm,
      color: Colors.accent,
    },
  });
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: Colors.bg,
    },
    list: {
      flexGrow: 1,
      paddingBottom: TAB_BAR_CLEARANCE,
    },
    // Flat rows on the screen background, like the chat lists and the radar,
    // so switching Radar and List changes only the content.
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.base,
      paddingVertical: Spacing.md,
      gap: Spacing.md,
      minHeight: 72,
    },
    // The one press treatment for a row. See PRESSED_OPACITY in ui/theme.
    rowPressed: {
      backgroundColor: Colors.surfacePressed,
    },
    avatarWrapper: {
      position: "relative",
      flexShrink: 0,
    },
    rowStatusBadge: {
      position: "absolute",
      end: -1,
      bottom: -1,
      backgroundColor: Colors.bg,
      borderRadius: Radius.full,
      padding: 1,
    },
    rowContent: {
      flex: 1,
      gap: 3,
    },
    rowRight: {
      alignItems: "flex-end",
      flexShrink: 0,
    },
    rowUsername: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
    },
    rowPeerID: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
      fontFamily: FontFamily.mono,
      letterSpacing: 0.8,
    },
    rowRelay: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
    },
    rowLastSeen: {
      fontSize: FontSize.xs,
      color: Colors.online,
    },
    rowSeparator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: Colors.border,
      // Aligned to the text, past the avatar: avatar (46) + gap (16). Same
      // inset the DM list uses, so the two read as one list style.
      marginStart: 62,
    },
    sheet: {
      paddingHorizontal: Spacing.xl,
      paddingBottom: Spacing.xl,
      gap: Spacing.xl,
    },
    sheetIdentity: {
      alignItems: "center",
      gap: Spacing.sm,
    },
    sheetUsername: {
      fontSize: FontSize.lg,
      fontWeight: FontWeight.bold,
      color: Colors.textPrimary,
    },
    sheetOwnName: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
    },
    sheetPeerIDRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
    },
    sheetPeerID: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
      fontFamily: FontFamily.mono,
      letterSpacing: 0.8,
    },
    sheetStatusRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
    },
    sheetStatusText: {
      fontSize: FontSize.sm,
      color: Colors.textMuted,
    },
    sheetActions: {
      width: "100%",
      gap: Spacing.sm,
    },
    relayNote: {
      width: "100%",
      gap: Spacing.xs,
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 1,
      borderColor: Colors.border,
      borderRadius: Radius.lg,
      padding: Spacing.base,
    },
    relayNoteTitle: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
    },
    relayNoteBody: {
      fontSize: FontSize.sm,
      color: Colors.textSecondary,
      lineHeight: 20,
    },
    sheetMessageBtn: {
      backgroundColor: Colors.accent,
      borderRadius: Radius.full,
      paddingVertical: Spacing.md,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
    },
    sheetMessageBtnText: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.semibold,
      color: Colors.textInverse,
    },
    sheetSatsBtn: {
      borderRadius: Radius.full,
      paddingVertical: Spacing.md,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    sheetSatsBtnText: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.semibold,
      color: Colors.textSecondary,
    },
    sendSatsRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    sendSatsInput: {
      flex: 1,
      height: SEND_SATS_ROW_HEIGHT,
      backgroundColor: Colors.surfaceRaised,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: Colors.border,
      paddingHorizontal: Spacing.base,
      paddingVertical: 0,
      fontSize: FontSize.base,
      color: Colors.textPrimary,
    },
    sendSatsConfirm: {
      width: SEND_SATS_ROW_HEIGHT,
      height: SEND_SATS_ROW_HEIGHT,
      borderRadius: Radius.full,
      backgroundColor: Colors.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    sendSatsConfirmDisabled: {
      opacity: DISABLED_OPACITY,
    },
    sendSatsCancel: {
      width: SEND_SATS_ROW_HEIGHT,
      height: SEND_SATS_ROW_HEIGHT,
      borderRadius: Radius.full,
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 1,
      borderColor: Colors.border,
      alignItems: "center",
      justifyContent: "center",
    },
  });
}
