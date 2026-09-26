// scripts/sync-bridges.js writes src/data/bridges.ts from Moat's answer, and
// the file joins its entries with newlines before Arti reads them. An entry
// that is not exactly one line would split into two bridges at runtime, and
// only the first would have passed the token checks, so the grammar check
// has to hold for every entry before anything else is looked at.

import { OBFS4_BRIDGE_LINES, SNOWFLAKE_BRIDGE_LINES } from "@data/bridges";

const { validate } = require("../../../scripts/sync-bridges.js") as {
  validate: (transport: string, lines: unknown[]) => void;
};

const obfs4 = OBFS4_BRIDGE_LINES.split("\n");
const snowflake = SNOWFLAKE_BRIDGE_LINES.split("\n");

// A well-formed line smuggled behind a good one.
const SMUGGLED = `${obfs4[0]}\nobfs4 192.0.2.1:443 ${"A".repeat(40)} cert=x iat-mode=0`;

describe("sync-bridges validate", () => {
  it("accepts the committed bridge lines", () => {
    expect(() => validate("obfs4", obfs4)).not.toThrow();
    expect(() => validate("snowflake", snowflake)).not.toThrow();
  });

  it.each([
    ["an embedded newline", SMUGGLED],
    ["an embedded carriage return", obfs4[0].replace(" ", "\r ")],
    ["a double space", obfs4[0].replace(" ", "  ")],
    ["a tab", obfs4[0].replace(" ", "\t")],
    ["a non-ASCII character", obfs4[0].replace("cert=", "cért=")],
  ])("refuses a line with %s", (_case, line) => {
    expect(() => validate("obfs4", [line, ...obfs4.slice(1)])).toThrow(
      /not printable ASCII on one line/,
    );
  });

  it.each([
    ["a number", 42],
    ["null", null],
    ["an object", { line: obfs4[0] }],
  ])("refuses %s in place of a line", (_case, entry) => {
    expect(() => validate("obfs4", [entry, ...obfs4.slice(1)])).toThrow(
      /not printable ASCII on one line/,
    );
  });
});
