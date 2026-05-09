# Packed Board Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the StorageMap-based board (17 individual SMT writes, 720K cycles) with 10 StorageValue rows using bit-packed cells, reducing setup to ~50-80K cycles and proving time from 32s to <5s.

**Architecture:** Each board row is stored as a single StorageValue Word. Each cell (3 bits, values 0-7) is packed into Felt[0] of the Word. The setup-note passes 10 pre-packed row values instead of 51 ship coordinate Felts. The contract validates ship counts by iterating the packed data in-memory rather than reading 17+ StorageMap entries.

**Tech Stack:** Miden Rust SDK (`miden::*`), `cargo miden build`, MockChain integration tests, React/TypeScript frontend with `@miden-sdk/react`.

---

### Task 1: Update battleship-account contract — storage layout and helpers

**Files:**
- Modify: `project-template/contracts/battleship-account/src/lib.rs`

- [ ] **Step 1: Write the new storage layout**

Replace the `my_board: StorageMap<Word, Felt>` with 10 StorageValue slots. Update the `#[component]` struct:

```rust
#[component]
struct BattleshipAccount {
    /// [grid_size, num_placed, phase, expected_turn]
    #[storage(description = "game config")]
    game_config: StorageValue<Word>,

    /// [opponent_prefix, opponent_suffix, ships_hit_count, total_shots_received]
    #[storage(description = "opponent info")]
    opponent: StorageValue<Word>,

    /// [h0, h1, h2, h3] salted hash of ship placement
    #[storage(description = "board commitment")]
    board_commitment: StorageValue<Word>,

    /// [h0, h1, h2, h3] opponent's salted board commitment
    #[storage(description = "opponent board commitment")]
    opponent_commitment: StorageValue<Word>,

    /// [gid0, gid1, gid2, gid3]
    #[storage(description = "game id")]
    game_id: StorageValue<Word>,

    /// [my_revealed, opponent_verified, 0, 0]
    #[storage(description = "reveal status")]
    reveal_status: StorageValue<Word>,

    /// Board rows 0-9: each Felt[0] packs 10 cells at 3 bits each (bits 0-29)
    /// Cell values: 0=water, 1-5=ship_id, 6=hit, 7=miss
    #[storage(description = "board row 0")]
    board_row_0: StorageValue<Word>,
    #[storage(description = "board row 1")]
    board_row_1: StorageValue<Word>,
    #[storage(description = "board row 2")]
    board_row_2: StorageValue<Word>,
    #[storage(description = "board row 3")]
    board_row_3: StorageValue<Word>,
    #[storage(description = "board row 4")]
    board_row_4: StorageValue<Word>,
    #[storage(description = "board row 5")]
    board_row_5: StorageValue<Word>,
    #[storage(description = "board row 6")]
    board_row_6: StorageValue<Word>,
    #[storage(description = "board row 7")]
    board_row_7: StorageValue<Word>,
    #[storage(description = "board row 8")]
    board_row_8: StorageValue<Word>,
    #[storage(description = "board row 9")]
    board_row_9: StorageValue<Word>,
}
```

- [ ] **Step 2: Add bit-packing helper functions**

Add these helper functions above the `impl BattleshipAccount`:

```rust
/// Extract a 3-bit cell value from a packed row.
/// packed: the Felt[0] value containing 10 cells at 3 bits each.
/// col: column index 0-9.
fn get_cell_from_packed(packed: u64, col: u64) -> u64 {
    (packed >> (col * 3)) & 0x7
}

/// Set a 3-bit cell value in a packed row. Returns the new packed value.
fn set_cell_in_packed(packed: u64, col: u64, value: u64) -> u64 {
    let shift = col * 3;
    let mask = !(0x7u64 << shift);
    (packed & mask) | (value << shift)
}
```

- [ ] **Step 3: Add row read/write dispatch helpers**

Since Miden contracts can't dynamically index storage slots, add dispatch methods:

```rust
#[component]
impl BattleshipAccount {
    /// Read a board row by index (0-9). Returns the packed Word.
    fn get_board_row(&self, row: u64) -> Word {
        match row {
            0 => self.board_row_0.get(),
            1 => self.board_row_1.get(),
            2 => self.board_row_2.get(),
            3 => self.board_row_3.get(),
            4 => self.board_row_4.get(),
            5 => self.board_row_5.get(),
            6 => self.board_row_6.get(),
            7 => self.board_row_7.get(),
            8 => self.board_row_8.get(),
            9 => self.board_row_9.get(),
            _ => panic!("row out of bounds"),
        }
    }

    /// Write a board row by index (0-9).
    fn set_board_row(&mut self, row: u64, value: Word) {
        match row {
            0 => self.board_row_0.set(value),
            1 => self.board_row_1.set(value),
            2 => self.board_row_2.set(value),
            3 => self.board_row_3.set(value),
            4 => self.board_row_4.set(value),
            5 => self.board_row_5.set(value),
            6 => self.board_row_6.set(value),
            7 => self.board_row_7.set(value),
            8 => self.board_row_8.set(value),
            9 => self.board_row_9.set(value),
            _ => panic!("row out of bounds"),
        }
    }
}
```

- [ ] **Step 4: Build the contract to verify it compiles**

Run:
```bash
cargo miden build --manifest-path project-template/contracts/battleship-account/Cargo.toml --release
```
Expected: Build succeeds (no methods use the new storage yet, but the layout is valid).

- [ ] **Step 5: Commit**

```bash
git add project-template/contracts/battleship-account/src/lib.rs
git commit -m "refactor(contract): replace StorageMap board with 10 packed StorageValue rows"
```

---

### Task 2: Implement `set_board` and update `place_ship`, `finalize_setup`, `get_cell`

**Files:**
- Modify: `project-template/contracts/battleship-account/src/lib.rs`

- [ ] **Step 1: Replace `place_ship` and `finalize_setup` with `set_board`**

Remove the existing `place_ship` and `finalize_setup` methods. Replace with a single `set_board` method:

```rust
    /// Set up the entire board in one call. Replaces place_ship + finalize_setup.
    /// rows: 10 Felts, each packing 10 cells at 3 bits (col0 in bits 0-2, col1 in bits 3-5, etc.)
    /// Cell values: 0=water, 1=carrier, 2=battleship, 3=cruiser, 4=submarine, 5=destroyer
    pub fn set_board(
        &mut self,
        row0: Felt, row1: Felt, row2: Felt, row3: Felt, row4: Felt,
        row5: Felt, row6: Felt, row7: Felt, row8: Felt, row9: Felt,
        game_id: Word,
        opponent_prefix: Felt,
        opponent_suffix: Felt,
        commitment: Word,
    ) {
        let config: Word = self.game_config.get();
        assert!(config[2].as_canonical_u64() == PHASE_CREATED, "wrong phase");

        let rows = [row0, row1, row2, row3, row4, row5, row6, row7, row8, row9];

        // Validate board: count total cells and per-ship counts
        let mut total_cells: u64 = 0;
        let mut ship_counts: [u64; 5] = [0; 5]; // index 0=ship1, 1=ship2, etc.

        let mut r: u64 = 0;
        while r < GRID_SIZE {
            let packed = rows[r as usize].as_canonical_u64();
            let mut c: u64 = 0;
            while c < GRID_SIZE {
                let cell = get_cell_from_packed(packed, c);
                assert!(cell <= 5, "invalid cell value");
                if cell >= 1 {
                    total_cells += 1;
                    ship_counts[(cell - 1) as usize] += 1;
                }
                c += 1;
            }
            r += 1;
        }

        // Validate totals
        assert!(total_cells == TOTAL_SHIP_CELLS, "wrong number of ships");
        assert!(ship_counts[0] == SHIP_1_SIZE, "ship 1 wrong size");
        assert!(ship_counts[1] == SHIP_2_SIZE, "ship 2 wrong size");
        assert!(ship_counts[2] == SHIP_3_SIZE, "ship 3 wrong size");
        assert!(ship_counts[3] == SHIP_4_SIZE, "ship 4 wrong size");
        assert!(ship_counts[4] == SHIP_5_SIZE, "ship 5 wrong size");

        // Write all 10 rows
        let mut r2: u64 = 0;
        while r2 < GRID_SIZE {
            self.set_board_row(r2, Word::from([rows[r2 as usize], felt!(0), felt!(0), felt!(0)]));
            r2 += 1;
        }

        // Store game metadata
        self.game_id.set(game_id);
        self.opponent.set(Word::from([opponent_prefix, opponent_suffix, felt!(0), felt!(0)]));
        self.board_commitment.set(commitment);

        // Set phase to CHALLENGED
        self.game_config.set(Word::from([
            Felt::new(GRID_SIZE),
            Felt::new(TOTAL_SHIP_CELLS),
            Felt::new(PHASE_CHALLENGED),
            felt!(0),
        ]));
    }
```

