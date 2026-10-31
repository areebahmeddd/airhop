// Guards the strings the OS renders, which never reach `t()` and so are invisible
// to `catalog.test.ts`: the iOS permission prompts in `<code>.lproj/`, the
// Android foreground-service notice and home screen widget in `values-*/`, the
// iOS widget's tables, and the locale list Android 13's per-app picker reads.
//
//   npm run i18n:native
//   npm run i18n:native -- --write    rewrite the iOS widget tables first
//
// The two widgets say the same words, so the iOS tables are written from the
// Android copy rather than edited: change values-*/strings.xml, then --write.
//
// Without it a language ships a complete catalog and still shows an English
// system dialog, silently. Swift needs no equivalent: its `reject()` messages are
// error codes JS branches on, not copy.
//
// Both platforms resolve these by the OS locale rather than the in-app picker,
// so a phone set to English shows an English notice under a Thai UI. On the
// default "system" preference the two agree, since the app re-samples the device
// language on every foreground edge; pinning a language in the app leaves these
// on the OS value deliberately. The localization section of
// docs/spec/ARCHITECTURE.md has why.

const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");
const IOS = path.join(ROOT, "ios", "Airhop");
const PLIST = path.join(IOS, "Info.plist");
const PBX = path.join(ROOT, "ios", "Airhop.xcodeproj", "project.pbxproj");
const RES = path.join(ROOT, "android", "app", "src", "main", "res");

// Read from the type union so this and the app cannot disagree about what
// ships. The pseudolocale is never inferred, so it never reaches a dialog.
function registryCodes() {
  const file = path.join(ROOT, "src", "i18n", "languages.ts");
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let codes = null;
  const visit = (node) => {
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === "LanguageCode" &&
      ts.isUnionTypeNode(node.type)
    ) {
      codes = node.type.types
        .filter((t) => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal))
        .map((t) => t.literal.text)
        .filter((c) => c !== "qps-ploc");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (codes === null) throw new Error("LanguageCode union not found");
  return codes;
}

const errors = [];
const codes = registryCodes();

// MARK: - iOS

// Read, not listed, so a permission added to the plist fails here until
// it is translated.
const plistKeys = [
  ...fs
    .readFileSync(PLIST, "utf8")
    .matchAll(/<key>(NS\w*UsageDescription)<\/key>/g),
].map((m) => m[1]);

if (plistKeys.length === 0) {
  errors.push("ios: Info.plist declares no usage descriptions");
}

// A .strings file is a sequence of `"key" = "value";`.
function readStrings(file) {
  const out = {};
  const source = fs.readFileSync(file, "utf8");
  for (const m of source.matchAll(/"([^"]+)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

const lprojs = fs
  .readdirSync(IOS)
  .filter((n) => n.endsWith(".lproj"))
  .map((n) => n.slice(0, -".lproj".length));

for (const code of codes) {
  if (!lprojs.includes(code)) errors.push(`ios: missing ${code}.lproj`);
}
for (const code of lprojs) {
  if (!codes.includes(code)) {
    errors.push(`ios: ${code}.lproj is not a language the app ships`);
  }
}

const pbx = fs.readFileSync(PBX, "utf8");
for (const code of lprojs) {
  const file = path.join(IOS, `${code}.lproj`, "InfoPlist.strings");
  if (!fs.existsSync(file)) {
    errors.push(`ios: ${code}.lproj has no InfoPlist.strings`);
    continue;
  }

  const strings = readStrings(file);
  for (const key of plistKeys) {
    const value = strings[key];
    if (value === undefined) errors.push(`ios ${code}: missing ${key}`);
    else if (value.trim().length === 0)
      errors.push(`ios ${code}: empty ${key}`);
    else if (!/\bAirhop\b/.test(value)) {
      errors.push(`ios ${code}: ${key} does not name Airhop`);
    }
  }
  for (const key of Object.keys(strings)) {
    if (!plistKeys.includes(key))
      errors.push(`ios ${code}: unknown key ${key}`);
  }

  if (!pbx.includes(`Airhop/${code}.lproj/InfoPlist.strings`)) {
    errors.push(`ios ${code}: not referenced by project.pbxproj`);
  }
  if (!new RegExp(`^\\t+"?${code}"?,$`, "m").test(pbx)) {
    errors.push(`ios ${code}: not in knownRegions`);
  }
}

// MARK: - Android

// European Portuguese sits at the bare `pt`, not at `pt-rPT`.
//
// Android tries the exact tag, then the parent language, then the parent's
// children. Without a `pt`, an Angolan or Mozambican phone reaches that third
// step and gets whichever child wins. Holding European at the parent settles
// every `pt-*` outside Brazil, which is what those countries write and how
// bitchat-android lays it out.
const PARENT_QUALIFIER = { "pt-PT": "values-pt" };

// Otherwise the legacy qualifier takes a two-letter language and a `-r` region;
// a script, or a three-letter language, needs the `b+` form. A subtag's length
// separates the two: `Hans` is a script, `BR` a region.
function qualifier(code) {
  const parent = PARENT_QUALIFIER[code];
  if (parent !== undefined) return parent;
  const [lang, sub] = code.split("-");
  if (sub !== undefined) {
    return sub.length === 2
      ? `values-${lang}-r${sub.toUpperCase()}`
      : `values-b+${lang}+${sub}`;
  }
  return lang.length > 2 ? `values-b+${lang}` : `values-${lang}`;
}

function readResources(file) {
  const out = {};
  const source = fs.readFileSync(file, "utf8");
  for (const m of source.matchAll(
    /<string name="([^"]+)"(?:\s+translatable="false")?\s*>([\s\S]*?)<\/string>/g,
  )) {
    out[m[1]] = m[2];
  }
  return out;
}

