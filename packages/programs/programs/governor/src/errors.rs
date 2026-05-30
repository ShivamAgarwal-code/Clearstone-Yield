//! Error variants emitted by the governor program. The variant **order
//! is load-bearing** — Anchor numbers them sequentially and existing
//! deployments + clients depend on the codes. Append new variants only.

use anchor_lang::prelude::*;

#[error_code]
pub enum GovernorError {
    #[msg("Pool is not in the expected status for this operation")]
    InvalidPoolStatus,
    #[msg("Pool is not active — register lending market first")]
    PoolNotActive,
    #[msg("Signer is not the pool authority or an approved admin")]
    Unauthorized,
    #[msg("Self-registration is not enabled for this pool")]
    SelfRegisterDisabled,
    #[msg("Invalid or expired Civic gateway token")]
    InvalidGatewayToken,
    #[msg("Reserve address does not match pool config")]
    ReserveMismatch,
    #[msg("Lending market does not match pool config")]
    MarketMismatch,
    #[msg("Invalid borrow rate curve: must be sorted, bounded, start at 0% and end at 100%")]
    InvalidCurve,
    #[msg("Withdraw queue is at capacity — wait for matured tickets to be reaped before enqueueing more")]
    WithdrawQueueFull,
    #[msg("Withdrawal ticket is not in this pool's queue or already redeemed")]
    TicketNotFound,
    #[msg("Redeem amount exceeds the queue's currently-matured wSOL pool")]
    RedeemExceedsPending,
}
