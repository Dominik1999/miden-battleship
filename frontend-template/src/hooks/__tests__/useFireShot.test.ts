import { renderHook, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@miden-sdk/react", () => import("@/__tests__/mocks/miden-sdk-react"));
vi.mock("@miden-sdk/miden-sdk", () => import("@/__tests__/mocks/miden-sdk"));
const publishShot = vi.fn(async () => ({ noteId: "0xshot", resultSerial: [] }));
vi.mock("@/lib/game", () => ({ publishShot: (...args: unknown[]) => publishShot(...(args as [])) }));

import { useFireShot } from "../useFireShot";

describe("useFireShot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns initial state", () => {
    const { result } = renderHook(() => useFireShot("mtst1me", "mtst1defender"));
    expect(result.current.isSubmitting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("publishes the shot from my account to the defender", async () => {
    const { result } = renderHook(() => useFireShot("mtst1me", "mtst1defender"));
    let ok = false;
    await act(async () => {
      ok = await result.current.fireShot(2, 7, 3);
    });
    expect(ok).toBe(true);
    expect(publishShot).toHaveBeenCalledWith(expect.anything(), "mtst1me", "mtst1defender", 2, 7, 3);
    expect(result.current.error).toBeNull();
    expect(result.current.isSubmitting).toBe(false);
  });

  it("surfaces a failure and resets isSubmitting", async () => {
    publishShot.mockRejectedValueOnce(new Error("prover down"));
    const { result } = renderHook(() => useFireShot("mtst1me", "mtst1defender"));
    let ok = true;
    await act(async () => {
      ok = await result.current.fireShot(0, 0, 1);
    });
    expect(ok).toBe(false);
    expect(result.current.error).toBe("prover down");
    expect(result.current.isSubmitting).toBe(false);
  });
});
