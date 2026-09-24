// Wallet screen: a balance card holding Receive, Send, Scan and Mints, the
// recovery phrase row, Activity, and the sheets those open.
//
// Presentation only. `services/wallet-service` owns proof selection,
// reservations and mint calls; no proof arithmetic happens here, because the
// DM thread and contact sheet run the same logic and must not drift. Rules:
//   * Value the mint has not confirmed unspent gets an "unconfirmed" line,
//     never folded into the headline.
//   * A built token stays reserved and listed in Activity, to re-share or
//     reclaim, until the user says it landed.
//   * An action that needs the internet says why when it cannot run.

import {
  bareToken,
  canEncodeTokenQr,
  isLikelyTestMint,
  TOKEN_QR_ERROR_CORRECTION,
  TOKEN_QR_MAX_CHARS,
  TOKEN_QR_SIZE,
  tokenQrPayload,
} from "@core/payments/cashu";
import { classifyScan } from "@core/payments/scan";
import {
  isValidRecoveryPhrase,
  normalizeRecoveryPhrase,
  pickVerificationPositions,
  unknownWordsIn,
  verifyPositions,
} from "@core/payments/wallet-seed";
import { Feather } from "@expo/vector-icons";
import { t, tPlural, useT, useTPlural } from "@i18n";
import { chevronForward, textAlignEnd } from "@i18n/layout";
import { acknowledged, succeeded } from "@platform/haptics";
import { getMeshService } from "@services/mesh-service";
import {
  deliverTokenToPeer,
  describePayResult,
  describeRoute,
  payPerson,
  reclaimTokenSend,
} from "@services/payment-router";
import {
  addMint as addMintService,
  claimLightningDeposit,
  confirmSend,
  consolidateMints,
  createLightningDeposit,
  enableWalletBackup,
  getRecoveryPhrase,
  hostOf,
  markBackupVerified,
  mintNetworkBlock,
  payLightningInvoice,
  prepareSend,
  quoteLightningWithdrawal,
  quoteSend,
  receiveToken,
  reconcile,
  refreshAccount,
  restoreFromRecoveryPhrase,
  WalletError,
  type LightningDeposit,
  type MeltQuote,
  type PreparedSend,
  type RestoreResult,
} from "@services/wallet-service";
import { showAlert, useAlertStore } from "@store/alert-store";
import { useContactsStore } from "@store/contacts-store";
import { useMeshStateStore } from "@store/mesh-state-store";
import { REACHABLE_TTL_MS, usePeerStore } from "@store/peer-store";
import { useSettingsStore } from "@store/settings-store";
import {
  isWalletStorageReady,
  selectAccounts,
  useWalletStore,
  whenWalletHydrated,
  type AccountBalance,
  type WalletTx,
} from "@store/wallet-store";
import Avatar from "@ui/components/avatar";
import BottomSheet from "@ui/components/bottom-sheet";
import ChoiceList from "@ui/components/choice-list";
import CopyGlyph from "@ui/components/copy-glyph";
import { useCopy } from "@ui/hooks/use-copy";
import { usePullRefreshColors } from "@ui/hooks/use-pull-refresh";
import {
  BUTTON_HEIGHT,
  DISABLED_OPACITY,
  FontFamily,
  FontSize,
  FontWeight,
  MIN_TOUCH,
  PRESSED_OPACITY,
  Radius,
  Spacing,
  TAB_BAR_CLEARANCE,
  useThemeColors,
} from "@ui/theme";
import {
  amountParts,
  formatAgo,
  formatAmount,
  formatNumber,
  formatUnitAmount,
  parseWholeNumber,
  unitLabel,
} from "@utils/format";
import { nostrShortLabel, peerIDToUsername } from "@utils/username";
import * as Clipboard from "expo-clipboard";
import { useNetworkState } from "expo-network";
import { nip19 } from "nostr-tools";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import QRCode from "react-native-qrcode-svg";
import TokenScanSheet, { type ScanTarget } from "./token-scan-sheet";

// What the App-level header can ask of this screen.
export type WalletAction = "help";

// Secondary text on the accent-filled balance card. Measured on both fills:
// white at this opacity on #111111, and #111111 on #F5F5F5, both clear 4.5:1.
const SECONDARY_ON_ACCENT = 0.72;

// The action circles in the balance card. The column around a circle is the
// MIN_TOUCH target.
const ACTION_CIRCLE = 48;

// Matches ChoiceList's glyph circle, so sheet lists read as one family.
const LIST_ICON = 38;

// One Activity row: a title and a meta line between Spacing.md paddings.
const ACTIVITY_ROW_HEIGHT = 64;

// How long a bottom sheet takes to slide out. Presenting the camera before it
// has gone would stack two modals, which iOS refuses.
const SHEET_EXIT_MS = 260;

// How often to poll a pending Lightning deposit while its sheet is open.
const DEPOSIT_POLL_MS = 3000;

// Three rows answer "did that go through"; the rest waits for a tap.
const ACTIVITY_COLLAPSED_COUNT = 3;

// A day, which is also how long wallet-service trusts a cached fee schedule, so
// "at least this old" and "possibly out of date" are the same threshold.
const FEE_CACHE_STALE_MS = 24 * 60 * 60 * 1000;

interface Props {
  action?: WalletAction | null;
  actionTrigger?: number;
}

