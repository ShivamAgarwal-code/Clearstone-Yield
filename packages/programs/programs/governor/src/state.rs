//! Persisted account state and serialised value types for the governor.
//! Anchor account discriminators are derived from the *struct name*
//! (`sha256("account:<Name>")[..8]`), so renaming any of these would
//! break already-deployed pools — keep the names stable across moves.

use anchor_lang::prelude::*;

use crate::constants::MAX_WITHDRAW_QUEUE_TICKETS;
use crate::errors::GovernorError;

// ---------------------------------------------------------------------------
// Pool / role / curve state
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct PoolConfig {
    pub authority: Pubkey,
    pub underlying_mint: Pubkey,
    pub underlying_oracle: Pubkey,
    pub borrow_mint: Pubkey,
    pub borrow_oracle: Pubkey,
    pub wrapped_mint: Pubkey,
    pub dm_mint_config: Pubkey,
    pub lending_market: Pubkey,
    pub collateral_reserve: Pubkey,
    pub borrow_reserve: Pubkey,
    pub decimals: u8,
    pub ltv_pct: u8,
    pub liquidation_threshold_pct: u8,
    pub status: PoolStatus,
    pub bump: u8,
    /// Civic gatekeeper network for self-registration. Pubkey::default() = disabled.
    /// Added in v2 — must be at end for backwards compatibility with existing accounts.
    pub gatekeeper_network: Pubkey,
    /// Klend elevation group this pool's reserves belong to. 0 = no group.
    /// Added in v3 — appended after `gatekeeper_network` for backwards compatibility.
    pub elevation_group: u8,
}

#[account]
#[derive(InitSpace)]
pub struct AdminEntry {
    pub pool: Pubkey,
    pub wallet: Pubkey,
    pub added_by: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum PoolStatus {
    Initializing,
    Active,
    Frozen,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PoolParams {
    pub underlying_oracle: Pubkey,
    pub borrow_mint: Pubkey,
    pub borrow_oracle: Pubkey,
    pub decimals: u8,
    pub ltv_pct: u8,
    pub liquidation_threshold_pct: u8,
    /// Klend elevation group for the reserve pair. 0 = no group.
    pub elevation_group: u8,
}

/// Init params for a native-wrap pool (cSOL, cUSDC, …). Slimmer than
/// `PoolParams` because there's no klend market or borrow leg — just
/// a 1:1 KYC wrapper.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct NativePoolParams {
    pub underlying_oracle: Pubkey,
    pub decimals: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ParticipantRole {
    Holder,
    Liquidator,
    /// Program-owned custody PDA from an integrating protocol (e.g.
    /// clearstone_core's `escrow_sy` / `token_fee_treasury_sy` / vault
    /// `yield_position` SY ATA). Whitelisted so the PDA can hold the mint;
    /// not eligible for `mint_to`.
    Escrow,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ReserveType {
    Collateral,
    Borrow,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct CurvePoint {
    pub utilization_rate_bps: u32,
    pub borrow_rate_bps: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct BorrowRateCurve {
    pub points: [CurvePoint; 11],
}

impl BorrowRateCurve {
    pub fn validate(&self) -> Result<()> {
        // First point must start at 0% utilization
        require!(
            self.points[0].utilization_rate_bps == 0,
            GovernorError::InvalidCurve
        );
        // Last point must be at 100% utilization
        require!(
            self.points[10].utilization_rate_bps == 10_000,
            GovernorError::InvalidCurve
        );

        for i in 0..11 {
            // Utilization must be in [0, 10000]
            require!(
                self.points[i].utilization_rate_bps <= 10_000,
                GovernorError::InvalidCurve
            );
            // Borrow rate cap: 5000 bps = 50% APR (klend devnet max)
            require!(
                self.points[i].borrow_rate_bps <= 5_000,
                GovernorError::InvalidCurve
            );
        }

        for i in 1..11 {
            // Utilization must be strictly increasing (klend rejects duplicates)
            require!(
                self.points[i].utilization_rate_bps > self.points[i - 1].utilization_rate_bps,
                GovernorError::InvalidCurve
            );
            // Borrow rate must be strictly increasing (klend rejects flat segments)
            require!(
                self.points[i].borrow_rate_bps > self.points[i - 1].borrow_rate_bps,
                GovernorError::InvalidCurve
            );
        }

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// csSOL-WT (withdraw-ticket) state
// ---------------------------------------------------------------------------

#[account]
pub struct WithdrawQueue {
    /// Pool this queue belongs to.
    pub pool_config: Pubkey,
    /// wSOL currently sitting in `pool_pending_wsol_pool` that has been
    /// matured from a Jito ticket but not yet redeemed by a csSOL-WT
    /// burn. Mirrors `pool_pending_wsol_ata`'s real balance modulo
    /// dust / on-chain rounding.
    pub pending_wsol: u64,
    /// Lifetime totals for analytics + reconciliation.
    pub total_cssol_wt_minted: u64,
    pub total_cssol_wt_redeemed: u64,
    /// Bounded list of in-flight tickets. Capacity-checked in
    /// `enqueue_withdraw_via_pool`. Redeemed entries are eagerly
    /// drained from the head on `mature_withdrawal_tickets`.
    pub tickets: Vec<WithdrawTicket>,
    pub bump: u8,
}

impl WithdrawQueue {
    /// 32 (pool_config) + 8 (pending_wsol) + 8 (minted) + 8 (redeemed)
    ///   + 4 (Vec len prefix) + N * sizeof(WithdrawTicket) + 1 (bump)
    /// WithdrawTicket = 32 + 32 + 8 + 8 + 1 = 81.
    pub const INIT_SPACE: usize = 32 + 8 + 8 + 8 + 4 + (MAX_WITHDRAW_QUEUE_TICKETS * 81) + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct WithdrawTicket {
    /// The Jito Vault `VaultStakerWithdrawalTicket` PDA we own.
    pub ticket_pda: Pubkey,
    /// The user who originally enqueued this ticket and is the
    /// `base` + `staker` of the underlying Jito ticket. Required for
    /// `mature_withdrawal_tickets` to satisfy Jito's check
    /// `ticket.staker == provided_staker` (error 1042). Also lets the
    /// playground UI filter "your tickets" without a per-ticket
    /// extra RPC fetch.
    pub staker: Pubkey,
    /// csSOL-WT minted to the requester at enqueue-time. wSOL payout
    /// after Jito unlock will land 1:1 against this (less any vault
    /// fees, which Jito takes inside its own ix and we do not
    /// double-account here).
    pub cssol_wt_amount: u64,
    /// Slot at which the ticket was enqueued. Useful for off-chain
    /// "should this be matured yet?" reasoning; the on-chain unlock
    /// gate is enforced by Jito Vault itself, not by us.
    pub created_at_slot: u64,
    /// True once `mature_withdrawal_tickets` has redeemed this entry
    /// against Jito (wSOL has flowed into our pending pool).
    pub redeemed: bool,
}