- [ ] **Step 2: Update `get_cell` to read from packed rows**

```rust
    /// Get a cell's state from the packed board.
    pub fn get_cell(&self, row: Felt, col: Felt) -> Felt {
        let r = row.as_canonical_u64();
        let c = col.as_canonical_u64();
        assert!(r < GRID_SIZE, "row out of bounds");
        assert!(c < GRID_SIZE, "col out of bounds");
        let row_word = self.get_board_row(r);
        let packed = row_word[0].as_canonical_u64();
        Felt::new(get_cell_from_packed(packed, c))
    }
```

- [ ] **Step 3: Update `process_shot` to use packed rows**

```rust
    /// Process an incoming shot. Returns encoded result: result * 2 + game_over.
    pub fn process_shot(&mut self, row: Felt, col: Felt, turn: Felt) -> Felt {
        let config: Word = self.game_config.get();
        assert!(config[2].as_canonical_u64() == PHASE_ACTIVE, "wrong phase for shot");
        assert!(turn.as_canonical_u64() == config[3].as_canonical_u64(), "wrong turn number");

        let r = row.as_canonical_u64();
        let c = col.as_canonical_u64();
        assert!(r < GRID_SIZE, "row out of bounds");
        assert!(c < GRID_SIZE, "col out of bounds");

        // Read the packed row
        let row_word = self.get_board_row(r);
        let packed = row_word[0].as_canonical_u64();
        let cell_val = get_cell_from_packed(packed, c);

        // Check not already shot (valid cells are 0-5; hit=6, miss=7)
        assert!(cell_val <= 5, "cell already shot");

        // Read opponent info
        let opp: Word = self.opponent.get();
        let ships_hit_count = opp[2].as_canonical_u64();
        let total_shots = opp[3].as_canonical_u64();

        // Determine result
        let is_hit = cell_val >= 1 && cell_val <= 5;
        let result: u64 = if is_hit { 1 } else { 0 };
        let new_cell: u64 = if is_hit { CELL_HIT } else { CELL_MISS };
        let new_hit_count: u64 = if is_hit { ships_hit_count + 1 } else { ships_hit_count };

        // Update the packed row
        let new_packed = set_cell_in_packed(packed, c, new_cell);
        self.set_board_row(r, Word::from([Felt::new(new_packed), felt!(0), felt!(0), felt!(0)]));

        // Update opponent info
        self.opponent.set(Word::from([opp[0], opp[1], Felt::new(new_hit_count), Felt::new(total_shots + 1)]));

        // Check victory
        let game_over: u64 = if new_hit_count == TOTAL_SHIP_CELLS { 1 } else { 0 };
        let new_phase: u64 = if game_over == 1 { PHASE_REVEAL } else { PHASE_ACTIVE };

        // Update config: advance expected_turn by 2
        self.game_config.set(Word::from([
            Felt::new(GRID_SIZE),
            Felt::new(TOTAL_SHIP_CELLS),
            Felt::new(new_phase),
            Felt::new(config[3].as_canonical_u64() + 2),
        ]));

        Felt::new(result * 2 + game_over)
    }
```

- [ ] **Step 4: Build the contract**

Run:
```bash
cargo miden build --manifest-path project-template/contracts/battleship-account/Cargo.toml --release
```
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add project-template/contracts/battleship-account/src/lib.rs
git commit -m "feat(contract): implement set_board with packed rows, update process_shot and get_cell"
```

---

### Task 3: Update setup-note script

**Files:**
- Modify: `project-template/contracts/setup-note/src/lib.rs`

- [ ] **Step 1: Rewrite setup-note to pass packed rows**

```rust
#![no_std]
#![feature(alloc_error_handler)]

