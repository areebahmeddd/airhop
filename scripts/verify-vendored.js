#!/usr/bin/env node
// Verifies that every committed native binary still matches the hash recorded
// in vendor.lock.json.
//
//   node scripts/verify-vendored.js            check the tree against the lock
//   node scripts/verify-vendored.js --write     record the current tree as the lock
//
// Why this exists. The embedded Tor client and its pluggable transports ship as
// compiled binaries committed straight into the repository. Nobody reviews a
// binary diff, and git alone will not tell you the bytes changed for a reason.
// A swapped blob looks exactly like a legitimate update in a pull request
// summary.
//
// What it checks, and no more:
//
// - Every tracked file under the vendored paths against the lock, so a binary
//   cannot change, appear or vanish without a re-recorded lock.
// - The lock against the SHA256SUMS files the build scripts in native/ write,
//   so a lock re-recorded without a build fails.
// - Every other tracked file for an executable or archive header, so a binary
//   cannot be committed somewhere this does not hash.
//
// None of that proves a binary corresponds to its source. Rebuilding it does:
// native/*/build-in-container.sh is reproducible for Android (run it twice from
// clean and compare SHA256SUMS.android), and build-native.yml rebuilds both
// platforms in CI. This is the cheap check that runs on every pull request.

const { createHash } = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const LOCK_FILE = "vendor.lock.json";

// Directories whose entire tracked contents are built artifacts. Every tracked
// file underneath is hashed, so a new file appearing is caught too: adding a
// file is as effective an attack as modifying one, and a manifest that only
// lists what it already knows about would miss it.
const VENDORED_PATHS = [
  "ios/Frameworks",
  "android/app/src/main/jniLibs",
  // The transports ship as an aar, not a bare .so: gomobile emits the Java
  // bindings the Kotlin side calls alongside the native code.
  "android/app/libs",
];

// Written by the build scripts in native/arti and native/iptproxy, one per
// platform, in sha256sum's format with paths relative to the repository root.
const BUILD_MANIFEST = /^native\/[^/]+\/SHA256SUMS\.[^/]+$/;

// Leading bytes of an ELF object, a Mach-O object (both widths, both byte
// orders), a universal binary, an `ar` archive and a zip (jar, aar, apk).
const BINARY_MAGIC = [
  "7f454c46",
  "feedface",
  "feedfacf",
  "cefaedfe",
  "cffaedfe",
  "cafebabe",
  "213c617263683e0a",
  "504b0304",
].map((hex) => Buffer.from(hex, "hex"));

// Binaries allowed outside the vendored paths. The Gradle wrapper jar is
// checked against Gradle's published checksums by ci.yml's wrapper validation
// instead.
const BINARY_ALLOWLIST = new Set(["android/gradle/wrapper/gradle-wrapper.jar"]);

function trackedFiles(prefix) {
  const args = ["ls-files", "-z"];
  if (prefix) args.push("--", prefix);
  const out = execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  // Posix separators so paths compare equal, and the lock reads the same, on
  // every platform.
  return out
    .split("\0")
    .filter((f) => f.length > 0)
    .map((f) => f.split(path.sep).join("/"));
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function currentTree() {
  const entries = {};
  const missing = [];
  for (const prefix of VENDORED_PATHS) {
    for (const file of trackedFiles(prefix)) {
      // Git still lists a file that has been deleted from the working tree but
      // whose deletion has not been staged, which is the ordinary state after
      // removing a binary by hand. Reading it throws a bare ENOENT and a stack
      // trace that says nothing about what to do, so collect these and say it
      // properly below.
      if (!fs.existsSync(file)) {
        missing.push(file);
        continue;
      }
      entries[file] = sha256(file);
    }
  }
  if (missing.length > 0) {
    console.error("Tracked binaries are missing from the working tree.\n");
    for (const file of missing) console.error(`  ${file}`);
    fail(
      "Stage the deletions (git add -A) if this is deliberate, or restore the files.",
    );
  }
  return entries;
}

// The union of every build manifest. A path listed twice must agree with
// itself, or which hash wins would depend on read order.
function buildManifests(problems) {
  const entries = {};
  const manifests = trackedFiles("native").filter((f) =>
    BUILD_MANIFEST.test(f),
  );
  for (const file of manifests) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
      if (!match) {
        problems.push(`${file}: not a sha256sum line: ${line}`);
        continue;
      }
      const [, hash, name] = match;
      if (entries[name] !== undefined && entries[name] !== hash) {
        problems.push(`${name}: listed with two different hashes in native/`);
      }
      entries[name] = hash;
    }
  }
  return entries;
}

