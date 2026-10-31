// A single message row: bubble, forwarded tag, star badge, and the long-press
// surface that opens the message action sheet.
//
// Attachment and Cashu-token rendering stay in message-thread.tsx (they
// depend on per-thread interactive state: playingUri, revealedAttachments,
// claimToken) and are handed down as render props.

import { isVideoNoteName } from "@core/mesh/wire/file-packet";
import type { ChatToken } from "@core/payments/cashu";
import { useT, type TranslationKey } from "@i18n";
import { contentTextAlign } from "@i18n/layout";
import { held } from "@platform/haptics";
import { Feather } from "@react-native-vector-icons/feather/static";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons/static";
import type {
  ChatAttachment,
  ChatMessage,
  MessageStatus,
} from "@store/chat-store";
import Avatar from "@ui/components/avatar";
import {
  FontFamily,
  FontSize,
  FontWeight,
  hitSlopFor,
  LineHeight,
  LONG_PRESS_MS,
  Radius,
  Spacing,
  useThemeColors,
  withAlpha,
} from "@ui/theme";
import { tokenizeFormatting } from "@utils/message-format";
import { messagePreviewText } from "@utils/message-preview";
import { messageText } from "@utils/message-text";
import React, { useMemo } from "react";
import {
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
} from "react-native";
import LiveVideoBubble from "./live-video-bubble";
import LocationCard, { openInMaps } from "./location-card";
import {
  findMessageLinks,
  inlineTokenPattern,
  linkHref,
  trimLink,
} from "./message-links";
import {
  screenReaderActions,
  type ScreenReaderAction,
} from "./screen-reader-actions";

// Drawn size of a sender's avatar in a channel thread. Tapping it (or the name
// beside it) opens that sender's profile, so both carry hitSlopFor() to reach the
// 44pt floor from 32pt without making the bubbles taller.
const AVATAR_TAP_SIZE = 32;

// Drawn size of a delivery tick. The failed one is a retry button, grown to the
// touch floor by slop; the timestamp beside it is plain text.
const TICK_SIZE = 13;

// Links offered as screen-reader actions, in reading order. A message pasted
// full of URLs would otherwise bury the menu under them.
const MAX_LINK_ACTIONS = 3;

// What a screen reader says for each tick, from the words the info sheet
// already uses where it has them. Keys, not text: see i18n.md.
const STATUS_LABEL: Record<MessageStatus, TranslationKey> = {
  sending: "chat.info.sending",
  sent: "chat.info.sent",
  carried: "chat.info.courier",
  queued: "chat.info.queued",
  delivered: "chat.bubble.status_delivered",
  read: "chat.bubble.status_read",
  failed: "chat.info.failed",
  reclaimed: "chat.info.reclaimed",
};

// A screen-reader action on what a bubble holds (play, open, claim). The
// primary one is also what a double tap does, as a tap on it would.
export interface BubbleAction extends ScreenReaderAction {
  primary?: boolean;
}

