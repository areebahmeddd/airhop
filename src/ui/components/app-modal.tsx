// React Native's Modal, hidden while the app lock asks. A Modal is its own
// window above the app root, where the lock screen draws, so it would show
// through the lock. Every Modal in the app is this one.

import { selectLockedOut, useAppLockStore } from "@store/app-lock-store";
import React from "react";
import { Modal, type ModalProps } from "react-native";

export default function AppModal({
  visible,
  ...props
}: ModalProps): React.JSX.Element {
  const lockedOut = useAppLockStore(selectLockedOut);
  return <Modal {...props} visible={visible !== false && !lockedOut} />;
}
