// Decides whether an incoming public message is hidden. Ported from bitchat's
// SpamFilter (Android shipped it in 2.1.0; iOS is porting it) with the same
// limits, so the three clients hide the same messages.
//
// Each sender gets three token buckets (messages, characters, links) plus three
// repetition checks: a message that repeats itself internally, a near-copy of
// the sender's own recent messages, and a near-copy of what other senders
// posted recently, which catches one text spread over many identities. Hidden
// messages spend no tokens but do enter the repetition history, so a spammer
// cannot cycle one text. Purely local: the message is still relayed.

import { countLinks } from "./link-counter";
import {
  alignmentUpperBound,
  crossSimilarity,
  normalizeForComparison,
  positionsOf,
  selfSimilarityReaches,
  trigramOverlap,
  trigramsOf,
} from "./repetition-detector";
import {
  SPAM_FILTER_CONFIG as C,
  CHARACTER_BUCKET,
  LINK_BUCKET,
  MESSAGE_BUCKET,
} from "./spam-filter-config";
import { TokenBucketSchedule } from "./token-bucket-schedule";

export type SpamVerdict =
  | "allowed"
  | "message-rate"
  | "character-rate"
  | "link-rate"
  | "repeated-message"
  | "repeated-across-users"
  | "repeated-characters";

interface Fingerprint {
  time: number;
  text: number[];
  trigrams: number[];
}

interface SenderState {
  rate: TokenBucketSchedule;
  history: Fingerprint[];
  lastActive: number;
}

interface SharedEntry {
  senderKey: string;
  fingerprint: Fingerprint;
}

// Work left for comparing one message against others. The trigram check is
// free; the diagonal bound spends a comparison and a full alignment spends an
// alignment.
interface ComparisonBudget {
  comparisons: number;
  alignments: number;
  positions: Map<number, number[]> | null;
}

export class SpamFilter {
  enabled = true;
  private readonly senders = new Map<string, SenderState>();
  private activity = 0;
  // Recent texts from every sender, numbered in arrival order from
  // `recentStart`, with an index from trigram to the texts holding it, so a
  // message only meets the texts it shares trigrams with.
  private recentTexts: SharedEntry[] = [];
  private recentStart = 0;
  private readonly recentTrigrams = new Map<number, number[]>();
  // Insertion-ordered, so the first key is the oldest verdict.
  private readonly verdicts = new Map<string, SpamVerdict>();

  constructor(private readonly nowMs: () => number = Date.now) {}

  // `senderKey` must name the author stably within a transport, and
  // `messageID` must be the same for every copy of one message.
  check(
    senderKey: string,
    messageID: string,
    content: string,
    timestampMs: number,
  ): SpamVerdict {
    if (!this.enabled) return "allowed";
    const known = this.verdicts.get(messageID);
    if (known !== undefined) return known;

    const now = this.nowMs() / 1000;
    const oldestTrusted = now - C.maxBackdateSeconds;
    const time = Math.min(Math.max(timestampMs / 1000, oldestTrusted), now);
    const state = this.senders.get(senderKey) ?? {
      rate: new TokenBucketSchedule([
        MESSAGE_BUCKET,
        CHARACTER_BUCKET,
        LINK_BUCKET,
      ]),
      history: [],
      lastActive: 0,
    };
    this.senders.delete(senderKey);
    state.lastActive = ++this.activity;
    state.rate.prune(oldestTrusted);

    const text = normalizeForComparison(content, C.maxAnalyzedLength);
    const compared = text.slice(0, C.maxComparedLength);
    const fingerprint: Fingerprint = {
      time,
      text: compared,
      trigrams: trigramsOf(compared),
    };

    let verdict: SpamVerdict;
    if (
      text.length >= C.minRepeatedCharactersLength &&
      selfSimilarityReaches(text, C.repeatedCharactersThreshold)
    ) {
      verdict = "repeated-characters";
    } else if (repeatsHistory(state, text.length, fingerprint)) {
      verdict = "repeated-message";
    } else if (this.repeatsOthers(senderKey, text.length, fingerprint)) {
      verdict = "repeated-across-users";
    } else {
      verdict = admitRate(state, content, time);
    }

    state.history.push(fingerprint);
    if (state.history.length > C.historySize) state.history.shift();
    if (text.length >= C.crossUserMinLength) {
      this.rememberRecent({ senderKey, fingerprint });
    }
    this.senders.set(senderKey, state);
    this.evictSenders();
    this.verdicts.set(messageID, verdict);
    if (this.verdicts.size > C.maxRememberedVerdicts) {
      const oldest = this.verdicts.keys().next().value;
      if (oldest !== undefined) this.verdicts.delete(oldest);
    }
    return verdict;
  }

  // Forgets every sender and text, as on a toggle.
  reset(): void {
    this.senders.clear();
    this.activity = 0;
    this.recentTexts = [];
    this.recentStart = 0;
    this.recentTrigrams.clear();
    this.verdicts.clear();
  }