// Memoized (see the export) so a thread of hundreds of messages does not
// re-render every bubble on each keyboard, scroll or state tick, which trips
// React Native's "VirtualizedList slow to update" warning. A message
// object is replaced whenever it changes (immutable store updates), so a
// reference check on `item` is enough; `tokens` is skipped because it derives
// from `item.text`, and the plain callbacks are behaviorally stable (they act
// on the item passed to them). The two render props are not: they draw on the
// thread's interactive state, which `renderState` exposes. The bubble still
// re-renders on theme/font changes via its own useThemeColors subscription, and
// an in-progress attachment card keeps updating through its own store
// subscription.
interface Props {
  item: ChatMessage;
  showAvatar: boolean;
  isFirstFromSender: boolean;
  tokens: ChatToken[];
  isPureToken: boolean;
  renderToken: (token: ChatToken) => React.ReactNode;
  renderAttachment: (attachment: ChatAttachment) => React.ReactNode;
  // This row's interactive state, flattened for the memo comparator: photo
  // revealed, voice note playing, token being claimed.
  //
  // The comparator cannot check the render props themselves. They are fresh
  // closures every parent render, so comparing them would defeat the memo (the
  // composer's draft changes per keystroke), and ignoring them would freeze the
  // bubble on its first render, so a tap on load, play or claim would show
  // nothing.
  // Row-scoped, so one tap re-renders one bubble.
  renderState: string;
  formatTime: (ms: number) => string;
  onLongPress: (item: ChatMessage) => void;
  // Tapping the failed indicator on one of your own messages resends it. Only
  // wired for text messages, the only kind this bubble owns the send path for.
  onRetry?: (item: ChatMessage) => void;
  // Tapping the avatar or name opens a profile sheet for that sender, same
  // "tap a peer to see who they are" affordance as the Mesh tab. Omitted in
  // a DM thread (there's only one other participant, already reachable via
  // the header). Only wired for channels, where a message can come from
  // any of several people.
  onPressSender?: (item: ChatMessage) => void;
  // Briefly true right after navigating here from a search result, so the
  // matched message is unmistakable among a screen of otherwise-identical
  // bubbles. A border ring (not a background wash) so it reads the same way
  // on both the light "theirs" bubble and the near-black "mine" bubble.
  highlighted?: boolean;
  // Selection mode, for forwarding several messages at once. When `selecting`
  // is true a plain tap toggles this row instead of doing nothing, and the
  // sender/avatar taps are suppressed so the whole row is one target.
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: (item: ChatMessage) => void;
  // Tapping a live stream's picture opens it full screen.
  onOpenLiveVideo?: (item: ChatMessage) => void;
  // The actions on what the thread renders into this bubble (attachments and
  // tokens), for a screen reader. On iOS the bubble is one element, so the
  // controls drawn inside it are unreachable any other way. A render prop for
  // the same reason as the two above, and kept fresh by `renderState`.
  contentActions?: (item: ChatMessage) => readonly BubbleAction[];
}

