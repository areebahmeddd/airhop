/**
 * @jest-environment node
 */
// A chat row must never render blank.
//
// The list shows `messagePreviewText` under every conversation. An attachment
// sent with no caption has an empty `text`, so without a fallback the row is an
// empty line and the conversation looks like nothing happened. Every branch
// below is a shape that reaches the list in normal use.
import { getEncodedToken, type Token } from "@cashu/cashu-ts";
import { toProofLike } from "@core/payments/cashu";
import { t } from "@i18n";
import type { ChatAttachment, ChatMessage } from "@store/chat-store";
import { messagePreviewEntry, messagePreviewText } from "../message-preview";

function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    channel: "#bluetooth",
    senderID: "0123456789abcdef",
    senderNickname: "swift-falcon-0123",
    text: "",
    timestampMs: 1_700_000_000_000,
    isMine: false,
    ...over,
  };
}

const attachment = (over: Partial<ChatAttachment> = {}): ChatAttachment => ({
  type: "image",
  uri: "file:///tmp/a.jpg",
  ...over,
});

describe("messagePreviewText", () => {
  it("prefers the text when there is any", () => {
    expect(messagePreviewText(message({ text: "hello" }))).toBe("hello");
  });

  it("prefers the caption over the attachment kind", () => {
    expect(
      messagePreviewText(
        message({ text: "on the roof", attachment: attachment() }),
      ),
    ).toBe("on the roof");
  });

  // The reason this module exists: no caption must not mean no row.
  it.each([
    ["voice", "transfer.kind.voice_preview"],
    ["image", "transfer.kind.photo_preview"],
    ["video", "transfer.kind.video_preview"],
  ] as const)("names a captionless %s attachment", (type, key) => {
    const preview = messagePreviewText(
      message({ attachment: attachment({ type }) }),
    );
    expect(preview).toBe(t(key));
    expect(preview).not.toBe("");
  });

  // A document is the one kind that carries a human-chosen name worth showing.
  it("shows a document's own filename", () => {
    expect(
      messagePreviewText(
        message({
          attachment: attachment({ type: "document", name: "budget.pdf" }),
        }),
      ),
    ).toBe("budget.pdf");
  });

  it("falls back to the generic label for a nameless document", () => {
    expect(
      messagePreviewText(
        message({ attachment: attachment({ type: "document" }) }),
      ),
    ).toBe(t("transfer.kind.document_preview"));
  });

  // Nothing to show is the only case allowed to be empty, and it cannot happen
  // for a message that carries either half.
  it("returns empty only when there is neither text nor attachment", () => {
    expect(messagePreviewText(message())).toBe("");
  });

  // A token is money to whoever reads it, so no preview may show one.
  describe("an ecash token", () => {
    const token = getEncodedToken({
      mint: "https://mint.example.com",
      unit: "sat",
      proofs: [16, 4, 1].map((amount, i) =>
        toProofLike({
          id: "00ad268c4d1f5826",
          amount,
          secret: `secret-${String(i)}`,
          C: "02" + "ab".repeat(32),
        }),
      ),
    } as unknown as Token);

    it("previews a message that is only a token as its amount", () => {
      const preview = messagePreviewText(message({ text: token }));
      expect(preview).toBe(
        t("notif.preview.ecash", { amount: "21", unit: "sat" }),
      );
      expect(preview).not.toContain("cashu");
    });

    it("logs the bell entry by key, so it re-reads after a switch", () => {
      const entry = messagePreviewEntry(message({ text: token }));
      expect(entry.previewKey).toBe("notif.preview.ecash");
      expect(entry.previewVars).toEqual({ amount: "21", unit: "sat" });
      expect(entry.preview).not.toContain("cashu");
    });

    it("leaves a token inside a sentence as the sender's words", () => {
      const text = `for lunch ${token}`;
      expect(messagePreviewText(message({ text }))).toBe(text);
    });
  });
});
