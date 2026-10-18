// Privacy & Security sub-screen: the always-on Double Ratchet / packet-signing
// guarantees, the app lock, notification privacy, and the blocked-peer list.
//
// The connectivity toggles (live voice, Tor, gateway, bridge) sit on the settings
// hub itself rather than here, one drill-in away, because they are the switches
// people come to flip. See connectivity-group.tsx.

import { t, useT, type TranslationKey } from "@i18n";
import { Feather } from "@react-native-vector-icons/feather/static";
import { disableAppLock, enableAppLock } from "@services/app-lock";
import { openBackgroundNoticeSettings } from "@services/background-notice";
import { dismissPreviewNotifications } from "@services/notification-service";
import { showAlert } from "@store/alert-store";
import { useBlockedStore } from "@store/blocked-store";
import {
  APP_LOCK_DELAY_OPTIONS,
  useSettingsStore,
  type AppLockDelaySeconds,
} from "@store/settings-store";
import BottomSheet from "@ui/components/bottom-sheet";
import UpperText from "@ui/components/upper-text";
import { HIT_SLOP, useThemeColors } from "@ui/theme";
import { resolveDisplayName } from "@utils/peer-display-name";
import React, { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import {
  GroupDivider,
  SettingLinkRow,
  SettingRow,
  SettingSwitch,
  SettingsScroll,
  SubHeader,
  useSharedStyles,
} from "../settings-primitives";

// Keys, translated on render.
const APP_LOCK_DELAY_LABELS: Record<AppLockDelaySeconds, TranslationKey> = {
  0: "settings.security.lock_immediately",
  60: "settings.security.lock_after_1m",
  300: "settings.security.lock_after_5m",
  1800: "settings.security.lock_after_30m",
};

interface Props {
  onBack: () => void;
}

export default function SecurityScreen({ onBack }: Props): React.JSX.Element {
  const Colors = useThemeColors();
  const styles = useSharedStyles();
  const T = useT();
  // Subscribe to the array itself (not the isBlocked function, whose identity
  // never changes) so the list re-renders when a block is added or removed.
  const blockedPeerIDs = useBlockedStore((s) => s.blockedPeerIDs);
  const hideNotificationPreviews = useSettingsStore(
    (s) => s.hideNotificationPreviews,
  );
  const ringAlertsEnabled = useSettingsStore((s) => s.ringAlertsEnabled);
  const backgroundMeshEnabled = useSettingsStore(
    (s) => s.backgroundMeshEnabled,
  );
  const appLockEnabled = useSettingsStore((s) => s.appLockEnabled);
  const appLockDelaySeconds = useSettingsStore((s) => s.appLockDelaySeconds);
  const [showDelaySheet, setShowDelaySheet] = useState(false);
  // The prompt is on screen: a second tap would only queue another.
  const [arming, setArming] = useState(false);

  async function toggleAppLock(on: boolean): Promise<void> {
    if (!on) {
      disableAppLock();
      return;
    }
    setArming(true);
    try {
      const result = await enableAppLock();
      if (result === "no-lock") {
        showAlert(
          t("settings.security.app_lock_no_screen_lock"),
          t("settings.security.app_lock_no_screen_lock_body"),
        );
      }
    } finally {
      setArming(false);
    }
  }

  function confirmUnblock(peerID: string): void {
    showAlert(
      t("settings.security.unblock_title"),
      t("settings.security.unblock_body", { name: resolveDisplayName(peerID) }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("settings.security.unblock"),
          onPress: () => {
            useBlockedStore.getState().unblockPeer(peerID);
          },
        },
      ],
    );
  }

  return (
    <View style={styles.container}>
      <SubHeader title={T("settings.section.privacy")} onBack={onBack} />
      <SettingsScroll>
        <View style={styles.section}>
          <UpperText style={styles.sectionTitle}>
            {T("settings.group.always_on")}
          </UpperText>
          <View style={styles.settingsGroup}>
            <SettingRow
              id="forward-secrecy"
              icon="repeat"
              label={T("settings.security.forward_secrecy")}
              description={T("settings.security.forward_secrecy_desc")}
              control={<SettingSwitch value={true} disabled />}
            />
            <GroupDivider />
            <SettingRow
              id="signed-packets"
              icon="check-circle"
              label={T("settings.security.signed_packets")}
              description={T("settings.security.signed_packets_desc")}
              control={<SettingSwitch value={true} disabled />}
            />
          </View>
        </View>

        <View style={styles.section}>
          <UpperText style={styles.sectionTitle}>
            {T("settings.group.lock")}
          </UpperText>
          <View style={styles.settingsGroup}>
            <SettingRow
              id="app-lock"
              icon="lock"
              label={T("settings.security.app_lock")}
              description={T("settings.security.app_lock_desc")}
              control={
                <SettingSwitch
                  value={appLockEnabled}
                  disabled={arming}
                  onValueChange={(v) => void toggleAppLock(v)}
                />
              }
            />
            {appLockEnabled && (
              <>
                <GroupDivider />
                <SettingLinkRow
                  icon="clock"
                  label={T("settings.security.app_lock_after")}
                  description={T("settings.security.app_lock_after_desc")}
                  control={
                    <Text style={styles.settingValue}>
                      {T(APP_LOCK_DELAY_LABELS[appLockDelaySeconds])}
                    </Text>
                  }
                  onPress={() => setShowDelaySheet(true)}
                />
              </>
            )}
          </View>
        </View>

        <View style={styles.section}>
          <UpperText style={styles.sectionTitle}>
            {T("settings.group.notifications")}
          </UpperText>
          <View style={styles.settingsGroup}>
            <SettingRow
              id="ring-alerts"
              icon="bell"
              label={T("settings.security.ring_alerts")}
              description={T("settings.security.ring_alerts_desc")}
              control={
                <SettingSwitch
                  value={ringAlertsEnabled}
                  onValueChange={(v) =>
                    useSettingsStore.getState().setRingAlertsEnabled(v)
                  }
                />
              }
            />
            <GroupDivider />
            <SettingRow
              id="hide-previews"
              icon="eye-off"
              label={T("settings.security.hide_previews")}
              description={T("settings.security.hide_previews_desc")}
              control={
                <SettingSwitch
                  value={hideNotificationPreviews}
                  onValueChange={(v) => {
                    useSettingsStore.getState().setHideNotificationPreviews(v);
                    // What is already in the tray was rendered with the
                    // preview, and stays on the lock screen until cleared.
                    if (v) void dismissPreviewNotifications();
                  }}
                />
              }
            />
            {/* Android's background notice exists only while background
                running is on. */}
            {Platform.OS === "android" && backgroundMeshEnabled && (
              <>
                <GroupDivider />
                <SettingLinkRow
                  icon="bell-off"
                  label={T("settings.security.background_notice")}
                  description={T("settings.security.background_notice_desc")}
                  onPress={() => void openBackgroundNoticeSettings()}
                  external
                />
              </>
            )}
          </View>
        </View>

        <View style={styles.section}>
          <UpperText style={styles.sectionTitle}>
            {T("settings.group.blocked")}
          </UpperText>
          <View style={styles.settingsGroup}>
            {blockedPeerIDs.length === 0 ? (
              <SettingRow
                icon="slash"
                label={T("settings.security.no_blocked")}
                description={T("settings.security.no_blocked_desc")}
              />
            ) : (
              blockedPeerIDs.map((peerID, index) => (
                <React.Fragment key={peerID}>
                  {index > 0 && <GroupDivider />}
                  <SettingRow
                    icon="slash"
                    label={resolveDisplayName(peerID)}
                    description={peerID}
                    control={
                      <Pressable
                        onPress={() => confirmUnblock(peerID)}
                        hitSlop={HIT_SLOP}
                        accessibilityRole="button"
                        accessibilityLabel={T(
                          "settings.security.unblock_peer",
                          {
                            name: resolveDisplayName(peerID),
                          },
                        )}
                      >
                        <Text
                          style={[
                            styles.settingValue,
                            { color: Colors.accent },
                          ]}
                        >
                          {T("settings.security.unblock")}
                        </Text>
                      </Pressable>
                    }
                  />
                </React.Fragment>
              ))
            )}
          </View>
        </View>
      </SettingsScroll>

      <BottomSheet
        visible={showDelaySheet}
        onClose={() => setShowDelaySheet(false)}
        sheetStyle={styles.sheet}
      >
        <Text style={styles.sheetTitle}>
          {T("settings.security.app_lock_after")}
        </Text>
        <Text style={styles.sheetSubtitle}>
          {T("settings.security.app_lock_after_desc")}
        </Text>
        <View style={styles.optionGroup}>
          {APP_LOCK_DELAY_OPTIONS.map((seconds, i) => {
            const selected = seconds === appLockDelaySeconds;
            return (
              <React.Fragment key={seconds}>
                {i > 0 && <GroupDivider />}
                <Pressable
                  style={({ pressed }) => [
                    styles.optionRowGrouped,
                    selected && styles.optionRowGroupedSelected,
                    pressed && styles.rowPressed,
                  ]}
                  onPress={() => {
                    useSettingsStore.getState().setAppLockDelaySeconds(seconds);
                    setShowDelaySheet(false);
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={T(APP_LOCK_DELAY_LABELS[seconds])}
                >
                  <View style={styles.optionText}>
                    <Text style={styles.optionLabel}>
                      {T(APP_LOCK_DELAY_LABELS[seconds])}
                    </Text>
                  </View>
                  {selected && (
                    <Feather
                      name="check"
                      size={18}
                      color={Colors.textPrimary}
                    />
                  )}
                </Pressable>
              </React.Fragment>
            );
          })}
        </View>
      </BottomSheet>
    </View>
  );
}
