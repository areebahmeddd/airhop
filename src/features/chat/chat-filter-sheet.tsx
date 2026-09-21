// The sheet behind the filter pill on the Chats screen: one grouped box of
// choices, the current one ticked. Same sheet and rows as the long-press
// sheets on both lists.

import { Feather } from "@expo/vector-icons";
import { useT } from "@i18n";
import BottomSheet from "@ui/components/bottom-sheet";
import {
  FontSize,
  FontWeight,
  MIN_TOUCH,
  Radius,
  Spacing,
  useThemeColors,
} from "@ui/theme";
import type { ChannelFilter, DmFilter } from "@utils/chat-filter";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

type Filter = DmFilter | ChannelFilter;

const ICONS: Record<Filter, React.ComponentProps<typeof Feather>["name"]> = {
  all: "list",
  unread: "inbox",
  verified: "shield",
  nearby: "radio",
  private: "lock",
};

interface Props<K extends Filter> {
  visible: boolean;
  options: readonly K[];
  selected: K;
  onSelect: (filter: K) => void;
  onClose: () => void;
}

export default function ChatFilterSheet<K extends Filter>({
  visible,
  options,
  selected,
  onSelect,
  onClose,
}: Props<K>): React.JSX.Element {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  return (
    <BottomSheet visible={visible} onClose={onClose} sheetStyle={styles.sheet}>
      <Text style={styles.title} accessibilityRole="header">
        {T("chat.filter.a11y")}
      </Text>
      <View style={styles.group} accessibilityRole="radiogroup">
        {options.map((option, index) => {
          const active = option === selected;
          return (
            <React.Fragment key={option}>
              {index > 0 && <View style={styles.divider} />}
              <Pressable
                style={({ pressed }) => [
                  styles.row,
                  pressed && styles.rowPressed,
                ]}
                onPress={() => {
                  onSelect(option);
                  onClose();
                }}
                accessibilityRole="radio"
                accessibilityState={{ checked: active }}
                accessibilityLabel={T(`chat.filter.${option}`)}
              >
                <Feather
                  name={ICONS[option]}
                  size={18}
                  color={Colors.textSecondary}
                />
                <Text style={styles.label}>{T(`chat.filter.${option}`)}</Text>
                {active && (
                  <Feather
                    name="check"
                    size={18}
                    color={Colors.textPrimary}
                    style={styles.check}
                  />
                )}
              </Pressable>
            </React.Fragment>
          );
        })}
      </View>
    </BottomSheet>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    sheet: {
      paddingHorizontal: Spacing.xl,
      paddingBottom: Spacing.xl,
      gap: Spacing.base,
    },
    title: {
      fontSize: FontSize.md,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
    },
    group: {
      backgroundColor: Colors.surfaceRaised,
      borderRadius: Radius.lg,
      overflow: "hidden",
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      paddingVertical: Spacing.md,
      paddingHorizontal: Spacing.base,
      minHeight: MIN_TOUCH,
    },
    rowPressed: {
      backgroundColor: Colors.surfacePressed,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: Colors.border,
      marginStart: Spacing.base,
    },
    label: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.medium,
      color: Colors.textPrimary,
      flex: 1,
    },
    check: {
      flexShrink: 0,
    },
  });
}