use miden::*;

use crate::bindings::miden::battleship_account::battleship_account;

/// Setup note for board placement (packed format).
///
/// Input layout (20 Felts):
///   [0..4]   game_id (4 Felts)
///   [4]      opponent_prefix
///   [5]      opponent_suffix
///   [6..10]  commitment (4 Felts, pre-computed by client)
///   [10..20] packed_rows (10 Felts, one per board row)
#[note]
struct SetupNote;

#[note]
impl SetupNote {
    #[note_script]
    fn run(self, _arg: Word) {
        let inputs = active_note::get_storage();

        let game_id = Word::from([inputs[0], inputs[1], inputs[2], inputs[3]]);
        let commitment = Word::from([inputs[6], inputs[7], inputs[8], inputs[9]]);

        battleship_account::set_board(
            inputs[10], inputs[11], inputs[12], inputs[13], inputs[14],
            inputs[15], inputs[16], inputs[17], inputs[18], inputs[19],
            game_id,
            inputs[4],  // opponent_prefix
            inputs[5],  // opponent_suffix
            commitment,
        );
    }
}
```

- [ ] **Step 2: Build the setup-note**

Run:
```bash
cargo miden build --manifest-path project-template/contracts/setup-note/Cargo.toml --release
```
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add project-template/contracts/setup-note/src/lib.rs
git commit -m "feat(setup-note): use packed row format, reduce inputs from 61 to 20 Felts"
```

---

### Task 4: Update integration tests

**Files:**
- Modify: `project-template/integration/tests/battleship_notes_test.rs`
- Modify: `project-template/integration/tests/battleship_integration_test.rs`
- Modify: `project-template/integration/tests/battleship_failure_test.rs`

- [ ] **Step 1: Update shared helpers — storage slots and board packing**

In all test files, update `all_storage_slots()` to use StorageValues for rows instead of a StorageMap. Update `build_setup_inputs` to produce packed rows.

Replace the `all_storage_slots` function:

```rust
fn board_row_slot(n: u32) -> StorageSlotName {
    let name = match n {
        0 => "miden_battleship_account::battleship_account::board_row_0",
        1 => "miden_battleship_account::battleship_account::board_row_1",
        2 => "miden_battleship_account::battleship_account::board_row_2",
        3 => "miden_battleship_account::battleship_account::board_row_3",
        4 => "miden_battleship_account::battleship_account::board_row_4",
        5 => "miden_battleship_account::battleship_account::board_row_5",
        6 => "miden_battleship_account::battleship_account::board_row_6",
        7 => "miden_battleship_account::battleship_account::board_row_7",
        8 => "miden_battleship_account::battleship_account::board_row_8",
        9 => "miden_battleship_account::battleship_account::board_row_9",
        _ => panic!("invalid board row"),
    };
    StorageSlotName::new(name).unwrap()
}

fn all_storage_slots() -> Vec<StorageSlot> {
    let mut slots = vec![
        StorageSlot::with_value(game_config_slot(), Word::default()),
        StorageSlot::with_value(opponent_slot(), Word::default()),
        StorageSlot::with_value(board_commitment_slot(), Word::default()),
        StorageSlot::with_value(opponent_commitment_slot(), Word::default()),
        StorageSlot::with_value(game_id_slot(), Word::default()),
        StorageSlot::with_value(reveal_status_slot(), Word::default()),
    ];
    for i in 0..10 {
        slots.push(StorageSlot::with_value(board_row_slot(i), Word::default()));
    }
    slots
}
```

Remove the old `board_slot()` function that returned the StorageMap slot name.

Replace `build_setup_inputs` to pack ship cells into 10 row Felts:

