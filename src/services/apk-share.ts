// Shares Airhop's own installed APK through the system share sheet, so a
// nearby phone with no Airhop yet can get it directly - Quick Share, Nearby
// Share, Bluetooth and the rest show up on their own.
//
// Android only; the native module rejects on iOS.

import NativeAirhopApp from "@bridge/NativeAirhopApp";
import { t } from "@i18n";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";

export type ApkShareResult =
  { ok: true } | { ok: false; reason: "unsupported" | "failed" };

export async function shareApk(): Promise<ApkShareResult> {
  if (Platform.OS !== "android") return { ok: false, reason: "failed" };
  try {
    const uri = await NativeAirhopApp?.copyApkToCache();
    if (uri === undefined || !(await Sharing.isAvailableAsync())) {
      return { ok: false, reason: "failed" };
    }
    await Sharing.shareAsync(uri, {
      mimeType: "application/vnd.android.package-archive",
      dialogTitle: t("settings.share_app_dialog"),
    });
    return { ok: true };
  } catch (e) {
    // SPLIT_INSTALL is the one failure worth surfacing; everything else
    // stays silent, matching the rest of the app's share failures.
    const unsupported =
      (e as { code?: string } | undefined)?.code === "SPLIT_INSTALL";
    return { ok: false, reason: unsupported ? "unsupported" : "failed" };
  }
}
