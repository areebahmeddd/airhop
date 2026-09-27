// Third-party package licenses.
//
// Versions come from this repo's package.json at build time, so the list cannot
// drift from what is pinned. Native binaries set `version` by hand, since npm
// does not install them. Everything else here is curated: name, license, repo
// and group.
//
// A declared license is the default answer, not the final one: what matters is
// the license of the code that ships in the binary. Where a thin wrapper links
// a differently-licensed native library, both are named (see react-native-mmkv,
// and IPtProxy with the transports inside it).

import pkg from "../../package.json";

export interface LicenseEntry {
  name: string;
  version: string;
  license: string;
  repo: string;
}

export interface LicenseGroup {
  category: string;
  description: string;
  entries: LicenseEntry[];
}

const DEPENDENCIES = pkg.dependencies as Record<string, string>;

// The pinned version without its range prefix ("~1.2.3" -> "1.2.3"), or "n/a"
// for an entry that is no longer a dependency.
function versionOf(name: string): string {
  const range = DEPENDENCIES[name];
  return range ? range.replace(/^[\^~]/, "") : "n/a";
}

// Grouped by role, alphabetical within a group.
const CATALOG: {
  category: string;
  description: string;
  packages: {
    name: string;
    license: string;
    repo: string;
    // Only for entries npm does not install; everything else is looked up.
    version?: string;
  }[];
}[] = [
  {
    category: "Core",
    description:
      "What the app is built on: React and React Native, packaged by Expo.",
    packages: [
      {
        name: "expo",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo",
      },
      {
        name: "react",
        license: "MIT",
        repo: "https://github.com/facebook/react",
      },
      {
        name: "react-native",
        license: "MIT",
        repo: "https://github.com/facebook/react-native",
      },
    ],
  },
  {
    category: "Device features",
    description:
      "The parts of the phone the app uses: camera, microphone, location, files, notifications, network state, languages and the screen lock.",
    packages: [
      {
        name: "expo-audio",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-audio",
      },
      {
        name: "expo-build-properties",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-build-properties",
      },
      {
        name: "expo-camera",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-camera",
      },
      {
        name: "expo-clipboard",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-clipboard",
      },
      {
        name: "expo-document-picker",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-document-picker",
      },
      {
        name: "expo-file-system",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-file-system",
      },
      {
        name: "expo-haptics",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-haptics",
      },
      {
        name: "expo-image-manipulator",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-image-manipulator",
      },
      {
        name: "expo-image-picker",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-image-picker",
      },
      {
        name: "expo-intent-launcher",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-intent-launcher",
      },
      {
        name: "expo-local-authentication",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-local-authentication",
      },
      {
        name: "expo-localization",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-localization",
      },
      {
        name: "expo-location",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-location",
      },
      {
        name: "expo-media-library",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-media-library",
      },
      {
        name: "expo-navigation-bar",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-navigation-bar",
      },
      {
        name: "expo-network",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-network",
      },
      {
        name: "expo-notifications",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-notifications",
      },
      {
        name: "expo-screen-capture",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-screen-capture",
      },
      {
        name: "expo-sharing",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-sharing",
      },
      {
        name: "expo-status-bar",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-status-bar",
      },
      {
        name: "expo-system-ui",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-system-ui",
      },
      {
        name: "expo-video",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-video",
      },
    ],
  },
  {
    category: "UI & rendering",
    description:
      "What draws the screen: fonts, icons, assets, gestures, animation, SVG and QR codes.",
    packages: [
      {
        name: "@expo-google-fonts/jetbrains-mono",
        license: "MIT AND OFL-1.1",
        repo: "https://github.com/expo/google-fonts/tree/main/font-packages/jetbrains-mono",
      },
      {
        name: "@react-native-vector-icons/feather",
        license: "MIT",
        repo: "https://github.com/oblador/react-native-vector-icons/tree/master/packages/feather",
      },
      {
        name: "@react-native-vector-icons/material-design-icons",
        license: "MIT",
        repo: "https://github.com/oblador/react-native-vector-icons/tree/master/packages/material-design-icons",
      },
      {
        name: "expo-asset",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-asset",
      },
      {
        name: "expo-font",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-font",
      },
      {
        name: "react-native-gesture-handler",
        license: "MIT",
        repo: "https://github.com/software-mansion/react-native-gesture-handler",
      },
      {
        name: "react-native-qrcode-svg",
        license: "MIT",
        repo: "https://github.com/Expensify/react-native-qrcode-svg",
      },
      {
        name: "react-native-reanimated",
        license: "MIT",
        repo: "https://github.com/software-mansion/react-native-reanimated",
      },
      {
        name: "react-native-safe-area-context",
        license: "MIT",
        repo: "https://github.com/AppAndFlow/react-native-safe-area-context",
      },
      {
        name: "react-native-svg",
        license: "MIT",
        repo: "https://github.com/software-mansion/react-native-svg",
      },
      {
        name: "react-native-worklets",
        license: "MIT",
        repo: "https://github.com/software-mansion/react-native-reanimated/tree/main/packages/react-native-worklets",
      },
    ],
  },
  {
    category: "Cryptography & protocol",
    description:
      "The foundations of encryption and messaging: key exchange, ciphers, hashing, seed phrases, compression, ecash, Nostr.",
    packages: [
      {
        name: "@cashu/cashu-ts",
        license: "MIT",
        repo: "https://github.com/cashubtc/cashu-ts",
      },
      {
        name: "@noble/ciphers",
        license: "MIT",
        repo: "https://github.com/paulmillr/noble-ciphers",
      },
      {
        name: "@noble/curves",
        license: "MIT",
        repo: "https://github.com/paulmillr/noble-curves",
      },
      {
        name: "@noble/hashes",
        license: "MIT",
        repo: "https://github.com/paulmillr/noble-hashes",
      },
      {
        name: "@scure/bip39",
        license: "MIT",
        repo: "https://github.com/paulmillr/scure-bip39",
      },
      {
        name: "nostr-tools",
        license: "Unlicense",
        repo: "https://github.com/nbd-wtf/nostr-tools",
      },
      {
        name: "pako",
        license: "MIT AND Zlib",
        repo: "https://github.com/nodeca/pako",
      },
    ],
  },
  {
    category: "Storage & state",
    description:
      "Where data is kept: local storage, secure randomness, native modules, in-memory state.",
    packages: [
      {
        name: "expo-secure-store",
        license: "MIT",
        repo: "https://github.com/expo/expo/tree/main/packages/expo-secure-store",
      },
      {
        name: "react-native-get-random-values",
        license: "MIT",
        repo: "https://github.com/LinusU/react-native-get-random-values",
      },
      {
        // Wrapper is MIT; it links Tencent's MMKV (BSD-3-Clause), which ships
        // in the binary.
        name: "react-native-mmkv",
        license: "MIT AND BSD-3-Clause",
        repo: "https://github.com/mrousavy/react-native-mmkv",
      },
      {
        name: "react-native-nitro-modules",
        license: "MIT",
        repo: "https://github.com/mrousavy/nitro",
      },
      {
        name: "zustand",
        license: "MIT",
        repo: "https://github.com/pmndrs/zustand",
      },
    ],
  },
  {
    category: "Binaries & frameworks",
    description:
      "Native code committed to this repo and shipped in the app, not installed from npm.",
    packages: [
      {
        name: "arti",
        version: "0.46.0",
        license: "MIT OR Apache-2.0",
        repo: "https://gitlab.torproject.org/tpo/core/arti",
      },
      {
        name: "IPtProxy",
        version: "5.5.1",
        license: "MIT",
        repo: "https://github.com/tladesignz/IPtProxy",
      },
      {
        name: "lyrebird",
        version: "bundled with IPtProxy",
        license: "BSD-3-Clause",
        repo: "https://gitlab.torproject.org/tpo/anti-censorship/pluggable-transports/lyrebird",
      },
      {
        name: "snowflake",
        version: "bundled with IPtProxy",
        license: "BSD-3-Clause",
        repo: "https://gitlab.torproject.org/tpo/anti-censorship/pluggable-transports/snowflake",
      },
    ],
  },
];

export const THIRD_PARTY_LICENSES: LicenseGroup[] = CATALOG.map((group) => ({
  category: group.category,
  description: group.description,
  entries: group.packages.map((p) => ({
    name: p.name,
    version: p.version ?? versionOf(p.name),
    license: p.license,
    repo: p.repo,
  })),
}));
