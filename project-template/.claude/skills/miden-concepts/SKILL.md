---
name: miden-concepts
description: Miden architecture and core concepts from a developer perspective. Covers the actor model, accounts, notes, transactions, assets, fees, privacy model, and standard patterns. Use when designing Miden applications or understanding how Miden differs from traditional blockchains.
---

# Miden Architecture for Developers

## What is Miden?

Miden is a zero-knowledge rollup that uses an **actor model** where each account is an independent smart contract. It settles on Ethereum via validity proofs through Agglayer.

Key properties:
- **Privacy by default** — accounts, notes, and transactions can be private; the network stores only cryptographic commitments
- **Client-side execution** — transactions are executed and proven locally by the user's device (or by a remote prover the client delegates to)
- **Programmable everything** — accounts hold code and storage; notes carry scripts and assets

## Mental Model Shifts from Traditional Blockchains

| Traditional (Ethereum) | Miden |
|------------------------|-------|
| Transactions involve sender + receiver | Transactions involve **one account only** |
| Public state by default | **Private by default** (this project uses private game accounts and public wallets) |
| Validators execute transactions | **Client executes and proves** locally |
| Gas metering | **Fee per transaction** in the chain's fee asset, scaled by proof size |
| Synchronous contract calls | **Asynchronous** communication via notes |
| Accounts are balances + storage | Accounts are **full smart contracts** with code, storage, and vault |

## Core Concepts

### Accounts
Each account is an independent smart contract containing:
- **Code** — Immutable logic assembled from MASM components
- **Storage** — Up to 255 named slots (value or storage map)
- **Vault** — Holds fungible and non-fungible assets (here: the fee asset)
- **Nonce** — Incremented with each state change
- **ID** — Unique identifier (prefix + suffix, 2 Felts)

Accounts are composed from **components**: an `AccountComponent` is MASM code with `@account_procedure`s plus its initial storage slots. Standard components from `miden-standards` (`BasicWallet`, `NoAuth`, `AuthFalcon512Rpo`, faucets) compose with custom ones. A new account exists on chain only after its first transaction.

### Notes
Notes are **UTXO-like messages** for asynchronous inter-account communication. A note contains:
- **Script** — Logic that executes when the note is consumed (a MASM `@note_script`)
- **Storage** — Data items (felts) the script reads with `active_note::get_bounded_storage`
- **Assets** — Fungible/non-fungible tokens attached to the note
- **Metadata** — Sender, tag, note type (public/private)

Notes are created as **output notes** by one transaction and consumed as **input notes** by another. A note tagged with `NoteTag::with_account_target(id)` is delivered to that account's client during sync.

### Transactions
A transaction is a **single-account state transition** with 4 phases:
1. Prologue (load the account and notes)
2. Consume input notes (execute their scripts against the account)
3. Execute the transaction script (optional, one-off logic with an argument and advice inputs)
4. Epilogue: authentication component (which also pays the fee), output notes, state commitment

**Important**: A two-party interaction (A tells B something) requires TWO transactions: A's transaction creates a note; B's transaction consumes it.

### Fees
Every transaction pays a fee in the chain's fee asset (USDCx on testnet 0.17), computed from the padded trace size (`base_fee * (ilog2(cycles) + 1)`). The auth component pays it from the vault, so an account that acts must hold the fee asset — including for its very first transaction.

### Assets
- **Fungible**: `[amount, 0, faucet_suffix, faucet_prefix]` (1 Word)
- **Non-fungible**: Unique token tied to a faucet account
- Assets live in account **vaults** and move between accounts via notes (P2ID for plain transfers)

### Felt and Word
- **Felt**: Field element in the Goldilocks prime field (p = 2^64 - 2^32 + 1). The fundamental data unit.
- **Word**: Array of 4 Felts (32 bytes). Used for hashes, storage values, account-id pairs, note serial numbers.

**WARNING**: Felt arithmetic is **modular**. Use the `u32` instructions (`u32assert`, `u32lt`, `u32shr`, ...) for counts, coordinates and bit fields. See the `rust-sdk-pitfalls` skill.

## Standard Note Patterns

| Pattern | Purpose | How It Works |
|---------|---------|-------------|
| **P2ID** | Send assets to a specific account | Note script checks consumer's ID matches target (the faucet funds game accounts this way) |
| **P2IDE** | P2ID with expiration | Adds block-height timelock; sender can reclaim after expiry |
| **SWAP** | Atomic asset exchange | Note offers asset A, requests asset B; consumer provides B |
| **Custom data note** (this project) | Carry game data to one account | Public note, no assets, storage = payload, tag = account target, script `call`s a component procedure |

## Development Model

```
Developer writes MASM → CodeBuilder assembles it at runtime → VM executes and proves
```

Three script kinds:
- `@account_procedure` in a component module — account logic and storage (`call`ed from scripts, 16-element stack window)
- `@note_script` — runs when the note is consumed
- `@transaction_script` — one-off logic with a word argument (and the advice map for larger payloads)

Contracts are tested locally with **MockChain** (`miden-testing`) and used on chain through **miden-client** (Rust) or the **web SDK** (browser); both assemble the same sources.

## Key Design Decisions for App Architects

1. **One account per actor** — each player in a match has its own game account
2. **Notes for communication** — challenge/accept/shot/result/defeat/forfeit/stake notes instead of direct calls; the component creates its own notes, with deadlines so a stalled note can be reclaimed
3. **Storage for state** — value slots for flags and counters, storage maps for the board, the shot log and the pinned script roots
4. **Public where discoverability is needed** — game notes are public and account-tagged; the game account itself is private, so the board never leaves the owner's device
5. **Components for reuse** — `BasicWallet` + `NoAuth` beside the custom component give fee payment without keys
