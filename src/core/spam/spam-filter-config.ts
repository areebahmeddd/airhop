// Limits for the public spam filter. Identical to bitchat-android's
// SpamFilterConfig and bitchat-ios's port, so a message one client hides, the
// others hide too.

export interface TokenBucketConfig {
  capacity: number;
  refillPerSecond: number;
}

// Per sender: a burst of 6 messages then one every 10 s, 1200 characters a
// minute, 2 links a minute. The character capacity is also the longest public
// message any bitchat client will show.
export const MESSAGE_BUCKET: TokenBucketConfig = {
  capacity: 6,
  refillPerSecond: 1 / 10,
};
export const CHARACTER_BUCKET: TokenBucketConfig = {
  capacity: 1200,
  refillPerSecond: 1200 / 60,
};
export const LINK_BUCKET: TokenBucketConfig = {
  capacity: 2,
  refillPerSecond: 2 / 60,
};

export const SPAM_FILTER_CONFIG = {
  // Relay backfill (an hour of geohash history) and gossip sync deliver history
  // in bursts, so buckets run on message time, clamped to this window.
  maxBackdateSeconds: 60 * 60,
  maxTrackedSenders: 1_000,
  // Verdicts by message ID, so one message arriving over several paths is
  // judged and counted once.
  maxRememberedVerdicts: 4_000,
  minRepeatedCharactersLength: 32,
  repeatedCharactersThreshold: 0.85,
  minRepeatedMessageLength: 10,
  repeatedMessageSimilarity: 0.8,
  // Near-copies a sender may post within the history window.
  allowedRepeats: 1,
  // Near-copies other senders may already have posted, which catches one text
  // spread over many throwaway identities.
  crossUserAllowedRepeats: 2,
  crossUserMinLength: 16,
  crossUserHistorySize: 200,
  // Caps on the work one message can cause against other senders' texts; a
  // flood built from a tiny alphabet passes the cheap checks.
  crossUserMaxComparisons: 64,
  crossUserMaxAlignments: 8,
  historySize: 10,
  historyWindowSeconds: 10 * 60,
  maxAnalyzedLength: 1_000,
  maxComparedLength: 280,
  maxAlignmentPeaks: 3,
  minPeakRun: 3,
  minSharedTrigrams: 0.25,
} as const;