// `<plurals>` as name to { quantity: text }. Other attributes are allowed, for
// the widget's `tools:ignore`.
function readPlurals(file) {
  const out = {};
  const source = fs.readFileSync(file, "utf8");
  for (const m of source.matchAll(
    /<plurals name="([^"]+)"[^>]*>([\s\S]*?)<\/plurals>/g,
  )) {
    out[m[1]] = {};
    for (const item of m[2].matchAll(
      /<item quantity="([^"]+)"\s*>([\s\S]*?)<\/item>/g,
    )) {
      out[m[1]][item[1]] = item[2];
    }
  }
  return out;
}

const QUANTITIES = ["zero", "one", "two", "few", "many", "other"];

// aapt2 reads these before the XML parser does, so they fail the build rather
// than the review.
const BARE_APOSTROPHE = /(^|[^\\])'/;
const UNESCAPED_XML = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)|<|>/;

const base = readResources(path.join(RES, "values", "strings.xml"));
// Only what the app shows: `mesh_` is the background notice, `widget_` the
// home screen widget. `app_name` is a proper noun and the Expo flag is marked
// untranslatable.
const OWNED = /^(?:mesh|widget)_/;
const basePlurals = readPlurals(path.join(RES, "values", "strings.xml"));
const androidKeys = Object.keys(base).filter((k) => OWNED.test(k));
const androidPlurals = Object.keys(basePlurals).filter((k) => OWNED.test(k));

for (const prefix of ["mesh_", "widget_"]) {
  if (!androidKeys.some((k) => k.startsWith(prefix))) {
    errors.push(`android: values/strings.xml declares no ${prefix}* strings`);
  }
}

// `%1$s` and friends, as a sorted set. A translation that drops one loses the
// value; one that adds one shows a literal or throws in getString.
function placeholders(text) {
  return [...new Set(text.match(/%(?:\d+\$)?[sd]/g) ?? [])].sort().join(" ");
}

// A form may leave the count out where the words carry it (Arabic's dual reads
// "two peers" with no digit), so a form other than `other` may drop one but add
// none. The widget's caption takes no argument at all, its count drawn on the
// line above, so there every form matches exactly.
function placeholdersFit(key, quantity, value) {
  const want = placeholders(basePlurals[key].other);
  const have = placeholders(value);
  if (quantity === "other" || key.startsWith("widget_")) return have === want;
  return have.split(" ").every((p) => p === "" || want.split(" ").includes(p));
}

const overlays = fs
  .readdirSync(RES)
  .filter((n) => n.startsWith("values-") && n !== "values-night");
// English is the default `values/`, which every unmatched locale falls back to.
const wanted = new Map(
  codes.filter((c) => c !== "en").map((c) => [qualifier(c), c]),
);

for (const [dir, code] of wanted) {
  if (!overlays.includes(dir))
    errors.push(`android: missing res/${dir} (${code})`);
}
for (const dir of overlays) {
  if (!wanted.has(dir))
    errors.push(`android: res/${dir} is not a language the app ships`);
}