```rust
/// Pack ship cells into 10 row values (3 bits per cell).
fn pack_board(ship_cells: &[(u64, u64, u64)]) -> [u64; 10] {
    let mut rows = [0u64; 10];
    for (r, c, ship_id) in ship_cells {
        let shift = c * 3;
        rows[*r as usize] |= ship_id << shift;
    }
    rows
}

fn build_setup_inputs(
    game_id: Word, opp_prefix: u64, opp_suffix: u64,
    commitment: Word, ship_cells: &[(u64, u64, u64)],
) -> Vec<Felt> {
    let mut inputs = Vec::new();
    // game_id (4)
    for f in game_id.iter() { inputs.push(*f); }
    // opponent (2)
    inputs.push(Felt::new(opp_prefix));
    inputs.push(Felt::new(opp_suffix));
    // commitment (4)
    for f in commitment.iter() { inputs.push(*f); }
    // packed rows (10)
    let packed = pack_board(ship_cells);
    for row_val in packed.iter() {
        inputs.push(Felt::new(*row_val));
    }
    inputs
}
```

- [ ] **Step 2: Update board state assertions**

Anywhere tests assert board cell values via `account.storage().get_map_item(...)`, change to read from the row StorageValue and unpack. Add a helper:

```rust
/// Read a cell from the packed board in the account's storage.
fn read_board_cell(account: &Account, row: u32, col: u32) -> u64 {
    let row_word = account.storage().get_item(&board_row_slot(row)).unwrap();
    let packed = row_word[0].as_canonical_u64();
    (packed >> (col as u64 * 3)) & 0x7
}
```

Replace any `account.storage().get_map_item(&board_slot(), key)` calls with `read_board_cell(account, row, col)`.

- [ ] **Step 3: Run all integration tests**

Run:
```bash
cd project-template && cargo test -p integration --release
```
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add project-template/integration/tests/
git commit -m "test: update all integration tests for packed board storage"
```

---

### Task 5: Measure cycle count improvement

**Files:**
- Modify: `project-template/integration/tests/cycle_benchmark_test.rs`

- [ ] **Step 1: Update the benchmark test helpers**

Update `all_storage_slots`, `build_setup_inputs`, etc. in the benchmark test to match the new packed format (same changes as Task 4).

- [ ] **Step 2: Run the benchmark**

Run:
```bash
cd project-template && cargo test -p integration --release -- benchmark_battleship_setup_note -- --nocapture
```
Expected: Output shows cycle count significantly lower than 720,790. Target: <100,000 cycles, trace length 2^17 or lower.

- [ ] **Step 3: Commit**

```bash
git add project-template/integration/tests/cycle_benchmark_test.rs
git commit -m "test: update cycle benchmark for packed board storage"
```

---

### Task 6: Update frontend — board packing and reading

**Files:**
- Modify: `frontend-template/src/lib/notes.ts`
- Modify: `frontend-template/src/hooks/useBoardState.ts`
- Modify: `frontend-template/src/config.ts`

- [ ] **Step 1: Update `buildSetupInputs` in `notes.ts`**

Replace the function to pack ship cells into 10 row values:

```typescript
/** Pack ship cells into 10 row values (3 bits per cell, col0 in bits 0-2, etc.) */
function packBoard(shipCells: ShipCell[]): bigint[] {
  const rows = new Array(10).fill(0n);
  for (const cell of shipCells) {
    const shift = BigInt(cell.col) * 3n;
    rows[cell.row] |= BigInt(cell.shipId) << shift;
  }
  return rows;
}

/** Build setup-note inputs: game_id(4) + opponent(2) + commitment(4) + packed_rows(10) = 20 felts */
export function buildSetupInputs(
  gameIdFelts: Felt[],
  oppPrefix: Felt,
  oppSuffix: Felt,
  commitment: Felt[],
  shipCells: ShipCell[],
): FeltArray {
  const arr = new FeltArray();
  for (let i = 0; i < 4; i++) arr.push(gameIdFelts[i]);
  arr.push(oppPrefix);
  arr.push(oppSuffix);
  for (let i = 0; i < 4; i++) arr.push(commitment[i]);
  const packed = packBoard(shipCells);
  for (const rowVal of packed) {
    arr.push(new Felt(rowVal));
  }
  return arr;
}
```

- [ ] **Step 2: Update `config.ts` — add board row slot names**

Add the 10 row slot name constants and remove the old `SLOT_BOARD`:

```typescript
// Board row storage slots (replace old SLOT_BOARD StorageMap)
export const SLOT_BOARD_ROWS = [
  "miden_battleship_account::battleship_account::board_row_0",
  "miden_battleship_account::battleship_account::board_row_1",
  "miden_battleship_account::battleship_account::board_row_2",
  "miden_battleship_account::battleship_account::board_row_3",
  "miden_battleship_account::battleship_account::board_row_4",
  "miden_battleship_account::battleship_account::board_row_5",
  "miden_battleship_account::battleship_account::board_row_6",
  "miden_battleship_account::battleship_account::board_row_7",
  "miden_battleship_account::battleship_account::board_row_8",
  "miden_battleship_account::battleship_account::board_row_9",
] as const;
```

Remove the old `SLOT_BOARD` constant.

- [ ] **Step 3: Update `useBoardState.ts` to read from packed row StorageValues**

```typescript
import { useMemo } from "react";
import { useAccount } from "@miden-sdk/react";
import { Felt, Word } from "@miden-sdk/miden-sdk";
import { SLOT_BOARD_ROWS, GRID_SIZE } from "@/config";
import type { Board, BoardCell, CellState } from "@/types/game";
import { CELL_HIT, CELL_MISS, CELL_WATER } from "@/types/game";

