// How good a match is: the floor that keeps "tor" out of "storage" must not
// also keep every two-character Chinese or Japanese word out of every result.

import { scoreMatch, searchKey } from "../search-text";

function score(text: string, query: string): number {
  const hay = searchKey(text);
  const q = searchKey(query);
  return scoreMatch(hay, hay.indexOf(q), q.length);
}

describe("scoreMatch", () => {
  it("ranks a prefix above a word above a mid-word match", () => {
    expect(score("storage", "stor")).toBe(3);
    expect(score("tor network", "network")).toBe(2);
    expect(score("restoration", "stora")).toBe(1);
  });

  it("drops a short Latin match inside a word", () => {
    expect(score("storage", "tor")).toBe(0);
    expect(score("guide", "id")).toBe(0);
  });

  it("starts a word after punctuation, not only after a space", () => {
    expect(score("e-mail", "mail")).toBe(2);
    expect(score("(tor)", "tor")).toBe(2);
    // An ideographic full stop and an Arabic comma are boundaries too.
    expect(score("設定。通知", "通知")).toBe(2);
    expect(score("شبكة،تور", "تور")).toBe(2);
  });

  it("does not start a word after a combining mark", () => {
    // The anusvara in "भं" is a mark, not a boundary: "डा" is mid-word there,
    // while the space before "डेटा" still starts one.
    expect(score("भंडारण और डेटा", "डा")).toBe(0);
    expect(score("भंडारण और डेटा", "डेटा")).toBe(2);
  });

  it("keeps a short match inside unspaced Han, kana and Thai", () => {
    expect(score("隐藏通知预览", "预览")).toBe(1);
    expect(score("通知のプレビューを隠す", "隠す")).toBe(1);
    expect(score("ซ่อนตัวอย่าง", "ตัว")).toBe(1);
  });

  it("does not treat half of a supplementary letter as a boundary", () => {
    // U+20000 is a Han letter written as a surrogate pair.
    expect(score("\u{20000}ab", "ab")).toBe(0);
  });
});
