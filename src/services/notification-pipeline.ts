// The listeners that turn arriving messages, rings and peers into system
// notifications, bell entries and the app icon badge.
//
// Module level rather than in a component, because the mesh outlives the UI.
// Swiping the app from recents on Android destroys the Activity and unmounts
// React while the foreground service keeps the mesh running, and a boot start
// never mounts it at all. Started with the mesh (app.tsx startMeshDependents and
// boot-start), stopped by the panic wipe.
//
// Everything a handler consults is read when the event arrives, so a mute, a
// setting or the open thread changed while it runs is honoured. What needs
// React stays in app.tsx: the navigators a tapped notification routes through,
// and which thread is on screen.
//
// Kept free of mesh-service: panic-wipe imports this, and must stay loadable
// without the native BLE module that mesh-service pulls in.

import { ringPulse } from "@platform/haptics";
import { useActivityStore } from "@store/activity-store";
import { subscribeInboundMessages, useChatStore } from "@store/chat-store";
import { useIncomingRingStore } from "@store/incoming-ring-store";
import { countReachablePeers, usePeerStore } from "@store/peer-store";
import { subscribeInboundRings } from "@store/ring-store";
import { useSettingsStore } from "@store/settings-store";
import { mentionsNickname } from "@utils/mentions";
import { messagePreviewEntry } from "@utils/message-preview";
import { systemPreview } from "@utils/message-text";
import { sumUnread } from "@utils/unread";
import { AppState, Platform } from "react-native";
import {
  configureNotifications,
  endAllRingAlerts,
  handleInboundMessage,
  handleNearbyPeers,
  isAppActive,
  isReadingChannel,
  raiseRingNotification,
  setAppBadgeCount,
  setNotificationsAppActive,
} from "./notification-service";

let stops: (() => void)[] | null = null;
// The local user's nickname, for mentions. A getter handed over by whoever
// started the pipeline, since this module cannot reach the mesh.
let ownNickname: () => string = () => "";

// Idempotent: a second call only refreshes the nickname getter, so every path
// that brings a mesh up may call it without stacking listeners.
export function startNotificationPipeline(nickname: () => string): void {
  ownNickname = nickname;
  if (stops !== null) return;

  // Whether a banner is owed depends on the app being in front, and nothing
  // else is guaranteed to be listening to say so: a boot start has no UI, and
  // the service's own default is "in front".
  setNotificationsAppActive(AppState.currentState === "active");
  const appState = AppState.addEventListener("change", (next) => {
    setNotificationsAppActive(next === "active");
  });

  const stopMessages = subscribeInboundMessages((msg) => {
    const chat = useChatStore.getState();
    const isMuted = chat.mutedChannels.includes(msg.channel);
    // Being @-mentioned overrides mute, the way every major chat app treats a
    // mention: even a muted channel pings and logs a bell entry when it is you
    // being addressed by name.
    const mentionsMe =
      !msg.isSystem && mentionsNickname(msg.text, ownNickname());
    // A muted conversation otherwise stays silent: no system notification, no
    // haptic, and no bell entry. Its unread still shows on its own row.
    if (isMuted && !mentionsMe) return;
    void handleInboundMessage(
      msg,
      sumUnread(chat.unreadCounts, chat.mutedChannels),
      mentionsMe,
    );
    // Bell history logs real notifications only: skip the conversation being
    // read (that is not a notification), the same activeChannel rule the
    // unread count uses.
    if (!msg.isSystem && msg.channel !== chat.activeChannel) {
      useActivityStore.getState().record({
        id: msg.id,
        channel: msg.channel,
        isDM: msg.channel.startsWith("dm:"),
        senderID: msg.senderID,
        senderNickname: msg.senderNickname,
        // Spread, so an attachment with no caption logs its key too and the
        // bell reads in the current language rather than the arrival one.
        ...messagePreviewEntry(msg),
        timestampMs: msg.timestampMs,
      });
    }
  });

  // Nearby peers, while nobody is looking. Counted by the store's own
  // reachability rule rather than by map size, because a peer who left without
  // a LEAVE lingers in the map: both sides of the change are measured with one
  // clock so the comparison is honest. When it is worth a notification is
  // shouldNotifyNearby's call.
  const stopPeers = usePeerStore.subscribe((state, prev) => {
    const nowMs = Date.now();
    void handleNearbyPeers(
      countReachablePeers(state.peers, nowMs),
      countReachablePeers(prev.peers, nowMs),
    );
  });

  // mesh-service.onRing already decided this ring should alert; only where is
  // decided here. Looking at the sender's own thread gets one pulse: the bell
  // row has just landed in front of them and the thread's read-receipt effect
  // acknowledges it. Otherwise the overlay goes up, foreground or not, the way
  // a call screen does; the tray is told as well when the overlay cannot be
  // seen, and always on iOS, where the tray's pulses are the only sound a ring
  // has.
  const stopRings = subscribeInboundRings((ring) => {
    const channel = `dm:${ring.peerID}`;
    if (isReadingChannel(channel)) {
      ringPulse();
      return;
    }
    // Logged like any other notification, so a ring missed while the phone was
    // in a bag is found under the bell.
    useActivityStore.getState().record({
      id: ring.ringID,
      channel,
      isDM: true,
      senderID: ring.peerID,
      senderNickname: ring.senderName,
      ...systemPreview("chat.ring.received_summary"),
      timestampMs: ring.receivedAtMs,
    });
    useIncomingRingStore.getState().show(ring);
    if (!isAppActive() || Platform.OS === "ios") {
      void raiseRingNotification(ring.peerID, ring.senderName);
    }
  });

  // The icon badge is total unread, muted conversations excluded. Here rather
  // than in a render, so it keeps counting while no screen exists.
  const unreadNow = (): number => {
    const chat = useChatStore.getState();
    return sumUnread(chat.unreadCounts, chat.mutedChannels);
  };
  let badge = unreadNow();
  void setAppBadgeCount(badge);
  const stopBadge = useChatStore.subscribe(() => {
    const next = unreadNow();
    if (next === badge) return;
    badge = next;
    void setAppBadgeCount(next);
  });

  const stopRingSetting = useSettingsStore.subscribe((state, prev) => {
    if (prev.ringAlertsEnabled && !state.ringAlertsEnabled) {
      void endAllRingAlerts();
    }
  });

  // Channels and the notification handler, which a boot start needs before its
  // first notification. Latched inside, so the UI calling it too is free.
  void configureNotifications();

  stops = [
    () => appState.remove(),
    stopMessages,
    stopPeers,
    stopRings,
    stopBadge,
    stopRingSetting,
  ];
}

// For the panic wipe: nothing arriving while it runs may reach the bell, the
// tray or the badge. The next mesh starts it again.
export function stopNotificationPipeline(): void {
  const current = stops;
  stops = null;
  ownNickname = () => "";
  current?.forEach((stop) => stop());
}