/** Extract a 3-bit cell value from a packed row u64 */
function getCellFromPacked(packed: bigint, col: number): number {
  return Number((packed >> (BigInt(col) * 3n)) & 0x7n);
}

export function useBoardState(accountId: string, isOpponent: boolean) {
  const { account } = useAccount(accountId);

  const board = useMemo<Board | null>(() => {
    if (!account && isOpponent) {
      const grid: Board = [];
      for (let row = 0; row < GRID_SIZE; row++) {
        const rowCells: BoardCell[] = [];
        for (let col = 0; col < GRID_SIZE; col++) {
          rowCells.push({ row, col, state: CELL_WATER });
        }
        grid.push(rowCells);
      }
      return grid;
    }
    if (!account) return null;

    const grid: Board = [];

    for (let row = 0; row < GRID_SIZE; row++) {
      const rowCells: BoardCell[] = [];
      const rowWord = account.storage().getItem(SLOT_BOARD_ROWS[row]);
      const packed = rowWord ? rowWord.toU64s()[0] : 0n;

      for (let col = 0; col < GRID_SIZE; col++) {
        const rawState = getCellFromPacked(packed, col) as CellState;
        let state: CellState = CELL_WATER;

        if (isOpponent) {
          state = rawState === CELL_HIT || rawState === CELL_MISS ? rawState : CELL_WATER;
        } else {
          state = rawState;
        }

        rowCells.push({ row, col, state });
      }
      grid.push(rowCells);
    }

    return grid;
  }, [account, isOpponent]);

  return { board, isLoading: !account };
}
```

- [ ] **Step 4: Build the frontend**

Run:
```bash
cd frontend-template && npx tsc -b --noEmit && yarn build
```
Expected: No type errors, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add frontend-template/src/lib/notes.ts frontend-template/src/hooks/useBoardState.ts frontend-template/src/config.ts
git commit -m "feat(frontend): pack board into rows for new contract format"
```

---

### Task 7: Rebuild .masp artifacts and verify end-to-end

**Files:**
- Copy: `project-template/contracts/battleship-account/target/miden/release/*.masp` -> `frontend-template/public/packages/battleship_account.masp`
- Copy: `project-template/contracts/setup-note/target/miden/release/*.masp` -> `frontend-template/public/packages/setup_note.masp`

- [ ] **Step 1: Rebuild all contracts**

```bash
cd project-template
cargo miden build --manifest-path contracts/battleship-account/Cargo.toml --release
cargo miden build --manifest-path contracts/setup-note/Cargo.toml --release
```

- [ ] **Step 2: Copy updated .masp packages to frontend**

```bash
cp contracts/battleship-account/target/miden/release/*.masp ../frontend-template/public/packages/battleship_account.masp
cp contracts/setup-note/target/miden/release/*.masp ../frontend-template/public/packages/setup_note.masp
```

- [ ] **Step 3: Run integration tests one final time**

```bash
cd project-template && cargo test -p integration --release
```
Expected: All tests pass.

- [ ] **Step 4: Run frontend tests**

```bash
cd frontend-template && npx vitest --run
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend-template/public/packages/
git commit -m "build: update .masp artifacts for packed board storage"
```
