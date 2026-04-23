# Compiler Bug Repro: midenc-hir-0.8.1 index out of bounds

Minimal reproduction for https://github.com/0xMiden/compiler/issues/1084

## The Bug

`cargo-miden 0.8.1` panics during MASP package creation:

```
thread 'main' panicked at midenc-hir-0.8.1/src/ir/entity/storage.rs:180:31:
index out of bounds: the len is 1 but the index is 1
```

## How to Reproduce

```bash
cd repro
cargo miden build --release
```

**Important:** Must build from within this directory (needs `rust-toolchain.toml` for nightly).

## What Triggers It

A single function with:
- 6 `assert!()` calls (each generates a conditional panic branch)
- 5 `if/else` expressions
- 3 storage writes (StorageMap + 2 StorageValue)

**Removing any one of the 6 asserts makes it compile successfully.**

The threshold appears to be the total number of branching points in a single function — `assert!` with a message generates a `cf.switch`-like branch, and combined with enough `if/else` expressions, the `SimplifySwitchFallbackOverlap` canonicalization pass hits an index out of bounds on `EntityStorage::group()`.

## Environment

- `cargo-miden 0.8.1` (installed via `cargo install cargo-miden`)
- `miden` SDK `0.12`
- Rust `nightly-2025-12-10`
- macOS (aarch64)
