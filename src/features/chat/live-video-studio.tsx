// Going live: a full-screen camera that previews exactly the 3:4 frame
// viewers get, then streams it to the chat it was opened from.
//
// Before going live the quality, the camera and the microphone can all be
// changed; once live only the camera can, since START has told viewers what
// the stream carries. Leaving any way at all (the close button, system back,
// the app losing the foreground, the camera being taken) ends the stream with
// END rather than abandoning it, and the recording comes back to the thread.
// Only "Discard" sends CANCELED, which tells viewers to drop what they have.
//
// Permissions are the thread's to ask before this opens: a blocked-permission
// alert drawn from here would sit under this modal.

import type { CameraFacing } from "@bridge/NativeAirhopVideo";
import { AirhopCameraPreview } from "@bridge/NativeAirhopVideoViews";
import {
  LIVE_VIDEO_QUALITIES,
  type LiveVideoQualityName,
} from "@core/mesh/video/live-video-quality";
import { t, useT, type TranslationKey } from "@i18n";
import { acknowledged, held } from "@platform/haptics";
import { Feather } from "@react-native-vector-icons/feather/static";
import {
  LiveVideoSendSession,
  type FinishedLiveVideo,
  type LiveVideoSendStats,
} from "@services/live-video-sender";
import { getMeshService, type MeshService } from "@services/mesh-service";
import AppModal from "@ui/components/app-modal";
import PrimaryButton from "@ui/components/primary-button";
import UpperText from "@ui/components/upper-text";
import {
  FontSize,
  FontWeight,
  hitSlopFor,
  MIN_TOUCH,
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

// Matches the compose row's round controls.
const CONTROL_SIZE = 44;
// How often the timer and the signal meter refresh while live.
const STATS_INTERVAL_MS = 500;

// Packets waiting to leave, as the congestion controller reads them: under its
// high water the link is keeping up, past its skip water video is dropping.
function signalOf(stats: LiveVideoSendStats | null): 0 | 1 | 2 {
  if (stats === null) return 2;
  if (stats.skipping) return 0;
  return stats.backlog >= 14 ? 1 : 2;
}

// Three bars of rising height, as a phone's signal meter draws them.
const SIGNAL_BAR_HEIGHTS = [Spacing.sm, Spacing.md, Spacing.base];

const SIGNAL_KEY: Record<0 | 1 | 2, TranslationKey> = {
  0: "chat.live_video.signal_poor",
  1: "chat.live_video.signal_weak",
  2: "chat.live_video.signal_good",
};

interface Props {
  visible: boolean;
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
  visible,
  channel,
  audienceName,
  micAllowed,
  onClose,
  onFinished,
  onToast,
}: Props): React.JSX.Element | null {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);

  const [phase, setPhase] = useState<Phase>("preview");
  const [quality, setQuality] = useState<LiveVideoQualityName>("low");
  const [facing, setFacing] = useState<CameraFacing>("front");
  // Read when the camera reopens for a new quality; a flip goes to the open
  // camera directly.
  const facingRef = useRef<CameraFacing>("front");
  const [micOn, setMicOn] = useState(micAllowed);
  const [cameraReady, setCameraReady] = useState(false);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [stats, setStats] = useState<LiveVideoSendStats | null>(null);
  const [canGoLive, setCanGoLive] = useState(false);

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
    if (!visible || phaseRef.current !== "preview") return;
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
  }, [visible, quality]);

  // Whether anyone can watch: re-asked while previewing, since a peer can
  // walk into range with the camera already open.
  useEffect(() => {
    if (!visible || phase !== "preview") return;
    const check = (): void =>
      setCanGoLive(getMeshService()?.canSendLiveVideo(channel) === true);
    check();
    const timer = setInterval(check, 2_000);
    return () => clearInterval(timer);
  }, [visible, phase, channel]);

  useEffect(() => {
    if (phase !== "live") return;
    const timer = setInterval(() => {
      setStats(sessionRef.current?.stats() ?? null);
    }, STATS_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [phase]);

  const end = useCallback(
    async (canceled: boolean): Promise<void> => {
      const mesh: MeshService | null = getMeshService();
      if (phaseRef.current === "live" || phaseRef.current === "starting") {
        setPhaseBoth("ending");
        const recording = (await mesh?.stopLiveVideo(canceled)) ?? null;
        sessionRef.current = null;
        if (recording !== null) callbacks.current.onFinished(recording);
      }
      setConfirmingEnd(false);
      setStats(null);
      setPhaseBoth("preview");
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
        callbacks.current.onToast(t("chat.live_video.camera_lost"));
        void end(false);
      },
    );
    if (session === null) {
      setPhaseBoth("preview");
      callbacks.current.onToast(t("chat.live_video.failed"));
      return;
    }
    sessionRef.current = session;
    acknowledged();
    setPhaseBoth("live");
  }, [channel, quality, micOn, end, setPhaseBoth]);

  // Leaving the app ends the stream: the camera stops in the background on
  // both platforms, and a stream with no picture is not live.
  const endRef = useRef(end);
  useEffect(() => {
    endRef.current = end;
  });
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active" && phaseRef.current === "live") {
        void endRef.current(false);
      }
    });
    return () => sub.remove();
  }, []);

  // The camera is released whenever the studio closes or goes away, and a
  // stream still live then ends with END rather than being left running.
  useEffect(() => {
    if (!visible) return;
    return () => {
      if (phaseRef.current === "live" || phaseRef.current === "starting") {
        void getMeshService()?.stopLiveVideo(false);
      }
      void LiveVideoSendSession.closeCamera();
    };
  }, [visible]);

  const requestClose = useCallback((): void => {
    if (phaseRef.current === "live") {
      setConfirmingEnd(true);
      return;
    }
    if (phaseRef.current === "preview") void end(true);
  }, [end]);

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      requestClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, requestClose]);

  const flip = useCallback((): void => {
    const next: CameraFacing = facing === "front" ? "back" : "front";
    facingRef.current = next;
    setFacing(next);
    void LiveVideoSendSession.setFacing(next).catch(() => undefined);
  }, [facing]);

  if (!visible) return null;

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
            style={styles.iconButton}
            hitSlop={hitSlopFor(CONTROL_SIZE)}
            accessibilityRole="button"
            accessibilityLabel={T("common.close")}
          >
            <Feather name="x" size={22} color={Colors.textPrimary} />
          </Pressable>
          {live ? (
            <View style={styles.liveRow} accessibilityLiveRegion="polite">
              <View style={styles.liveBadge}>
                <View style={styles.liveDot} />
                <UpperText style={styles.liveBadgeText}>
                  {T("chat.live_video.badge")}
                </UpperText>
              </View>
              <Text style={styles.timer}>
                {formatDuration(Math.floor((stats?.elapsedMs ?? 0) / 1000))}
              </Text>
            </View>
          ) : (
            <Text style={styles.title}>{T("chat.live_video.title")}</Text>
          )}
          <Pressable
            onPress={flip}
            disabled={busy}
            style={styles.iconButton}
            hitSlop={hitSlopFor(CONTROL_SIZE)}
            accessibilityRole="button"
            accessibilityLabel={T("chat.live_video.flip")}
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
          {live ? (
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
              <Pressable
                onPress={() => setConfirmingEnd(false)}
                style={styles.keep}
                accessibilityRole="button"
              >
                <Text style={styles.keepText}>{T("chat.live_video.keep")}</Text>
              </Pressable>
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
                    style={[styles.tab, quality === name && styles.tabActive]}
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
                  onPress={() => setMicOn((on) => !on)}
                  disabled={!micAllowed}
                  style={[styles.round, !micOn && styles.roundOff]}
                  hitSlop={hitSlopFor(CONTROL_SIZE)}
                  accessibilityRole="switch"
                  accessibilityState={{
                    checked: micOn,
                    disabled: !micAllowed,
                  }}
                  accessibilityLabel={T("chat.live_video.mic")}
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
    // The one place the stream's state shows without words: red while live.
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
    keep: {
      minHeight: MIN_TOUCH,
      alignItems: "center",
      justifyContent: "center",
    },
    keepText: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.medium,
      color: Colors.textSecondary,
    },
  });
}
