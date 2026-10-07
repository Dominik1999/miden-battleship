//! Client helpers for the testnet binaries: client setup, game account creation, faucet funding
//! and thin transaction wrappers.

use std::{path::PathBuf, process::Command, sync::Arc, time::Duration};

use anyhow::{bail, Context, Result};
use miden_client::{
    account::{Account, AccountId, NetworkId},
    asset::AssetId,
    builder::ClientBuilder,
    grpc_support::TESTNET_PROVER_ENDPOINT,
    keystore::FilesystemKeyStore,
    note::{Note, NoteRecipient},
    store::NoteFilter,
    transaction::{TransactionId, TransactionRequestBuilder, TransactionScript},
    Client, Felt, RemoteTransactionProver, Word,
};
use miden_client_sqlite_store::ClientBuilderSqliteExt;
use sha2::{Digest, Sha256};

use crate::battleship::{game_account_builder, BattleshipScripts};

/// Public testnet faucet HTTP API.
pub const TESTNET_FAUCET_API: &str = "https://faucet-api.testnet.miden.io";
/// USDCx has 6 decimals: one token in base units.
pub const ONE_USDCX: u64 = 1_000_000;
/// Proving a battleship transaction on the remote prover takes tens of seconds.
pub const PROVER_TIMEOUT: Duration = Duration::from_secs(300);

pub type TestnetClient = Client<FilesystemKeyStore>;

/// Initialized client plus its keystore.
pub struct ClientSetup {
    pub client: TestnetClient,
    pub keystore: Arc<FilesystemKeyStore>,
}

/// Builds a testnet client whose SQLite store and keystore live under `project-template/` as
/// `testnet-store-<name>.sqlite3` and `testnet-keystore-<name>/`. Paths are per name so two
/// players can run side by side; 0.14 stores are incompatible and must not be reused.
pub async fn setup_testnet_client(name: &str) -> Result<ClientSetup> {
    let keystore_path = PathBuf::from(format!("testnet-keystore-{name}"));
    let keystore =
        Arc::new(FilesystemKeyStore::new(keystore_path).context("failed to initialize keystore")?);
    let store_path = PathBuf::from(format!("testnet-store-{name}.sqlite3"));
    let prover = RemoteTransactionProver::new(TESTNET_PROVER_ENDPOINT).with_timeout(PROVER_TIMEOUT);
    let client = ClientBuilder::for_testnet()
        .sqlite_store(store_path)
        .authenticator(keystore.clone())
        .prover(Arc::new(prover))
        .build()
        .await
        .context("failed to build testnet client")?;
    Ok(ClientSetup { client, keystore })
}

/// Creates a new game account (battleship + BasicWallet + NoAuth, public) and registers it with
/// the client. The account exists on chain once its first transaction (consuming the funding
/// note) is committed.
pub async fn create_game_account(
    client: &mut TestnetClient,
    scripts: &BattleshipScripts,
) -> Result<Account> {
    let seed: [u8; 32] = rand::random();
    let account = game_account_builder(seed, scripts.component.clone())
        .build()
        .context("failed to build game account")?;
    client
        .add_account(&account, false)
        .await
        .context("failed to add game account to the client")?;
    Ok(account)
}

/// Returns the chain's fee asset (USDCx on testnet) as reported by the latest synced block.
pub async fn fee_asset_id(client: &mut TestnetClient) -> Result<AssetId> {
    client.sync_state().await.context("sync failed")?;
    let header = client.get_latest_block_header().await?;
    let config = client
        .get_protocol_config(header.protocol_config_commitment())
        .await
        .context("protocol config not available; sync first")?;
    Ok(config.fee_asset_id())
}

/// Returns the latest tracked state of `account_id`.
pub async fn tracked_account(client: &TestnetClient, account_id: AccountId) -> Result<Account> {
    client
        .get_account(account_id)
        .await?
        .with_context(|| format!("account {} is not tracked", account_id.to_hex()))
}

/// Returns the balance of `asset_id` in the tracked account's vault.
pub async fn fee_asset_balance(
    client: &TestnetClient,
    account_id: AccountId,
    asset_id: AssetId,
) -> Result<u64> {
    let account = tracked_account(client, account_id).await?;
    Ok(account
        .vault()
        .get_balance(asset_id)
        .map(|amount| amount.as_u64())
        .unwrap_or(0))
}

