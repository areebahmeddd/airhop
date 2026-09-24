// The sheet for paying a person, shared by the DM thread and the contact info
// sheet so there is one amount field and one account of what Send did: copies
// would drift on what happens to the user's money. It picks no rail.
// `payPerson` chooses from who the recipient is and what is reachable, and
// returns the rail used and whether the payment can still be reclaimed; this
// reports that answer in the same words every time.

import { useT } from "@i18n";
import {
  describePayResult,
  payPerson,
  type PayResult,
} from "@services/payment-router";
import { showAlert } from "@store/alert-store";
import BottomSheet from "@ui/components/bottom-sheet";
import {
  BUTTON_HEIGHT,
  DISABLED_OPACITY,
  FontSize,
  FontWeight,
  Radius,
  Spacing,
  useThemeColors,
} from "@ui/theme";
import { amountParts, parseWholeNumber } from "@utils/format";
import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

interface Props {
  visible: boolean;
  onClose: () => void;
  // At least one must be set. The peer ID names the thread; the Nostr key
  // unlocks NIP-61.
  peerID?: string;
  nostrPubkey?: string;
  displayName: string;
  // For the local echo in the thread; omitted, it reads "You".
  senderNickname?: string;
}

export default function SendEcashSheet({
  visible,
  onClose,
  peerID,
  nostrPubkey,
  displayName,
  senderNickname,
}: Props): React.JSX.Element {
  const T = useT();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);

  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [sending, setSending] = useState(false);

  function reset(): void {
    setAmount("");
    setMemo("");
  }

  async function handleSend(): Promise<void> {
    const sats = parseWholeNumber(amount);
    if (sats === null || sending) return;

    // Quoting and the nutzap lookup await the network, so a double tap would
    // start two payments.
    setSending(true);
    let result: PayResult | null;
    try {
      result = await payPerson({
        ...(peerID !== undefined ? { peerID } : {}),
        ...(nostrPubkey !== undefined ? { nostrPubkey } : {}),
        amount: sats,
        memo: memo.trim() || undefined,
        recipientName: displayName,
        ...(senderNickname !== undefined ? { senderNickname } : {}),
      });
    } finally {
      setSending(false);
    }
    // Cancelled, or refused with its own alert already on screen.
    if (!result) return;

    reset();
    onClose();
    showAlert(
      T("wallet.pay.sent_title", {
        ...amountParts(result.amount, result.unit),
        name: displayName,
      }),
      describePayResult(result),
    );
  }

  return (
    <BottomSheet visible={visible} onClose={onClose} sheetStyle={styles.sheet}>
      <Text style={styles.title}>{T("wallet.pay.title")}</Text>
      <Text style={styles.subtitle}>
        {T("wallet.pay.to", { name: displayName })}
      </Text>
      <TextInput
        style={styles.input}
        value={amount}
        onChangeText={setAmount}
        placeholder={T("wallet.pay.amount")}
        placeholderTextColor={Colors.textMuted}
        keyboardType="number-pad"
        returnKeyType="next"
        selectionColor={Colors.selection}
      />
      <TextInput
        style={[styles.input, styles.inputCompact]}
        value={memo}
        onChangeText={setMemo}
        placeholder={T("wallet.pay.memo")}
        placeholderTextColor={Colors.textMuted}
        autoCapitalize="sentences"
        selectionColor={Colors.selection}
      />
      <View style={styles.actions}>
        <Pressable
          style={[
            styles.confirm,
            (!amount.trim() || sending) && styles.confirmDisabled,
          ]}
          onPress={() => void handleSend()}
          disabled={!amount.trim() || sending}
          accessibilityRole="button"
          accessibilityLabel={T("wallet.pay.send")}
        >
          <Text style={styles.confirmText}>
            {sending ? T("wallet.pay.sending") : T("wallet.pay.send")}
          </Text>
        </Pressable>
        <Pressable
          style={styles.cancel}
          onPress={() => {
            reset();
            onClose();
          }}
          accessibilityRole="button"
          accessibilityLabel={T("common.cancel")}
        >
          <Text style={styles.cancelText}>{T("common.cancel")}</Text>
        </Pressable>
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
      fontWeight: FontWeight.bold,
      color: Colors.textPrimary,
    },
    subtitle: {
      fontSize: FontSize.sm,
      color: Colors.textMuted,
      lineHeight: FontSize.sm * 1.5,
    },
    input: {
      backgroundColor: Colors.surfaceRaised,
      borderRadius: Radius.xl,
      borderWidth: 1,
      borderColor: Colors.border,
      paddingHorizontal: Spacing.base,
      paddingVertical: Spacing.md,
      color: Colors.textPrimary,
      fontSize: FontSize.base,
    },
    inputCompact: {
      marginTop: -Spacing.xs,
    },
    actions: {
      width: "100%",
      marginTop: Spacing.xs,
    },
    confirm: {
      width: "100%",
      minHeight: BUTTON_HEIGHT,
      backgroundColor: Colors.accent,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
    },
    confirmDisabled: {
      opacity: DISABLED_OPACITY,
    },
    confirmText: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.bold,
      color: Colors.textInverse,
    },
    cancel: {
      width: "100%",
      minHeight: BUTTON_HEIGHT,
      marginTop: Spacing.sm,
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 1,
      borderColor: Colors.border,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
    },
    cancelText: {
      fontSize: FontSize.base,
      color: Colors.textPrimary,
      fontWeight: FontWeight.semibold,
    },
  });
}
