// The DMs disappearing messages must keep showing, since the outbox is still
// their only way to arrive (outbox-store's awaitingReceiptIds). Screens pass
// it to the expiry filter, so a row is never hidden that the sweep keeps.

import { awaitingReceiptIds, useOutboxStore } from "@store/outbox-store";
import { useMemo } from "react";

export function useAwaitingReceipt(): ReadonlySet<string> {
  const pending = useOutboxStore((s) => s.pending);
  return useMemo(() => awaitingReceiptIds(pending), [pending]);
}
