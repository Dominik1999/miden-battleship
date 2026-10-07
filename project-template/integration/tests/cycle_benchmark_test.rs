//! Cycle-count measurements for the battleship transactions (informational; run with
//! `cargo test -p integration --release --test cycle_benchmark_test -- --nocapture`).

mod common;

use anyhow::Result;
use common::*;
use miden_client::transaction::ExecutedTransaction;

fn report(label: &str, executed: &ExecutedTransaction) {
    let m = executed.measurements();
    let total = m.total_cycles();
    let padded = total.next_power_of_two();
    println!(
        "{label:<28} total {total:>8} cycles (2^{} trace)  prologue {:>6}  notes {:>7}  script {:>7}  epilogue {:>6}  auth {:>6}  fee {}",
        padded.trailing_zeros(),
        m.prologue,
        m.notes_processing,
        m.tx_script_processing,
        m.epilogue,
        m.auth_procedure,
        executed.compute_fee().as_u64(),
    );
}

#[tokio::test]
async fn benchmark_all_transactions() -> Result<()> {
    let mut game = Game::new()?;
    let setup = game.setup(game.a, game.b, A_COMMITMENT).await?;
    game.setup(game.b, game.a, B_COMMITMENT).await?;
    let challenge = game.challenge_note()?;
    let publish = game.publish(game.a, challenge.clone()).await?;
    let accept_challenge = game.consume(game.b, &challenge).await?;
    let accept = game.accept_note()?;
    game.publish(game.b, accept.clone()).await?;
    game.consume(game.a, &accept).await?;
    let (shot_hit, result) = game.fire(game.a, game.b, 0, 0, 1).await?;
    let consume_result = game.consume(game.a, &result).await?;
    let (shot_miss, _) = game.fire(game.b, game.a, 9, 9, 2).await?;

    println!();
    report("setup tx script", &setup);
    report("publish note (send_notes)", &publish);
    report("consume challenge", &accept_challenge);
    report("consume shot (hit)", &shot_hit);
    report("consume shot (miss)", &shot_miss);
    report("consume result note", &consume_result);
    println!(
        "result note script root: {:?}",
        game.scripts
            .result_script_root()
            .iter()
            .map(|f| f.as_canonical_u64())
            .collect::<Vec<_>>()
    );
    Ok(())
}
