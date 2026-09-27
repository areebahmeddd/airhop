// Onboarding step 1: Welcome. One sentence, one action, and a quieter way in
// for someone bringing an identity from another phone.

import Feather from "@expo/vector-icons/Feather";
import { useT } from "@i18n";
import { useRichText } from "@i18n/rich-text";
import { acknowledged } from "@platform/haptics";
import PixelBird, { BIRD_COLUMNS, BIRD_ROWS } from "@ui/components/pixel-bird";
import PrimaryButton from "@ui/components/primary-button";
import {
  FontSize,
  FontWeight,
  HIT_SLOP,
  LineHeight,
  Radius,
  Spacing,
  useThemeColors,
} from "@ui/theme";
import React, { useMemo } from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import HelloSheet from "./hello-sheet";

const TERMS_URL = "https://airhop.1mindlabs.org/terms-of-service";
const PRIVACY_URL = "https://airhop.1mindlabs.org/privacy-policy";

// The agreement and the note live in the shell, so Back from a transfer asks
// neither again. Neither is stored.
interface Props {
  agreed: boolean;
  onAgreedChange: (agreed: boolean) => void;
  // Whether the author's note opens with the screen.
  greet: boolean;
  onGreeted: () => void;
  onContinue: () => void;
  onTransfer: () => void;
}

export default function WelcomeScreen({
  agreed,
  onAgreedChange,
  greet,
  onGreeted,
  onContinue,
  onTransfer,
}: Props): React.JSX.Element {
  const Colors = useThemeColors();
  const T = useT();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  const { width } = useWindowDimensions();
  // Size the bird to about half the screen width, capped, so it reads big on
  // phones without overflowing tablets. Cell rounded to a whole pixel keeps
  // the pixel edges crisp.
  const birdCell = Math.max(
    2,
    Math.round(Math.min(width * 0.5, 240) / BIRD_COLUMNS),
  );

  // The consent line is one translated sentence with the two document names
  // substituted in as tappable nodes, so a translator can put them wherever
  // their language needs them. See i18n/rich-text.tsx.
  const consent = useRichText(
    "onboarding.welcome.consent",
    {
      terms: (
        <Text
          style={styles.link}
          onPress={() => void Linking.openURL(TERMS_URL)}
          suppressHighlighting
        >
          {T("legal.terms")}
        </Text>
      ),
      privacy: (
        <Text
          style={styles.link}
          onPress={() => void Linking.openURL(PRIVACY_URL)}
          suppressHighlighting
        >
          {T("legal.privacy")}
        </Text>
      ),
    },
    { cta: T("onboarding.welcome.cta") },
  );

  function toggleAgreed(): void {
    // A selection tick, the lightest feedback the OS offers, matching how a
    // native checkbox or picker feels. Not an impact: nothing happened yet.
    acknowledged();
    onAgreedChange(!agreed);
  }

  return (
    <SafeAreaView style={styles.root}>
      {/* Scrolls only on a short viewport (landscape, largest text size), where
          a clipped CTA would leave the app unstartable. */}
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        {/* minHeight: on a short screen `flex: 1` alone leaves the bird no
            space at all. */}
        <View
          style={[
            styles.hero,
            { minHeight: BIRD_ROWS * birdCell + Spacing["3xl"] },
          ]}
        >
          <PixelBird color={Colors.textPrimary} cell={birdCell} />
        </View>

        <View style={styles.footer}>
          <View style={styles.textBlock}>
            <Text style={styles.wordmark} accessibilityRole="header">
              airhop
            </Text>
            <Text style={styles.tagline}>
              {T("onboarding.welcome.tagline")}
            </Text>
          </View>
          <View style={styles.actions}>
            <PrimaryButton
              label={T("onboarding.welcome.cta")}
              onPress={onContinue}
              disabled={!agreed}
              accessibilityLabel={T("onboarding.welcome.cta")}
              // A dimmed button with no stated reason is a dead end; the hint
              // is read as focus lands, before the tap that would do nothing.
              accessibilityHint={
                agreed ? undefined : T("onboarding.welcome.cta_hint")
              }
            />
            {/* The terms cover a transferred identity as much as a new one. */}
            <PrimaryButton
              label={T("onboarding.welcome.transfer")}
              onPress={onTransfer}
              variant="outline"
              style={styles.transfer}
              disabled={!agreed}
              accessibilityHint={
                agreed ? undefined : T("onboarding.welcome.cta_hint")
              }
            />
            <Pressable
              style={styles.agreement}
              onPress={toggleAgreed}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: agreed }}
              accessibilityLabel={T("onboarding.welcome.consent_a11y")}
              // Links inside an accessible parent are unreachable to a screen
              // reader, so they come back as custom actions rather than
              // splitting the row into three stops.

              accessibilityActions={[
                { name: "terms", label: T("onboarding.welcome.open_terms") },
                {
                  name: "privacy",
                  label: T("onboarding.welcome.open_privacy"),
                },
              ]}
              onAccessibilityAction={(event) => {
                if (event.nativeEvent.actionName === "terms") {
                  void Linking.openURL(TERMS_URL);
                } else if (event.nativeEvent.actionName === "privacy") {
                  void Linking.openURL(PRIVACY_URL);
                }
              }}
              hitSlop={HIT_SLOP}
            >
              <View style={[styles.checkbox, agreed && styles.checkboxChecked]}>
                {agreed ? (
                  <Feather name="check" size={13} color={Colors.textInverse} />
                ) : null}
              </View>
              <Text style={styles.agreementText}>{consent}</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>

      <HelloSheet visible={greet} onClose={onGreeted} />
    </SafeAreaView>
  );
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: Colors.bg,
    },
    scroll: {
      flexGrow: 1,
    },
    hero: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    footer: {
      paddingHorizontal: Spacing.base,
      paddingBottom: Spacing.md,
      gap: Spacing.xl,
    },
    textBlock: {
      alignItems: "flex-start",
      gap: Spacing.xs,
    },
    wordmark: {
      fontSize: FontSize["3xl"],
      fontWeight: FontWeight.bold,
      color: Colors.textPrimary,
      letterSpacing: -1.5,
      lineHeight: LineHeight["3xl"],
    },
    tagline: {
      fontSize: FontSize.md,
      fontWeight: FontWeight.regular,
      color: Colors.textSecondary,
      letterSpacing: 0,
    },
    actions: {
      gap: Spacing.base,
    },
    transfer: {
      marginTop: -Spacing.sm,
    },
    agreement: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.xs,
    },
    checkbox: {
      width: 20,
      height: 20,
      borderRadius: Radius.full,
      borderWidth: 1.5,
      borderColor: Colors.borderStrong,
      alignItems: "center",
      justifyContent: "center",
      // Nudge down so the box aligns with the first line's cap height.
      marginTop: 1,
    },
    checkboxChecked: {
      backgroundColor: Colors.accent,
      borderColor: Colors.accent,
    },
    agreementText: {
      flex: 1,
      fontSize: FontSize.sm,
      lineHeight: LineHeight.sm,
      color: Colors.textSecondary,
    },
    link: {
      color: Colors.textPrimary,
      fontWeight: FontWeight.medium,
      textDecorationLine: "underline",
    },
  });
}