export default function WalletScreen({
  action,
  actionTrigger,
}: Props): React.JSX.Element {
  const T = useT();
  const TP = useTPlural();
  const Colors = useThemeColors();
  const styles = useMemo(() => createStyles(Colors), [Colors]);
  const pullRefreshColors = usePullRefreshColors();

  // Narrow subscriptions: the store changes on every history write.
  const proofs = useWalletStore((s) => s.proofs);
  const mints = useWalletStore((s) => s.mints);
  const reserved = useWalletStore((s) => s.reserved);
  const history = useWalletStore((s) => s.history);
  const backupEnabled = useWalletStore((s) => s.backupEnabled);
  const backupVerified = useWalletStore((s) => s.backupVerified);

  const accounts = useMemo<AccountBalance[]>(
    () => selectAccounts({ proofs, mints, reserved, backupEnabled }),
    [proofs, mints, reserved, backupEnabled],
  );

  const [locked, setLocked] = useState(() => !isWalletStorageReady());
  useEffect(() => {
    // The encrypted store hydrates asynchronously, so the banner clears
    // itself. Settles once: with no keychain the wallet stays locked for good.
    if (!locked) return;
    let cancelled = false;
    void whenWalletHydrated().then(() => {
      if (!cancelled) setLocked(!isWalletStorageReady());
    });
    return () => {
      cancelled = true;
    };
  }, [locked]);

  const peers = usePeerStore((s) => s.peers);
  const [peerClock, setPeerClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setPeerClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const onlinePeers = useMemo(() => {
    const cutoff = peerClock - REACHABLE_TTL_MS;
    return [...peers.values()].filter((peer) => peer.lastSeenMs >= cutoff);
  }, [peerClock, peers]);

  // ---- Sheet state ----
  const [showReceive, setShowReceive] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [showZap, setShowZap] = useState(false);
  const [showAddMint, setShowAddMint] = useState(false);
  const [showDeposit, setShowDeposit] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [showPeerPicker, setShowPeerPicker] = useState(false);
  const [showConsolidate, setShowConsolidate] = useState(false);
  const [scannerTarget, setScannerTarget] = useState<ScanTarget | null>(null);
  // Receive and Send open a chooser first; Lightning and Zap live behind it.
  const [chooser, setChooser] = useState<"receive" | "send" | null>(null);
  const [showMints, setShowMints] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  // A pending send re-shown as a QR, for handing it over after the fact.
  const [qrToken, setQrToken] = useState<WalletTx | null>(null);
  const [showRestore, setShowRestore] = useState(false);

  // Steps in order: warn, show, verify. "view" is read-only, once backup is on.
  const [backupStep, setBackupStep] = useState<
    "warn" | "show" | "verify" | "view" | null
  >(null);
  const [phrase, setPhrase] = useState("");
  const [verifyPositionList, setVerifyPositionList] = useState<number[]>([]);
  const [verifyAnswers, setVerifyAnswers] = useState<Record<number, string>>(
    {},
  );
  const [verifyError, setVerifyError] = useState(false);

  const [restoreInput, setRestoreInput] = useState("");
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(
    null,
  );
  const [restoreProgress, setRestoreProgress] = useState<string | null>(null);
  const [consolidateTarget, setConsolidateTarget] = useState<string | null>(
    null,
  );

  const [tokenInput, setTokenInput] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sendMemo, setSendMemo] = useState("");
  const [zapNpub, setZapNpub] = useState("");

  // Shown in Receive, so the key a Zap needs is somewhere the user can find it.
  const myNpub = useMemo(() => {
    const hex = getMeshService()?.getNostrPubKeyHex();
    if (hex === undefined || hex.length === 0) return null;
    try {
      return nip19.npubEncode(hex);
    } catch {
      return null;
    }
  }, []);

  // Contacts from a QR card or an ANNOUNCE already carry a Nostr key, so offer
  // them rather than 63 typed characters.
  const contacts = useContactsStore((c) => c.contacts);
  const zapContacts = useMemo(
    () =>
      Object.values(contacts)
        .filter((c) => c.nostrPubkeyHex !== undefined)
        .sort((a, b) => a.nickname.localeCompare(b.nickname))
        .slice(0, 8),
    [contacts],
  );
  const [zapAmount, setZapAmount] = useState("");
  const [zapNote, setZapNote] = useState("");
  const [mintUrlInput, setMintUrlInput] = useState("");
  const [depositAmount, setDepositAmount] = useState("");
  // Lightning acts on one mint at a time: ecash cannot be pooled across mints.
  const [activeMint, setActiveMint] = useState<string | null>(null);
  const [withdrawInvoice, setWithdrawInvoice] = useState("");
  const [withdrawQuote, setWithdrawQuote] = useState<MeltQuote | null>(null);

  // The latest send's token, still reserved and reclaimable.
  const [pending, setPending] = useState<PreparedSend | null>(null);
  const [deposit, setDeposit] = useState<LightningDeposit | null>(null);
  // Copy invoice is wide enough to confirm in words, not only a glyph swap.
  const { copied: invoiceCopied, copy: copyInvoice } = useCopy();

  const [depositClock, setDepositClock] = useState(0);
  const depositExpiresAtMs = deposit?.expiresAtMs;
  const depositExpired =
    depositExpiresAtMs !== undefined && depositClock >= depositExpiresAtMs;

  // Per action, so the spinner sits on the button that caused it.
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshingMint, setRefreshingMint] = useState<string | null>(null);

  // Subscribed, so flipping Internet or Tor in Settings re-renders the gate.
  useSettingsStore((st) => st.internetEnabled);
  useSettingsStore((st) => st.torEnabled);
  useSettingsStore((st) => st.allowMintOverClearnet);
  useMeshStateStore((st) => st.torActive);
  const networkBlock = mintNetworkBlock();
  const networkBlocked = networkBlock !== null;
  // A hint, never a gate: a captive portal reads as connected, and every mint
  // call reports its own failure.
  const network = useNetworkState();
  const offline =
    network.isConnected === false || network.isInternetReachable === false;

  // ---- Header action handoff ----
  const prevActionTrigger = useRef(actionTrigger ?? 0);
  useEffect(() => {
    if (
      actionTrigger === undefined ||
      actionTrigger <= prevActionTrigger.current
    ) {
      return;
    }
    prevActionTrigger.current = actionTrigger;
    // One-shot handoff from the header's help button, once per press.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (action === "help") setShowHelp(true);
  }, [action, actionTrigger]);

  // ---- Derived balances ----

  // Units are separate currencies, never summed. Sats lead: the only unit
  // Airhop mints into.
  const unitTotals = useMemo(() => {
    const totals = new Map<
      string,
      { balance: number; unverified: number; reserved: number }
    >();
    for (const account of accounts) {
      const current = totals.get(account.unit) ?? {
        balance: 0,
        unverified: 0,
        reserved: 0,
      };
      current.balance += account.balance;
      current.unverified += account.unverified;
      current.reserved += account.reserved;
      totals.set(account.unit, current);
    }
    return [...totals.entries()]
      .map(([unit, v]) => ({ unit, ...v }))
      .sort((a, b) => (a.unit === "sat" ? -1 : b.unit === "sat" ? 1 : 0));
  }, [accounts]);

  const primary = unitTotals.find((u) => u.unit === "sat") ??
    unitTotals[0] ?? { unit: "sat", balance: 0, unverified: 0, reserved: 0 };

  // Sends with a token still to hand over. A normal send is reserved and
  // reclaimable. A nutzap whose relay publish failed is locked to the
  // recipient, so has no reservation, but still needs delivering; leaving it
  // out would strand the value.
  const pendingSends = useMemo(
    () =>
      history.filter(
        (tx) =>
          tx.status === "pending" &&
          (tx.kind === "send" || tx.kind === "nutzap-out") &&
          (reserved[tx.id] !== undefined || Boolean(tx.token)),
      ),
    [history, reserved],
  );

  const pendingDeposits = useMemo(
    () => history.filter((tx) => tx.kind === "mint" && tx.status === "pending"),
    [history],
  );

  const recent = useMemo(() => history.slice(0, 12), [history]);

  const [showAllActivity, setShowAllActivity] = useState(false);
  const visibleActivity = showAllActivity
    ? recent
    : recent.slice(0, ACTIVITY_COLLAPSED_COUNT);

  const mintList = useMemo(() => Object.values(mints), [mints]);

  // Test mints hand out fake sats; a balance that cannot be cashed out must
  // never look like one that can.
  const holdsTestMoney = useMemo(
    () =>
      accounts.some(
        (a) =>
          (a.balance > 0 || a.reserved > 0) &&
          isLikelyTestMint({
            url: a.mintUrl,
            name: mints[a.mintUrl]?.name,
            description: mints[a.mintUrl]?.description,
          }),
      ),
    [accounts, mints],
  );

  // For the Mints sheet. A multi-currency mint has one account per unit, so
  // show funded accounts plus one row (sat preferred) per empty mint, not four
  // empty rows that read as four mints.
  const visibleAccounts = useMemo(() => {
    const funded = accounts.filter(
      (a) => a.balance > 0 || a.reserved > 0 || a.proofCount > 0,
    );
    const covered = new Set(funded.map((a) => a.mintUrl));
    const placeholders = new Map<string, AccountBalance>();
    for (const account of accounts) {
      if (covered.has(account.mintUrl)) continue;
      const current = placeholders.get(account.mintUrl);
      if (
        current === undefined ||
        (current.unit !== "sat" && account.unit === "sat")
      ) {
        placeholders.set(account.mintUrl, account);
      }
    }
    return [...funded, ...placeholders.values()];
  }, [accounts]);

  // What the recovery phrase could NOT rebuild: received coins carry the
  // sender's secrets until a swap re-issues them under ours. The backup sheet
  // names an amount only where the guarantee does not hold.
  const unbackedBalance = useMemo(
    () =>
      accounts
        .filter((a) => a.unit === primary.unit)
        .reduce((sum, a) => sum + a.unbacked, 0),
    [accounts, primary.unit],
  );

  // Display only: sats and bitcoin differ by a constant, so nothing sent or
  // quoted depends on it.
  const bitcoinUnit = useSettingsStore((s) => s.bitcoinUnit);
  const setBitcoinUnit = useSettingsStore((s) => s.setBitcoinUnit);

  const headline = useMemo(
    () => formatAmount(primary.balance, primary.unit, bitcoinUnit),
    [primary.balance, primary.unit, bitcoinUnit],
  );

  // Only sat balances have a bitcoin denomination to switch to.
  function toggleBitcoinUnit(): void {
    if (primary.unit !== "sat") return;
    setBitcoinUnit(bitcoinUnit === "sat" ? "btc" : "sat");
  }

  // For the lines under the headline, which must agree with it.
  function showAmount(amount: number, unit: string): string {
    const formatted = formatAmount(amount, unit, bitcoinUnit);
    return `${formatted.value} ${formatted.label}`;
  }

  // TOKEN_QR_SIZE (what the character ceiling was budgeted for), clamped to
  // the sheet width less its padding and the frame's (80pt). A clipped code
  // reads as broken.
  const { width: windowWidth } = useWindowDimensions();
  const qrSize = Math.min(
    TOKEN_QR_SIZE,
    windowWidth - Spacing.xl * 2 - Spacing.base * 2,
  );

  // Two or more means no payment can exceed the largest single mint balance.
  const splitAccounts = useMemo(
    () => accounts.filter((a) => a.unit === primary.unit && a.balance > 0),
    [accounts, primary.unit],
  );

  // ---- Error surface ----

  // The service carries the "why" in `detail`; this only picks the title.
  const reportError = useCallback((err: unknown, fallbackTitle: string) => {
    if (err instanceof WalletError) {
      const titles: Record<string, string> = {
        locked: t("wallet.err.locked"),
        offline: t("wallet.err.mint_unreachable"),
        "tor-blocked": t("wallet.err.tor_blocked"),
        insufficient: t("wallet.err.insufficient"),
        inexact: t("wallet.err.exact_amount"),
        "no-mint": t("wallet.err.no_mint"),
        unsupported: t("wallet.err.mint_unsupported"),
        "mint-error": t("wallet.err.mint_refused"),
        "invalid-token": t("wallet.err.unreadable"),
        "forged-token": t("wallet.err.rejected"),
        "already-spent": t("wallet.err.already_spent"),
        "change-pending": t("wallet.err.change_pending"),
      };
      showAlert(
        titles[err.code] ?? fallbackTitle,
        err.detail ? `${err.message}\n\n${err.detail}` : err.message,
      );
      return;
    }
    showAlert(fallbackTitle, String(err));
  }, []);

  // ---- Receive ----

  async function handleReceive(): Promise<void> {
    const raw = tokenInput.trim();
    if (!raw) return;
    setBusy("receive");
    try {
      const result = await receiveToken(raw);
      setShowReceive(false);
      setTokenInput("");

      if (result.outcome === "own-pending") {
        showAlert(
          t("wallet.receive.own_payment"),
          t("wallet.receive.own_payment_body"),
        );
        return;
      }
      if (result.outcome === "duplicate") {
        showAlert(
          t("wallet.receive.already_have"),
          t("wallet.receive.already_have_body"),
        );
        return;
      }
      const where = hostOf(result.mintUrl);
      if (result.outcome === "swapped") {
        showAlert(
          `+${formatUnitAmount(result.amount, result.unit)}`,
          t("wallet.receive.redeemed_here", { mint: where }) +
            (result.memo
              ? t("wallet.receive.memo_quoted", { memo: result.memo })
              : ""),
        );
      } else {
        showAlert(
          `+${formatUnitAmount(result.amount, result.unit)}`,
          // Separate keys so translators can reword each; the joining space
          // lives here, not in the copy.
          [
            t("wallet.receive.stored_unconfirmed", {
              mint: where,
              reason: result.offlineReason ?? t("wallet.receive.offline"),
            }),
            result.dleq === "valid"
              ? t("wallet.receive.dleq_ok")
              : t("wallet.receive.dleq_uncached"),
            t("wallet.receive.dleq_warning"),
          ].join(" ") + (result.memo ? `\n\n"${result.memo}"` : ""),
        );
      }
    } catch (err) {
      reportError(err, t("wallet.receive.failed"));
    } finally {
      setBusy(null);
    }
  }

  // iOS shows one modal at a time, so opening the scanner over a sheet
  // silently does nothing. The sheet closes, its exit finishes, then the camera
  // opens; every path back restores the sheet the same way.
  function reopenSheetFor(target: ScanTarget): void {
    if (target === "any") return;
    setTimeout(() => {
      if (target === "token") setShowReceive(true);
      else setShowWithdraw(true);
    }, SHEET_EXIT_MS);
  }

  function openScanner(target: ScanTarget): void {
    setChooser(null);
    if (target === "token") setShowReceive(false);
    else if (target === "invoice") setShowWithdraw(false);
    setTimeout(() => setScannerTarget(target), SHEET_EXIT_MS);
  }

  // Same one-modal-at-a-time rule as the scanner.
  function switchSheet(open: () => void): void {
    setChooser(null);
    setShowMints(false);
    setShowBackup(false);
    setTimeout(open, SHEET_EXIT_MS);
  }

  function closeScanner(): void {
    if (scannerTarget === null) return;
    const target = scannerTarget;
    setScannerTarget(null);
    reopenSheetFor(target);
  }

  // A scan fills the field rather than acting. The sheet shows what is about
  // to happen; claiming or paying whatever the camera saw would remove the last
  // chance to check it.
  function handleScanned(value: string): void {
    if (scannerTarget === null) return;
    const target = scannerTarget;
    setScannerTarget(null);
    // "any" (the Scan action) routes by what it saw.
    const kind =
      target === "any" ? (classifyScan(value)?.kind ?? null) : target;
    if (kind === "token") {
      setTokenInput(value);
      reopenSheetFor("token");
    } else if (kind === "invoice") {
      if (target === "any") setActiveMint(splitAccounts[0]?.mintUrl ?? null);
      setWithdrawInvoice(value);
      setWithdrawQuote(null);
      reopenSheetFor("invoice");
    } else if (kind === "npub") {
      setZapNpub(value);
      setTimeout(() => setShowZap(true), SHEET_EXIT_MS);
    }
  }

  // ---- Send ----

  async function handleSend(): Promise<void> {
    const amount = parseWholeNumber(sendAmount);
    if (amount === null) return;
    setBusy("send");
    try {
      // Quote first so an inexact amount is explained before anything is
      // reserved.
      const quote = await quoteSend({ amount, unit: primary.unit });
      // Also the inexact alert's confirm, which runs after this function's
      // guard has ended, so it owns its busy flag and error report.
      const commit = async (allowInexact: boolean): Promise<void> => {
        setBusy("send");
        try {
          const prepared = await prepareSend({
            amount,
            unit: primary.unit,
            memo: sendMemo.trim() || undefined,
            allowInexact,
          });
          setShowSend(false);
          setSendAmount("");
          setSendMemo("");
          setPending(prepared);
        } catch (err) {
          reportError(err, t("wallet.send.build_failed"));
        } finally {
          setBusy(null);
        }
      };

      if (!quote.exact) {
        showAlert(
          t("wallet.err.exact_amount"),
          t("wallet.send.inexact_body", {
            ...amountParts(amount, quote.unit),
            spend: amountParts(quote.spend, quote.unit).amount,
            extra: amountParts(quote.spend - amount, quote.unit).amount,
          }),
          [
            { text: T("common.cancel"), style: "cancel" },
            {
              text: t("wallet.send.send_amount", {
                amount: amountParts(quote.spend, quote.unit).amount,
              }),
              style: "destructive",
              onPress: () => void commit(true),
            },
          ],
        );
        return;
      }
      await commit(false);
    } catch (err) {
      reportError(err, t("wallet.send.build_failed"));
    } finally {
      setBusy(null);
    }
  }

  // Drops the reservation, forfeiting reclaim for good, so it asks first.
  // Reclaim only returns money to the balance; the confirm belongs on the
  // door that does not reopen.
  function markDelivered(txId: string): void {
    const tx = pending?.txId === txId ? pending : undefined;
    showAlert(
      t("wallet.delivered.title"),
      tx !== undefined
        ? t("wallet.delivered.body", {
            ...amountParts(tx.amount, tx.unit),
          })
        : t("wallet.delivered.body_generic"),
      [
        { text: t("wallet.delivered.cancel"), style: "cancel" },
        {
          text: t("wallet.delivered.confirm"),
          style: "destructive",
          onPress: () => {
            confirmSend(txId);
            setPending(null);
            setShowPeerPicker(false);
          },
        },
      ],
    );
  }

  // The transfer never landed. Puts the proofs back into the balance.
  function handleReclaim(tx: WalletTx | PreparedSend): void {
    // WalletTx `id` and PreparedSend `txId` are the same value.
    const txId = "txId" in tx ? tx.txId : tx.id;
    showAlert(
      t("wallet.reclaim.title"),
      t("wallet.reclaim.body", {
        ...amountParts(tx.amount, tx.unit),
      }),
      [
        { text: t("wallet.reclaim.keep"), style: "cancel" },
        {
          text: t("wallet.reclaim.confirm"),
          style: "destructive",
          onPress: () => {
            reclaimTokenSend(txId);
            setPending(null);
          },
        },
      ],
    );
  }

  function handleShareToken(token: string): void {
    void Share.share({ message: token });
  }

  async function handleCopyToken(token: string): Promise<void> {
    await Clipboard.setStringAsync(token);
    acknowledged();
    showAlert(T("common.copied"), t("wallet.copied.token_body"));
  }

  // Clipboards leak to other apps and sync, but refusing pushes people to a
  // screenshot, which is worse. Offer it and say to clean up after.
  async function handleCopyPhrase(): Promise<void> {
    await Clipboard.setStringAsync(phrase);
    acknowledged();
    showAlert(T("common.copied"), t("wallet.copied.phrase_body"));
  }

  // Through the shared helper, so message id, delivery status and pending
  // transaction line up as they do for a send from a chat.
  function handleSendTokenToPeer(peerID: string): void {
    if (!pending) return;
    if (!getMeshService()) {
      showAlert(t("wallet.mesh_offline"), t("wallet.mesh_offline_body"));
      return;
    }
    const route = deliverTokenToPeer({ peerID, prepared: pending });
    const amount = pending.amount;
    const unit = pending.unit;
    // Handed off, not proven delivered, so it stays pending and reclaimable.
    setShowPeerPicker(false);
    setPending(null);
    showAlert(
      t("wallet.send.sent_to", {
        ...amountParts(amount, unit),
        name: peerIDToUsername(peerID),
      }),
      t("wallet.send.sent_to_body", { route: describeRoute(route) }),
    );
  }

  // ---- Zap ----

  // A contact's nickname, else the app's usual short npub label.
  function zapRecipientLabel(pubkeyHex: string): string {
    const known = Object.values(contacts).find(
      (c) => c.nostrPubkeyHex === pubkeyHex,
    );
    return known?.nickname ?? nostrShortLabel(pubkeyHex);
  }

  async function handleZap(): Promise<void> {
    const npubRaw = zapNpub.trim();
    const amount = parseWholeNumber(zapAmount);
    if (!npubRaw || amount === null) return;

    let recipientPubkey: string;
    try {
      if (npubRaw.startsWith("npub")) {
        const decoded = nip19.decode(npubRaw);
        if (decoded.type !== "npub") throw new Error(t("wallet.zap.not_npub"));
        recipientPubkey = decoded.data;
      } else if (/^[0-9a-f]{64}$/i.test(npubRaw)) {
        recipientPubkey = npubRaw.toLowerCase();
      } else {
        throw new Error(t("wallet.zap.bad_key"));
      }
    } catch {
      showAlert(
        t("wallet.zap.invalid_pubkey"),
        t("wallet.zap.invalid_pubkey_body"),
      );
      return;
    }

    setBusy("zap");
    setShowZap(false);
    try {
      // `payPerson` matches the key against contacts first, so a payment to
      // someone with a thread lands there, not in a second conversation.
      const result = await payPerson({
        nostrPubkey: recipientPubkey,
        amount,
        memo: zapNote.trim() || undefined,
        unit: primary.unit,
        recipientName: zapRecipientLabel(recipientPubkey),
      });
      if (!result) return;
      setZapNpub("");
      setZapAmount("");
      setZapNote("");

      // Nothing carried it: hand the token back to share by hand, as Send does.
      if (result.token !== undefined) {
        setPending({
          txId: result.txId,
          token: result.token,
          amount: result.amount,
          spend: result.amount,
          fee: 0,
          exact: true,
          unit: result.unit,
          mintUrl: result.mintUrl,
          proofs: [],
        });
      }
      showAlert(
        t("wallet.pay.sent_title", {
          ...amountParts(result.amount, result.unit),
          name: zapRecipientLabel(recipientPubkey),
        }),
        describePayResult(result),
      );
    } catch (err) {
      reportError(err, t("wallet.zap.failed"));
    } finally {
      setBusy(null);
    }
  }

  // ---- Mints ----

  async function handleAddMint(): Promise<void> {
    const raw = mintUrlInput.trim();
    if (!raw) return;
    setBusy("addMint");
    try {
      const { mint, units } = await addMintService(raw);
      setShowAddMint(false);
      setMintUrlInput("");
      showAlert(
        mint.name
          ? t("wallet.mint.added_named", { name: mint.name })
          : t("wallet.mint.added"),
        t("wallet.mint.added_body", {
          mint: hostOf(mint.url),
          units: units.join(", "),
        }),
      );
    } catch (err) {
      reportError(err, t("wallet.mint.add_failed"));
    } finally {
      setBusy(null);
    }
  }

  // Settles anything left hanging, then refreshes every funded account. Silent
  // on success; trouble is reported once, not per mint.
  async function handlePullRefresh(): Promise<void> {
    // Empty accounts exist only because the mint advertises the unit.
    const funded = accounts.filter((a) => a.proofCount > 0 || a.reserved > 0);
    // Gate closed: every call would fail into an alert repeating the banner.
    if (locked || networkBlocked) return;
    setPullRefreshing(true);
    try {
      // Sequenced, not raced: reconcile claims deposits and melt change into
      // the accounts the refresh below swaps.
      try {
        await reconcile();
      } catch {
        // Best effort; the refresh is still worth attempting.
      }
      const results = await Promise.allSettled(
        funded.map((a) => refreshAccount(a.mintUrl, a.unit)),
      );
      const failed = funded.filter((_, i) => results[i]?.status === "rejected");
      if (failed.length === 0) return;
      const hosts = [...new Set(failed.map((a) => hostOf(a.mintUrl)))];
      if (failed.length === funded.length) {
        reportError(
          (results[0] as PromiseRejectedResult | undefined)?.reason,
          t("wallet.refresh.failed"),
        );
      } else {
        showAlert(
          t("wallet.refresh.partly"),
          t("wallet.refresh.unreachable", { mints: hosts.join(", ") }),
        );
      }
    } finally {
      setPullRefreshing(false);
    }
  }

  async function handleRefreshMint(
    mintUrl: string,
    unit: string,
  ): Promise<void> {
    setRefreshingMint(mintUrl);
    try {
      const result = await refreshAccount(mintUrl, unit);
      const parts: string[] = [];
      if (result.swapped > 0) {
        parts.push(
          t("wallet.refresh.swapped", {
            ...amountParts(result.swapped, unit),
          }),
        );
      }
      if (result.spentRemoved > 0) {
        parts.push(tPlural("wallet.spent_removed_detail", result.spentRemoved));
      }
      // Never in doubt, only outside the recovery phrase until this swap.
      if (result.securedForBackup > 0) {
        parts.push(
          t("wallet.refresh.secured", {
            ...amountParts(result.securedForBackup, unit),
          }),
        );
      }
      showAlert(
        t("wallet.refresh.done"),
        parts.length > 0
          ? parts.join("\n\n")
          : t("wallet.refresh.all_confirmed"),
      );
    } catch (err) {
      reportError(err, t("wallet.refresh.failed"));
    } finally {
      setRefreshingMint(null);
    }
  }

  // Removal confirms in its own alert, once this one has gone.
  function openMintActions(account: AccountBalance): void {
    const record = mints[account.mintUrl];
    const host = hostOf(account.mintUrl);
    showAlert(record?.name ?? host, record?.name !== undefined ? host : "", [
      ...(networkBlocked
        ? []
        : [
            {
              text: t("wallet.mint.confirm_with", { mint: host }),
              onPress: () =>
                void handleRefreshMint(account.mintUrl, account.unit),
            },
          ]),
      {
        text: t("wallet.mint.remove"),
        style: "destructive" as const,
        onPress: () => {
          setTimeout(() => handleRemoveMint(account), SHEET_EXIT_MS);
        },
      },
      { text: t("common.cancel"), style: "cancel" as const },
    ]);
  }

  function handleRemoveMint(account: AccountBalance): void {
    const hasValue = account.balance > 0 || account.reserved > 0;
    const balanceShown = amountParts(account.balance, account.unit);
    showAlert(
      hasValue ? t("wallet.mint.remove_with_balance") : t("wallet.mint.remove"),
      hasValue
        ? tPlural("wallet.mint.remove_body", account.proofCount, {
            mint: hostOf(account.mintUrl),
            balance: balanceShown.amount,
            unit: balanceShown.unit,
          })
        : t("wallet.mint.remove_plain", { mint: hostOf(account.mintUrl) }),
      [
        { text: T("common.cancel"), style: "cancel" },
        {
          text: hasValue ? t("wallet.mint.delete_anyway") : T("common.remove"),
          style: "destructive",
          onPress: () => useWalletStore.getState().removeMint(account.mintUrl),
        },
      ],
    );
  }

  // ---- Backup ----

  // Starts on a warning: bare words invite a screenshot, the most common way
  // seed phrases are stolen.
  function handleStartBackup(): void {
    setBackupStep("warn");
  }

  // Switches to deterministic secrets now, so new coins are covered even if
  // verification is abandoned.
  async function handleRevealPhrase(): Promise<void> {
    setBusy("backup");
    try {
      const setup = await enableWalletBackup();
      setPhrase(setup.phrase);
      setVerifyPositionList(pickVerificationPositions());
      setVerifyAnswers({});
      setVerifyError(false);
      setBackupStep("show");
    } catch (err) {
      reportError(err, t("wallet.backup.setup_failed"));
      setBackupStep(null);
    } finally {
      setBusy(null);
    }
  }

  // Positions are random each time, so passing once teaches nothing.
  function handleVerifyPhrase(): void {
    if (verifyPositions(phrase, verifyAnswers)) {
      markBackupVerified();
      closeBackupSheet();
      showAlert(t("wallet.backup.on"), t("wallet.backup.on_body"));
      return;
    }
    setVerifyError(true);
  }

  async function handleViewPhrase(): Promise<void> {
    setBusy("backup");
    try {
      const stored = await getRecoveryPhrase();
      if (stored === null) {
        showAlert(
          t("wallet.backup.no_phrase"),
          t("wallet.backup.no_phrase_body"),
        );
        return;
      }
      setPhrase(stored);
      // Unverified goes back through write-it-down, the way out of that state.
      if (backupVerified) {
        setBackupStep("view");
      } else {
        setVerifyPositionList(pickVerificationPositions());
        setVerifyAnswers({});
        setVerifyError(false);
        setBackupStep("show");
      }
    } finally {
      setBusy(null);
    }
  }

  // Watches the alert store's visibility: a backdrop dismissal fires no button
  // and must count as cancel.
  function confirmReplacePhrase(body: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        resolve(value);
      };
      const unsubscribe = useAlertStore.subscribe((state) => {
        if (state.visible) return;
        setTimeout(() => finish(false), 0);
      });
      showAlert(t("wallet.backup.replace_title"), body, [
        {
          text: T("common.cancel"),
          style: "cancel",
          onPress: () => finish(false),
        },
        {
          text: t("wallet.backup.replace"),
          style: "destructive",
          onPress: () => finish(true),
        },
      ]);
    });
  }

  function closeBackupSheet(): void {
    setBackupStep(null);
    // The phrase is the money; never leave it in state.
    setPhrase("");
    setVerifyAnswers({});
    setVerifyError(false);
  }

  async function handleRestore(): Promise<void> {
    const input = restoreInput.trim();
    if (!isValidRecoveryPhrase(input)) {
      const unknown = unknownWordsIn(input);
      showAlert(
        t("wallet.backup.invalid_phrase"),
        unknown.length > 0
          ? t("wallet.backup.not_bip39", {
              words: unknown.slice(0, 4).join(", "),
            })
          : t("wallet.backup.invalid_phrase_body"),
      );
      return;
    }
    if (mintList.length === 0) {
      showAlert(
        t("wallet.backup.add_mint_first"),
        t("wallet.backup.add_mint_first_body"),
      );
      return;
    }
    // Coins from the old phrase stay spendable but stop being restorable.
    // Asked whenever value is held, not only with backup on: the phrase exists
    // from wallet creation.
    const current = await getRecoveryPhrase().catch(() => null);
    const samePhrase =
      current !== null &&
      normalizeRecoveryPhrase(current) === normalizeRecoveryPhrase(input);
    const holdsValue = accounts.some((a) => a.balance > 0 || a.reserved > 0);
    if (current !== null && !samePhrase && (backupEnabled || holdsValue)) {
      const body = backupEnabled
        ? t("wallet.backup.replace_body")
        : t("wallet.backup.replace_unseen_body");
      if (!(await confirmReplacePhrase(body))) return;
    }

    setBusy("restore");
    setRestoreResult(null);
    try {
      const result = await restoreFromRecoveryPhrase({
        phrase: input,
        mintUrls: mintList.map((m) => m.url),
        unit: primary.unit,
        onProgress: (progress) =>
          setRestoreProgress(
            t("wallet.backup.restore_progress", {
              mint: hostOf(progress.mintUrl),
              step: progress.step,
              total: progress.total,
            }),
          ),
      });
      setRestoreResult(result);
      setRestoreInput("");
    } catch (err) {
      reportError(err, t("wallet.backup.restore_failed"));
    } finally {
      setBusy(null);
      setRestoreProgress(null);
    }
  }

  // ---- Consolidate ----

  async function handleConsolidate(): Promise<void> {
    const target = consolidateTarget;
    if (!target) return;
    const sources = splitAccounts.filter((a) => a.mintUrl !== target);
    if (sources.length === 0) return;

    setBusy("consolidate");
    let moved = 0;
    let fees = 0;
    // Paid out of the source, not yet claimed: in transit, not failed.
    const inTransit: string[] = [];
    const failures: string[] = [];
    try {
      for (const source of sources) {
        try {
          const result = await consolidateMints({
            fromMintUrl: source.mintUrl,
            toMintUrl: target,
            unit: primary.unit,
          });
          if (result.depositPending) {
            inTransit.push(
              t("wallet.mint.deposit_pending", {
                ...amountParts(result.spent - result.fee, primary.unit),
                mint: hostOf(source.mintUrl),
                target: hostOf(target),
              }),
            );
            continue;
          }
          moved += result.received;
          fees += result.fee;
        } catch (err) {
          failures.push(
            `${hostOf(source.mintUrl)}: ${err instanceof WalletError ? err.message : String(err)}`,
          );
        }
      }
      setShowConsolidate(false);
      showAlert(
        moved > 0
          ? t("wallet.mint.moved")
          : inTransit.length > 0
            ? t("wallet.mint.move_pending")
            : t("wallet.mint.nothing_moved"),
        [
          moved > 0
            ? t("wallet.mint.moved_body", {
                ...amountParts(moved, primary.unit),
                mint: hostOf(target),
                fees: amountParts(fees, primary.unit).amount,
              })
            : null,
          inTransit.length > 0 ? inTransit.join("\n") : null,
          failures.length > 0 ? failures.join("\n") : null,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    } finally {
      setBusy(null);
    }
  }

  // ---- Lightning deposit ----

  async function handleCreateDeposit(): Promise<void> {
    const amount = parseWholeNumber(depositAmount);
    const mintUrl = activeMint ?? mintList[0]?.url;
    if (amount === null || !mintUrl) return;
    setBusy("deposit");
    try {
      const created = await createLightningDeposit({
        amount,
        mintUrl,
        unit: "sat",
        description: t("wallet.ln.deposit_memo"),
      });
      setDeposit(created);
      setDepositClock(Date.now());
      setDepositAmount("");
    } catch (err) {
      reportError(err, t("wallet.ln.invoice_failed"));
    } finally {
      setBusy(null);
    }
  }

  // A bolt11 invoice expires in minutes; without a clock the wait reads as a
  // hang.
  useEffect(() => {
    if (!showDeposit || depositExpiresAtMs === undefined) return;
    const timer = setInterval(() => setDepositClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [showDeposit, depositExpiresAtMs]);

  // Stops when the sheet closes or the invoice expires. Giving up loses
  // nothing: `reconcile` claims a late payment on the next launch or pull.
  useEffect(() => {
    if (!deposit || !showDeposit || depositExpired) return;
    let cancelled = false;
    // A round trip can outlast the interval; two claims on one quote make the
    // loser report a spurious error.
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void (async () => {
        try {
          const minted = await claimLightningDeposit(
            deposit.mintUrl,
            deposit.unit,
            deposit.quoteId,
          );
          if (cancelled || minted <= 0) return;
          // Usually paid from another app, so the buzz says it landed.
          succeeded();
          setDeposit(null);
          setShowDeposit(false);
          showAlert(
            `+${formatUnitAmount(minted, deposit.unit)}`,
            t("wallet.ln.deposit_credited", {
              ...amountParts(minted, deposit.unit),
              mint: hostOf(deposit.mintUrl),
            }),
          );
        } catch {
          // Still unpaid, or the mint blinked. Keep polling.
        } finally {
          inFlight = false;
        }
      })();
    }, DEPOSIT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [deposit, showDeposit, depositExpired]);

  // ---- Lightning withdrawal ----

  async function handleQuoteWithdraw(): Promise<void> {
    const invoice = withdrawInvoice.trim();
    const mintUrl = activeMint ?? mintList[0]?.url;
    if (!invoice || !mintUrl) return;
    setBusy("withdrawQuote");
    try {
      setWithdrawQuote(
        await quoteLightningWithdrawal({ invoice, mintUrl, unit: "sat" }),
      );
    } catch (err) {
      reportError(err, t("wallet.ln.price_failed"));
    } finally {
      setBusy(null);
    }
  }

  async function handlePayWithdraw(): Promise<void> {
    if (!withdrawQuote) return;
    const { unit } = withdrawQuote;
    setBusy("withdrawPay");
    try {
      const result = await payLightningInvoice(withdrawQuote);
      setShowWithdraw(false);
      setWithdrawQuote(null);
      setWithdrawInvoice("");
      showAlert(
        t("wallet.ln.paid"),
        t(
          result.changeReturned > 0
            ? "wallet.ln.withdrawn_with_change"
            : "wallet.ln.withdrawn",
          {
            ...amountParts(result.paid, unit),
            fee: amountParts(result.fee, unit).amount,
            change: amountParts(result.changeReturned, unit).amount,
          },
        ),
      );
    } catch (err) {
      reportError(err, t("wallet.ln.payment_failed"));
    } finally {
      setBusy(null);
    }
  }

  const hasSpendable = accounts.some((a) => a.balance > 0);
  // Why Lightning cannot run right now, shown in place of its description.
  const lightningBlockedReason =
    networkBlock === "internet-off"
      ? T("wallet.choose.internet_off")
      : networkBlock === "tor"
        ? T("wallet.choose.tor_paused")
        : offline
          ? T("wallet.choose.offline")
          : null;
  const depositBlockedReason =
    lightningBlockedReason ??
    (mintList.length === 0 ? T("wallet.choose.needs_mint") : null);

  // The phrase exists from wallet creation; what backup adds is twelve words
  // written down and kept. So it reads safe only
  // once verified: an unwritten phrase implies a safety net that is not there,
  // and unconfirmed is shown as unsafe, not half-safe.
  const backupSafe = backupEnabled && backupVerified;
  const backupStatus = backupEnabled
    ? backupVerified
      ? T("wallet.backup.on")
      : T("wallet.backup.state_unconfirmed")
    : T("wallet.backup.state_off");

  // Status in plain words; detail and actions live in the sheet it opens.
  const backupRow = (
    <Pressable
      style={({ pressed }) => [
        styles.backupRow,
        pressed && styles.backupRowPressed,
      ]}
      onPress={() => setShowBackup(true)}
      accessibilityRole="button"
      accessibilityLabel={T("wallet.backup.phrase")}
      accessibilityHint={backupStatus}
    >
      <Feather
        name={backupSafe ? "shield" : "shield-off"}
        size={18}
        color={backupSafe ? Colors.verified : Colors.danger}
      />
      <View style={styles.backupRowText}>
        <Text style={styles.backupRowTitle}>{T("wallet.backup.phrase")}</Text>
        <Text style={styles.backupRowStatus}>{backupStatus}</Text>
      </View>
      <Feather name={chevronForward} size={16} color={Colors.textMuted} />
    </Pressable>
  );

  const backupDetails = (
    <>
      <View style={styles.backupHeader}>
        {/* Only a verified backup gets an intact shield, in verified blue
            (never encrypted green). Off and unconfirmed are both struck red. */}
        <Feather
          name={backupEnabled && backupVerified ? "shield" : "shield-off"}
          size={16}
          color={
            backupEnabled && backupVerified ? Colors.verified : Colors.danger
          }
        />
        <Text style={styles.backupTitle}>{T("wallet.explain.phrase")}</Text>
        <View
          style={[
            styles.pill,
            backupEnabled && backupVerified && styles.pillOn,
            backupEnabled && !backupVerified && styles.pillWarn,
          ]}
          accessibilityLabel={
            backupEnabled
              ? backupVerified
                ? T("wallet.backup.on")
                : T("wallet.backup.state_unconfirmed")
              : T("wallet.backup.state_off")
          }
        >
          <Text
            style={[
              styles.pillText,
              backupEnabled && backupVerified && styles.pillTextOn,
              backupEnabled && !backupVerified && styles.pillTextWarn,
            ]}
          >
            {backupEnabled
              ? backupVerified
                ? T("wallet.backup.badge_on")
                : T("wallet.backup.badge_unconfirmed")
              : T("wallet.backup.badge_off")}
          </Text>
        </View>
      </View>

      {backupEnabled ? (
        <>
          <Text style={styles.backupBody}>
            {T("wallet.backup.on_body_short")}
          </Text>
          {/* Unconfirmed is the most dangerous state: it reads as protected
              while the words live only on the phone that may be lost. */}
          {!backupVerified && (
            <View style={styles.backupWarnRow}>
              <Feather name="alert-triangle" size={13} color={Colors.danger} />
              <Text style={styles.backupWarnText}>
                {T("wallet.backup.unconfirmed_body")}
              </Text>
            </View>
          )}
          {unbackedBalance > 0 && (
            <View style={styles.backupWarnRow}>
              <Feather
                name="alert-circle"
                size={13}
                color={Colors.textSecondary}
              />
              <Text style={styles.backupWarnText}>
                {T("wallet.backup.not_covered", {
                  amount: formatUnitAmount(unbackedBalance, primary.unit),
                })}
              </Text>
            </View>
          )}
        </>
      ) : (
        <Text style={styles.backupBody}>{T("wallet.backup.off_body")}</Text>
      )}

      <View style={styles.backupActions}>
        <Pressable
          style={styles.backupBtn}
          onPress={() =>
            switchSheet(() => {
              if (backupEnabled) void handleViewPhrase();
              else void handleStartBackup();
            })
          }
          accessibilityRole="button"
          accessibilityLabel={
            backupEnabled ? T("wallet.backup.view") : T("wallet.backup.setup")
          }
        >
          <Feather
            name={backupEnabled ? "eye" : "key"}
            size={16}
            color={Colors.accent}
          />
          <Text style={styles.backupBtnText}>
            {backupEnabled
              ? T("wallet.backup.view_short")
              : T("wallet.backup.setup_short")}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.backupBtn, networkBlocked && styles.smallBtnDisabled]}
          disabled={networkBlocked}
          onPress={() =>
            switchSheet(() => {
              setRestoreInput("");
              setRestoreResult(null);
              setShowRestore(true);
            })
          }
          accessibilityRole="button"
          accessibilityLabel={T("wallet.backup.restore")}
        >
          <Feather name="download-cloud" size={16} color={Colors.accent} />
          <Text style={styles.backupBtnText}>
            {T("wallet.backup.restore_short")}
          </Text>
        </Pressable>
      </View>
    </>
  );

  // ---- Render ----

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={pullRefreshing}
          onRefresh={() => void handlePullRefresh()}
          {...pullRefreshColors}
        />
      }
    >
      {locked && (
        <View style={[styles.banner, styles.bannerDanger]}>
          <Feather name="lock" size={16} color={Colors.danger} />
          <Text style={styles.bannerText}>{T("wallet.balance.locked")}</Text>
        </View>
      )}

      {networkBlock === "internet-off" && !locked && (
        <View style={[styles.banner, styles.bannerWarn]}>
          <Feather name="cloud-off" size={16} color={Colors.textSecondary} />
          <Text style={styles.bannerText}>
            {T("wallet.balance.internet_off", {
              setting: T("settings.network.internet"),
            })}
          </Text>
        </View>
      )}

      {networkBlock === "tor" && !locked && (
        <View style={[styles.banner, styles.bannerTor]}>
          <Feather name="shield" size={16} color={Colors.tor} />
          <Text style={styles.bannerText}>
            {T("wallet.balance.tor_blocked", {
              setting: T("settings.conn.mint_clearnet"),
            })}
          </Text>
        </View>
      )}

      {offline && !networkBlocked && !locked && (
        <View style={[styles.banner, styles.bannerWarn]}>
          <Feather name="wifi-off" size={16} color={Colors.textSecondary} />
          <Text style={styles.bannerText}>{T("wallet.balance.offline")}</Text>
        </View>
      )}

      {/* Accent-filled, like the user's own chat bubbles. */}
      <View style={styles.balanceCard}>
        <Text style={styles.balanceLabel}>{T("wallet.balance.spendable")}</Text>
        {/* Tap toggles sats and bitcoin. No animation: a balance that morphs
            is one people stop trusting. */}
        <Pressable
          style={({ pressed }) => [
            styles.balanceRow,
            pressed && styles.balanceRowPressed,
          ]}
          onPress={toggleBitcoinUnit}
          disabled={primary.unit !== "sat"}
          accessibilityRole="button"
          accessibilityLabel={T("wallet.balance.a11y", {
            value: headline.value,
            unit: headline.label,
          })}
          accessibilityHint={
            primary.unit === "sat" ? T("wallet.balance.unit_hint") : undefined
          }
        >
          {/* Shrinks rather than wraps, so a large balance at a large OS
              text size stays on one line beside its unit: the one number
              that must never be half-visible. */}
          <Text
            style={styles.balanceAmount}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.6}
          >
            {headline.value}
          </Text>
          <Text style={styles.balanceUnit}>{headline.label}</Text>
        </Pressable>

        {/* Anything not plainly spendable is stated, never folded in. */}
        {primary.unverified > 0 && (
          <View style={styles.balanceNote}>
            <Feather name="clock" size={12} color={Colors.textInverse} />
            <Text style={styles.balanceNoteText}>
              {T("wallet.balance.unconfirmed_note", {
                amount: showAmount(primary.unverified, primary.unit),
              })}
            </Text>
          </View>
        )}
        {primary.reserved > 0 && (
          <View style={styles.balanceNote}>
            <Feather
              name="arrow-up-right"
              size={12}
              color={Colors.textInverse}
            />
            <Text style={styles.balanceNoteText}>
              {T("wallet.balance.reserved_note", {
                amount: showAmount(primary.reserved, primary.unit),
              })}
            </Text>
          </View>
        )}
        {unitTotals
          .filter((u) => u.unit !== primary.unit && u.balance > 0)
          .map((u) => (
            <View key={u.unit} style={styles.balanceNote}>
              <Text style={styles.balanceNoteText}>
                {T("wallet.balance.other_mint_note", {
                  amount: showAmount(u.balance, u.unit),
                })}
              </Text>
            </View>
          ))}
        {pendingDeposits.length > 0 && (
          <View style={styles.balanceNote}>
            <Feather name="download" size={12} color={Colors.textInverse} />
            <Text style={styles.balanceNoteText}>
              {TP("wallet.ln.pending_deposits", pendingDeposits.length)}
            </Text>
          </View>
        )}
        {holdsTestMoney && (
          <View style={styles.balanceNote}>
            <Text style={styles.balanceNoteText}>
              {T("wallet.balance.test_mint_note")}
            </Text>
          </View>
        )}
        {/* Send dims on an empty balance rather than opening a list that can
            only fail. */}
        <View style={styles.actionRow}>
          <ActionButton
            styles={styles}
            Colors={Colors}
            icon="arrow-down"
            label={T("wallet.explain.receive")}
            a11yLabel={T("wallet.explain.receive")}
            disabled={locked}
            onPress={() => setChooser("receive")}
          />
          <ActionButton
            styles={styles}
            Colors={Colors}
            icon="arrow-up"
            label={T("wallet.explain.send")}
            a11yLabel={
              hasSpendable
                ? T("wallet.explain.send")
                : T("wallet.action.send_disabled")
            }
            disabled={locked || !hasSpendable}
            onPress={() => setChooser("send")}
          />
          <ActionButton
            styles={styles}
            Colors={Colors}
            icon="maximize"
            label={T("wallet.action.scan")}
            a11yLabel={T("wallet.action.scan_a11y")}
            disabled={locked}
            onPress={() => openScanner("any")}
          />
          <ActionButton
            styles={styles}
            Colors={Colors}
            icon="database"
            label={T("wallet.mint.title")}
            a11yLabel={T("wallet.mint.title")}
            disabled={locked}
            onPress={() => setShowMints(true)}
          />
        </View>
      </View>

      {backupRow}

      {/* Always shown, so an empty wallet does not look like a lost history
          and the tab does not reflow on the first payment. */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{T("wallet.activity.title")}</Text>
        {/* Unclaimed sends lead, with their actions: their proofs are
            reserved, not spent, and until one is marked delivered or
            reclaimed this card is the only way back to that value. */}
        {pendingSends.map((tx) => {
          // An unpublished nutzap is locked to the recipient: no reclaim.
          const reclaimable = reserved[tx.id] !== undefined;
          return (
            <View key={tx.id} style={styles.pendingCard}>
              <View style={styles.pendingHeader}>
                <Feather name="clock" size={15} color={Colors.textSecondary} />
                <Text style={styles.pendingAmount}>
                  {formatUnitAmount(tx.amount, tx.unit)}
                </Text>
                <Text style={styles.pendingTime}>
                  {formatAgo(tx.createdAtMs)}
                </Text>
              </View>
              <Text style={styles.pendingBody}>
                {reclaimable
                  ? t("wallet.pending.reserved_desc")
                  : t("wallet.pending.locked_desc")}
                {tx.error ? `\n\n${tx.error}` : ""}
              </Text>
              <View style={styles.pendingActions}>
                <Pressable
                  style={styles.pendingBtn}
                  onPress={() => setQrToken(tx)}
                  accessibilityRole="button"
                  accessibilityLabel={t("wallet.pending.show_qr")}
                >
                  <Text style={styles.pendingBtnText}>QR</Text>
                </Pressable>
                <Pressable
                  style={styles.pendingBtn}
                  onPress={() => void handleCopyToken(tx.token ?? "")}
                  accessibilityRole="button"
                  accessibilityLabel={t("wallet.pending.copy_again")}
                >
                  <Text style={styles.pendingBtnText}>{T("common.copy")}</Text>
                </Pressable>
                <Pressable
                  style={styles.pendingBtn}
                  onPress={() => handleShareToken(tx.token ?? "")}
                  accessibilityRole="button"
                  accessibilityLabel={t("wallet.pending.share_again")}
                >
                  <Text style={styles.pendingBtnText}>{T("common.share")}</Text>
                </Pressable>
                <Pressable
                  style={styles.pendingBtn}
                  onPress={() => markDelivered(tx.id)}
                  accessibilityRole="button"
                  accessibilityLabel={t("wallet.pending.mark_delivered")}
                >
                  <Text style={styles.pendingBtnText}>
                    {t("wallet.pending.delivered")}
                  </Text>
                </Pressable>
                {reclaimable && (
                  <Pressable
                    style={[styles.pendingBtn, styles.pendingBtnDanger]}
                    onPress={() => handleReclaim(tx)}
                    accessibilityRole="button"
                    accessibilityLabel={t("wallet.pending.reclaim_into")}
                  >
                    <Text style={styles.pendingBtnDangerText}>
                      {T("wallet.reclaim.confirm")}
                    </Text>
                  </Pressable>
                )}
              </View>
            </View>
          );
        })}
        {recent.length === 0 ? (
          <View style={[styles.emptyCard, styles.activityEmpty]}>
            <Text style={styles.emptyTitle}>{T("wallet.activity.none")}</Text>
          </View>
        ) : (
          <View style={styles.historyCard}>
            {visibleActivity.map((tx, index) => (
              <View key={tx.id}>
                {index > 0 && <View style={styles.historyDivider} />}
                <View style={styles.historyRow}>
                  <Feather
                    name={txIcon(tx)}
                    size={15}
                    color={
                      tx.status === "failed"
                        ? Colors.danger
                        : Colors.textSecondary
                    }
                    style={styles.historyIcon}
                  />
                  <View style={styles.historyText}>
                    <Text style={styles.historyTitle}>{txTitle(tx)}</Text>
                    <Text style={styles.historySub}>
                      {formatAgo(tx.createdAtMs)}
                      {" · "}
                      {hostOf(tx.mintUrl)}
                      {txStatusNote(tx) !== undefined
                        ? ` · ${txStatusNote(tx)}`
                        : ""}
                    </Text>
                    {/* Every kind shows its reason, including a melt with no
                        answer whose payment may have gone through. */}
                    {tx.error !== undefined && tx.error.length > 0 ? (
                      <Text style={styles.historyError}>{tx.error}</Text>
                    ) : null}
                  </View>
                  <Text
                    style={[
                      styles.historyAmount,
                      isVoided(tx)
                        ? styles.historyVoid
                        : isNeutral(tx)
                          ? styles.historyNeutral
                          : isCredit(tx)
                            ? styles.historyCredit
                            : styles.historyDebit,
                    ]}
                  >
                    {isVoided(tx) || isNeutral(tx)
                      ? ""
                      : isCredit(tx)
                        ? "+"
                        : "−"}
                    {formatAmount(tx.amount, tx.unit, "sat").value}
                  </Text>
                </View>
              </View>
            ))}
            {recent.length > ACTIVITY_COLLAPSED_COUNT && (
              <>
                <View style={styles.historyDivider} />
                <Pressable
                  style={styles.historyMoreRow}
                  onPress={() => setShowAllActivity((v) => !v)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showAllActivity }}
                  accessibilityLabel={
                    showAllActivity
                      ? T("wallet.activity.show_fewer")
                      : TP(
                          "wallet.activity.show_more_a11y",
                          recent.length - ACTIVITY_COLLAPSED_COUNT,
                        )
                  }
                >
                  <Text style={styles.historyMoreText}>
                    {showAllActivity
                      ? T("wallet.activity.show_less")
                      : TP(
                          "wallet.activity.show_more",
                          recent.length - ACTIVITY_COLLAPSED_COUNT,
                        )}
                  </Text>
                  <Feather
                    name={showAllActivity ? "chevron-up" : "chevron-down"}
                    size={14}
                    color={Colors.textMuted}
                  />
                </Pressable>
              </>
            )}
          </View>
        )}
      </View>

      {/* ---- Sheets ---- */}

      <BottomSheet
        visible={chooser === "receive"}
        onClose={() => setChooser(null)}
        sheetStyle={styles.modalSheet}
      >
        <Text style={styles.modalTitle}>{T("wallet.explain.receive")}</Text>
        <ChoiceList
          choices={[
            {
              key: "scan",
              icon: "maximize",
              title: T("wallet.choose.scan"),
              detail: T("wallet.choose.scan_desc"),
              // Ecash only: inside Receive, an invoice or npub would turn the
              // scan into a payment. The card's Scan is the one that routes.
              onPress: () => openScanner("token"),
            },
            {
              key: "paste",
              icon: "clipboard",
              title: T("wallet.choose.paste"),
              detail: T("wallet.choose.paste_desc"),
              onPress: () => switchSheet(() => setShowReceive(true)),
            },
            {
              key: "topup",
              icon: "download",
              title: T("wallet.choose.topup"),
              detail: depositBlockedReason ?? T("wallet.choose.topup_desc"),
              disabled: depositBlockedReason !== null,
              onPress: () =>
                switchSheet(() => {
                  setActiveMint(mintList[0]?.url ?? null);
                  setDeposit(null);
                  setShowDeposit(true);
                }),
            },
          ]}
        />
        <Pressable
          style={styles.modalCancel}
          onPress={() => setChooser(null)}
          accessibilityRole="button"
          accessibilityLabel={T("common.cancel")}
        >
          <Text style={styles.modalCancelText}>{T("common.cancel")}</Text>
        </Pressable>
      </BottomSheet>

      <BottomSheet
        visible={chooser === "send"}
        onClose={() => setChooser(null)}
        sheetStyle={styles.modalSheet}
      >
        <Text style={styles.modalTitle}>{T("wallet.explain.send")}</Text>
        <ChoiceList
          choices={[
            {
              key: "token",
              icon: "grid",
              title: T("wallet.choose.token"),
              detail: T("wallet.choose.token_desc"),
              onPress: () => switchSheet(() => setShowSend(true)),
            },
            {
              key: "zap",
              icon: "zap",
              title: T("wallet.choose.zap"),
              detail: T("wallet.choose.zap_desc"),
              onPress: () => switchSheet(() => setShowZap(true)),
            },
            {
              key: "invoice",
              icon: "upload",
              title: T("wallet.choose.invoice"),
              detail: lightningBlockedReason ?? T("wallet.choose.invoice_desc"),
              disabled: lightningBlockedReason !== null,
              onPress: () =>
                switchSheet(() => {
                  setActiveMint(splitAccounts[0]?.mintUrl ?? null);
                  setWithdrawQuote(null);
                  setShowWithdraw(true);
                }),
            },
          ]}
        />
        <Pressable
          style={styles.modalCancel}
          onPress={() => setChooser(null)}
          accessibilityRole="button"
          accessibilityLabel={T("common.cancel")}
        >
          <Text style={styles.modalCancelText}>{T("common.cancel")}</Text>
        </Pressable>
      </BottomSheet>

      <BottomSheet
        visible={showMints}
        onClose={() => setShowMints(false)}
        sheetStyle={[styles.modalSheet, styles.scrollSheet]}
        scrollable
      >
        <View style={styles.sheetHeader}>
          <Text style={styles.modalTitle}>{T("wallet.mint.title")}</Text>
          {mintList.length > 0 && (
            <Text style={styles.sheetHeaderNote}>
              {formatNumber(mintList.length)}
            </Text>
          )}
        </View>
        <ScrollView
          contentContainerStyle={styles.sheetList}
          showsVerticalScrollIndicator={false}
        >
          {visibleAccounts.length === 0 ? (
            <Text style={styles.modalSubtitle}>
              {T("wallet.mint.none_desc")}
            </Text>
          ) : (
            <View style={styles.listGroup}>
              {visibleAccounts.map((account, index) => {
                const record = mints[account.mintUrl];
                const shown = formatAmount(
                  account.balance,
                  account.unit,
                  bitcoinUnit,
                );
                const meta = [
                  record?.name !== undefined ? hostOf(account.mintUrl) : null,
                  account.unverified > 0
                    ? TP("wallet.mint.unconfirmed_count", account.unverified)
                    : null,
                ].filter((part) => part !== null);
                return (
                  <View key={account.key}>
                    {index > 0 && <View style={styles.listDivider} />}
                    <Pressable
                      style={({ pressed }) => [
                        styles.listRow,
                        pressed && styles.listRowPressed,
                      ]}
                      onPress={() => openMintActions(account)}
                      accessibilityRole="button"
                      accessibilityLabel={
                        record?.name ?? hostOf(account.mintUrl)
                      }
                      accessibilityHint={`${shown.value} ${shown.label}`}
                    >
                      <View style={styles.listIcon}>
                        {refreshingMint === account.mintUrl ? (
                          <ActivityIndicator
                            size="small"
                            color={Colors.textSecondary}
                          />
                        ) : (
                          <Feather
                            name="database"
                            size={16}
                            color={Colors.textPrimary}
                          />
                        )}
                      </View>
                      <View style={styles.listText}>
                        <View style={styles.mintNameRow}>
                          <Text style={styles.listTitle} numberOfLines={1}>
                            {record?.name ?? hostOf(account.mintUrl)}
                          </Text>
                          {isLikelyTestMint({
                            url: account.mintUrl,
                            name: record?.name,
                            description: record?.description,
                          }) && (
                            <View style={styles.testBadge}>
                              <Text style={styles.testBadgeText}>TEST</Text>
                            </View>
                          )}
                        </View>
                        {meta.length > 0 && (
                          <Text style={styles.listMeta} numberOfLines={1}>
                            {meta.join(" · ")}
                          </Text>
                        )}
                      </View>
                      <View style={styles.listAmount}>
                        <Text style={styles.mintBalance}>{shown.value}</Text>
                        <Text style={styles.mintUnit}>{shown.label}</Text>
                      </View>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          )}

          {/* Two mints' ecash can never form one token; Lightning is the
              only way to merge them. */}
          {splitAccounts.length > 1 && (
            <ChoiceList
              choices={[
                {
                  key: "consolidate",
                  icon: "git-merge",
                  title: T("wallet.mint.consolidate"),
                  detail:
                    lightningBlockedReason ??
                    T("wallet.mint.split_across", {
                      count: splitAccounts.length,
                    }),
                  disabled: lightningBlockedReason !== null,
                  onPress: () =>
                    switchSheet(() => {
                      setConsolidateTarget(splitAccounts[0].mintUrl);
                      setShowConsolidate(true);
                    }),
                },
              ]}
            />
          )}

          <Pressable
            style={({ pressed }) => [
              styles.modalCancel,
              styles.pillWithIcon,
              pressed && styles.listRowPressed,
            ]}
            onPress={() => switchSheet(() => setShowAddMint(true))}
            accessibilityRole="button"
            accessibilityLabel={T("wallet.mint.add")}
          >
            <Feather name="plus" size={16} color={Colors.textPrimary} />
            <Text style={styles.modalCancelText}>{T("wallet.mint.add")}</Text>
          </Pressable>
          <Pressable
            style={styles.modalCancel}
            onPress={() => setShowMints(false)}
            accessibilityRole="button"
            accessibilityLabel={T("common.done")}
          >
            <Text style={styles.modalCancelText}>{T("common.done")}</Text>
          </Pressable>
        </ScrollView>
      </BottomSheet>

      <BottomSheet
        visible={showBackup}
        onClose={() => setShowBackup(false)}
        sheetStyle={[styles.modalSheet, styles.scrollSheet]}
        scrollable
      >
        <ScrollView
          contentContainerStyle={styles.sheetList}
          showsVerticalScrollIndicator={false}
        >
          {backupDetails}
        </ScrollView>
      </BottomSheet>

      <BottomSheet
        visible={showHelp}
        onClose={() => setShowHelp(false)}
        sheetStyle={[styles.modalSheet, styles.scrollSheet]}
        scrollable
      >
        <ScrollView showsVerticalScrollIndicator={false}>
          <View style={styles.infoPanel}>
            {[
              {
                icon: "help-circle" as const,
                title: T("wallet.explain.title"),
                body: T("wallet.explain.intro"),
              },
              {
                icon: "arrow-up" as const,
                title: T("wallet.explain.send"),
                body: T("wallet.explain.send_desc"),
              },
              {
                icon: "arrow-down" as const,
                title: T("wallet.explain.receive"),
                body: T("wallet.explain.receive_desc"),
              },
              {
                icon: "zap" as const,
                title: T("wallet.explain.zap"),
                body: T("wallet.explain.zap_desc"),
              },
              {
                icon: "plus" as const,
                title: T("wallet.mint.add_short"),
                body: T("wallet.explain.add_mint_desc"),
              },
              {
                icon: "shield" as const,
                title: T("wallet.backup.phrase"),
                body: T("wallet.explain.phrase_desc"),
              },
            ].map((row, index) => (
              <View key={row.title}>
                {index > 0 && <View style={styles.infoPanelDivider} />}
                <View style={styles.infoPanelRow}>
                  <Feather
                    name={row.icon}
                    size={16}
                    color={Colors.textMuted}
                    style={styles.infoPanelIcon}
                  />
                  <View style={styles.infoPanelText}>
                    <Text style={styles.infoPanelTitle}>{row.title}</Text>
                    <Text style={styles.infoPanelBody}>{row.body}</Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        </ScrollView>
      </BottomSheet>

      <BottomSheet
        visible={showReceive}
        onClose={() => setShowReceive(false)}
        sheetStyle={styles.modalSheet}
      >
        <Text style={styles.modalTitle}>{T("wallet.receive.title")}</Text>
        <Text style={styles.modalSubtitle}>{T("wallet.receive.body")}</Text>
        {myNpub !== null && (
          <Pressable
            style={styles.npubRow}
            onPress={() => {
              void Clipboard.setStringAsync(myNpub);
              acknowledged();
              showAlert(T("common.copied"), t("wallet.nostr.copied_body"));
            }}
            accessibilityRole="button"
            accessibilityLabel={T("wallet.nostr.copy_key")}
          >
            <View style={styles.npubText}>
              <Text style={styles.npubLabel}>{T("wallet.nostr.your_key")}</Text>
              <Text style={styles.npubValue} numberOfLines={1}>
                {myNpub}
              </Text>
            </View>
            <Feather name="copy" size={16} color={Colors.accent} />
          </Pressable>
        )}
        <TextInput
          style={styles.tokenInput}
          value={tokenInput}
          onChangeText={setTokenInput}
          placeholder="cashuB..."
          placeholderTextColor={Colors.textMuted}
          multiline
          numberOfLines={3}
          autoCapitalize="none"
          autoCorrect={false}
          selectionColor={Colors.selection}
        />
        <Pressable
          style={styles.generatedActionBtn}
          onPress={() => openScanner("token")}
          accessibilityRole="button"
          accessibilityLabel={T("wallet.receive.scan")}
        >
          <Feather name="camera" size={18} color={Colors.accent} />
          <Text style={styles.generatedActionText}>
            {T("wallet.receive.scan_short")}
          </Text>
        </Pressable>
        <SheetActions
          styles={styles}
          confirmLabel={
            busy === "receive"
              ? T("wallet.receive.receiving")
              : T("wallet.explain.receive")
          }
          confirmDisabled={!tokenInput.trim() || busy !== null || locked}
          onConfirm={() => void handleReceive()}
          onCancel={() => setShowReceive(false)}
        />
      </BottomSheet>

      <BottomSheet
        visible={showSend}
        onClose={() => setShowSend(false)}
        sheetStyle={styles.modalSheet}
      >
        <Text style={styles.modalTitle}>{T("wallet.send.title")}</Text>
        <Text style={styles.modalSubtitle}>{T("wallet.send.body")}</Text>
        <TextInput
          style={styles.tokenInput}
          value={sendAmount}
          onChangeText={setSendAmount}
          placeholder={T("wallet.send.amount_in", { unit: primary.unit })}
          placeholderTextColor={Colors.textMuted}
          keyboardType="number-pad"
          returnKeyType="next"
          selectionColor={Colors.selection}
        />
        <TextInput
          style={[styles.tokenInput, styles.tokenInputCompact]}
          value={sendMemo}
          onChangeText={setSendMemo}
          placeholder={T("wallet.send.memo")}
          placeholderTextColor={Colors.textMuted}
          autoCapitalize="sentences"
          selectionColor={Colors.selection}
        />
        <SheetActions
          styles={styles}
          confirmLabel={
            busy === "send" ? T("wallet.send.building") : T("wallet.send.build")
          }
          confirmDisabled={!sendAmount.trim() || busy !== null || locked}
          onConfirm={() => void handleSend()}
          onCancel={() => {
            setShowSend(false);
            setSendAmount("");
            setSendMemo("");
          }}
        />
      </BottomSheet>

      <BottomSheet
        visible={showZap}
        onClose={() => setShowZap(false)}
        sheetStyle={styles.modalSheet}
      >
        <Text style={styles.modalTitle}>{T("wallet.zap.title")}</Text>
        <Text style={styles.modalSubtitle}>{T("wallet.zap.body")}</Text>
        {zapContacts.length > 0 && (
          <View style={styles.zapContacts}>
            {zapContacts.map((contact) => {
              const hex = contact.nostrPubkeyHex;
              if (hex === undefined) return null;
              const selected = zapNpub === hex;
              return (
                <Pressable
                  key={contact.peerID}
                  style={[
                    styles.zapContactChip,
                    selected && styles.zapContactChipOn,
                  ]}
                  onPress={() => setZapNpub(selected ? "" : hex)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={T("wallet.zap.contact", {
                    name: contact.nickname,
                  })}
                >
                  <Text
                    style={[
                      styles.zapContactText,
                      selected && styles.zapContactTextOn,
                    ]}
                    numberOfLines={1}
                  >
                    {contact.nickname}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
        <TextInput
          style={styles.tokenInput}
          value={zapNpub}
          onChangeText={setZapNpub}
          placeholder={T("wallet.zap.pubkey_placeholder")}
          placeholderTextColor={Colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          selectionColor={Colors.selection}
        />
        <TextInput
          style={[styles.tokenInput, styles.tokenInputCompact]}
          value={zapAmount}
          onChangeText={setZapAmount}
          placeholder={T("wallet.send.amount_in", { unit: primary.unit })}
          placeholderTextColor={Colors.textMuted}
          keyboardType="number-pad"
          selectionColor={Colors.selection}
        />
        <TextInput
          style={[styles.tokenInput, styles.tokenInputCompact]}
          value={zapNote}
          onChangeText={setZapNote}
          placeholder={T("wallet.pay.memo")}
          placeholderTextColor={Colors.textMuted}
          autoCapitalize="sentences"
          selectionColor={Colors.selection}
        />
        <SheetActions
          styles={styles}
          confirmLabel={
            busy === "zap" ? T("wallet.zap.sending") : T("wallet.explain.zap")
          }
          confirmDisabled={
            !zapNpub.trim() || !zapAmount.trim() || busy !== null || locked
          }
          onConfirm={() => void handleZap()}
          onCancel={() => {
            setShowZap(false);
            setZapNpub("");
            setZapAmount("");
            setZapNote("");
          }}
        />
      </BottomSheet>

      <BottomSheet
        visible={showAddMint}
        onClose={() => setShowAddMint(false)}
        sheetStyle={styles.modalSheet}
      >
        <Text style={styles.modalTitle}>{T("wallet.explain.add_mint")}</Text>
        <Text style={styles.modalSubtitle}>{T("wallet.mint.add_body")}</Text>
        <TextInput
          style={styles.tokenInput}
          value={mintUrlInput}
          onChangeText={setMintUrlInput}
          placeholder="https://mint.example.com"
          placeholderTextColor={Colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="done"
          selectionColor={Colors.selection}
        />
        <SheetActions
          styles={styles}
          confirmLabel={
            busy === "addMint" ? T("wallet.mint.checking") : T("common.add")
          }
          confirmDisabled={!mintUrlInput.trim() || busy !== null || locked}
          onConfirm={() => void handleAddMint()}
          onCancel={() => {
            setShowAddMint(false);
            setMintUrlInput("");
          }}
        />
      </BottomSheet>

      {/* Generated token: the send has reserved proofs but not spent them. */}
      <BottomSheet
        visible={pending !== null}
        onClose={() => setPending(null)}
        sheetStyle={styles.modalSheet}
      >
        <View style={styles.generatedHeader}>
          <Feather name="check-circle" size={28} color={Colors.online} />
          <View style={styles.generatedAmountRow}>
            <Text style={styles.generatedAmount}>
              {pending === null
                ? ""
                : amountParts(pending.amount, pending.unit).amount}
            </Text>
            <Text style={styles.generatedUnit}>
              {pending === null ? "" : unitLabel(pending.unit)}
            </Text>
          </View>
          <Text style={styles.generatedMint} numberOfLines={1}>
            {pending ? hostOf(pending.mintUrl) : ""}
          </Text>
          {pending && pending.fee > 0 && (
            <Text style={styles.generatedMint}>
              {T("wallet.send.fee_note", {
                spend: amountParts(pending.spend, pending.unit).amount,
                unit: unitLabel(pending.unit),
                fee: amountParts(pending.fee, pending.unit).amount,
              })}
            </Text>
          )}
          {/* Fees are cached so a send prices offline, but a mint that has
              raised its input fee since takes more than the quote said.
              Shown only once the cache is stale, so the usual case is quiet. */}
          {pending !== null &&
            pending.pricedFromCacheAgeMs !== undefined &&
            pending.pricedFromCacheAgeMs >= FEE_CACHE_STALE_MS && (
              <Text style={styles.generatedMint}>
                {T("wallet.send.stale_fee_note", {
                  days: Math.floor(
                    pending.pricedFromCacheAgeMs / FEE_CACHE_STALE_MS,
                  ),
                })}
              </Text>
            )}
        </View>
        {/* A QR rather than 400 characters of base64, and every Cashu
            wallet scans one. Text fallback for a token too large to encode (an unusually
            fragmented balance). */}
        {pending !== null && canEncodeTokenQr(pending.token) ? (
          <View style={styles.qrFrame}>
            <QRCode
              value={tokenQrPayload(pending.token)}
              size={qrSize}
              ecl={TOKEN_QR_ERROR_CORRECTION}
              color="#000000"
              backgroundColor="#FFFFFF"
            />
          </View>
        ) : (
          <>
            <View style={styles.readonlyValueBox}>
              <Text
                style={styles.readonlyValue}
                selectable
                numberOfLines={3}
                ellipsizeMode="tail"
              >
                {pending?.token ?? ""}
              </Text>
            </View>
            <Text style={styles.generatedHint}>
              {T("wallet.send.qr_too_big")}
            </Text>
          </>
        )}
        <Text style={styles.generatedHint}>{T("wallet.send.bearer_note")}</Text>
        <View style={styles.generatedActions}>
          <Pressable
            style={styles.generatedActionBtn}
            onPress={() => pending && void handleCopyToken(pending.token)}
            accessibilityRole="button"
            accessibilityLabel={T("wallet.send.copy_token")}
          >
            <Feather name="copy" size={18} color={Colors.accent} />
            <Text style={styles.generatedActionText}>{T("common.copy")}</Text>
          </Pressable>
          <Pressable
            style={styles.generatedActionBtn}
            onPress={() => pending && handleShareToken(pending.token)}
            accessibilityRole="button"
            accessibilityLabel={T("wallet.send.share_token")}
          >
            <Feather name="share" size={18} color={Colors.accent} />
            <Text style={styles.generatedActionText}>{T("common.share")}</Text>
          </Pressable>
          <Pressable
            style={styles.generatedActionBtn}
            onPress={() => pending && void openTokenInWallet(pending.token)}
            accessibilityRole="button"
            accessibilityLabel={T("wallet.send.open_in_wallet")}
          >
            <Feather name="external-link" size={18} color={Colors.accent} />
            <Text style={styles.generatedActionText}>
              {T("wallet.send.open_in_wallet_short")}
            </Text>
          </Pressable>
          <Pressable
            style={styles.generatedActionBtn}
            onPress={() => setShowPeerPicker(true)}
            accessibilityRole="button"
            accessibilityLabel={T("wallet.send.to_peer")}
          >
            <Feather name="radio" size={18} color={Colors.accent} />
            <Text style={styles.generatedActionText}>
              {T("wallet.send.to_peer_short")}
            </Text>
          </Pressable>
        </View>
        <View style={styles.modalActions}>
          <Pressable
            style={styles.modalConfirm}
            onPress={() => pending && markDelivered(pending.txId)}
            accessibilityRole="button"
            accessibilityLabel={T("wallet.send.mark_delivered")}
          >
            <Text style={styles.modalConfirmText}>
              {T("wallet.send.they_got_it")}
            </Text>
          </Pressable>
          <Pressable
            style={styles.modalCancel}
            onPress={() => setPending(null)}
            accessibilityRole="button"
            accessibilityLabel={T("wallet.send.keep_pending")}
          >
            <Text style={styles.modalCancelText}>
              {T("wallet.send.decide_later")}
            </Text>
          </Pressable>
        </View>
      </BottomSheet>

      {/* Lightning deposit */}
      <BottomSheet
        visible={showDeposit}
        onClose={() => {
          setShowDeposit(false);
          setDeposit(null);
        }}
        sheetStyle={styles.modalSheet}
      >
        <Text style={styles.modalTitle}>{T("wallet.ln.deposit_title")}</Text>
        {deposit === null ? (
          <>
            <Text style={styles.modalSubtitle}>
              {T("wallet.ln.deposit_body")}
            </Text>
            <TextInput
              style={styles.tokenInput}
              value={depositAmount}
              onChangeText={setDepositAmount}
              placeholder={T("wallet.ln.amount_placeholder")}
              placeholderTextColor={Colors.textMuted}
              keyboardType="number-pad"
              selectionColor={Colors.selection}
            />
            <MintPicker
              styles={styles}
              Colors={Colors}
              label={T("wallet.mint.issued_by")}
              options={mintList.map((m) => ({
                mintUrl: m.url,
                sub: m.name ?? hostOf(m.url),
              }))}
              selected={activeMint}
              onSelect={setActiveMint}
            />
            <SheetActions
              styles={styles}
              confirmLabel={
                busy === "deposit"
                  ? T("wallet.ln.requesting")
                  : T("wallet.ln.get_invoice")
              }
              confirmDisabled={!depositAmount.trim() || busy !== null}
              onConfirm={() => void handleCreateDeposit()}
              onCancel={() => setShowDeposit(false)}
            />
          </>
        ) : (
          <>
            <Text style={styles.modalSubtitle}>
              {T("wallet.ln.pay_invoice_for", {
                ...amountParts(deposit.amount, deposit.unit),
              })}
            </Text>
            {/* bech32 uppercases losslessly into QR alphanumeric mode, a
                denser code. Length checked so a long invoice falls back to
                text instead of throwing. */}
            {deposit.invoice.length <= TOKEN_QR_MAX_CHARS && (
              <View style={styles.qrFrame}>
                <QRCode
                  value={deposit.invoice.toUpperCase()}
                  size={qrSize}
                  ecl={TOKEN_QR_ERROR_CORRECTION}
                  backgroundColor="#FFFFFF"
                  color="#000000"
                />
              </View>
            )}
            {/* Head first: the `lnbc` prefix and amount are all a person can
                check by eye. */}
            <View style={styles.readonlyValueBox}>
              <Text
                style={styles.readonlyValue}
                selectable
                numberOfLines={4}
                ellipsizeMode="tail"
              >
                {deposit.invoice}
              </Text>
            </View>
            {/* Weighted, not equal: Open finishes the job on this phone and
                leads, Copy serves other routes, Close walks away. */}
            <View style={styles.generatedActions}>
              <Pressable
                style={styles.generatedPrimaryBtn}
                onPress={() => void openInvoiceInWallet(deposit.invoice)}
                accessibilityRole="button"
                accessibilityLabel={T("wallet.ln.open_wallet")}
              >
                <Feather
                  name="external-link"
                  size={18}
                  color={Colors.textInverse}
                />
                <Text style={styles.generatedPrimaryText}>
                  {T("wallet.ln.open_wallet_short")}
                </Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.generatedActionBtn,
                  pressed && styles.generatedActionBtnPressed,
                ]}
                onPress={() => copyInvoice(deposit.invoice)}
                accessibilityRole="button"
                accessibilityLabel={T("wallet.ln.copy_invoice")}
              >
                <CopyGlyph
                  copied={invoiceCopied}
                  size={18}
                  color={Colors.accent}
                />
                <Text style={styles.generatedActionText}>
                  {invoiceCopied
                    ? T("common.copied")
                    : T("wallet.ln.copy_invoice")}
                </Text>
              </Pressable>
            </View>
            {depositExpired ? (
              <View style={styles.waitingRow}>
                <Feather name="clock" size={16} color={Colors.textMuted} />
                <Text style={styles.waitingText}>
                  {T("wallet.ln.expired_body")}
                </Text>
              </View>
            ) : (
              <View style={styles.waitingRow}>
                <ActivityIndicator size="small" color={Colors.textMuted} />
                <Text style={styles.waitingText}>
                  {depositExpiresAtMs === undefined
                    ? T("wallet.ln.waiting")
                    : T("wallet.ln.waiting_expires", {
                        countdown: formatCountdown(
                          depositExpiresAtMs - depositClock,
                        ),
                      })}
                </Text>
              </View>
            )}
            <View style={styles.modalActions}>
              {/* Borderless, so it does not read as a peer of the two above. */}
              <Pressable
                style={styles.modalDismiss}
                onPress={() => setShowDeposit(false)}
                accessibilityRole="button"
                accessibilityLabel={T("common.close")}
              >
                <Text style={styles.modalDismissText}>{T("common.close")}</Text>
              </Pressable>
              {depositExpired && (
                <Pressable
                  style={styles.modalConfirm}
                  disabled={busy !== null}
                  onPress={() => {
                    setDeposit(null);
                    void handleCreateDeposit();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={T("wallet.ln.new_invoice")}
                >
                  <Text style={styles.modalConfirmText}>
                    {T("wallet.ln.new_invoice_short")}
                  </Text>
                </Pressable>
              )}
            </View>
          </>
        )}
      </BottomSheet>

      {/* Lightning withdrawal */}
      <BottomSheet
        visible={showWithdraw}
        onClose={() => {
          setShowWithdraw(false);
          setWithdrawQuote(null);
        }}
        sheetStyle={styles.modalSheet}
      >
        <Text style={styles.modalTitle}>{T("wallet.ln.withdraw_title")}</Text>
        <Text style={styles.modalSubtitle}>{T("wallet.ln.withdraw_body")}</Text>
        <TextInput
          style={[styles.tokenInput, styles.tokenInputMono]}
          value={withdrawInvoice}
          onChangeText={(text) => {
            setWithdrawInvoice(text);
            setWithdrawQuote(null);
          }}
          placeholder="lnbc..."
          placeholderTextColor={Colors.textMuted}
          multiline
          numberOfLines={3}
          autoCapitalize="none"
          autoCorrect={false}
          selectionColor={Colors.selection}
        />
        <Pressable
          style={styles.generatedActionBtn}
          onPress={() => openScanner("invoice")}
          accessibilityRole="button"
          accessibilityLabel={T("wallet.ln.scan_invoice")}
        >
          <Feather name="camera" size={18} color={Colors.accent} />
          <Text style={styles.generatedActionText}>
            {T("wallet.receive.scan_short")}
          </Text>
        </Pressable>
        <MintPicker
          styles={styles}
          Colors={Colors}
          label={T("wallet.ln.paid_from")}
          options={splitAccounts.map((a) => ({
            mintUrl: a.mintUrl,
            sub: t("wallet.mint.available_amount", {
              ...amountParts(a.balance, a.unit),
            }),
          }))}
          selected={activeMint}
          onSelect={(url) => {
            setActiveMint(url);
            // A quote is priced against one mint's fees.
            setWithdrawQuote(null);
          }}
        />
        {withdrawQuote && (
          <View style={styles.quoteBox}>
            <QuoteRow
              styles={styles}
              label={T("wallet.ln.invoice")}
              value={formatUnitAmount(withdrawQuote.amount, withdrawQuote.unit)}
            />
            <QuoteRow
              styles={styles}
              label={T("wallet.ln.routing_reserve")}
              value={T("wallet.ln.up_to", {
                ...amountParts(withdrawQuote.feeReserve, withdrawQuote.unit),
              })}
            />
            <QuoteRow
              styles={styles}
              label={T("wallet.ln.reserved")}
              value={T("wallet.ln.amount_unit", {
                ...amountParts(withdrawQuote.total, withdrawQuote.unit),
              })}
            />
          </View>
        )}
        <SheetActions
          styles={styles}
          confirmLabel={
            withdrawQuote
              ? busy === "withdrawPay"
                ? T("wallet.ln.paying")
                : T("wallet.ln.pay_amount", {
                    ...amountParts(withdrawQuote.amount, withdrawQuote.unit),
                  })
              : busy === "withdrawQuote"
                ? T("wallet.mint.checking")
                : T("wallet.ln.get_quote")
          }
          confirmDisabled={!withdrawInvoice.trim() || busy !== null}
          onConfirm={() =>
            void (withdrawQuote ? handlePayWithdraw() : handleQuoteWithdraw())
          }
          onCancel={() => {
            setShowWithdraw(false);
            setWithdrawQuote(null);
            setWithdrawInvoice("");
          }}
        />
      </BottomSheet>

      {/* Recovery phrase: warn -> show -> verify, or view when already set up */}
      <BottomSheet
        visible={backupStep !== null}
        onClose={closeBackupSheet}
        sheetStyle={styles.modalSheet}
        scrollable
      >
        {backupStep === "warn" && (
          <>
            <Text style={styles.modalTitle}>
              {T("wallet.backup.setup_title")}
            </Text>
            <Text style={styles.modalSubtitle}>
              {T("wallet.backup.about_to_see")}
            </Text>
            {[
              T("wallet.backup.warn_secret"),
              T("wallet.backup.warn_paper"),
              T("wallet.backup.warn_scope"),
              T("wallet.backup.warn_mints"),
            ].map((line) => (
              <View key={line} style={styles.bulletRow}>
                <View style={styles.bulletDot} />
                <Text style={styles.bulletText}>{line}</Text>
              </View>
            ))}
            <SheetActions
              styles={styles}
              confirmLabel={
                busy === "backup"
                  ? T("wallet.backup.preparing")
                  : T("wallet.backup.show_phrase")
              }
              confirmDisabled={busy !== null}
              onConfirm={() => void handleRevealPhrase()}
              onCancel={closeBackupSheet}
            />
          </>
        )}

        {(backupStep === "show" || backupStep === "view") && (
          <>
            <Text style={styles.modalTitle}>
              {backupStep === "view"
                ? T("wallet.backup.your_phrase")
                : T("wallet.backup.write_down")}
            </Text>
            <Text style={styles.modalSubtitle}>
              {T("wallet.backup.exact_order")}
            </Text>
            <View style={styles.phraseGrid}>
              {phrase.split(" ").map((word, index) => (
                <View
                  key={`${String(index)}-${word}`}
                  style={styles.phraseCell}
                >
                  <Text style={styles.phraseIndex}>{index + 1}</Text>
                  <Text style={styles.phraseWord}>{word}</Text>
                </View>
              ))}
            </View>
            <Pressable
              style={styles.generatedActionBtn}
              onPress={() => void handleCopyPhrase()}
              accessibilityRole="button"
              accessibilityLabel={T("wallet.backup.copy_phrase")}
            >
              <Feather name="copy" size={18} color={Colors.accent} />
              <Text style={styles.generatedActionText}>
                {T("wallet.backup.copy_clipboard")}
              </Text>
            </Pressable>
            {backupStep === "show" ? (
              <SheetActions
                styles={styles}
                confirmLabel={T("wallet.backup.written_down")}
                confirmDisabled={false}
                onConfirm={() => setBackupStep("verify")}
                onCancel={closeBackupSheet}
              />
            ) : (
              <Pressable
                style={styles.modalCancel}
                onPress={closeBackupSheet}
                accessibilityRole="button"
                accessibilityLabel={T("common.done")}
              >
                <Text style={styles.modalCancelText}>{T("common.done")}</Text>
              </Pressable>
            )}
          </>
        )}

        {backupStep === "verify" && (
          <>
            <Text style={styles.modalTitle}>
              {T("wallet.backup.check_copy")}
            </Text>
            <Text style={styles.modalSubtitle}>
              {T("wallet.backup.verify_body")}
            </Text>
            {verifyPositionList.map((position) => (
              <View key={position} style={styles.verifyRow}>
                <Text style={styles.verifyLabel}>
                  {T("wallet.backup.word_n", { position })}
                </Text>
                <TextInput
                  style={[styles.tokenInput, styles.tokenInputCompact]}
                  value={verifyAnswers[position] ?? ""}
                  onChangeText={(text) => {
                    setVerifyAnswers((prev) => ({ ...prev, [position]: text }));
                    setVerifyError(false);
                  }}
                  placeholder="word"
                  placeholderTextColor={Colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  selectionColor={Colors.selection}
                />
              </View>
            ))}
            {verifyError && (
              <Text style={styles.verifyError}>
                {T("wallet.backup.verify_mismatch")}
              </Text>
            )}
            <SheetActions
              styles={styles}
              confirmLabel={T("wallet.backup.confirm")}
              confirmDisabled={
                verifyPositionList.some(
                  (p) => (verifyAnswers[p] ?? "").trim().length === 0,
                ) || busy !== null
              }
              onConfirm={handleVerifyPhrase}
              onCancel={() => setBackupStep("show")}
              cancelLabel={T("common.back")}
            />
          </>
        )}
      </BottomSheet>

      {/* Restore from a phrase */}
      <BottomSheet
        visible={showRestore}
        onClose={() => setShowRestore(false)}
        sheetStyle={styles.modalSheet}
        scrollable
      >
        <Text style={styles.modalTitle}>
          {T("wallet.backup.restore_title")}
        </Text>
        {restoreResult === null ? (
          <>
            <Text style={styles.modalSubtitle}>
              {T("wallet.backup.restore_body")}
            </Text>
            <TextInput
              style={styles.tokenInput}
              value={restoreInput}
              onChangeText={setRestoreInput}
              placeholder={T("wallet.backup.phrase_placeholder")}
              placeholderTextColor={Colors.textMuted}
              multiline
              numberOfLines={3}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              selectionColor={Colors.selection}
            />
            <Text style={styles.modalSubtitle}>
              {mintList.length === 0
                ? T("wallet.backup.no_mints_yet")
                : T("wallet.backup.will_scan", {
                    mints: mintList.map((m) => hostOf(m.url)).join(", "),
                  })}
            </Text>
            {restoreProgress !== null && (
              <View style={styles.waitingRow}>
                <ActivityIndicator size="small" color={Colors.textMuted} />
                <Text style={styles.waitingText}>{restoreProgress}</Text>
              </View>
            )}
            <SheetActions
              styles={styles}
              confirmLabel={
                busy === "restore"
                  ? T("wallet.backup.scanning")
                  : T("wallet.backup.restore_short")
              }
              confirmDisabled={
                !restoreInput.trim() || busy !== null || mintList.length === 0
              }
              onConfirm={() => void handleRestore()}
              onCancel={() => setShowRestore(false)}
            />
          </>
        ) : (
          <>
            <View style={styles.generatedHeader}>
              <Feather
                name={restoreResult.proofCount > 0 ? "check-circle" : "info"}
                size={28}
                color={
                  restoreResult.proofCount > 0
                    ? Colors.online
                    : Colors.textMuted
                }
              />
              <View style={styles.generatedAmountRow}>
                <Text style={styles.generatedAmount}>
                  {
                    amountParts(
                      restoreResult.recovered[primary.unit] ?? 0,
                      primary.unit,
                    ).amount
                  }
                </Text>
                <Text style={styles.generatedUnit}>
                  {unitLabel(primary.unit)}
                </Text>
              </View>
            </View>
            <Text style={styles.modalSubtitle}>
              {restoreResult.proofCount > 0
                ? TP("wallet.backup.recovered", restoreResult.proofCount, {
                    mints: restoreResult.mintsScanned.map(hostOf).join(", "),
                  })
                : T("wallet.backup.nothing_recovered")}
            </Text>
            {restoreResult.alreadySpent > 0 && (
              <Text style={styles.modalSubtitle}>
                {TP("wallet.backup.already_spent", restoreResult.alreadySpent)}
              </Text>
            )}
            {restoreResult.mintsFailed.length > 0 && (
              <Text style={styles.modalSubtitle}>
                {T("wallet.backup.unreachable_mints", {
                  mints: restoreResult.mintsFailed
                    .map((f) => hostOf(f.mintUrl))
                    .join(", "),
                })}
              </Text>
            )}
            <Pressable
              style={styles.modalCancel}
              onPress={() => {
                setShowRestore(false);
                setRestoreResult(null);
              }}
              accessibilityRole="button"
              accessibilityLabel={T("common.done")}
            >
              <Text style={styles.modalCancelText}>{T("common.done")}</Text>
            </Pressable>
          </>
        )}
      </BottomSheet>

      {/* Consolidate across mints */}
      <BottomSheet
        visible={showConsolidate}
        onClose={() => setShowConsolidate(false)}
        sheetStyle={styles.modalSheet}
        scrollable
      >
        <Text style={styles.modalTitle}>
          {T("wallet.mint.consolidate_title")}
        </Text>
        <Text style={styles.modalSubtitle}>
          {T("wallet.mint.consolidate_body")}
        </Text>
        {splitAccounts.map((account) => {
          const isTarget = account.mintUrl === consolidateTarget;
          return (
            <Pressable
              key={account.key}
              style={[styles.pickRow, isTarget && styles.pickRowSelected]}
              onPress={() => setConsolidateTarget(account.mintUrl)}
              accessibilityRole="radio"
              accessibilityState={{ selected: isTarget }}
              accessibilityLabel={T("wallet.mint.move_everything_to", {
                mint: hostOf(account.mintUrl),
              })}
            >
              <Feather
                name={isTarget ? "check-circle" : "circle"}
                size={18}
                color={isTarget ? Colors.accent : Colors.textMuted}
              />
              <View style={styles.pickInfo}>
                <Text style={styles.pickTitle}>{hostOf(account.mintUrl)}</Text>
                <Text style={styles.pickSub}>
                  {formatNumber(account.balance)} {account.unit}
                  {isTarget
                    ? ` ${t("wallet.mint.destination")}`
                    : ` ${t("wallet.mint.will_move")}`}
                </Text>
              </View>
            </Pressable>
          );
        })}
        <SheetActions
          styles={styles}
          confirmLabel={
            busy === "consolidate"
              ? T("wallet.mint.moving")
              : T("wallet.mint.move")
          }
          confirmDisabled={consolidateTarget === null || busy !== null}
          onConfirm={() => void handleConsolidate()}
          onCancel={() => setShowConsolidate(false)}
        />
      </BottomSheet>

      <TokenScanSheet
        visible={scannerTarget !== null}
        target={scannerTarget ?? "token"}
        onClose={closeScanner}
        onScanned={handleScanned}
      />

      {/* Re-show a pending token as a QR, for handing it over later. */}
      <BottomSheet
        visible={qrToken !== null}
        onClose={() => setQrToken(null)}
        sheetStyle={styles.modalSheet}
      >
        <Text style={styles.modalTitle}>
          {qrToken
            ? formatUnitAmount(qrToken.amount, qrToken.unit)
            : T("wallet.token")}
        </Text>
        <Text style={styles.modalSubtitle}>{T("wallet.send.scan_note")}</Text>
        {qrToken?.token !== undefined && canEncodeTokenQr(qrToken.token) ? (
          <View style={styles.qrFrame}>
            <QRCode
              value={tokenQrPayload(qrToken.token)}
              size={qrSize}
              ecl={TOKEN_QR_ERROR_CORRECTION}
              color="#000000"
              backgroundColor="#FFFFFF"
            />
          </View>
        ) : (
          <Text style={styles.modalSubtitle}>
            {T("wallet.send.qr_too_big_short")}
          </Text>
        )}
        <Pressable
          style={styles.modalCancel}
          onPress={() => setQrToken(null)}
          accessibilityRole="button"
          accessibilityLabel={T("common.done")}
        >
          <Text style={styles.modalCancelText}>{T("common.done")}</Text>
        </Pressable>
      </BottomSheet>

      {/* Peer picker for a mesh hand-off */}
      <BottomSheet
        visible={showPeerPicker}
        onClose={() => setShowPeerPicker(false)}
        sheetStyle={styles.modalSheet}
      >
        <Text style={styles.modalTitle}>{T("wallet.send.to_peer_short")}</Text>
        <Text style={styles.modalSubtitle}>{T("wallet.send.mesh_note")}</Text>
        {onlinePeers.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>{T("wallet.send.no_peers")}</Text>
            <Text style={styles.emptyBody}>
              {T("wallet.send.no_peers_note")}
            </Text>
          </View>
        ) : (
          onlinePeers.map((peer) => {
            const username = peerIDToUsername(peer.peerID);
            return (
              <Pressable
                key={peer.peerID}
                style={styles.peerPickerRow}
                onPress={() => handleSendTokenToPeer(peer.peerID)}
                accessibilityRole="button"
                accessibilityLabel={T("wallet.send.send_to", {
                  name: username,
                })}
              >
                <Avatar username={username} peerID={peer.peerID} size={40} />
                <View style={styles.peerPickerInfo}>
                  <Text style={styles.peerPickerName}>{username}</Text>
                  <Text style={styles.peerPickerID}>
                    {peer.peerID.slice(0, 8)}
                  </Text>
                </View>
                <Feather name="send" size={16} color={Colors.textMuted} />
              </Pressable>
            );
          })
        )}
        <View style={styles.modalActions}>
          <Pressable
            style={styles.modalCancel}
            onPress={() => setShowPeerPicker(false)}
            accessibilityRole="button"
            accessibilityLabel={T("common.cancel")}
          >
            <Text style={styles.modalCancelText}>{T("common.cancel")}</Text>
          </Pressable>
        </View>
      </BottomSheet>
    </ScrollView>
  );
}

// ---- Small presentational pieces ----

type Styles = ReturnType<typeof createStyles>;
type FeatherName = React.ComponentProps<typeof Feather>["name"];

// The whole column, label included, is the target, not only the circle.
function ActionButton({
  styles,
  Colors,
  icon,
  label,
  a11yLabel,
  disabled = false,
  onPress,
}: {
  styles: Styles;
  Colors: ReturnType<typeof useThemeColors>;
  icon: FeatherName;
  label: string;
  a11yLabel: string;
  disabled?: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      style={[styles.actionBtn, disabled && styles.actionBtnDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={a11yLabel}
    >
      {({ pressed }) => (
        <>
          <View
            style={[styles.actionCircle, pressed && styles.actionCirclePressed]}
          >
            <Feather name={icon} size={20} color={Colors.textInverse} />
          </View>
          <Text style={styles.actionLabel} numberOfLines={2}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

// `cancelLabel` is overridable: mid-flow the secondary goes back, and "Cancel"
// there reads as discarding the step.
function SheetActions({
  styles,
  confirmLabel,
  confirmDisabled,
  onConfirm,
  onCancel,
  cancelLabel = t("common.cancel"),
}: {
  styles: Styles;
  confirmLabel: string;
  confirmDisabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  cancelLabel?: string;
}): React.JSX.Element {
  return (
    <View style={styles.modalActions}>
      <Pressable
        style={[
          styles.modalConfirm,
          confirmDisabled && styles.modalConfirmDisabled,
        ]}
        onPress={onConfirm}
        disabled={confirmDisabled}
        accessibilityRole="button"
        accessibilityLabel={confirmLabel}
      >
        <Text style={styles.modalConfirmText}>{confirmLabel}</Text>
      </Pressable>
      <Pressable
        style={styles.modalCancel}
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel={cancelLabel}
      >
        <Text style={styles.modalCancelText}>{cancelLabel}</Text>
      </Pressable>
    </View>
  );
}

// A single option renders as a line of text, not a one-row picker.
function MintPicker({
  styles,
  Colors,
  label,
  options,
  selected,
  onSelect,
}: {
  styles: Styles;
  Colors: ReturnType<typeof useThemeColors>;
  label: string;
  options: { mintUrl: string; sub: string }[];
  selected: string | null;
  onSelect: (mintUrl: string) => void;
}): React.JSX.Element | null {
  if (options.length === 0) return null;
  if (options.length === 1) {
    return (
      <Text style={styles.modalSubtitle}>
        {label} {hostOf(options[0].mintUrl)}
      </Text>
    );
  }
  return (
    <>
      <Text style={styles.modalSubtitle}>{label}</Text>
      {options.map((option) => {
        const active = option.mintUrl === selected;
        return (
          <Pressable
            key={option.mintUrl}
            style={[styles.pickRow, active && styles.pickRowSelected]}
            onPress={() => onSelect(option.mintUrl)}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`${label} ${hostOf(option.mintUrl)}`}
          >
            <Feather
              name={active ? "check-circle" : "circle"}
              size={18}
              color={active ? Colors.accent : Colors.textMuted}
            />
            <View style={styles.pickInfo}>
              <Text style={styles.pickTitle}>{hostOf(option.mintUrl)}</Text>
              <Text style={styles.pickSub}>{option.sub}</Text>
            </View>
          </Pressable>
        );
      })}
    </>
  );
}

function QuoteRow({
  styles,
  label,
  value,
}: {
  styles: Styles;
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <View style={styles.quoteRow}>
      <Text style={styles.quoteLabel}>{label}</Text>
      <Text style={styles.quoteValue}>{value}</Text>
    </View>
  );
}

// ---- Wallet handoff ----

// Try, do not ask: `canOpenURL` says "no" unless the scheme is declared in the
// Android `queries` and iOS LSApplicationQueriesSchemes, while `openURL` just
// rejects when nothing handles it. Share is only the fallback: it lists
// Messages and Drive, not wallets.
async function handOffToWallet(uri: string): Promise<void> {
  try {
    await Linking.openURL(uri);
  } catch {
    try {
      await Share.share({ message: uri });
    } catch {
      // Silent: the instrument is on screen with Copy beside it.
    }
  }
}

// For the Lightning wallet the user pays it FROM.
function openInvoiceInWallet(invoice: string): Promise<void> {
  return handOffToWallet(`lightning:${invoice}`);
}

// `cashu:` is NUT-00's scheme. Only the handoff wears it; Share passes the bare
// token, which every wallet reads. `bareToken` prevents `cashu:cashu:`.
function openTokenInWallet(token: string): Promise<void> {
  return handOffToWallet(`cashu:${bareToken(token) ?? token}`);
}

// ---- Transaction formatting ----

function isCredit(tx: WalletTx): boolean {
  return tx.kind === "receive" || tx.kind === "mint" || tx.kind === "nutzap-in";
}

// No money moved: a reclaim, an expired mint quote, a failed send. `isCredit`
// keys off `kind` alone, so these are checked first. A failed swap that
// removed already-spent proofs is a real reduction.
function isVoided(tx: WalletTx): boolean {
  if (tx.status === "reclaimed" || tx.status === "expired") return true;
  return tx.status === "failed" && tx.spentRemoved !== true;
}

// A swap trades coins at the same mint; signing it would read as a payment.
function isNeutral(tx: WalletTx): boolean {
  return tx.kind === "swap" && tx.status !== "failed";
}

function txIcon(tx: WalletTx): React.ComponentProps<typeof Feather>["name"] {
  switch (tx.kind) {
    case "receive":
      return "arrow-down-left";
    case "send":
      return "arrow-up-right";
    case "mint":
      return "download";
    case "melt":
      return "upload";
    case "nutzap-in":
    case "nutzap-out":
      return "zap";
    case "swap":
      return "refresh-cw";
  }
}

function txTitle(tx: WalletTx): string {
  switch (tx.kind) {
    case "receive":
      // Nothing arrived, so the failure goes in the title, not a note.
      if (tx.status === "failed") return t("wallet.activity.receive_failed");
      return tx.status === "pending"
        ? t("wallet.activity.received_unconfirmed")
        : t("wallet.activity.received");
    case "send":
      if (tx.status === "reclaimed") return t("wallet.activity.reclaimed");
      if (tx.status === "failed") return t("wallet.activity.send_failed");
      return t("wallet.activity.sent");
    case "mint":
      return t("wallet.activity.ln_deposit");
    case "melt":
      return t("wallet.activity.ln_withdrawal");
    case "nutzap-in":
      return t("wallet.activity.nutzap_received");
    case "nutzap-out":
      return t("wallet.zap.sent");
    case "swap":
      if (tx.spentRemoved === true) return t("wallet.activity.spent_removed");
      if (tx.status === "failed") return t("wallet.refresh.failed");
      // Persisted before the request, so visible in flight; past tense would
      // claim a reissue the mint has not confirmed.
      return tx.status === "pending"
        ? t("wallet.activity.refreshing")
        : t("wallet.activity.refreshed");
  }
}

// Undefined when the title already says it (no "Reclaimed · reclaimed").
// Catalog keys, never the raw enum value.
function txStatusNote(tx: WalletTx): string | undefined {
  if (tx.status === "completed") return undefined;
  if (
    tx.kind === "send" &&
    (tx.status === "reclaimed" || tx.status === "failed")
  )
    return undefined;
  switch (tx.status) {
    case "pending":
      return t("wallet.activity.status_pending");
    case "failed":
      return t("wallet.activity.status_failed");
    case "reclaimed":
      return t("wallet.activity.status_reclaimed");
    case "expired":
      return t("wallet.activity.status_expired");
  }
}

// Clamped at zero: a tick past the deadline before the expired branch renders
// must not flash "-1s".
function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

function createStyles(Colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: Colors.bg,
    },
    content: {
      padding: Spacing.base,
      gap: Spacing.base,
      paddingBottom: TAB_BAR_CLEARANCE,
    },
    section: {
      gap: Spacing.sm,
    },
    sectionTitle: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
      letterSpacing: 0.8,
      textTransform: "uppercase",
      paddingHorizontal: Spacing.xs,
    },
    banner: {
      flexDirection: "row",
      gap: Spacing.md,
      alignItems: "flex-start",
      borderRadius: Radius.lg,
      borderWidth: 1,
      padding: Spacing.base,
    },
    bannerDanger: {
      backgroundColor: Colors.dangerDim,
      borderColor: Colors.danger,
    },
    bannerWarn: {
      backgroundColor: Colors.surfaceRaised,
      borderColor: Colors.border,
    },
    bannerTor: {
      backgroundColor: Colors.torDim,
      borderColor: Colors.torDim,
    },
    bannerText: {
      flex: 1,
      fontSize: FontSize.sm,
      color: Colors.textSecondary,
      lineHeight: FontSize.sm * 1.5,
    },
    // The accent inverts with the theme, so text uses textInverse and dims by
    // opacity: the grey tokens are tuned for the page, not this fill.
    balanceCard: {
      backgroundColor: Colors.accent,
      borderRadius: Radius.xl,
      padding: Spacing.lg,
      gap: Spacing.sm,
      alignItems: "center",
    },
    balanceLabel: {
      fontSize: FontSize.xs,
      color: Colors.textInverse,
      opacity: SECONDARY_ON_ACCENT,
      letterSpacing: 0.8,
      textTransform: "uppercase",
    },
    balanceRow: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: Spacing.sm,
    },
    // Dims rather than darkens: the row sits on the accent fill.
    balanceRowPressed: {
      opacity: PRESSED_OPACITY,
    },
    balanceAmount: {
      fontSize: FontSize["3xl"],
      fontWeight: FontWeight.bold,
      color: Colors.textInverse,
      lineHeight: FontSize["3xl"] * 1.1,
    },
    balanceUnit: {
      fontSize: FontSize.lg,
      color: Colors.textInverse,
      opacity: SECONDARY_ON_ACCENT,
      fontWeight: FontWeight.medium,
      marginBottom: Spacing.xs,
    },
    balanceNote: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      opacity: SECONDARY_ON_ACCENT,
    },
    balanceNoteText: {
      fontSize: FontSize.sm,
      color: Colors.textInverse,
      flexShrink: 1,
      textAlign: "center",
    },
    // Inside the balance card, so it stretches past the card's centring.
    actionRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignSelf: "stretch",
      marginTop: Spacing.base,
    },
    actionBtn: {
      flex: 1,
      alignItems: "center",
      gap: Spacing.xs,
      paddingVertical: Spacing.xs,
    },
    actionBtnDisabled: {
      opacity: DISABLED_OPACITY,
    },
    actionCircle: {
      width: ACTION_CIRCLE,
      height: ACTION_CIRCLE,
      borderRadius: Radius.full,
      backgroundColor: Colors.onAccentFill,
      alignItems: "center",
      justifyContent: "center",
    },
    actionCirclePressed: {
      backgroundColor: Colors.onAccentPressed,
    },
    // Allowed two lines: a quarter row is narrow for "Монетные дворы".
    actionLabel: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.medium,
      color: Colors.textInverse,
      textAlign: "center",
    },
    pendingCard: {
      backgroundColor: Colors.surface,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: Colors.borderStrong,
      padding: Spacing.base,
      gap: Spacing.sm,
    },
    pendingHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    pendingAmount: {
      flex: 1,
      fontSize: FontSize.base,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
      fontFamily: FontFamily.mono,
    },
    pendingTime: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
    },
    pendingBody: {
      fontSize: FontSize.sm,
      color: Colors.textMuted,
      lineHeight: FontSize.sm * 1.5,
    },
    pendingActions: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: Spacing.sm,
    },
    // MIN_TOUCH even in a tight row, since one of these moves money. The row
    // wraps, so the height costs only a wrap on a narrow screen.
    pendingBtn: {
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      minHeight: MIN_TOUCH,
      justifyContent: "center",
      borderRadius: Radius.full,
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    pendingBtnText: {
      fontSize: FontSize.sm,
      color: Colors.textSecondary,
      fontWeight: FontWeight.medium,
    },
    pendingBtnDanger: {
      backgroundColor: Colors.dangerDim,
      borderColor: Colors.danger,
    },
    pendingBtnDangerText: {
      fontSize: FontSize.sm,
      color: Colors.danger,
      fontWeight: FontWeight.medium,
    },
    emptyCard: {
      backgroundColor: Colors.surface,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: Colors.border,
      padding: Spacing.xl,
      alignItems: "center",
      gap: Spacing.sm,
    },
    emptyTitle: {
      fontSize: FontSize.base,
      color: Colors.textSecondary,
      fontWeight: FontWeight.medium,
    },
    emptyBody: {
      fontSize: FontSize.sm,
      color: Colors.textMuted,
      textAlign: "center",
      lineHeight: FontSize.sm * 1.6,
    },
    npubRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.base,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.lg,
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    npubText: {
      flex: 1,
      gap: 1,
    },
    npubLabel: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
    },
    npubValue: {
      fontSize: FontSize.xs,
      color: Colors.textSecondary,
      fontFamily: FontFamily.mono,
    },
    zapContacts: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: Spacing.xs,
    },
    zapContactChip: {
      paddingHorizontal: Spacing.sm,
      paddingVertical: 4,
      borderRadius: Radius.full,
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    zapContactChipOn: {
      borderColor: Colors.accent,
    },
    zapContactText: {
      fontSize: FontSize.xs,
      color: Colors.textSecondary,
    },
    zapContactTextOn: {
      color: Colors.accent,
      fontWeight: FontWeight.semibold,
    },
    mintNameRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
    },
    testBadge: {
      paddingHorizontal: 5,
      paddingVertical: 1,
      borderRadius: Radius.sm,
      borderWidth: 1,
      borderColor: Colors.borderStrong,
    },
    testBadgeText: {
      fontSize: FontSize["2xs"],
      fontWeight: FontWeight.semibold,
      color: Colors.textMuted,
      letterSpacing: 0.5,
    },
    mintBalance: {
      fontSize: FontSize.md,
      fontWeight: FontWeight.bold,
      color: Colors.textPrimary,
      fontFamily: FontFamily.mono,
    },
    mintUnit: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
    },
    smallBtnDisabled: {
      opacity: DISABLED_OPACITY,
    },
    backupRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      paddingHorizontal: Spacing.base,
      paddingVertical: Spacing.md,
      minHeight: MIN_TOUCH,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: Colors.border,
      backgroundColor: Colors.surface,
    },
    backupRowPressed: {
      backgroundColor: Colors.surfacePressed,
    },
    backupRowText: {
      flex: 1,
    },
    backupRowTitle: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.medium,
      color: Colors.textPrimary,
    },
    backupRowStatus: {
      fontSize: FontSize.sm,
      color: Colors.textMuted,
    },
    backupHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    backupTitle: {
      flex: 1,
      fontSize: FontSize.base,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
    },
    pill: {
      paddingHorizontal: Spacing.sm,
      paddingVertical: 2,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: Colors.border,
      backgroundColor: Colors.surfaceRaised,
    },
    pillOn: {
      borderColor: Colors.verified,
    },
    pillWarn: {
      borderColor: Colors.danger,
      backgroundColor: Colors.dangerDim,
    },
    pillText: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
      fontWeight: FontWeight.semibold,
    },
    pillTextOn: {
      color: Colors.verified,
    },
    pillTextWarn: {
      color: Colors.danger,
    },
    backupBody: {
      fontSize: FontSize.sm,
      color: Colors.textMuted,
      lineHeight: FontSize.sm * 1.5,
    },
    backupWarnRow: {
      flexDirection: "row",
      gap: Spacing.sm,
      alignItems: "flex-start",
      backgroundColor: Colors.surfaceRaised,
      borderRadius: Radius.lg,
      padding: Spacing.md,
    },
    backupWarnText: {
      flex: 1,
      fontSize: FontSize.sm,
      color: Colors.textSecondary,
      lineHeight: FontSize.sm * 1.5,
    },
    backupActions: {
      flexDirection: "row",
      gap: Spacing.sm,
    },
    backupBtn: {
      flex: 1,
      minHeight: MIN_TOUCH,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      borderRadius: Radius.full,
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    backupBtnText: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.semibold,
      color: Colors.accent,
    },
    bulletRow: {
      flexDirection: "row",
      gap: Spacing.md,
      alignItems: "flex-start",
    },
    bulletDot: {
      width: 5,
      height: 5,
      borderRadius: Radius.full,
      backgroundColor: Colors.textMuted,
      marginTop: 7,
      flexShrink: 0,
    },
    bulletText: {
      flex: 1,
      fontSize: FontSize.sm,
      color: Colors.textSecondary,
      lineHeight: FontSize.sm * 1.5,
    },
    phraseGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: Spacing.sm,
    },
    phraseCell: {
      width: "47%",
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: Colors.border,
      backgroundColor: Colors.surfaceRaised,
    },
    phraseIndex: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
      fontFamily: FontFamily.mono,
      minWidth: 16,
      textAlign: textAlignEnd,
    },
    phraseWord: {
      flex: 1,
      fontSize: FontSize.sm,
      color: Colors.textPrimary,
      fontFamily: FontFamily.mono,
      fontWeight: FontWeight.medium,
    },
    verifyRow: {
      gap: Spacing.xs,
    },
    verifyLabel: {
      fontSize: FontSize.sm,
      color: Colors.textSecondary,
      fontWeight: FontWeight.medium,
    },
    verifyError: {
      fontSize: FontSize.sm,
      color: Colors.danger,
    },
    pickRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      paddingHorizontal: Spacing.base,
      paddingVertical: Spacing.md,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: Colors.border,
      backgroundColor: Colors.surfaceRaised,
    },
    pickRowSelected: {
      borderColor: Colors.accent,
    },
    pickInfo: {
      flex: 1,
      gap: 2,
    },
    pickTitle: {
      fontSize: FontSize.base,
      color: Colors.textPrimary,
      fontWeight: FontWeight.medium,
      fontFamily: FontFamily.mono,
    },
    pickSub: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
    },
    historyCard: {
      backgroundColor: Colors.surface,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: Colors.border,
      paddingHorizontal: Spacing.base,
    },
    historyRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      paddingVertical: Spacing.md,
    },
    historyIcon: {
      flexShrink: 0,
    },
    historyText: {
      flex: 1,
      gap: 2,
    },
    historyTitle: {
      fontSize: FontSize.sm,
      color: Colors.textPrimary,
      fontWeight: FontWeight.medium,
    },
    historySub: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
    },
    historyError: {
      fontSize: FontSize.xs,
      color: Colors.danger,
      marginTop: Spacing.xs,
    },
    historyAmount: {
      fontSize: FontSize.sm,
      color: Colors.textSecondary,
      fontFamily: FontFamily.mono,
      fontWeight: FontWeight.semibold,
    },
    historyCredit: {
      color: Colors.online,
    },
    historyDebit: {
      color: Colors.danger,
    },
    historyVoid: {
      color: Colors.textMuted,
      textDecorationLine: "line-through",
    },
    historyNeutral: {
      color: Colors.textMuted,
    },
    historyDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: Colors.border,
    },
    historyMoreRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      paddingVertical: Spacing.md,
    },
    historyMoreText: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.medium,
      color: Colors.textMuted,
    },
    infoPanel: {
      backgroundColor: Colors.surface,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: Colors.border,
      padding: Spacing.base,
      gap: Spacing.md,
    },
    infoPanelRow: {
      flexDirection: "row",
      gap: Spacing.md,
      alignItems: "flex-start",
      paddingVertical: Spacing.xs,
    },
    infoPanelIcon: {
      marginTop: 2,
      flexShrink: 0,
    },
    infoPanelText: {
      flex: 1,
      gap: 3,
    },
    infoPanelTitle: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
    },
    infoPanelBody: {
      fontSize: FontSize.sm,
      color: Colors.textMuted,
      lineHeight: FontSize.sm * 1.5,
    },
    infoPanelDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: Colors.border,
    },
    modalSheet: {
      paddingHorizontal: Spacing.xl,
      paddingBottom: Spacing.xl,
      gap: Spacing.md,
    },
    // The Mints, backup and help sheets can outgrow the screen.
    scrollSheet: {
      maxHeight: "80%",
    },
    sheetList: {
      gap: Spacing.sm,
    },
    sheetHeader: {
      flexDirection: "row",
      alignItems: "baseline",
      justifyContent: "space-between",
    },
    sheetHeaderNote: {
      fontSize: FontSize.sm,
      color: Colors.textMuted,
    },
    listGroup: {
      backgroundColor: Colors.surfaceRaised,
      borderRadius: Radius.lg,
      overflow: "hidden",
    },
    listDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: Colors.border,
      marginStart: Spacing.base + LIST_ICON + Spacing.md,
    },
    listRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      padding: Spacing.base,
    },
    listRowPressed: {
      backgroundColor: Colors.surfacePressed,
    },
    listIcon: {
      width: LIST_ICON,
      height: LIST_ICON,
      borderRadius: Radius.full,
      backgroundColor: Colors.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    listText: {
      flex: 1,
    },
    listTitle: {
      flexShrink: 1,
      fontSize: FontSize.base,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
    },
    listMeta: {
      fontSize: FontSize.sm,
      color: Colors.textSecondary,
    },
    listAmount: {
      alignItems: "flex-end",
    },
    pillWithIcon: {
      flexDirection: "row",
      gap: Spacing.sm,
    },
    // The collapsed Activity height, so the first payment causes no jump.
    activityEmpty: {
      minHeight: ACTIVITY_COLLAPSED_COUNT * ACTIVITY_ROW_HEIGHT,
      justifyContent: "center",
    },
    modalTitle: {
      fontSize: FontSize.md,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
    },
    modalSubtitle: {
      fontSize: FontSize.sm,
      color: Colors.textMuted,
      lineHeight: FontSize.sm * 1.5,
    },
    tokenInput: {
      backgroundColor: Colors.surfaceRaised,
      borderRadius: Radius.xl,
      borderWidth: 1,
      borderColor: Colors.border,
      paddingHorizontal: Spacing.base,
      paddingVertical: Spacing.md,
      color: Colors.textPrimary,
      fontSize: FontSize.sm,
      fontFamily: FontFamily.mono,
      minHeight: 80,
      textAlignVertical: "top",
    },
    tokenInputCompact: {
      minHeight: 0,
      fontFamily: undefined,
    },
    tokenInputMono: {
      fontFamily: FontFamily.mono,
      fontSize: FontSize.xs,
      letterSpacing: 0.3,
    },
    // Text, not a disabled TextInput: on Android a multiline TextInput with
    // `numberOfLines` scrolls to the cursor at the end, hiding the
    // `lnbc`/`cashuB` head behind half-clipped glyphs.
    readonlyValueBox: {
      backgroundColor: Colors.surfaceRaised,
      borderRadius: Radius.xl,
      borderWidth: 1,
      borderColor: Colors.border,
      paddingHorizontal: Spacing.base,
      paddingVertical: Spacing.md,
      minHeight: 80,
    },
    readonlyValue: {
      color: Colors.textSecondary,
      fontSize: FontSize.xs,
      fontFamily: FontFamily.mono,
      letterSpacing: 0.3,
      lineHeight: 16,
    },
    modalActions: {
      width: "100%",
      marginTop: Spacing.xs,
      gap: Spacing.sm,
    },
    modalCancel: {
      width: "100%",
      minHeight: BUTTON_HEIGHT,
      paddingVertical: Spacing.md,
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 1,
      borderColor: Colors.border,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
    },
    modalCancelText: {
      fontSize: FontSize.base,
      color: Colors.textPrimary,
      fontWeight: FontWeight.semibold,
    },
    modalDismiss: {
      width: "100%",
      minHeight: BUTTON_HEIGHT,
      paddingVertical: Spacing.md,
      borderRadius: Radius.full,
      backgroundColor: Colors.surfaceRaised,
      alignItems: "center",
      justifyContent: "center",
    },
    modalDismissText: {
      fontSize: FontSize.base,
      color: Colors.textSecondary,
      fontWeight: FontWeight.semibold,
    },
    modalConfirm: {
      width: "100%",
      minHeight: BUTTON_HEIGHT,
      paddingVertical: Spacing.md,
      backgroundColor: Colors.accent,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
    },
    modalConfirmDisabled: {
      opacity: DISABLED_OPACITY,
    },
    modalConfirmText: {
      fontSize: FontSize.base,
      color: Colors.textInverse,
      fontWeight: FontWeight.bold,
    },
    qrFrame: {
      alignSelf: "center",
      padding: Spacing.base,
      borderRadius: Radius.lg,
      backgroundColor: "#FFFFFF",
    },
    quoteBox: {
      backgroundColor: Colors.surfaceRaised,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: Colors.border,
      padding: Spacing.base,
      gap: Spacing.xs,
    },
    quoteRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    quoteLabel: {
      fontSize: FontSize.sm,
      color: Colors.textMuted,
    },
    quoteValue: {
      fontSize: FontSize.sm,
      color: Colors.textPrimary,
      fontFamily: FontFamily.mono,
    },
    waitingRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      paddingVertical: Spacing.sm,
    },
    waitingText: {
      fontSize: FontSize.sm,
      color: Colors.textMuted,
    },
    generatedHeader: {
      alignItems: "center",
      gap: Spacing.xs,
      paddingBottom: Spacing.sm,
    },
    generatedAmountRow: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: Spacing.sm,
    },
    generatedAmount: {
      fontSize: FontSize["2xl"],
      fontWeight: FontWeight.bold,
      color: Colors.textPrimary,
    },
    generatedUnit: {
      fontSize: FontSize.base,
      color: Colors.textMuted,
      fontWeight: FontWeight.medium,
      marginBottom: 3,
    },
    generatedMint: {
      fontSize: FontSize.sm,
      color: Colors.textMuted,
      textAlign: "center",
    },
    generatedHint: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
      textAlign: "center",
      lineHeight: FontSize.xs * 1.6,
      paddingHorizontal: Spacing.sm,
    },
    generatedActions: {
      width: "100%",
      gap: Spacing.sm,
    },
    generatedActionBtn: {
      width: "100%",
      minHeight: BUTTON_HEIGHT,
      paddingVertical: Spacing.md,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      borderRadius: Radius.full,
      backgroundColor: Colors.surfaceRaised,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    generatedActionBtnPressed: {
      backgroundColor: Colors.surfacePressed,
    },
    generatedActionText: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.semibold,
      color: Colors.accent,
    },
    generatedPrimaryBtn: {
      width: "100%",
      minHeight: BUTTON_HEIGHT,
      paddingVertical: Spacing.md,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      borderRadius: Radius.full,
      backgroundColor: Colors.accent,
    },
    generatedPrimaryText: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.bold,
      color: Colors.textInverse,
    },
    peerPickerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      paddingVertical: Spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: Colors.border,
    },
    peerPickerInfo: {
      flex: 1,
      gap: 2,
    },
    peerPickerName: {
      fontSize: FontSize.base,
      fontWeight: FontWeight.semibold,
      color: Colors.textPrimary,
    },
    peerPickerID: {
      fontSize: FontSize.xs,
      color: Colors.textMuted,
      fontFamily: FontFamily.mono,
    },
  });
}
