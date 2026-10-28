// Going live: a full-screen camera that previews exactly the 3:4 frame
// viewers get, then streams it to the chat it was opened from.
//
// Before going live the quality, the camera and the microphone can all be
// changed; once live only the camera can, since START has told viewers what
// the stream carries. End, close and system back ask first (End, Discard or
// Keep streaming). Every other way out (the app going to the background, the
// camera being taken, the thread going away) ends the stream with END and
// hands its recording back to the thread. Only Discard sends CANCELED, which
// tells viewers to drop what they have.
//
// Mounted only while open. Permissions are the thread's to ask first: a
// blocked-permission alert drawn from here would sit under this modal, and for
// the same reason this screen carries its own toast.

import type { CameraFacing } from "@bridge/NativeAirhopVideo";
import { AirhopCameraPreview } from "@bridge/NativeAirhopVideoViews";
import {
  LIVE_VIDEO_QUALITIES,
  type LiveVideoQualityName,
} from "@core/mesh/video/live-video-quality";
import { t, useT, type TranslationKey } from "@i18n";
import { acknowledged, held } from "@platform/haptics";
import {
  Feather,
  type FeatherIconName,
} from "@react-native-vector-icons/feather/static";
import {
  LiveVideoSendSession,
  type FinishedLiveVideo,
  type LiveVideoSendStats,
} from "@services/live-video-sender";
import { getMeshService, type MeshService } from "@services/mesh-service";
import AppModal from "@ui/components/app-modal";
import PrimaryButton from "@ui/components/primary-button";
import RingAlertSheet from "@ui/components/ring-alert-sheet";
import TextButton from "@ui/components/text-button";
import Toast from "@ui/components/toast";
import UpperText from "@ui/components/upper-text";
import {
  DISABLED_OPACITY,
  FontSize,
  FontWeight,
  MIN_TOUCH,
  PRESSED_OPACITY,
  Radius,
  Spacing,
  useThemeColors,
} from "@ui/theme";
import { formatDuration } from "@utils/format";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AppState,
  BackHandler,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type Phase = "preview" | "starting" | "live" | "ending";

const QUALITIES: { name: LiveVideoQualityName; labelKey: TranslationKey }[] = [
  { name: "low", labelKey: "chat.live_video.quality_low" },
  { name: "medium", labelKey: "chat.live_video.quality_medium" },
  { name: "high", labelKey: "chat.live_video.quality_high" },
];

const QUALITY_HINT: Record<LiveVideoQualityName, TranslationKey> = {
  low: "chat.live_video.quality_low_hint",
  medium: "chat.live_video.quality_medium_hint",
  high: "chat.live_video.quality_high_hint",
};

const CONTROL_SIZE = MIN_TOUCH;
// How often the timer and the signal meter refresh while live.
const STATS_INTERVAL_MS = 500;

function signalOf(stats: LiveVideoSendStats | null): 0 | 1 | 2 {
  if (stats === null) return 2;
  if (stats.skipping) return 0;
  return stats.congested ? 1 : 2;
}

// Three bars of rising height, as a phone's signal meter draws them.
const SIGNAL_BAR_HEIGHTS = [Spacing.sm, Spacing.md, Spacing.base];

const SIGNAL_KEY: Record<0 | 1 | 2, TranslationKey> = {
  0: "chat.live_video.signal_poor",
  1: "chat.live_video.signal_weak",
  2: "chat.live_video.signal_good",
};

interface Props {
  channel: string;
  // Whom the stream reaches, for the line under the preview: null for the
  // Bluetooth room, a name for a DM.
  audienceName: string | null;
  micAllowed: boolean;
  onClose: () => void;
  // The stream ended and left a recording.
  onFinished: (recording: FinishedLiveVideo) => void;
  onToast: (message: string) => void;
}

