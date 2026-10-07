import {
  FAUCET_MAX_RETRIES,
  FAUCET_RETRY_DELAY_MS,
  FEE_ASSET_DECIMALS,
  FEE_ASSET_SYMBOL,
} from "@/config";

const log = (msg: string, ...args: unknown[]) =>
  console.log(`%c[Funding] ${msg}`, "color: #fc0; font-weight: bold", ...args);

/** Error from the public faucet HTTP API. `retryAfterMs` is set on 429 (per-account cooldown). */
export class FaucetError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "FaucetError";
  }

  /** 429 (cooldown), 5xx (faucet/funding service flaky) and network errors are worth retrying. */
  get retryable(): boolean {
    return this.status === undefined || this.status === 429 || this.status >= 500;
  }
}

export interface PowChallenge {
  challenge: string;
  target: string | number | bigint;
  timestamp?: number;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.replace(/^0x/, "");
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(clean)) throw new FaucetError("Invalid faucet challenge.");
  return Uint8Array.from(clean.match(/../g)!, (byte) => parseInt(byte, 16));
};

/**
 * Solve the faucet proof of work: find a u64 `nonce` such that the first 8 bytes
 * (big-endian) of SHA-256(challenge || nonce_be) are below `target`.
 */
export async function solvePow(
  challengeHex: string,
  target: bigint,
  opts: { deadlineMs?: number; startNonce?: bigint } = {},
): Promise<bigint> {
  if (target <= 0n || target > 1n << 64n) throw new FaucetError("Invalid faucet PoW target.");
  const challenge = hexToBytes(challengeHex);
  const input = new Uint8Array(challenge.length + 8);
  input.set(challenge);
  const view = new DataView(input.buffer);
  let nonce =
    opts.startNonce ??
    new DataView(crypto.getRandomValues(new Uint8Array(8)).buffer).getBigUint64(0);
  const deadline = Date.now() + (opts.deadlineMs ?? 90_000);
  for (;;) {
    view.setBigUint64(challenge.length, nonce);
    const digest = new DataView(await crypto.subtle.digest("SHA-256", input));
    if (digest.getBigUint64(0) < target) return nonce;
    if (Date.now() >= deadline) throw new FaucetError("Faucet proof of work timed out. Try again.");
    nonce = BigInt.asUintN(64, nonce + 1n);
  }
}

async function faucetGet(
  fetchImpl: FetchLike,
  baseUrl: string,
  path: string,
  params?: URLSearchParams,
): Promise<unknown> {
  const url = `${baseUrl.replace(/\/$/, "")}/${path}${params ? `?${params}` : ""}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), cache: "no-store" });
  } catch (err) {
    throw new FaucetError(`Faucet ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const retryAfter = Number(response.headers?.get?.("retry-after") ?? NaN);
    throw new FaucetError(
      `Faucet ${path}: HTTP ${response.status} ${body}`.trim(),
      response.status,
      Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
    );
  }
  return response.json();
}

/**
 * Request a public P2ID funding note of `amount` base units of the fee asset for
 * `accountAddress` (bech32 or 0x-hex) from the faucet HTTP API. The recipient
 * does not need to exist on-chain yet. Returns the note id; the recipient must
 * still consume the note.
 *
 * Flow: GET /pow → solve SHA-256 PoW → GET /get_tokens. `amount` must be the
 * same on both calls (the server re-derives the PoW difficulty from it).
 */
export async function requestFaucetTokens(
  baseUrl: string,
  accountAddress: string,
  amount: bigint,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const amountStr = amount.toString();
  const pow = (await faucetGet(
    fetchImpl,
    baseUrl,
    "pow",
    new URLSearchParams({ account_id: accountAddress, amount: amountStr }),
  )) as PowChallenge;
  const nonce = await solvePow(String(pow.challenge), BigInt(pow.target));
  const result = (await faucetGet(
    fetchImpl,
    baseUrl,
    "get_tokens",
    new URLSearchParams({
      account_id: accountAddress,
      asset_amount: amountStr,
      challenge: String(pow.challenge),
      nonce: nonce.toString(),
    }),
  )) as { note_id?: unknown };
  if (typeof result.note_id !== "string" || !/^0x[0-9a-f]{64}$/i.test(result.note_id)) {
    throw new FaucetError("Faucet did not return a valid funding note ID.");
  }
  return result.note_id;
}