  // Newest first, so a burst of look-alikes exhausting the budget spends it on
  // the oldest texts.
  private repeatsOthers(
    senderKey: string,
    length: number,
    message: Fingerprint,
  ): boolean {
    if (length < C.crossUserMinLength) return false;
    const shared = new Array<number>(this.recentTexts.length).fill(0);
    for (const trigram of message.trigrams) {
      for (const sequence of this.recentTrigrams.get(trigram) ?? []) {
        shared[sequence - this.recentStart]++;
      }
    }
    const budget: ComparisonBudget = {
      comparisons: C.crossUserMaxComparisons,
      alignments: C.crossUserMaxAlignments,
      positions: null,
    };
    let copies = 0;
    for (let i = shared.length - 1; i >= 0; i--) {
      if (shared[i] === 0 && C.minSharedTrigrams > 0) continue;
      const entry = this.recentTexts[i];
      if (entry.senderKey === senderKey) continue;
      if (budget.comparisons <= 0 || budget.alignments <= 0) break;
      const larger = Math.max(
        entry.fingerprint.trigrams.length,
        message.trigrams.length,
      );
      const overlap = larger === 0 ? 1 : shared[i] / larger;
      if (!isNearCopy(entry.fingerprint, message, overlap, budget)) continue;
      if (++copies > C.crossUserAllowedRepeats) return true;
    }
    return false;
  }

  private rememberRecent(entry: SharedEntry): void {
    const sequence = this.recentStart + this.recentTexts.length;
    this.recentTexts.push(entry);
    for (const trigram of entry.fingerprint.trigrams) {
      const list = this.recentTrigrams.get(trigram);
      if (list === undefined) this.recentTrigrams.set(trigram, [sequence]);
      else list.push(sequence);
    }
    while (this.recentTexts.length > C.crossUserHistorySize) {
      const oldest = this.recentTexts.shift() as SharedEntry;
      // The oldest text holds the smallest sequence in each of its lists.
      for (const trigram of oldest.fingerprint.trigrams) {
        const list = this.recentTrigrams.get(trigram);
        if (list === undefined) continue;
        list.shift();
        if (list.length === 0) this.recentTrigrams.delete(trigram);
      }
      this.recentStart++;
    }
  }

  // Drops the least recently active senders once over the limit, in one pass
  // down to three quarters of it so the sort runs rarely.
  private evictSenders(): void {
    if (this.senders.size <= C.maxTrackedSenders) return;
    const keep = Math.max(1, Math.floor((C.maxTrackedSenders * 3) / 4));
    const byAge = [...this.senders].sort(
      (a, b) => a[1].lastActive - b[1].lastActive,
    );
    for (const [key] of byAge.slice(0, this.senders.size - keep)) {
      this.senders.delete(key);
    }
  }
}

function repeatsHistory(
  state: SenderState,
  length: number,
  message: Fingerprint,
): boolean {
  if (length < C.minRepeatedMessageLength) return false;
  const budget: ComparisonBudget = {
    comparisons: Number.POSITIVE_INFINITY,
    alignments: Number.POSITIVE_INFINITY,
    positions: null,
  };
  const copies = state.history.filter((earlier) =>
    isNearCopy(
      earlier,
      message,
      trigramOverlap(earlier.trigrams, message.trigrams),
      budget,
    ),
  ).length;
  return copies > C.allowedRepeats;
}

function isNearCopy(
  earlier: Fingerprint,
  message: Fingerprint,
  sharedTrigrams: number,
  budget: ComparisonBudget,
): boolean {
  const shorter = Math.min(earlier.text.length, message.text.length);
  const longer = Math.max(earlier.text.length, message.text.length);
  // The similarity can never exceed shorter over longer.
  if (
    Math.abs(earlier.time - message.time) > C.historyWindowSeconds ||
    longer === 0 ||
    shorter / longer < C.repeatedMessageSimilarity ||
    sharedTrigrams < C.minSharedTrigrams
  ) {
    return false;
  }
  budget.comparisons--;
  budget.positions ??= positionsOf(message.text);
  const bound = alignmentUpperBound(
    earlier.text,
    message.text,
    budget.positions,
    C.maxAlignmentPeaks,
  );
  if (bound / longer < C.repeatedMessageSimilarity) return false;
  budget.alignments--;
  return (
    crossSimilarity(
      earlier.text,
      message.text,
      C.maxAlignmentPeaks,
      C.minPeakRun,
    ) >= C.repeatedMessageSimilarity
  );
}

// Characters are code points, as bitchat counts them.
function admitRate(
  state: SenderState,
  content: string,
  time: number,
): SpamVerdict {
  const costs = [1, Array.from(content).length, countLinks(content)];
  switch (state.rate.tryAdmit(time, costs)) {
    case null:
      return "allowed";
    case 0:
      return "message-rate";
    case 1:
      return "character-rate";
    default:
      return "link-rate";
  }
}