export default function LiveVideoStudio({
  channel,
  audienceName,
  micAllowed,
  onClose,
  onFinished,
  onToast,
}: Props): React.JSX.Element {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);

  const [phase, setPhase] = useState<Phase>("preview");
  const [quality, setQuality] = useState<LiveVideoQualityName>("low");
  // Read when the camera reopens for a new quality; a flip goes to the open
  // camera directly. Nothing renders from it, so it is a ref, not state.
  const facingRef = useRef<CameraFacing>("front");
  const [micOn, setMicOn] = useState(micAllowed);
  const [cameraReady, setCameraReady] = useState(false);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [stats, setStats] = useState<LiveVideoSendStats | null>(null);
  const [canGoLive, setCanGoLive] = useState(false);
  // Whether the stream carries sound: the mic switch, unless no microphone
  // opened.
  const [liveWithSound, setLiveWithSound] = useState(true);
  const [toast, setToast] = useState<{
    message: string;
    icon: FeatherIconName;
  } | null>(null);
  const hideToast = useCallback(() => setToast(null), []);

  const phaseRef = useRef<Phase>("preview");
  const setPhaseBoth = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);
  const sessionRef = useRef<LiveVideoSendSession | null>(null);
  const callbacks = useRef({ onClose, onFinished, onToast });
  useEffect(() => {
    callbacks.current = { onClose, onFinished, onToast };
  });

  // The camera follows the quality, so the preview always shows the frame the
  // stream will have.
  useEffect(() => {
    if (phaseRef.current !== "preview") return;
    let cancelled = false;
    setCameraReady(false);
    LiveVideoSendSession.openCamera(
      LIVE_VIDEO_QUALITIES[quality],
      facingRef.current,
    )
      .then(() => {
        if (!cancelled) setCameraReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        callbacks.current.onToast(t("chat.live_video.camera_failed"));
        callbacks.current.onClose();
      });
    return () => {
      cancelled = true;
    };
  }, [quality]);

  // Whether anyone can watch: re-asked throughout, since peers walk into and
  // out of range with the camera open, and a stream sent to nobody should say
  // so rather than show a healthy signal.
  useEffect(() => {
    const check = (): void => {
      const mesh = getMeshService();
      // A DM peer who walks into range with no session yet gets one opened.
      mesh?.prepareLiveVideo(channel);
      setCanGoLive(mesh?.canSendLiveVideo(channel) === true);
    };
    check();
    const timer = setInterval(check, 2_000);
    return () => clearInterval(timer);
  }, [channel]);

  const end = useCallback(
    async (canceled: boolean): Promise<void> => {
      // A second tap while the first is still sending END.
      if (phaseRef.current === "ending") return;
      const mesh: MeshService | null = getMeshService();
      if (phaseRef.current === "live" || phaseRef.current === "starting") {
        setPhaseBoth("ending");
        const recording =
          (await mesh?.stopLiveVideo(canceled, sessionRef.current)) ?? null;
        sessionRef.current = null;
        if (recording !== null) callbacks.current.onFinished(recording);
      }
      callbacks.current.onClose();
    },
    [setPhaseBoth],
  );

  const goLive = useCallback(async (): Promise<void> => {
    const mesh = getMeshService();
    if (mesh === null || phaseRef.current !== "preview") return;
    held();
    setPhaseBoth("starting");
    const session = await mesh.startLiveVideo(
      channel,
      LIVE_VIDEO_QUALITIES[quality],
      micOn,
      () => {
        // Said by the thread once the studio has closed: shown now, it would
        // fade under this modal while END drains.
        void end(false).then(() =>
          callbacks.current.onToast(t("chat.live_video.camera_lost")),
        );
      },
    );
    // Ended while starting (the camera lost, the studio closing) by a caller
    // that has already stopped the stream. Widened: the check at the top
    // narrowed the ref to "preview", and narrowing does not see the await.
    if ((phaseRef.current as Phase) !== "starting") return;
    if (session === null) {
      setPhaseBoth("preview");
      setToast({ message: t("chat.live_video.failed"), icon: "alert-circle" });
      return;
    }
    sessionRef.current = session;
    setLiveWithSound(session.summary().withSound);
    acknowledged();
    setPhaseBoth("live");
    // Sent to the background while starting, which the AppState listener
    // below only acts on once live.
    if (AppState.currentState === "background") void end(false);
  }, [channel, quality, micOn, end, setPhaseBoth]);

  const endRef = useRef(end);
  useEffect(() => {
    endRef.current = end;
  });

  useEffect(() => {
    if (phase !== "live") return;
    const timer = setInterval(() => {
      const session = sessionRef.current;
      // Ended from outside (the mesh stopped): close as an End would, which
      // still hands the recording back.
      if (session !== null && !session.isRunning) {
        void endRef.current(false);
        return;
      }
      setStats(session?.stats() ?? null);
    }, STATS_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [phase]);

  // Going to the background ends the stream: the camera stops there on both
  // platforms. Not on inactive, which iOS reports for Control Center and a
  // call banner, both of which leave the camera running.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background" && phaseRef.current === "live") {
        void endRef.current(false);
      }
    });
    return () => sub.remove();
  }, []);

  // The camera is released when the studio goes. A stream still live then ends
  // and its recording is still handed back: the thread can go from under a
  // live studio, as when a ring is answered. One still starting ends too, and
  // the start, when it returns, finds the studio already ending.
  useEffect(() => {
    return () => {
      if (phaseRef.current === "live" || phaseRef.current === "starting") {
        phaseRef.current = "ending";
        void getMeshService()
          ?.stopLiveVideo(false, sessionRef.current)
          .then((recording) => {
            if (recording !== null) callbacks.current.onFinished(recording);
          });
      }
      void LiveVideoSendSession.closeCamera();
    };
  }, []);

  const requestClose = useCallback((): void => {
    if (phaseRef.current === "live") {
      setConfirmingEnd(true);
      return;
    }
    if (phaseRef.current === "preview") callbacks.current.onClose();
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      requestClose();
      return true;
    });
    return () => sub.remove();
  }, [requestClose]);

  const flip = useCallback((): void => {
    const previous = facingRef.current;
    const next: CameraFacing = previous === "front" ? "back" : "front";
    facingRef.current = next;
    // A phone with one camera keeps the one it has.
    void LiveVideoSendSession.setFacing(next).catch(() => {
      facingRef.current = previous;
    });
  }, []);

  // The microphone is optional, so a blocked one is said here rather than by
  // an alert, which would open under this modal.
  const toggleMic = useCallback((): void => {
    if (!micAllowed) {
      setToast({
        message: t("permission.blocked_title", {
          label: t("chat.perm.mic_label"),
        }),
        icon: "mic-off",
      });
      return;
    }
    setMicOn((on) => !on);
  }, [micAllowed]);

  const live = phase === "live";
  const busy = phase === "starting" || phase === "ending";
  const preset = LIVE_VIDEO_QUALITIES[quality];
  const signal = signalOf(stats);
  const audience =
    audienceName === null
      ? T("chat.live_video.audience_room")
      : T("chat.live_video.audience_dm", { name: audienceName });

  return (
    <AppModal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={requestClose}
    >
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <View style={styles.topBar}>
          <Pressable
            onPress={requestClose}
            disabled={busy}
            style={({ pressed }) => [
              styles.iconButton,
              busy && styles.disabled,
              pressed && styles.dimmed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={T("common.close")}
            accessibilityState={{ disabled: busy }}
          >
            <Feather name="x" size={22} color={Colors.textPrimary} />
          </Pressable>
          {live ? (
            <View style={styles.liveRow}>
              {/* Announced once, on going live; the timer below changes
                  every second and would be read out every second. */}
              <View style={styles.liveBadge} accessibilityLiveRegion="polite">
                <View style={styles.liveDot} />
                <UpperText style={styles.liveBadgeText}>
                  {T("chat.live_video.badge")}
                </UpperText>
              </View>
              <Text style={styles.timer}>
                {formatDuration(Math.floor((stats?.elapsedMs ?? 0) / 1000))}
              </Text>
              {!liveWithSound && (
                <Feather
                  name="mic-off"
                  size={16}
                  color={Colors.textSecondary}
                  accessible
                  accessibilityLabel={T("chat.live_video.no_sound")}
                />
              )}
            </View>
          ) : (
            <Text style={styles.title}>{T("chat.live_video.title")}</Text>
          )}
          <Pressable
            onPress={flip}
            disabled={busy || !cameraReady}
            style={({ pressed }) => [
              styles.iconButton,
              (busy || !cameraReady) && styles.disabled,
              pressed && styles.dimmed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={T("chat.live_video.flip")}
            accessibilityState={{ disabled: busy || !cameraReady }}
          >
            <Feather name="refresh-cw" size={20} color={Colors.textPrimary} />
          </Pressable>
        </View>

        <View style={styles.stage}>
          <View
            style={[
              styles.frame,
              { aspectRatio: preset.width / preset.height },
              live && styles.frameLive,
            ]}
          >
            {cameraReady && <AirhopCameraPreview style={styles.fill} />}
          </View>
          {live && !canGoLive ? (
            <Text style={styles.caption}>{T("chat.live_video.nobody")}</Text>
          ) : live ? (
            <View
              style={styles.signalRow}
              accessible
              accessibilityLabel={T(SIGNAL_KEY[signal])}
            >
              {[0, 1, 2].map((bar) => (
                <View
                  key={bar}
                  style={[
                    styles.signalBar,
                    { height: SIGNAL_BAR_HEIGHTS[bar] },
                    bar <= signal && styles.signalBarOn,
                    signal === 0 && bar === 0 && styles.signalBarPoor,
                  ]}
                />
              ))}
              <Text style={styles.caption}>{T(SIGNAL_KEY[signal])}</Text>
            </View>
          ) : (
            <Text style={styles.caption}>
              {canGoLive ? audience : T("chat.live_video.nobody")}
            </Text>
          )}
          <Toast
            message={toast?.message ?? null}
            icon={toast?.icon}
            onHide={hideToast}
          />
        </View>

        <View style={styles.footer}>
          {confirmingEnd ? (
            <View style={styles.confirm}>
              <Text style={styles.confirmTitle}>
                {T("chat.live_video.end_title")}
              </Text>
              <Text style={styles.confirmBody}>
                {T("chat.live_video.end_body")}
              </Text>
              <PrimaryButton
                label={T("chat.live_video.end")}
                onPress={() => void end(false)}
              />
              <PrimaryButton
                variant="outline"
                label={T("chat.live_video.discard")}
                onPress={() => void end(true)}
              />
              <TextButton
                label={T("chat.live_video.keep")}
                onPress={() => setConfirmingEnd(false)}
              />
            </View>
          ) : live || busy ? (
            <PrimaryButton
              label={T("chat.live_video.end")}
              onPress={() => setConfirmingEnd(true)}
              disabled={busy}
            />
          ) : (
            <>
              <View style={styles.tabs} accessibilityRole="radiogroup">
                {QUALITIES.map(({ name, labelKey }) => (
                  <Pressable
                    key={name}
                    style={({ pressed }) => [
                      styles.tab,
                      quality === name && styles.tabActive,
                      pressed && styles.dimmed,
                    ]}
                    onPress={() => setQuality(name)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: quality === name }}
                  >
                    <Text
                      style={[
                        styles.tabText,
                        quality === name && styles.tabTextActive,
                      ]}
                    >
                      {T(labelKey)}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.hint}>{T(QUALITY_HINT[quality])}</Text>
              <View style={styles.actions}>
                <Pressable
                  onPress={toggleMic}
                  style={({ pressed }) => [
                    styles.round,
                    !micOn && styles.roundOff,
                    !micAllowed && styles.disabled,
                    pressed && styles.roundPressed,
                  ]}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: micOn }}
                  accessibilityLabel={T("chat.live_video.mic")}
                  accessibilityHint={
                    micAllowed
                      ? undefined
                      : T("permission.blocked_body", {
                          purpose: T("chat.perm.live_video_purpose"),
                        })
                  }
                >
                  <Feather
                    name={micOn ? "mic" : "mic-off"}
                    size={18}
                    color={micOn ? Colors.textPrimary : Colors.textMuted}
                  />
                </Pressable>
                <PrimaryButton
                  style={styles.goLive}
                  label={T("chat.live_video.go_live")}
                  onPress={() => void goLive()}
                  disabled={!canGoLive || !cameraReady}
                  accessibilityHint={
                    canGoLive ? undefined : T("chat.live_video.nobody")
                  }
                />
              </View>
            </>
          )}
        </View>
      </SafeAreaView>
      <RingAlertSheet />
    </AppModal>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: Colors.bg,
    },
    topBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.base,
      paddingVertical: Spacing.xs,
    },
    iconButton: {
      width: CONTROL_SIZE,
      height: CONTROL_SIZE,
      alignItems: "center",
      justifyContent: "center",
    },
    title: {
      fontSize: FontSize.md,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
    },
    liveRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    liveBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing["2xs"],
      borderRadius: Radius.full,
      backgroundColor: Colors.danger,
    },
    liveDot: {
      width: Spacing["xs-sm"],
      height: Spacing["xs-sm"],
      borderRadius: Radius.full,
      backgroundColor: Colors.onStatus,
    },
    liveBadgeText: {
      fontSize: FontSize.xs,
      fontWeight: FontWeight.bold,
      color: Colors.onStatus,
    },
    timer: {
      fontSize: FontSize.md,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
      fontVariant: ["tabular-nums"],
    },
    stage: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.md,
      paddingHorizontal: Spacing.xl,
    },
    frame: {
      flex: 1,
      maxWidth: "100%",
      borderRadius: Radius.xl,
      overflow: "hidden",
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 2,
      borderColor: Colors.border,
    },
    frameLive: {
      borderColor: Colors.danger,
    },
    fill: {
      flex: 1,
    },
    caption: {
      fontSize: FontSize.sm,
      color: Colors.textSecondary,
      textAlign: "center",
    },
    signalRow: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: Spacing["2xs"],
    },
    signalBar: {
      width: Spacing.xs,
      borderRadius: Radius.xs,
      backgroundColor: Colors.border,
    },
    signalBarOn: {
      backgroundColor: Colors.textPrimary,
    },
    signalBarPoor: {
      backgroundColor: Colors.danger,
    },
    footer: {
      paddingHorizontal: Spacing.xl,
      paddingBottom: Spacing.base,
      paddingTop: Spacing.md,
      gap: Spacing.md,
    },
    tabs: {
      flexDirection: "row",
      backgroundColor: Colors.surfaceRaised,
      borderRadius: Radius.full,
      padding: Spacing["2xs"],
    },
    tab: {
      flex: 1,
      minHeight: MIN_TOUCH,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: Radius.full,
    },
    tabActive: { backgroundColor: Colors.surface },
    tabText: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.medium,
      color: Colors.textSecondary,
    },
    tabTextActive: { color: Colors.textPrimary },
    hint: {
      fontSize: FontSize.sm,
      color: Colors.textMuted,
      textAlign: "center",
    },
    actions: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
    },
    round: {
      width: CONTROL_SIZE,
      height: CONTROL_SIZE,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: Colors.surfaceRaised,
    },
    roundOff: {
      backgroundColor: Colors.surface,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    goLive: {
      flex: 1,
    },
    confirm: {
      gap: Spacing.sm,
    },
    confirmTitle: {
      fontSize: FontSize.md,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
      textAlign: "center",
    },
    confirmBody: {
      fontSize: FontSize.sm,
      color: Colors.textSecondary,
      textAlign: "center",
      marginBottom: Spacing.xs,
    },
    dimmed: {
      opacity: PRESSED_OPACITY,
    },
    roundPressed: {
      backgroundColor: Colors.surfacePressed,
    },
    disabled: {
      opacity: DISABLED_OPACITY,
    },
  });
}
