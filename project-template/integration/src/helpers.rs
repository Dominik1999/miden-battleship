//! Client helpers for the testnet binaries: client setup, game and wallet accounts, faucet
//! funding and the game's transactions (setup, handshake, fire, resolve, answer, reclaim, stake,
//! claim). Everything mirrors `tests/common/mod.rs` on a real node.

use std::{path::PathBuf, process::Command, sync::Arc, time::Duration};

use anyhow::{bail, Context, Result};
use miden_client::{
    account::{
        component::{BasicWallet, NoAuth},
        Account, AccountBuilder, AccountId, AccountType, NetworkId,
    },
    asset::{AssetId, FungibleAsset},
    builder::ClientBuilder,
    grpc_support::TESTNET_PROVER_ENDPOINT,
    keystore::FilesystemKeyStore,
    note::Note,
    store::NoteFilter,
    transaction::{TransactionId, TransactionRequestBuilder, TransactionScript},
    Client, Felt, RemoteTransactionProver, Word,
};
use miden_client_sqlite_store::ClientBuilderSqliteExt;
use sha2::{Digest, Sha256};

use crate::battleship::*;

/// Public testnet faucet HTTP API.
pub const TESTNET_FAUCET_API: &str = "https://faucet-api.testnet.miden.io";
/// USDCx has 6 decimals: one token in base units.
pub const ONE_USDCX: u64 = 1_000_000;
/// Proving a battleship transaction on the remote prover takes tens of seconds.
pub const PROVER_TIMEOUT: Duration = Duration::from_secs(300);
/// Base units requested per faucet claim (the public faucet caps a claim at 10_000).
pub const FAUCET_CLAIM_AMOUNT: u64 = 10_000;
/// Stake used on testnet (the faucet grants 10_000 base units per claim).
pub const TESTNET_STAKE: u64 = 2_000;
/// Stake notes stay refundable to the staker after 60 days.
pub const STAKE_EXPIRY_DELTA: u64 = 60 * 24 * 3600;

pub type TestnetClient = Client<FilesystemKeyStore>;

/// Initialized client plus its keystore.
pub struct ClientSetup {
    pub client: TestnetClient,
    pub keystore: Arc<FilesystemKeyStore>,
}

/// Builds a testnet client whose SQLite store and keystore live under `project-template/` as
/// `testnet-store-<name>.sqlite3` and `testnet-keystore-<name>/`. One client per player.
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

/// Creates a new PRIVATE game account (battleship + BasicWallet + NoAuth) and registers it with
/// the client; `account.seed()` is the seed carried in the handshake notes. The account exists
/// on chain once its first transaction (consuming the funding note) is committed.
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