function hasBinaryMagic(file) {
  const head = Buffer.alloc(8);
  let read;
  try {
    const fd = fs.openSync(file, "r");
    try {
      read = fs.readSync(fd, head, 0, head.length, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // A submodule directory, or a file deleted but not yet staged. Neither has
    // bytes to inspect.
    return false;
  }
  return BINARY_MAGIC.some(
    (magic) =>
      read >= magic.length && head.subarray(0, magic.length).equals(magic),
  );
}

function strayBinaries() {
  const vendored = (file) =>
    VENDORED_PATHS.some((prefix) => file.startsWith(`${prefix}/`));
  return trackedFiles().filter(
    (file) =>
      !vendored(file) && !BINARY_ALLOWLIST.has(file) && hasBinaryMagic(file),
  );
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function main() {
  const write = process.argv.includes("--write");
  const tree = currentTree();
  const names = Object.keys(tree).sort();

  if (names.length === 0) {
    fail(`No tracked files under ${VENDORED_PATHS.join(", ")}`);
  }

  if (write) {
    const lock = { files: {} };
    for (const name of names) lock.files[name] = tree[name];
    fs.writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2) + "\n");
    console.log(`Recorded ${names.length} vendored file(s) in ${LOCK_FILE}.`);
    return;
  }

  if (!fs.existsSync(LOCK_FILE)) {
    fail(
      `${LOCK_FILE} is missing. Run: node scripts/verify-vendored.js --write`,
    );
  }

  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
  } catch (err) {
    fail(`${LOCK_FILE} is not valid JSON: ${err.message}`);
  }
  const recorded = lock.files ?? {};

  const problems = [];
  for (const name of names) {
    if (recorded[name] === undefined) {
      problems.push(`${name}: present in the tree but not in ${LOCK_FILE}`);
    } else if (recorded[name] !== tree[name]) {
      problems.push(
        `${name}: hash changed\n    expected ${recorded[name]}\n    found    ${tree[name]}`,
      );
    }
  }
  for (const name of Object.keys(recorded)) {
    if (tree[name] === undefined) {
      problems.push(
        `${name}: recorded in ${LOCK_FILE} but missing from the tree`,
      );
    }
  }

  const built = buildManifests(problems);
  for (const name of Object.keys(recorded)) {
    if (built[name] === undefined) {
      problems.push(`${name}: in ${LOCK_FILE} but in no native/*/SHA256SUMS.*`);
    } else if (built[name] !== recorded[name]) {
      problems.push(
        `${name}: ${LOCK_FILE} and the build's SHA256SUMS disagree\n    lock     ${recorded[name]}\n    build    ${built[name]}`,
      );
    }
  }
  for (const name of Object.keys(built)) {
    if (recorded[name] === undefined) {
      problems.push(
        `${name}: in native/*/SHA256SUMS.* but not in ${LOCK_FILE}`,
      );
    }
  }

  for (const file of strayBinaries()) {
    problems.push(
      `${file}: an executable or archive outside ${VENDORED_PATHS.join(", ")}`,
    );
  }

  if (problems.length > 0) {
    console.error("Committed binaries failed verification.\n");
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      `\nRebuild with the scripts in native/ (or build-native.yml), which write` +
        ` the SHA256SUMS files, then re-record the lock in the same commit:\n` +
        `  node scripts/verify-vendored.js --write\n`,
    );
    fail(`${problems.length} problem(s) with committed binaries`);
  }

  console.log(
    `Verified ${names.length} vendored file(s) against ${LOCK_FILE} and native/*/SHA256SUMS.*.`,
  );
}

main();
