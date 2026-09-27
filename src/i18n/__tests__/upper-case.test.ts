/**
 * @jest-environment node
 */
// Capitals in the reading language, the job `textTransform` does with the
// wrong locale on both platforms.

import { upperCase } from "../upper-case";

describe("upperCase", () => {
  it("keeps the dot on a Turkish capital İ", () => {
    expect(upperCase("Bildirimler", "tr")).toBe("BİLDİRİMLER");
    expect(upperCase("Dil", "tr")).toBe("DİL");
    expect(upperCase("Eşitleme", "tr")).toBe("EŞİTLEME");
  });

  it("gives dotless ı its own capital, I", () => {
    expect(upperCase("Kapalı", "tr")).toBe("KAPALI");
  });

  it("uses the default mapping everywhere else", () => {
    expect(upperCase("Notifications", "en")).toBe("NOTIFICATIONS");
    expect(upperCase("Bildirimler", "de")).toBe("BILDIRIMLER");
    expect(upperCase("Réseau", "fr")).toBe("RÉSEAU");
  });

  it("leaves Georgian as written, since Mtavruli is not a heading style", () => {
    expect(upperCase("შეტყობინებები", "ka")).toBe("შეტყობინებები");
  });

  it("passes caseless scripts through", () => {
    expect(upperCase("通知", "ja")).toBe("通知");
    expect(upperCase("الإشعارات", "ar")).toBe("الإشعارات");
  });
});
