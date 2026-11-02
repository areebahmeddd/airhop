// Backing store for the custom alert modal (src/ui/components/alert-modal.tsx),
// a drop-in replacement for React Native's native `Alert.alert` so every
// notice/confirm dialog in the app matches its own design language instead
// of the OS-default alert box. Not persisted, purely transient UI state.

import { t } from "@i18n";
import { create } from "zustand";

export interface AlertButtonConfig {
  text: string;
  style?: "default" | "cancel" | "destructive";
  onPress?: () => void;
}

interface AlertState {
  visible: boolean;
  title: string;
  message?: string;
  buttons: AlertButtonConfig[];
  show: (
    title: string,
    message?: string,
    buttons?: AlertButtonConfig[],
  ) => void;
  hide: () => void;
}

export const useAlertStore = create<AlertState>((set) => ({
  visible: false,
  title: "",
  message: undefined,
  buttons: [],

  show(title, message, buttons) {
    set({
      visible: true,
      title,
      message,
      // Translated here rather than held as a module constant, because `show`
      // runs at the moment the alert is raised and `t` resolves the language
      // then. A default button built once at import would freeze in whichever
      // language the app started in.
      buttons:
        buttons && buttons.length > 0 ? buttons : [{ text: t("common.ok") }],
    });
  },

  hide() {
    set({ visible: false });
  },
}));

// Same call shape as RN's `Alert.alert(title, message?, buttons?)`.
export function showAlert(
  title: string,
  message?: string,
  buttons?: AlertButtonConfig[],
): void {
  useAlertStore.getState().show(title, message, buttons);
}
