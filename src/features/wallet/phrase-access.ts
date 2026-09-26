// The owner check in front of the recovery phrase.
//
// The twelve words move every coin to any phone, silently, so they are shown
// only once the OS has confirmed the owner: the same check a device transfer
// asks for. With no screen lock there is no owner to ask and they show, as a
// transfer proceeds.

import { t } from "@i18n";
import { confirmDeviceOwner } from "@platform/device-auth";

// One prompt at a time: a second tap while the OS sheet is up must not queue
// another behind it.
let inFlight = false;

export async function confirmOwnerForPhrase(): Promise<boolean> {
  if (inFlight) return false;
  inFlight = true;
  try {
    const result = await confirmDeviceOwner({
      prompt: t("wallet.backup.auth_prompt"),
      cancelLabel: t("common.cancel"),
    });
    return result !== "refused";
  } finally {
    inFlight = false;
  }
}
