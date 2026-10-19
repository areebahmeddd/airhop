// The in-app Privacy Policy has to say what the published one says. It is a
// hand-kept copy of landing/src/pages/PrivacyPage.tsx, and a copy that drifts
// promises the reader retention and coverage the app does not have. Every
// heading, paragraph and bullet on the site is rendered here, word for word and
// in order; the site's "This website" section is the only one left out.

import { render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import PrivacyScreen from "../privacy-screen";

// Declared rather than pulled in via @types/node, as settings-index.test.ts
// does: the app ships with no Node type dependency.
declare const __dirname: string;
declare function require(id: string): unknown;

interface NodeFs {
  readFileSync(path: string, encoding: string): string;
}
interface NodePath {
  join(...parts: string[]): string;
}
const fs = require("fs") as NodeFs;
const path = require("path") as NodePath;

jest.setTimeout(30_000);

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

const LANDING = path.join(
  __dirname,
  "../../../../../landing/src/pages/PrivacyPage.tsx",
);

// The section about the site itself, which the app has no part in.
const SITE_ONLY = "This website";

// JSX text as React reads it: a run spanning lines is trimmed line by line and
// the non-empty lines joined with one space; {" "} is a space; a closing block
// tag ends a block. Headings come back marked, to group the blocks under them.
const HEADING = "\u0000";

function landingText(): string[] {
  const source = fs.readFileSync(LANDING, "utf8");
  const start = source.indexOf("<EnglishContent");
  const end = source.indexOf("</EnglishContent>");
  const body = source.slice(source.indexOf(">", start) + 1, end);
  let out = "";
  for (const part of body.split(/(<[^>]+>|\{" "\})/)) {
    if (part === '{" "}') out += " ";
    else if (part.startsWith("<h2")) out += `\n${HEADING}`;
    else if (/^<\/(h2|p|li)>$/.test(part)) out += "\n";
    else if (part.startsWith("<")) continue;
    else if (!part.includes("\n")) out += part;
    else {
      const lines = part.split(/\r?\n/);
      out += lines
        .map((line, i) => {
          let kept = line;
          if (i > 0) kept = kept.trimStart();
          if (i < lines.length - 1) kept = kept.trimEnd();
          return kept;
        })
        .filter((line) => line.trim().length > 0)
        .join(" ");
    }
  }
  return out
    .split("\n")
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter((block) => block.length > 0);
}

// Every published block, less the site-only section, headings unmarked.
function landingBlocks(): string[] {
  const blocks: string[] = [];
  let siteOnly = false;
  for (const block of landingText()) {
    if (block.startsWith(HEADING)) {
      const heading = block.slice(HEADING.length).trim();
      siteOnly = heading === SITE_ONLY;
      if (!siteOnly) blocks.push(heading);
    } else if (!siteOnly) {
      blocks.push(block);
    }
  }
  return blocks;
}

// The shape of screen.toJSON(), declared rather than imported from
// react-test-renderer, which is the testing library's dependency, not ours.
interface RenderedNode {
  type: string;
  children: (RenderedNode | string)[] | null;
}

function textOf(node: RenderedNode | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map(textOf).join("");
}

// The outermost Text of each block: a paragraph's spans are nested inside it.
function renderedBlocks(node: RenderedNode | string): string[] {
  if (typeof node === "string") return [];
  if (node.type === "Text") return [textOf(node)];
  return (node.children ?? []).flatMap(renderedBlocks);
}

it("says what the published policy says", async () => {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <PrivacyScreen onBack={() => {}} />
    </SafeAreaProvider>,
  );
  const tree = screen.toJSON();
  const roots = Array.isArray(tree) ? tree : tree === null ? [] : [tree];
  // Everything above the first heading is the reader's chrome.
  const all = roots.flatMap(renderedBlocks);
  const blocks = all.slice(all.indexOf("Summary"));
  expect(blocks).toEqual(landingBlocks());
});