export interface ClaimOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  onStatus?: (status: string) => void;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: FetchLike;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `requestFaucetTokens` with backoff: retries network errors, 5xx (the testnet
 * faucet is sometimes flaky) and 429 (waits `Retry-After`). 4xx other than 429
 * (bad address, amount over the cap) fail immediately.
 */
export async function claimFaucetTokens(
  baseUrl: string,
  accountAddress: string,
  amount: bigint,
  opts: ClaimOptions = {},
): Promise<string> {
  const maxRetries = opts.maxRetries ?? FAUCET_MAX_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? FAUCET_RETRY_DELAY_MS;
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      opts.onStatus?.(
        attempt === 1 ? "Requesting fee tokens from faucet..." : `Retrying faucet (${attempt}/${maxRetries})...`,
      );
      const noteId = await requestFaucetTokens(baseUrl, accountAddress, amount, opts.fetchImpl);
      log(`Faucet note ${noteId} requested for ${accountAddress}`);
      return noteId;
    } catch (err) {
      lastError = err;
      const faucetErr = err instanceof FaucetError ? err : null;
      if (faucetErr && !faucetErr.retryable) throw err;
      if (attempt === maxRetries) break;
      const delay = faucetErr?.retryAfterMs ?? retryDelayMs * attempt;
      log(`Faucet attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)} — retrying in ${delay}ms`);
      opts.onStatus?.(`Faucet busy, retrying in ${Math.ceil(delay / 1000)}s...`);
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new FaucetError(String(lastError));
}

export interface TopUpInput {
  /** Current fee-asset balance of the game account (null = unknown yet). */
  balance: bigint | null;
  threshold: bigint;
  /** A claimed funding note that has not been consumed yet. */
  pendingClaim: boolean;
  lastClaimAt: number | null;
  now: number;
  cooldownMs: number;
}

/** Decide whether to request another faucet claim for the game account. */
export function shouldTopUp(input: TopUpInput): boolean {
  if (input.balance === null) return false;
  if (input.balance >= input.threshold) return false;
  if (input.pendingClaim) return false;
  if (input.lastClaimAt !== null && input.now - input.lastClaimAt < input.cooldownMs) return false;
  return true;
}

/** Format a base-unit amount of the fee asset, e.g. 10000n → "0.010000 USDCx". */
export function formatFeeBalance(
  amount: bigint | null | undefined,
  decimals = FEE_ASSET_DECIMALS,
  symbol = FEE_ASSET_SYMBOL,
): string {
  if (amount === null || amount === undefined) return `… ${symbol}`;
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = (amount % base).toString().padStart(decimals, "0");
  return `${whole}.${frac} ${symbol}`;
}

/** Minimal note shape used to recognise a fee-asset P2ID funding note. */
export interface FundingNoteLike {
  script(): { root(): { toHex(): string } };
  assets(): { fungibleAssets(): { faucetId(): { toString(): string }; amount(): bigint }[] };
}

/** True when `note` is a P2ID note carrying a positive amount of the fee asset. */
export function isFeeFundingNote(
  note: FundingNoteLike,
  feeFaucetHex: string,
  p2idRootHex: string,
): boolean {
  try {
    if (note.script().root().toHex().toLowerCase() !== p2idRootHex.toLowerCase()) return false;
    return note
      .assets()
      .fungibleAssets()
      .some((asset) => asset.faucetId().toString().toLowerCase() === feeFaucetHex.toLowerCase() && asset.amount() > 0n);
  } catch {
    return false;
  }
}
