//! Anchor `#[event]` definitions emitted by the governor program. Names
//! are part of the on-chain log schema; renaming would break clients
//! decoding logs by discriminator.

use anchor_lang::prelude::*;

use crate::state::ReserveType;

#[event]
pub struct PoolCreatedEvent {
    pub pool: Pubkey,
    pub underlying_mint: Pubkey,
    pub wrapped_mint: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct SelfRegisterEvent {
    pub pool: Pubkey,
    pub wallet: Pubkey,
    pub gatekeeper_network: Pubkey,
}

#[event]
pub struct WrapEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub underlying_amount: u64,
    pub wrapped_amount: u64,
}

#[event]
pub struct WrapWithJitoVaultEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub jito_vault: Pubkey,
    pub pool_vrt_token_account: Pubkey,
    pub underlying_amount: u64,
    pub wrapped_amount: u64,
}

#[event]
pub struct UnwrapEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub underlying_amount: u64,
    pub wrapped_amount: u64,
}

#[event]
pub struct WrapNativeEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub underlying_amount: u64,
    pub wrapped_amount: u64,
}

#[event]
pub struct UnwrapNativeEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub underlying_amount: u64,
    pub wrapped_amount: u64,
}

#[event]
pub struct BorrowRateCurveUpdated {
    pub pool: Pubkey,
    pub reserve: Pubkey,
    pub reserve_type: ReserveType,
}

// ---------------------------------------------------------------------------
// csSOL-WT (withdraw-ticket) events
// ---------------------------------------------------------------------------

#[event]
pub struct EnqueueWithdrawEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub ticket: Pubkey,
    pub cssol_burned: u64,
    pub cssol_wt_minted: u64,
    pub slot: u64,
}

#[event]
pub struct MatureTicketEvent {
    pub pool: Pubkey,
    pub ticket: Pubkey,
    pub wsol_payout: u64,
}

#[event]
pub struct RedeemCsSolWtEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub cssol_wt_burned: u64,
    pub wsol_paid: u64,
}