function MessageBubble({
  item,
  showAvatar,
  isFirstFromSender,
  tokens,
  isPureToken,
  // `renderState` is not destructured: the memo comparator reads it, the body
  // never does.
  renderToken,
  renderAttachment,
  formatTime,
  onLongPress,
  onRetry,
  onPressSender,
  highlighted,
  selecting,
  selected,
  onToggleSelect,
  onOpenLiveVideo,
  contentActions,
}: Props): React.JSX.Element {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);

  function handleLongPress(): void {
    held();
    // In selection mode a long press is the same as a tap: holding again to
    // reopen the menu that started the selection would be a dead end.
    if (selecting === true) {
      onToggleSelect?.(item);
      return;
    }
    onLongPress(item);
  }

  function handleToggle(): void {
    onToggleSelect?.(item);
  }

  // A round video note stands on its own, as it does in every messenger that
  // has one: a circle inside a bubble reads as a picture of a circle. Its time
  // and ticks keep the bubble's colour in a pill beneath it.
  const bare =
    item.attachment?.type === "video" &&
    isVideoNoteName(item.attachment.name) &&
    item.text.length === 0 &&
    tokens.length === 0;

  // While selecting, the row itself is the target: the avatar and the sender
  // name stop opening a profile so a tap anywhere reads the same way.
  const senderPress =
    selecting === true || onPressSender === undefined
      ? undefined
      : () => onPressSender(item);

  // Outside selection the retry tick is the one tappable mark; inside it the
  // whole row toggles, and a tap on the tick must not resend instead.
  const retry =
    item.isMine &&
    item.status === "failed" &&
    onRetry !== undefined &&
    selecting !== true
      ? () => onRetry(item)
      : undefined;

  // Everything a sighted reader can tap inside the bubble, as named actions,
  // since the bubble is a single element to VoiceOver (TalkBack still reaches
  // the nested controls, and gets the same actions). The menu comes last, and
  // a double tap does the primary action, or opens the menu when there is none.
  // A live stream's controls are their own elements, so it needs none of this.
  function bubbleActions(): ReturnType<typeof screenReaderActions> {
    if (selecting === true) {
      return screenReaderActions(handleToggle, [], Platform.OS);
    }
    if (item.liveVideo !== undefined) return {};
    const content = contentActions?.(item) ?? [];
    const pin = item.locationPin;
    const links =
      item.text.length > 0 && !isPureToken && pin === undefined
        ? findMessageLinks(messageText(item), MAX_LINK_ACTIONS)
        : [];
    const actions: ScreenReaderAction[] = [
      ...content,
      ...(retry
        ? [{ name: "retry", label: T("common.try_again"), run: retry }]
        : []),
      ...(pin
        ? [
            {
              name: "maps",
              label: T("chat.location.open_maps"),
              run: () => openInMaps(pin),
            },
          ]
        : []),
      ...links.map((link, i) => ({
        name: `link${String(i)}`,
        label: T("chat.bubble.open_link", { link }),
        run: () => void Linking.openURL(linkHref(link)).catch(() => {}),
      })),
      {
        name: "longpress",
        label: T("chat.bubble.more_options"),
        run: handleLongPress,
      },
    ];
    const primary = content.find((action) => action.primary === true);
    return screenReaderActions(
      primary?.run ?? handleLongPress,
      actions,
      Platform.OS,
    );
  }

  const status =
    item.isMine && !item.isSystem && item.status !== undefined
      ? T(STATUS_LABEL[item.status])
      : undefined;

  return (
    <Pressable
      style={[
        styles.messageRow,
        item.isMine ? styles.messageRowMine : styles.messageRowTheirs,
      ]}
      onPress={selecting === true ? handleToggle : undefined}
      // The whole row holds, not just the bubble, which on a one-word message
      // is a 40pt target in a full-width row.
      onLongPress={handleLongPress}
      delayLongPress={LONG_PRESS_MS}
      // Only an accessibility element while it is a checkbox: a Pressable is
      // `accessible` by default, which collapses its children into one node and
      // would swallow the bubble's own sender-and-body label.
      accessible={selecting === true}
      accessibilityRole={selecting === true ? "checkbox" : undefined}
      accessibilityState={
        selecting === true ? { checked: selected === true } : undefined
      }
    >
      {/* Leading check, only while selecting. Outside the bubble so it reads as
          a row control rather than part of the message, and on the same side for
          everyone so a mixed thread has one column of checks. */}
      {selecting === true && (
        <View
          style={[
            styles.selectCheck,
            // Own rows pack to the end, so the check needs the free space on its
            // trailing side to stay in the same column as the one on a received
            // row. Without it the check hugs the bubble and the column zigzags.
            item.isMine && styles.selectCheckLeading,
            selected === true && styles.selectCheckOn,
          ]}
        >
          {selected === true && (
            <Feather name="check" size={13} color={Colors.textInverse} />
          )}
        </View>
      )}
      {showAvatar ? (
        isFirstFromSender ? (
          <Pressable
            onPress={senderPress}
            disabled={senderPress === undefined}
            hitSlop={hitSlopFor(AVATAR_TAP_SIZE)}
            accessibilityRole={senderPress ? "button" : undefined}
            accessibilityLabel={
              senderPress
                ? T("chat.bubble.view_profile", { name: item.senderNickname })
                : undefined
            }
          >
            <Avatar
              username={item.senderNickname}
              peerID={item.senderID}
              size={32}
            />
          </Pressable>
        ) : (
          <View style={styles.avatarSpacer} />
        )
      ) : null}

      <View
        style={[
          styles.bubbleWrapper,
          item.isMine ? styles.bubbleWrapperMine : styles.bubbleWrapperTheirs,
        ]}
      >
        {showAvatar && isFirstFromSender && (
          <Pressable
            onPress={senderPress}
            disabled={senderPress === undefined}
            hitSlop={hitSlopFor(AVATAR_TAP_SIZE)}
            accessibilityRole={senderPress ? "button" : undefined}
            accessibilityLabel={
              senderPress
                ? T("chat.bubble.view_profile", { name: item.senderNickname })
                : undefined
            }
          >
            <View style={styles.senderNameRow}>
              <Text style={styles.senderName}>{item.senderNickname}</Text>
              {item.viaBridge && (
                // Arrived from another mesh island across the mesh bridge.
                <Feather
                  name="globe"
                  size={11}
                  color={Colors.bridge}
                  accessibilityLabel={T("chat.bubble.via_bridge")}
                />
              )}
            </View>
          </Pressable>
        )}

        <Pressable
          onPress={selecting === true ? handleToggle : undefined}
          onLongPress={handleLongPress}
          delayLongPress={LONG_PRESS_MS}
          // A live stream's two controls, the picture and its sound, are their
          // own nodes and name the sender themselves; as one node with the
          // bubble neither could be reached.
          accessible={selecting === true || item.liveVideo === undefined}
          accessibilityRole={selecting === true ? "checkbox" : "button"}
          accessibilityState={
            selecting === true ? { checked: selected === true } : undefined
          }
          accessibilityLabel={T("chat.bubble.a11y", {
            sender: item.isMine ? T("chat.you") : item.senderNickname,
            body:
              messageText(item) ||
              messagePreviewText(item) ||
              T("chat.bubble.attachment"),
          })}
          // The ticks are drawn, so their meaning is spoken here, read after
          // the label as each platform reads a value.
          accessibilityValue={
            status !== undefined ? { text: status } : undefined
          }
          // iOS only: TalkBack already says "double tap and hold" for the
          // declared longpress action, and would read the hint after it.
          accessibilityHint={
            selecting === true || Platform.OS !== "ios"
              ? undefined
              : T("chat.bubble.a11y_hint")
          }
          {...bubbleActions()}
        >
          <View
            style={[
              styles.bubble,
              bare
                ? styles.bubbleBare
                : item.isMine
                  ? styles.bubbleMine
                  : styles.bubbleTheirs,
              // Both sides gate on the same run marker the avatar and sender
              // name use, so a run carries exactly one tail either way.
              !item.isMine && isFirstFromSender && styles.bubbleTailTheirs,
              item.isMine && isFirstFromSender && styles.bubbleTailMine,
              highlighted && styles.bubbleHighlighted,
            ]}
          >
            {item.forwarded && (
              <View
                style={[
                  styles.forwardedTag,
                  item.isMine && !bare && styles.forwardedTagMine,
                ]}
              >
                <Feather
                  name="corner-up-right"
                  size={11}
                  color={
                    item.isMine && !bare ? Colors.textInverse : Colors.textMuted
                  }
                />
                <Text
                  style={[
                    styles.forwardedTagText,
                    item.isMine && !bare && styles.forwardedTagTextMine,
                  ]}
                >
                  {T("chat.bubble.forwarded")}
                </Text>
              </View>
            )}

            {/* Tagged like a forwarded message: icon and label above the
                translated text below, findable at a glance in a thread. */}
            {item.ring === true && (
              <View style={styles.ringTag}>
                <Feather
                  name="bell"
                  size={11}
                  color={item.isMine ? Colors.textInverse : Colors.accent}
                />
                <Text
                  style={[
                    styles.ringTagText,
                    item.isMine && styles.ringTagTextMine,
                  ]}
                >
                  {T("chat.contact.ring_action")}
                </Text>
              </View>
            )}

            {item.attachment && renderAttachment(item.attachment)}
            {item.liveVideo && (
              <LiveVideoBubble
                message={item}
                onOpen={selecting === true ? undefined : onOpenLiveVideo}
              />
            )}

            {/* The message text is the one-line summary the conversation list
                and notifications read, so it is suppressed here where the card
                says the same thing better. */}
            {item.locationPin && (
              <LocationCard pin={item.locationPin} isMine={item.isMine} />
            )}

            {item.text.length > 0 && !isPureToken && !item.locationPin && (
              <Text
                style={[
                  styles.messageText,
                  item.isMine
                    ? styles.messageTextMine
                    : styles.messageTextTheirs,
                  { textAlign: contentTextAlign(messageText(item)) },
                ]}
              >
                {renderMessageText(
                  messageText(item),
                  item.isMine
                    ? styles.messageMentionMine
                    : styles.messageMentionTheirs,
                  item.isMine ? styles.messageLinkMine : styles.messageLink,
                  {
                    bold: styles.messageBold,
                    italic: styles.messageItalic,
                    strike: styles.messageStrike,
                    code: item.isMine
                      ? styles.messageCodeMine
                      : styles.messageCodeTheirs,
                  },
                  handleLongPress,
                )}
              </Text>
            )}

            {tokens.map((token) => (
              <React.Fragment key={token.raw}>
                {renderToken(token)}
              </React.Fragment>
            ))}

            <View
              style={[
                styles.metaRow,
                bare && [
                  styles.metaPill,
                  item.isMine ? styles.bubbleMine : styles.bubbleTheirs,
                ],
              ]}
            >
              <Text
                style={[styles.timestamp, item.isMine && styles.timestampMine]}
              >
                {formatTime(item.timestampMs)}
              </Text>
              {/* Delivery ticks, own outgoing messages only (never on system
                  notices or received messages). A failed message's mark is
                  tappable to resend. */}
              {item.isMine &&
                !item.isSystem &&
                item.status !== undefined &&
                (retry ? (
                  <Pressable
                    onPress={retry}
                    hitSlop={hitSlopFor(TICK_SIZE)}
                    accessibilityRole="button"
                    accessibilityLabel={T("chat.bubble.failed_retry")}
                  >
                    <StatusTick status={item.status} Colors={Colors} />
                  </Pressable>
                ) : (
                  <StatusTick status={item.status} Colors={Colors} />
                ))}
            </View>
          </View>
        </Pressable>
      </View>
    </Pressable>
  );
}

