// React Native's Modal, hidden while the app lock asks. A Modal is its own
// window above the app root, where the lock screen draws, so it would show
// through the lock. Every Modal in the app is this one.
//
// The lock hides it at once rather than sliding it away: what it shows should
// not linger over the lock, and the lock hides every open Modal in the same
// commit, nested ones included (a sheet with a full-screen view over it). iOS
// refuses to close a Modal whose nested one is still mid-slide, which leaves
// an invisible window over the app.

import { selectLockedOut, useAppLockStore } from "@store/app-lock-store";
import React from "react";
import { Modal, type ModalProps } from "react-native";

export default function AppModal({
  visible,
  animationType,
  ...props
}: ModalProps): React.JSX.Element {
  const lockedOut = useAppLockStore(selectLockedOut);
  return (
    <Modal
      {...props}
      visible={visible !== false && !lockedOut}
      animationType={lockedOut ? "none" : animationType}
    />
  );
}
