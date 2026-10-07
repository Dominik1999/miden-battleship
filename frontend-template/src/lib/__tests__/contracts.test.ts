import { describe, it, expect } from "vitest";
import { substituteWord } from "@/lib/masmSources";
import { scriptRootFelts } from "@/lib/contracts";

describe("MASM templates", () => {
  it("substitutes the four placeholders of a word", () => {
    const src = "push.{{ISC3}}.{{ISC2}}.{{ISC1}}.{{ISC0}} # {{ISC0}}";
    expect(substituteWord(src, "ISC", [1n, 2n, 3n, 4n])).toBe("push.4.3.2.1 # 1");
  });

  it("flattens script roots in script_roots order", () => {
    expect(scriptRootFelts({ shot: [1n, 1n, 1n, 1n], result: [2n, 2n, 2n, 2n], defeat: [3n, 3n, 3n, 3n], forfeit: [4n, 4n, 4n, 4n] })).toEqual([
      1n, 1n, 1n, 1n, 2n, 2n, 2n, 2n, 3n, 3n, 3n, 3n, 4n, 4n, 4n, 4n,
    ]);
  });
});