// ============================================================================
// Faucet funding (public testnet faucet, sha256 proof of work)
// ============================================================================

fn curl_get(url: &str) -> Result<String> {
    let output = Command::new("curl")
        .args(["-sS", "--fail-with-body", "--max-time", "60", url])
        .output()
        .context("failed to run curl")?;
    let body = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() {
        bail!(
            "GET {url} failed: {} {}",
            String::from_utf8_lossy(&output.stderr).trim(),
            body.trim()
        );
    }
    Ok(body)
}

fn solve_pow(challenge_hex: &str, target: u64) -> Result<u64> {
    let challenge = (0..challenge_hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&challenge_hex[i..i + 2], 16))
        .collect::<Result<Vec<u8>, _>>()
        .context("challenge is not hex")?;
    for nonce in 0u64..100_000_000 {
        let mut hasher = Sha256::new();
        hasher.update(&challenge);
        hasher.update(nonce.to_be_bytes());
        let digest = hasher.finalize();
        let head = u64::from_be_bytes(digest[..8].try_into().expect("8 bytes"));
        if head < target {
            return Ok(nonce);
        }
    }
    bail!("no proof-of-work solution found")
}

/// Requests `amount` base units of the fee asset for `account_id` from the testnet faucet as a
/// public P2ID note. Retries on 429 (shared cooldown). Returns the faucet's note id string.
pub fn request_faucet_tokens(account_id: AccountId, amount: u64) -> Result<String> {
    let bech32 = account_id.to_bech32(NetworkId::Testnet);
    let mut attempts = 0;
    loop {
        attempts += 1;
        let pow: serde_json::Value = serde_json::from_str(&curl_get(&format!(
            "{TESTNET_FAUCET_API}/pow?account_id={bech32}&amount={amount}"
        ))?)
        .context("invalid /pow response")?;
        let challenge = pow["challenge"]
            .as_str()
            .context("/pow: missing challenge")?;
        let target = pow["target"].as_u64().context("/pow: missing target")?;
        let nonce = solve_pow(challenge, target)?;
        let url = format!(
            "{TESTNET_FAUCET_API}/get_tokens?account_id={bech32}&is_private_note=false&asset_amount={amount}&challenge={challenge}&nonce={nonce}"
        );
        match curl_get(&url) {
            Ok(body) => {
                let value: serde_json::Value =
                    serde_json::from_str(&body).context("invalid /get_tokens response")?;
                return Ok(value["note_id"].as_str().unwrap_or(body.trim()).to_string());
            }
            Err(e) if attempts < 6 && e.to_string().contains("429") => {
                println!("  faucet busy (429), retrying in 20 s...");
                std::thread::sleep(Duration::from_secs(20));
            }
            Err(e) => return Err(e),
        }
    }
}

// ============================================================================
// Sync and note discovery
// ============================================================================

