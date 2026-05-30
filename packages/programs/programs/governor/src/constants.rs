//! Compile-time constants for the governor program. Kept in their own
//! module so feature-specific files (`state`, `events`, `instructions/*`)
//! can reach them without pulling the whole prelude.

use anchor_lang::prelude::*;

/// Jito Vault program ID (same on devnet + mainnet).
pub const JITO_VAULT_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8");

/// MintTo ix discriminator on the Jito Vault program (kinobi u8 enum).
pub const JITO_VAULT_MINT_TO_DISC: u8 = 11;

/// EnqueueWithdrawal ix discriminator on the Jito Vault program.
pub const JITO_VAULT_ENQUEUE_WITHDRAWAL_DISC: u8 = 12;

/// BurnWithdrawalTicket ix discriminator on the Jito Vault program.
pub const JITO_VAULT_BURN_WITHDRAWAL_TICKET_DISC: u8 = 14;

/// Maximum number of in-flight Jito withdrawal tickets queued by the pool
/// at any time. Per-pool, not per-user (with the ephemeral-base-keypair
/// pattern, a single user can spawn arbitrarily many tickets).
///
/// Capped at 120: total account size = 69 bytes overhead + 81 bytes/ticket
/// × 120 = 9789 bytes, comfortably under Solana's 10240-byte
/// `MAX_PERMITTED_DATA_INCREASE` cap that applies to Anchor's init flow.
/// To go higher, add a chunked `grow_withdraw_queue` ix that reallocs in
/// 10240-byte increments — deferred to v2.
///
/// If hit, `enqueue_withdraw_via_pool` rejects until matured tickets are
/// reaped via `mature_withdrawal_tickets`.
pub const MAX_WITHDRAW_QUEUE_TICKETS: usize = 120;
