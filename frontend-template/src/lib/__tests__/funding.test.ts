import { describe, it, expect, vi } from "vitest";
import { claimFaucetTokens, FaucetError, formatFeeBalance, requestFaucetTokens, shouldTopUp, solvePow } from "@/lib/funding";

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

describe("faucet proof of work", () => {
  it("finds a nonce whose digest prefix is below the target", async () => {
    const nonce = await solvePow("00ff", 1n << 60n, { startNonce: 0n });
    expect(typeof nonce).toBe("bigint");
  });

  it("rejects an invalid challenge", async () => {
    await expect(solvePow("zz", 1n << 63n)).rejects.toBeInstanceOf(FaucetError);
  });
});

describe("requestFaucetTokens", () => {
  it("calls /pow then /get_tokens with the same amount and returns the note id", async () => {
    const noteId = "0x" + "ab".repeat(32);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/pow?")) return jsonResponse(200, { challenge: "00ff", target: (1n << 63n).toString() });
      expect(url).toContain("asset_amount=10000");
      expect(url).toContain("account_id=mtst1abc");
      return jsonResponse(200, { note_id: noteId });
    });
    await expect(requestFaucetTokens("https://faucet", "mtst1abc", 10_000n, fetchImpl)).resolves.toBe(noteId);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails on a malformed note id", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/pow?") ? jsonResponse(200, { challenge: "00ff", target: (1n << 63n).toString() }) : jsonResponse(200, { note_id: "nope" }),
    );
    await expect(requestFaucetTokens("https://faucet", "mtst1abc", 1n, fetchImpl)).rejects.toThrow(/valid funding note/);
  });
});

describe("claimFaucetTokens", () => {
  it("retries on 429 using Retry-After and succeeds", async () => {
    const noteId = "0x" + "cd".repeat(32);
    let powCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/pow?")) {
        powCalls++;
        return powCalls === 1 ? jsonResponse(429, "slow down", { "retry-after": "1" }) : jsonResponse(200, { challenge: "00ff", target: (1n << 63n).toString() });
      }
      return jsonResponse(200, { note_id: noteId });
    });
    const sleep = vi.fn(async () => {});
    const statuses: string[] = [];
    await expect(claimFaucetTokens("https://faucet", "mtst1abc", 1n, { fetchImpl, sleep, onStatus: (s) => statuses.push(s) })).resolves.toBe(noteId);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(statuses.some((s) => /retry/i.test(s))).toBe(true);
  });

  it("does not retry a 400 (bad address or amount over the cap)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, "amount too large"));
    await expect(claimFaucetTokens("https://faucet", "mtst1abc", 1n, { fetchImpl, sleep: async () => {} })).rejects.toThrow(/400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("top-up policy", () => {
  const base = { threshold: 3_000n, pendingClaim: false, lastClaimAt: null, now: 100_000, cooldownMs: 35_000 };
  it("claims only when the balance is known, low, no claim pending and the cooldown passed", () => {
    expect(shouldTopUp({ ...base, balance: 1_000n })).toBe(true);
    expect(shouldTopUp({ ...base, balance: null })).toBe(false);
    expect(shouldTopUp({ ...base, balance: 5_000n })).toBe(false);
    expect(shouldTopUp({ ...base, balance: 1_000n, pendingClaim: true })).toBe(false);
    expect(shouldTopUp({ ...base, balance: 1_000n, lastClaimAt: 90_000 })).toBe(false);
    expect(shouldTopUp({ ...base, balance: 1_000n, lastClaimAt: 10_000 })).toBe(true);
  });

  it("formats base units with 6 decimals", () => {
    expect(formatFeeBalance(10_000n)).toBe("0.010000 USDCx");
    expect(formatFeeBalance(1_234_567n)).toBe("1.234567 USDCx");
    expect(formatFeeBalance(null)).toBe("… USDCx");
  });
});