/// Syncs until `predicate` finds a note among the client's committed, unconsumed notes.
pub async fn wait_for_note(
    client: &mut TestnetClient,
    timeout: Duration,
    mut predicate: impl FnMut(&Note) -> bool,
) -> Result<Note> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        client.sync_state().await.context("sync failed")?;
        for record in client.get_input_notes(NoteFilter::Committed).await? {
            let Ok(note) = TryInto::<Note>::try_into(record) else {
                continue;
            };
            if predicate(&note) {
                return Ok(note);
            }
        }
        if std::time::Instant::now() > deadline {
            bail!("timed out after {timeout:?} waiting for a note");
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

/// Syncs until a note consumable by `account_id` appears (e.g. the faucet's P2ID note).
pub async fn wait_for_consumable_note(
    client: &mut TestnetClient,
    account_id: AccountId,
    timeout: Duration,
) -> Result<Note> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        client.sync_state().await.context("sync failed")?;
        if let Some((record, _)) = client.get_consumable_notes(Some(account_id)).await?.pop() {
            return TryInto::<Note>::try_into(record)
                .map_err(|e| anyhow::anyhow!("note record: {e:?}"));
        }
        if std::time::Instant::now() > deadline {
            bail!("timed out after {timeout:?} waiting for a consumable note");
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

/// Syncs until the transaction is committed.
pub async fn wait_for_commit(
    client: &mut TestnetClient,
    tx_id: TransactionId,
    timeout: Duration,
) -> Result<()> {
    use miden_client::store::TransactionFilter;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        client.sync_state().await.context("sync failed")?;
        let uncommitted = client
            .get_transactions(TransactionFilter::Uncommitted)
            .await?;
        if !uncommitted.iter().any(|tx| tx.id == tx_id) {
            return Ok(());
        }
        if std::time::Instant::now() > deadline {
            bail!("timed out after {timeout:?} waiting for tx {tx_id} to commit");
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

// ============================================================================
// Transactions
// ============================================================================

/// Submits a transaction and waits for it to commit.
async fn submit_and_wait(
    client: &mut TestnetClient,
    account_id: AccountId,
    request: miden_client::transaction::TransactionRequest,
) -> Result<TransactionId> {
    let tx_id = client
        .submit_new_transaction(account_id, request)
        .await
        .context("failed to submit transaction")?;
    wait_for_commit(client, tx_id, Duration::from_secs(300)).await?;
    Ok(tx_id)
}

/// Consumes `notes` on `account_id` (also the deploy path for a fresh, funded account).
pub async fn consume_notes(
    client: &mut TestnetClient,
    account_id: AccountId,
    notes: Vec<Note>,
) -> Result<TransactionId> {
    let request = TransactionRequestBuilder::new()
        .build_consume_notes(notes)
        .context("failed to build consume request")?;
    submit_and_wait(client, account_id, request).await
}

/// Consumes a shot note on the defender's account; the result note is created by the component.
pub async fn consume_shot_note(
    client: &mut TestnetClient,
    account_id: AccountId,
    shot_note: Note,
    result_recipient: NoteRecipient,
) -> Result<TransactionId> {
    let request = TransactionRequestBuilder::new()
        .input_notes([(shot_note, None)])
        .expected_output_recipients([result_recipient])
        .build()
        .context("failed to build shot request")?;
    submit_and_wait(client, account_id, request).await
}

/// Creates `note` as an output note of `account_id` (requires the BasicWallet interface).
pub async fn publish_note(
    client: &mut TestnetClient,
    account_id: AccountId,
    note: Note,
) -> Result<TransactionId> {
    let request = TransactionRequestBuilder::new()
        .own_output_notes([note])
        .build()
        .context("failed to build publish request")?;
    submit_and_wait(client, account_id, request).await
}

/// Runs a transaction script on `account_id`, optionally with a script argument and advice map
/// entries.
pub async fn run_tx_script(
    client: &mut TestnetClient,
    account_id: AccountId,
    script: TransactionScript,
    script_arg: Option<Word>,
    advice_map: Vec<(Word, Vec<Felt>)>,
) -> Result<TransactionId> {
    let mut builder = TransactionRequestBuilder::new()
        .custom_script(script)
        .extend_advice_map(advice_map);
    if let Some(arg) = script_arg {
        builder = builder.script_arg(arg);
    }
    let request = builder.build().context("failed to build script request")?;
    submit_and_wait(client, account_id, request).await
}

/// Note id of a note the client can see, for logging.
pub fn note_id_hex(note: &Note) -> String {
    note.id().to_hex()
}

// ============================================================================
// Funding
// ============================================================================

/// Base units requested per faucet claim (the public faucet caps a claim at 10_000).
pub const FAUCET_CLAIM_AMOUNT: u64 = 10_000;

/// Claims fee tokens from the faucet for `account_id` and consumes the funding note (this is
/// also the account's first transaction, which deploys it). Returns the new balance.
pub async fn fund_from_faucet(
    client: &mut TestnetClient,
    account_id: AccountId,
    fee_asset: AssetId,
) -> Result<u64> {
    let note_id = request_faucet_tokens(account_id, FAUCET_CLAIM_AMOUNT)?;
    println!("  faucet note {note_id} requested, waiting for it to land...");
    let note = wait_for_consumable_note(client, account_id, Duration::from_secs(180)).await?;
    consume_notes(client, account_id, vec![note]).await?;
    fee_asset_balance(client, account_id, fee_asset).await
}

/// Tops the account up from the faucet while its fee balance is below `min_balance`.
pub async fn ensure_funded(
    client: &mut TestnetClient,
    account_id: AccountId,
    fee_asset: AssetId,
    min_balance: u64,
) -> Result<u64> {
    let mut balance = fee_asset_balance(client, account_id, fee_asset).await?;
    while balance < min_balance {
        println!("  balance {balance} < {min_balance}, claiming from the faucet");
        balance = fund_from_faucet(client, account_id, fee_asset).await?;
    }
    Ok(balance)
}
