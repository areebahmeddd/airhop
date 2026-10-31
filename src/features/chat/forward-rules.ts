// Which rooms a forward may go to, beyond the media and length rules. Pure, so
// the forward sheet's greying and the thread's backstop apply one rule.

import { mayContainToken } from "@core/payments/cashu";
import { SENDER_CAPACITY } from "@core/router/public-message-limiter";
import { isGeoChannel } from "@services/geohash-channel-service";
import { isPublicRoom } from "./compose-budget";

// Receivers let one sender post this many public messages in a row, then one a
// second (as bitchat-ios). A bulk forward goes out in one burst, so anything
// past this is dropped at every phone and still settles "sent" here.
export const PUBLIC_FORWARD_BURST = SENDER_CAPACITY;

type ForwardRefusal = "ecash" | "burst";

// Whether any of these texts (message bodies and captions alike) may hold an
// ecash token. The same test Copy uses to treat a message as a secret.
export function carriesEcash(texts: readonly string[]): boolean {
  return texts.some(mayContainToken);
}

// Why `target` cannot take a selection of `count` messages, or null. Ecash is
// refused everywhere: a token is a bearer secret, in a room anyone can claim it
// first, and even in a DM the receiver of a forward is not who it was sent to.
export function forwardRefusal(
  target: string,
  sealed: boolean,
  selection: { ecash: boolean; count: number },
): ForwardRefusal | null {
  if (selection.ecash) return "ecash";
  if (selection.count > PUBLIC_FORWARD_BURST && isPublicRoom(target, sealed)) {
    return "burst";
  }
  return null;
}

// Whether a forward into `target` is read beyond the people chosen for it, and
// how far: a location room's copy also goes to public internet relays.
export function publicForwardReach(
  target: string,
  sealed: boolean,
): "geo" | "mesh" | null {
  if (!isPublicRoom(target, sealed)) return null;
  return isGeoChannel(target) ? "geo" : "mesh";
}
