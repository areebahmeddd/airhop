// Copying a bearer secret: an ecash token or the recovery phrase.
//
// Android 13+ then keeps it out of the clipboard preview and the keyboard's
// paste suggestions. iOS has no equivalent flag. Peer IDs, keys, invoices and
// other text meant to be shared copy plainly.

import * as Clipboard from "expo-clipboard";

const SECRET: Clipboard.SetStringOptions = { android: { isSensitive: true } };

export function copySecret(text: string): Promise<boolean> {
  return Clipboard.setStringAsync(text, SECRET);
}