for (const [dir, code] of wanted) {
  const file = path.join(RES, dir, "strings.xml");
  if (!fs.existsSync(file)) {
    errors.push(`android ${code}: res/${dir} has no strings.xml`);
    continue;
  }
  const strings = readResources(file);
  for (const key of androidKeys) {
    const value = strings[key];
    if (value === undefined) errors.push(`android ${code}: missing ${key}`);
    else if (value.trim().length === 0)
      errors.push(`android ${code}: empty ${key}`);
    // aapt2 rejects a bare apostrophe inside <string>, so an orthography that
    // writes them (Malagasy's haraton'ny) breaks the build rather than degrading
    // it. The XML metacharacters below are the parser's problem, not aapt's.
    else if (BARE_APOSTROPHE.test(value))
      errors.push(
        `android ${code}: unescaped apostrophe in ${key}, write \\' instead`,
      );
    else if (UNESCAPED_XML.test(value))
      errors.push(`android ${code}: unescaped & < or > in ${key}`);
    else if (placeholders(value) !== placeholders(base[key]))
      errors.push(`android ${code}: ${key} placeholders differ from English`);
  }
  // Quantities follow the language's CLDR rules, which catalog.test.ts already
  // holds the JS catalog to; here only presence, `other`, escaping and
  // placeholders.
  const plurals = readPlurals(file);
  for (const key of androidPlurals) {
    const forms = plurals[key];
    if (forms === undefined) {
      errors.push(`android ${code}: missing plurals ${key}`);
      continue;
    }
    if (forms.other === undefined)
      errors.push(`android ${code}: ${key} has no "other" item`);
    for (const [quantity, value] of Object.entries(forms)) {
      const where = `${key}[${quantity}]`;
      if (!QUANTITIES.includes(quantity))
        errors.push(`android ${code}: unknown quantity ${where}`);
      else if (value.trim().length === 0)
        errors.push(`android ${code}: empty ${where}`);
      else if (BARE_APOSTROPHE.test(value))
        errors.push(
          `android ${code}: unescaped apostrophe in ${where}, write \\' instead`,
        );
      else if (UNESCAPED_XML.test(value))
        errors.push(`android ${code}: unescaped & < or > in ${where}`);
      else if (!placeholdersFit(key, quantity, value))
        errors.push(
          `android ${code}: ${where} placeholders differ from English`,
        );
    }
  }
  for (const key of Object.keys(plurals)) {
    if (!androidPlurals.includes(key)) {
      errors.push(`android ${code}: unknown plurals ${key}`);
    }
  }
  for (const key of Object.keys(strings)) {
    if (!androidKeys.includes(key)) {
      errors.push(`android ${code}: unknown key ${key}`);
    }
  }
}

// The per-app language picker on Android 13. A language missing from this file
// is one the picker cannot offer, however complete its catalog.
const LOCALE_CONFIG = path.join(RES, "xml", "locales_config.xml");
if (!fs.existsSync(LOCALE_CONFIG)) {
  errors.push("android: res/xml/locales_config.xml is missing");
} else {
  const declared = [
    ...fs
      .readFileSync(LOCALE_CONFIG, "utf8")
      .matchAll(/android:name="([^"]+)"/g),
  ].map((m) => m[1]);
  if (declared.join(" ") !== codes.join(" ")) {
    for (const code of codes) {
      if (!declared.includes(code))
        errors.push(`android: locales_config.xml is missing ${code}`);
    }
    for (const code of declared) {
      if (!codes.includes(code))
        errors.push(
          `android: locales_config.xml lists ${code}, which is not shipped`,
        );
    }
    if (
      declared.length === codes.length &&
      declared.every((c) => codes.includes(c))
    ) {
      errors.push("android: locales_config.xml is not in LANGUAGE_ORDER");
    }
  }
  const manifest = fs.readFileSync(
    path.join(ROOT, "android/app/src/main/AndroidManifest.xml"),
    "utf8",
  );
  if (!manifest.includes('android:localeConfig="@xml/locales_config"')) {
    errors.push(
      "android: AndroidManifest.xml does not point at locales_config",
    );
  }
}

// A literal left in the Kotlin is a string no overlay can reach.
const KOTLIN = path.join(
  ROOT,
  "android/app/src/main/java/org/onemindlabs/airhop",
);
const LITERAL_CALLS = {
  "service/AirhopForegroundService.kt": [
    "setContentTitle",
    "setContentText",
    "addAction",
  ],
  "widget/AirhopMeshWidget.kt": ["setTextViewText", "setContentDescription"],
};
for (const [file, calls] of Object.entries(LITERAL_CALLS)) {
  const source = fs.readFileSync(path.join(KOTLIN, file), "utf8");
  for (const call of calls) {
    for (const m of source.matchAll(
      new RegExp(`\\.${call}\\(([^\\n]*)`, "g"),
    )) {
      if (/"[^"]/.test(m[1])) {
        errors.push(`android: ${call} still passes a literal: ${m[1].trim()}`);
      }
    }
  }
}

// The same for the XML the widget host and the picker read: text, labels and
// descriptions point at a resource or say nothing.
const XML_COPY =
  /android:(?:text|label|description|contentDescription)="([^"]*)"/g;
