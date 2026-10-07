import { Felt, Word } from "@miden-sdk/miden-sdk";

/** Generate 4 random felts (each < 2^32). */
export function randomFelts(): Felt[] {
  return Array.from({ length: 4 }, () =>
    new Felt(BigInt(Math.floor(Math.random() * 2 ** 32))),
  );
}

/** Generate a random 4-felt Word (used as note serial number / game id / commitment). */
export function randomWord(): Word {
  return Word.newFromFelts(randomFelts());
}
