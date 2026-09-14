// Privacy & Security sub-screen: the always-on Double Ratchet / packet-signing
// guarantees, and the blocked-peer list.
//
// The connectivity toggles (live voice, Tor, gateway, bridge) sit on the settings
// hub itself rather than here, one drill-in away, because they are the switches
// people come to flip. See connectivity-group.tsx.

import { showAlert } from "@store/alert-store";
import { useBlockedStore } from "@store/blocked-store";
import { useSettingsStore } from "@store/settings-store";
import { HIT_SLOP, useThemeColors } from "@ui/theme";
import { resolveDisplayName } from "@utils/peer-display-name";
import React from "react";
import { Pressable, Text, View } from "react-native";
import {
  GroupDivider,
  SettingRow,
  SettingSwitch,
  SettingsScroll,
  SubHeader,
  useSharedStyles,
} from "../settings-primitives";

import { t, useT } from "@i18n";
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
          <Text style={styles.sectionTitle}>
            {T("settings.group.always_on")}
          </Text>
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
          <Text style={styles.sectionTitle}>
            {T("settings.group.notifications")}
          </Text>
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
                  onValueChange={(v) =>
                    useSettingsStore.getState().setHideNotificationPreviews(v)
                  }
                />
              }
            />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{T("settings.group.blocked")}</Text>
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
    </View>
  );
}
