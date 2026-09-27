/**
 * @jest-environment node
 */
// A received name becomes a path segment on this phone and the name another app
// shows when the file is shared on, so it must stay one segment and stay
// readable in its own script.

import { safeFileName } from "../safe-file-name";
import { utf8ByteLength } from "../utf8-budget";

describe("safeFileName", () => {
  it("keeps names in every script", () => {
    expect(safeFileName("報告書.pdf")).toBe("報告書.pdf");
    expect(safeFileName("تقرير.pdf")).toBe("تقرير.pdf");
    expect(safeFileName("отчёт-2.pdf")).toBe("отчёт-2.pdf");
    // Devanagari vowel signs are marks, and must stay with their letters.
    expect(safeFileName("रिपोर्ट.pdf")).toBe("रिपोर्ट.pdf");
  });

  it("composes a decomposed accent into one letter", () => {
    expect(safeFileName("cafe\u0301.txt")).toBe("caf\u00E9.txt");
  });

  it("never leaves a separator or a parent reference", () => {
    const name = safeFileName("../../etc/passwd");
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
    expect(safeFileName("a\\b.txt")).toBe("a_b.txt");
  });

  it("replaces controls, bidi overrides and zero-width characters", () => {
    // "invoice" + RLO + "fdp.exe" would read as "invoiceexe.pdf".
    expect(safeFileName("invoice\u202Efdp.exe")).toBe("invoice_fdp.exe");
    expect(safeFileName("a\u0000b\u200Bc\n.txt")).toBe("a_b_c_.txt");
  });

  it("cuts by UTF-8 bytes on a character boundary", () => {
    const name = safeFileName("報".repeat(100));
    expect(utf8ByteLength(name)).toBeLessThanOrEqual(128);
    expect(name).toBe("報".repeat(42));
    expect(safeFileName("a".repeat(300))).toBe("a".repeat(128));
  });
});
