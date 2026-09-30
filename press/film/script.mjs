// The narration, one entry per spoken clip. Each becomes its own file in
// assets/vo/, so a line can be rewritten or re-timed without touching the rest.
//
// `say` is what the voice reads and is spelled for the ear: "Noster" for Nostr,
// "bit chat" for bitchat. `text` is the same line as a viewer would read it,
// kept beside it so a captions track can be cut from this file.
//
// Every claim here is one the docs already make. Where the wording is close to
// a sentence in the FAQ or ROADMAP.md, that is deliberate.

export const VOICE = "af_heart";
// A touch over natural pace. The film is dense, and Kokoro at 1.0 lingers.
export const SPEED = 1.06;

const line = (id, text, say = text) => ({ id, text, say });

export const LINES = [
  // Earth
  line("e1", "We’ve never been more connected."),
  line("e2", "But every message runs through a network that isn’t ours."),

  // The day it goes down
  line("l1", "So when it goes down..."),
  line("l2a", "During a natural disaster."),
  line("l2b", "At a packed festival."),
  line("l2c", "On a trail, two days in."),
  line("l2d", "Or in a shutdown."),
  line("l3", "...you go quiet."),

  // The idea
  line("i1", "But the person you need is still right there."),
  line("i2", "What if the phones just talked to each other?"),

  // The mark
  line("m1", "This is Airhop.", "This is Air hop."),
  line("m2", "Messaging that works without the internet."),

  // Mesh, hops, envelope, courier
  line("h1", "Nearby phones find each other over Bluetooth, and form a mesh."),
  line("h2", "Your message hops from phone to phone, until it reaches the one it’s for."),
  line("h3", "Sealed, like an envelope. Nobody in between can open it."),
  line("h4", "Nobody in range? A passing phone carries it there."),

  // The turn
  line("t1", "Pretty cool?"),
  line("t2", "That’s not all."),

  // Identity
  line("d1", "No account."),
  line("d2", "No phone number."),
  line("d3", "Just a key, made on your phone."),

  // Nostr
  line(
    "n1",
    "Out of Bluetooth range? Airhop switches to Nostr.",
    "Out of Bluetooth range? Air hop switches to Noster.",
  ),
  line("n2", "Hundreds of independent relays. None of them ours."),
  line("n3", "Your message travels gift-wrapped, so no relay can read it."),
  line("n4", "Add Tor, and they can’t see where you are."),
  line("n5", "Next door, or across the planet, you stay in touch."),

  // And more
  line("r1", "There’s more."),
  line("r2", "Rooms for your block and your city."),
  line("r3", "Live voice, like a walkie-talkie."),
  line("r4", "Notices that stay pinned."),
  line("r5", "A gateway, to share your connection."),
  line("r6", "A bridge between two crowds."),
  line("r7", "Thirty-five languages."),

  // Wallet
  line("w1", "And money."),
  line(
    "w2",
    "Ecash, handed phone to phone, with no signal on either one.",
    "E-cash, handed phone to phone, with no signal on either one.",
  ),
  line("w4", "How is that possible?"),
  line(
    "w5",
    "It’s Cashu: digital cash, backed by Bitcoin. Whoever holds a coin can spend it, like a banknote.",
    "It’s Cashoo: digital cash, backed by Bitcoin. Whoever holds a coin can spend it, like a banknote.",
  ),
  line("w3", "Back online, the mint confirms it."),

  // bitchat
  line(
    "b1",
    "Airhop speaks bitchat’s open protocol, so the two just talk.",
    "Air hop speaks bit chat’s open protocol, so the two just talk.",
  ),
  line("b2", "Then we kept going."),
  line("b3", "The Double Ratchet algorithm: a new key for every message."),
  line("b4", "Wi-Fi Aware.", "Why-fye Aware."),
  line("b5", "mDNS discovery.", "M D N S discovery."),
  line("b6", "Tor, with bridges."),
  line("b7", "A full wallet, powered by Cashu.", "A full wallet, powered by Cashoo."),
  line("b8", "One codebase, in TypeScript.", "One codebase, in Type Script."),

  // Cryptography
  line("c1", "And the cryptography? We didn’t invent it. That’s the point."),
  line("c2", "The Noise handshake, proven in WireGuard.", "The Noise handshake, proven in Wire Guard."),
  line("c3", "The Double Ratchet algorithm, from Signal."),
  line("c4", "The Onion Router, from the Tor Project."),
  line("c5", "Open. Studied. Proven. We just made it easy."),

  // Nothing to hand over
  line("x1", "No servers."),
  line("x2", "No accounts."),
  line("x3", "No tracking."),
  line("x4", "Nothing to hand over."),
  line("x5", "New phone? Scan a code, and everything moves across."),
  line("x6", "And if you ever need to: three taps, and it’s gone."),

  // Not done
  line("z1", "And we’re not done yet."),
  line("z2", "Coming soon."),

  // End
  line("f1", "Try Airhop.", "Try Air hop."),
  line("f2", "Free, and open source."),
  line("f3", "Let’s airhop.", "Let’s air hop."),
];