const xmlFiles = [
  path.join(ROOT, "android/app/src/main/AndroidManifest.xml"),
  ...["layout", "xml"].flatMap((dir) =>
    fs.existsSync(path.join(RES, dir))
      ? fs
          .readdirSync(path.join(RES, dir))
          .filter((n) => n.endsWith(".xml"))
          .map((n) => path.join(RES, dir, n))
      : [],
  ),
];
for (const file of xmlFiles) {
  for (const m of fs.readFileSync(file, "utf8").matchAll(XML_COPY)) {
    if (m[1] !== "" && !m[1].startsWith("@")) {
      errors.push(
        `android: ${path.relative(ROOT, file)} has literal copy "${m[1]}"`,
      );
    }
  }
}

// MARK: - iOS widget

const WIDGET = path.join(ROOT, "ios", "AirhopWidget");
const WRITE = process.argv.includes("--write");

// What the widget draws on both platforms. Read from the Android keys, so a
// line added there for the widget is a line the iOS tables have to carry.
const widgetKeys = androidKeys.filter(
  (k) => k.startsWith("widget_") || k === "mesh_bluetooth_off",
);
const widgetPlurals = androidPlurals.filter((k) => k.startsWith("widget_"));

// Android resource text to the plain string, then into Apple's placeholder.
function plain(text) {
  return text
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/%(\d+)\$s/g, "%$1$@");
}

const stringsValue = (text) => text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const xmlValue = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function widgetStrings(dir, strings) {
  const lines = [
    `/* Written from android/app/src/main/res/${dir}/strings.xml by npm run i18n:native -- --write. Edit that file, not this one. */`,
    "",
    ...widgetKeys.map(
      (k) => `"${k}" = "${stringsValue(plain(strings[k] ?? ""))}";`,
    ),
  ];
  return lines.join("\n") + "\n";
}

// `%#@count@` with the forms under it: the count picks the form and, as on
// Android, is drawn on its own line, so no form needs to print it.
function widgetStringsdict(plurals) {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
  ];
  for (const key of widgetPlurals) {
    out.push(
      `\t<key>${key}</key>`,
      "\t<dict>",
      "\t\t<key>NSStringLocalizedFormatKey</key>",
      "\t\t<string>%#@count@</string>",
      "\t\t<key>count</key>",
      "\t\t<dict>",
      "\t\t\t<key>NSStringFormatSpecTypeKey</key>",
      "\t\t\t<string>NSStringPluralRuleType</string>",
      "\t\t\t<key>NSStringFormatValueTypeKey</key>",
      "\t\t\t<string>ld</string>",
    );
    for (const quantity of QUANTITIES) {
      const value = plurals[key]?.[quantity];
      if (value === undefined) continue;
      out.push(
        `\t\t\t<key>${quantity}</key>`,
        `\t\t\t<string>${xmlValue(plain(value))}</string>`,
      );
    }
    out.push("\t\t</dict>", "\t</dict>");
  }
  out.push("</dict>", "</plist>");
  return out.join("\n") + "\n";
}

const widgetLprojs = fs.existsSync(WIDGET)
  ? fs
      .readdirSync(WIDGET)
      .filter((n) => n.endsWith(".lproj"))
      .map((n) => n.slice(0, -".lproj".length))
  : [];
for (const code of widgetLprojs) {
  if (!codes.includes(code)) {
    errors.push(`ios widget: ${code}.lproj is not a language the app ships`);
  }
}

for (const code of codes) {
  const dir = code === "en" ? "values" : qualifier(code);
  const file = path.join(RES, dir, "strings.xml");
  if (!fs.existsSync(file)) continue; // reported above
  const want = {
    "Localizable.strings": widgetStrings(dir, readResources(file)),
    "Localizable.stringsdict": widgetStringsdict(readPlurals(file)),
  };
  for (const [name, text] of Object.entries(want)) {
    const target = path.join(WIDGET, `${code}.lproj`, name);
    if (WRITE) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    } else if (!fs.existsSync(target)) {
      errors.push(`ios widget: missing ${code}.lproj/${name}`);
    } else if (fs.readFileSync(target, "utf8") !== text) {
      errors.push(
        `ios widget ${code}: ${name} differs from res/${dir}, run npm run i18n:native -- --write`,
      );
    }
    // Up to the closing `;`, or Localizable.strings would match the
    // .stringsdict reference too.
    const ref = `${code}.lproj/${name}`;
    if (!pbx.includes(`${ref};`) && !pbx.includes(`${ref}";`)) {
      errors.push(
        `ios widget ${code}: ${name} not referenced by project.pbxproj`,
      );
    }
  }
}

// MARK: - Report

if (errors.length > 0) {
  console.error(errors.join("\n"));
  console.error(`\n${errors.length} problem(s).`);
  process.exit(1);
}

console.log(
  `${codes.length} languages. iOS: ${plistKeys.length} permission strings each. ` +
    `Android: ${androidKeys.length + androidPlurals.length} notice and widget strings each. ` +
    `iOS widget: ${widgetKeys.length + widgetPlurals.length} strings each.`,
);