// Splits on *bold*, _italic_, ~strike~ and `code` first (see
// message-format.ts for the delimiter rules), then runs the mention/link pass
// below over each span's own text. Formatting spans do not nest inside one
// another, so a second marker inside a span is left as plain characters; code
// is left out of the mention/link pass too, since its content is verbatim.
// A message with no delimiters at all never leaves the fast path.
function renderMessageText(
  text: string,
  mentionStyle: StyleProp<TextStyle>,
  linkStyle: StyleProp<TextStyle>,
  formatStyle: {
    bold: StyleProp<TextStyle>;
    italic: StyleProp<TextStyle>;
    strike: StyleProp<TextStyle>;
    code: StyleProp<TextStyle>;
  },
  onLongPress: () => void,
): React.ReactNode {
  const tokens = tokenizeFormatting(text);
  if (tokens.length === 1 && tokens[0].kind === "text") {
    return renderInlineTokens(text, mentionStyle, linkStyle, onLongPress);
  }
  let key = 0;
  return tokens.map((token) => {
    if (token.kind === "text") {
      return (
        <React.Fragment key={key++}>
          {renderInlineTokens(
            token.value,
            mentionStyle,
            linkStyle,
            onLongPress,
          )}
        </React.Fragment>
      );
    }
    if (token.kind === "code") {
      return (
        <Text key={key++} style={formatStyle.code}>
          {token.value}
        </Text>
      );
    }
    return (
      <Text key={key++} style={formatStyle[token.kind]}>
        {renderInlineTokens(token.value, mentionStyle, linkStyle, onLongPress)}
      </Text>
    );
  });
}