/// Creates a new public NoAuth wallet (testnet stand-in for the player's wallet) and registers
/// it with the client.
pub async fn create_wallet_account(client: &mut TestnetClient) -> Result<Account> {
    let seed: [u8; 32] = rand::random();
    let account = AccountBuilder::new(seed)
        .account_type(AccountType::Public)
        .with_component(BasicWallet)
        .with_component(NoAuth)
        .build()
        .context("failed to build wallet account")?;
    client
        .add_account(&account, false)
        .await
        .context("failed to add wallet account to the client")?;
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

/// Timestamp of the latest synced block, the reference block of the next transaction.
pub async fn now(client: &mut TestnetClient) -> Result<u64> {
    client.sync_state().await.context("sync failed")?;
    Ok(client.get_latest_block_header().await?.timestamp() as u64)
}

/// A deadline 12 hours after the latest block.
pub async fn deadline(client: &mut TestnetClient) -> Result<u64> {
    Ok(now(client).await? + DEADLINE_DELTA)
}

/// Returns the latest tracked state of `account_id`.
pub async fn tracked_account(client: &TestnetClient, account_id: AccountId) -> Result<Account> {
    client
        .get_account(account_id)
        .await?
        .with_context(|| format!("account {} is not tracked", account_id.to_hex()))
}

pub async fn game_state(client: &TestnetClient, account_id: AccountId) -> Result<GameState> {
    Ok(GameState::from_account(
        &tracked_account(client, account_id).await?,
    ))
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

/// Runs a transaction script on `account_id`, optionally with a script argument, advice map
/// entries and expected output notes.
pub async fn run_tx_script(
    client: &mut TestnetClient,
    account_id: AccountId,
    script: TransactionScript,
    script_arg: Option<Word>,
    advice_map: Vec<(Word, Vec<Felt>)>,
    expected: Vec<Note>,
) -> Result<TransactionId> {
    let mut builder = TransactionRequestBuilder::new()
        .custom_script(script)
        .extend_advice_map(advice_map)
        .expected_output_recipients(expected.iter().map(|n| n.recipient().clone()));
    if let Some(arg) = script_arg {
        builder = builder.script_arg(arg);
    }
    let request = builder.build().context("failed to build script request")?;
    submit_and_wait(client, account_id, request).await
}

/// Runs the setup transaction script on a game account with the classic board.
pub async fn setup_game(
    client: &mut TestnetClient,
    scripts: &BattleshipScripts,
    game: AccountId,
    opponent: AccountId,
    owner_wallet: AccountId,
    game_id: Word,
) -> Result<TransactionId> {
    let rows = pack_board(&classic_ship_cells());
    let payload = build_setup_payload(game_id, opponent, owner_wallet, &rows, &scripts.roots());
    let key = setup_payload_commitment(&payload);
    run_tx_script(
        client,
        game,
        scripts.setup_tx.clone(),
        Some(key),
        vec![(key, payload)],
        vec![],
    )
    .await
}

/// The turn `game` fires next, from its tracked state. Before the handshake completes
/// (CHALLENGED) the only legal shot is the challenger's turn 1, fired in the move that consumes
/// the acceptance.
pub async fn next_fire_turn(client: &TestnetClient, game: AccountId) -> Result<u64> {
    let s = game_state(client, game).await?;
    Ok(
        if s.phase == PHASE_CHALLENGED || s.role == ROLE_CHALLENGER {
            2 * s.shots_fired + 1
        } else {
            2 * s.shots_fired + 2
        },
    )
}

/// One move of a game account: the opponent notes it consumes (with their note args), the
/// notes the component is expected to create, and optionally a shot to fire afterwards.
#[derive(Default)]
pub struct Move {
    pub inputs: Vec<(Note, Option<Word>)>,
    pub expected: Vec<Note>,
    pub fire: Option<Word>,
}

/// Submits a move as a single transaction: the input notes are consumed first, then the fire
/// script runs. Waits for the commit.
pub async fn submit_move(
    client: &mut TestnetClient,
    scripts: &BattleshipScripts,
    game: AccountId,
    mv: Move,
) -> Result<TransactionId> {
    let mut builder = TransactionRequestBuilder::new()
        .input_notes(mv.inputs)
        .expected_output_recipients(mv.expected.iter().map(|n| n.recipient().clone()));
    if let Some(args) = mv.fire {
        builder = builder
            .custom_script(scripts.fire_tx.clone())
            .script_arg(args);
    }
    let request = builder.build().context("failed to build move request")?;
    submit_and_wait(client, game, request).await
}

/// Plans the shot `game` fires next at `opponent`: returns the fire args and the shot note the
/// component will create, with a deadline 12 hours after the latest block.
pub async fn plan_shot(
    client: &mut TestnetClient,
    scripts: &BattleshipScripts,
    game: AccountId,
    opponent: AccountId,
    row: u64,
    col: u64,
) -> Result<(Word, Note)> {
    let deadline = deadline(client).await?;
    let turn = next_fire_turn(client, game).await?;
    let shot = expected_shot_note(scripts, game, opponent, row, col, turn, deadline)?;
    Ok((fire_args(row, col, deadline), shot))
}

/// What the defender's client predicts for an incoming shot (mirrors `process_shot`).
pub async fn predict(
    client: &TestnetClient,
    defender: AccountId,
    row: u64,
    col: u64,
) -> Result<ShotResult> {
    let account = tracked_account(client, defender).await?;
    let cell = read_board_cell(&account, row, col);
    let is_hit = (1..=5).contains(&cell);
    let hits = GameState::from_account(&account).ships_hit_count;
    Ok(ShotResult {
        is_hit,
        game_over: is_hit && hits + 1 >= TOTAL_SHIP_CELLS,
    })
}

/// Plans the resolution of an incoming shot on `defender`: the note args (result deadline), the
/// result note and, on the 17th hit, the defeat note addressed to the opponent's wallet.
pub async fn plan_resolution(
    client: &mut TestnetClient,
    scripts: &BattleshipScripts,
    defender: AccountId,
    shot: &Note,
) -> Result<(Word, Note, Option<Note>)> {
    let parsed = ShotNoteStorage::from_note(shot)?;
    let shooter = shot.metadata().sender();
    let result = predict(client, defender, parsed.row, parsed.col).await?;
    let result_deadline = deadline(client).await?;
    let result_note = expected_result_note(
        scripts,
        defender,
        shooter,
        parsed.turn,
        result,
        result_deadline,
    )?;
    let defeat = if result.game_over {
        let state = game_state(client, defender).await?;
        let wallet = state
            .opponent_wallet
            .context("opponent wallet stored at handshake")?;
        Some(expected_defeat_note(scripts, defender, wallet)?)
    } else {
        None
    };
    Ok((shot_note_args(result_deadline), result_note, defeat))
}

/// Reclaims an unanswered own note after its deadline; returns the forfeit note.
pub async fn reclaim(
    client: &mut TestnetClient,
    scripts: &BattleshipScripts,
    game: AccountId,
    note: Note,
) -> Result<Note> {
    let state = game_state(client, game).await?;
    let wallet = state.owner_wallet.context("owner wallet stored at setup")?;
    let forfeit = expected_forfeit_note(scripts, game, wallet)?;
    let mv = Move {
        inputs: vec![(note, None)],
        expected: vec![forfeit.clone()],
        fire: None,
    };
    submit_move(client, scripts, game, mv).await?;
    Ok(forfeit)
}

/// The wallet publishes a stake note of `amount` fee-asset units.
pub async fn stake(
    client: &mut TestnetClient,
    scripts: &BattleshipScripts,
    parties: StakeParties,
    fee_asset: AssetId,
    amount: u64,
) -> Result<Note> {
    let expiry = now(client).await? + STAKE_EXPIRY_DELTA;
    let asset = FungibleAsset::new(fee_asset.faucet_id(), amount)?.into();
    let serial = Word::from([
        id_prefix(parties.my_wallet),
        id_suffix(parties.my_game),
        felt(expiry),
        felt(9),
    ]);
    let note = make_stake_note(scripts, parties, expiry, asset, serial)?;
    publish_note(client, parties.my_wallet, note.clone()).await?;
    Ok(note)
}

/// The wallet consumes `notes` in one transaction (a claim or a refund).
pub async fn claim(
    client: &mut TestnetClient,
    wallet: AccountId,
    notes: Vec<Note>,
) -> Result<TransactionId> {
    let request = TransactionRequestBuilder::new()
        .input_notes(notes.into_iter().map(|n| (n, None)))
        .build()
        .context("failed to build claim request")?;
    submit_and_wait(client, wallet, request).await
}

/// Note id of a note the client can see, for logging.
pub fn note_id_hex(note: &Note) -> String {
    note.id().to_hex()
}