const MENTION_SUFFIX_STYLE: TextStyle = { fontWeight: FontWeight.regular };

// Render message text with @mentions emphasised and URLs tappable, the way
// every chat app does. A mention is an "@" at a word start followed by nickname
// characters; anything else (an email's "@", a lone "@") is left plain.
// Highlighting is syntactic, so it does not need the roster. A link opens in
// the system browser; it keeps the bubble's long-press so a message that is
// nothing but a link can still reach the action sheet.
function renderInlineTokens(
  text: string,
  mentionStyle: StyleProp<TextStyle>,
  linkStyle: StyleProp<TextStyle>,
  onLongPress: () => void,
): React.ReactNode {
  // Every @name that notifies is highlighted, in any script. A location
  // channel's "#abcd" belongs to the mention, drawn lighter as in bitchat.
  // Shared with findMessageLinks, so a screen reader is offered these links.
  const re = inlineTokenPattern();
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const url = m[4];
    if (url === undefined) {
      const lead = m[1];
      // Plain run up to and including the leading whitespace.
      out.push(text.slice(last, m.index + lead.length));
      out.push(
        <Text key={key++} style={mentionStyle}>
          {m[2]}
          {m[3] !== undefined ? (
            <Text style={MENTION_SUFFIX_STYLE}>{m[3]}</Text>
          ) : null}
        </Text>,
      );
      last = m.index + m[0].length;
      continue;
    }
    const trimmed = trimLink(url);
    out.push(text.slice(last, m.index));
    out.push(
      <Text
        key={key++}
        style={linkStyle}
        onPress={() => {
          void Linking.openURL(linkHref(trimmed)).catch(() => {});
        }}
        // Holding a link opens the message actions rather than dead-ending.
        // Text has no delayLongPress, so it crosses at the platform default
        // rather than LONG_PRESS_MS.
        onLongPress={onLongPress}
        suppressHighlighting
        accessibilityRole="link"
      >
        {trimmed}
      </Text>,
    );
    last = m.index + trimmed.length;
  }
  if (last === 0) return text; // nothing matched: raw string, no spans
  out.push(text.slice(last));
  return out;
}

// WhatsApp-shaped delivery ticks: a single check for sent, a double check for
// delivered and read. Not WhatsApp's blue for read: blue means a verified
// contact in this app and nowhere else. Read is instead the one monochrome tick
// drawn at full strength, so a read double check is the delivered one lighting
// up. The dimmed ticks are icons, owed 3:1 (WCAG 1.4.11): 0.55 holds 4.05:1 on
// the dark theme's light bubble, a shade under the timestamp's 0.6 so read
// stands further from delivered.
function StatusTick({
  status,
  Colors,
}: {
  status: MessageStatus;
  Colors: ReturnType<typeof useThemeColors>;
}): React.JSX.Element {
  const dim = { opacity: 0.55 };
  switch (status) {
    case "sending":
      return (
        <MaterialDesignIcons
          name="clock-outline"
          size={TICK_SIZE}
          color={Colors.textInverse}
          style={dim}
        />
      );
    case "sent":
      return (
        <MaterialDesignIcons
          name="check"
          size={TICK_SIZE}
          color={Colors.textInverse}
          style={dim}
        />
      );
    case "carried":
      return (
        <MaterialDesignIcons
          name="account-arrow-right"
          size={TICK_SIZE}
          color={Colors.textInverse}
          style={dim}
        />
      );
    case "queued":
      // Held locally, not handed to anyone: an hourglass, distinct from the
      // courier hand-off ("carried") and the transient "sending" clock.
      return (
        <MaterialDesignIcons
          name="timer-sand"
          size={TICK_SIZE}
          color={Colors.textInverse}
          style={dim}
        />
      );
    case "delivered":
      return (
        <MaterialDesignIcons
          name="check-all"
          size={TICK_SIZE}
          color={Colors.textInverse}
          style={dim}
        />
      );
    case "read":
      return (
        <MaterialDesignIcons
          name="check-all"
          size={TICK_SIZE}
          color={Colors.textInverse}
        />
      );
    case "failed":
      return (
        <MaterialDesignIcons
          name="alert-circle-outline"
          size={TICK_SIZE}
          color={Colors.danger}
        />
      );
    case "reclaimed":
      // An ecash payment the sender pulled back. An undo arrow rather than a
      // tick: no tick would be true of a payment that was taken back.
      return (
        <MaterialDesignIcons
          name="undo-variant"
          size={TICK_SIZE}
          color={Colors.textInverse}
          style={dim}
        />
      );
  }
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    messageRow: {
      flexDirection: "row",
      marginVertical: Spacing["2xs"],
      alignItems: "flex-end",
      gap: Spacing.sm,
    },
    messageRowMine: { justifyContent: "flex-end" },
    selectCheck: {
      width: 22,
      height: 22,
      borderRadius: Radius.full,
      borderWidth: 1.5,
      // A text token doing border duty: a checkbox owes WCAG 1.4.11's 3:1, and
      // borderStrong measures 1.58:1 on the page in light, 1.81:1 in dark.
      borderColor: Colors.textMuted,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
      // The row aligns to flex-end so an avatar sits by its bubble's tail. A
      // row control is not part of the message and opts out.
      alignSelf: "center",
    },
    selectCheckLeading: {
      marginEnd: "auto",
    },
    selectCheckOn: {
      backgroundColor: Colors.accent,
      borderColor: Colors.accent,
    },
    messageRowTheirs: { justifyContent: "flex-start" },
    avatarSpacer: { width: 32, flexShrink: 0 },
    bubbleWrapper: { maxWidth: "75%", gap: 2 },
    bubbleWrapperMine: { alignItems: "flex-end" },
    bubbleWrapperTheirs: { alignItems: "flex-start" },
    senderNameRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      marginBottom: Spacing["2xs"],
    },
    senderName: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
      marginStart: Spacing.md,
    },
    bubble: {
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing["sm-md"],
      borderRadius: Radius.xl,
    },
    bubbleMine: { backgroundColor: Colors.myBubble },
    bubbleTheirs: { backgroundColor: Colors.theirBubble },
    bubbleBare: { paddingHorizontal: 0, paddingVertical: 0 },
    // The squared-off corner pointing at the sender. Logical, because bubbles
    // align by writing direction, or the tail points away in Arabic.
    bubbleTailTheirs: { borderBottomStartRadius: Radius.sm },
    bubbleTailMine: { borderBottomEndRadius: Radius.sm },
    bubbleHighlighted: {
      borderWidth: 2,
      borderColor: Colors.accent,
    },
    messageText: {
      fontSize: FontSize.base,
      lineHeight: LineHeight.base,
    },
    messageTextMine: { color: Colors.textInverse },
    messageTextTheirs: { color: Colors.textPrimary },
    messageMentionMine: {
      color: Colors.textInverse,
      fontWeight: FontWeight.bold,
    },
    messageMentionTheirs: {
      color: Colors.accent,
      fontWeight: FontWeight.bold,
    },
    messageLink: {
      color: Colors.accent,
      textDecorationLine: "underline",
    },
    messageLinkMine: {
      color: Colors.textInverse,
      textDecorationLine: "underline",
    },
    messageBold: { fontWeight: FontWeight.bold },
    messageItalic: { fontStyle: "italic" },
    messageStrike: { textDecorationLine: "line-through" },
    messageCodeMine: {
      fontFamily: FontFamily.mono,
      fontSize: FontSize.sm,
      backgroundColor: withAlpha(Colors.textInverse, 0.16),
      borderRadius: Radius.xs,
    },
    messageCodeTheirs: {
      fontFamily: FontFamily.mono,
      fontSize: FontSize.sm,
      backgroundColor: withAlpha(Colors.textPrimary, 0.08),
      borderRadius: Radius.xs,
    },
    metaRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: Spacing["xs-sm"],
      marginTop: Spacing.xs,
    },
    metaPill: {
      alignSelf: "flex-end",
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing["2xs"],
      borderRadius: Radius.full,
    },
    timestamp: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
    },
    // Text owes 4.5:1: 0.6 holds 4.82:1 on the dark theme's light bubble,
    // where the ticks' 0.55 would give 4.05:1. Light reads 7.2:1.
    timestampMine: { color: Colors.textInverse, opacity: 0.6 },
    forwardedTag: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      marginBottom: Spacing.xs,
    },
    forwardedTagMine: { opacity: 0.7 },
    forwardedTagText: {
      fontSize: FontSize.xs,
      fontStyle: "italic",
      color: Colors.textMuted,
    },
    forwardedTagTextMine: { color: Colors.textInverse },
    ringTag: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      marginBottom: Spacing.xs,
    },
    ringTagText: {
      fontSize: FontSize.xs,
      fontWeight: FontWeight.semibold,
      color: Colors.accent,
    },
    // Your own bubble is filled with the accent, so the tag inverts on it.
    ringTagTextMine: { color: Colors.textInverse },
  });
}

export default React.memo(
  MessageBubble,
  (prev, next) =>
    prev.item === next.item &&
    prev.renderState === next.renderState &&
    prev.showAvatar === next.showAvatar &&
    prev.isFirstFromSender === next.isFirstFromSender &&
    prev.isPureToken === next.isPureToken &&
    prev.highlighted === next.highlighted &&
    prev.selecting === next.selecting &&
    prev.selected === next.selected,
);
