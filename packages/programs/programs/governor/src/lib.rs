use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_spl::token_interface;
use delta_mint::cpi as delta_cpi;
use delta_mint::cpi::accounts as delta_accounts;
use delta_mint::program::DeltaMint as DeltaMintProgram;

pub mod civic_pass;
use civic_pass::Pass;

// Phase-1 split: extracted compile-time constants, persisted state,
// errors, and emitted events into dedicated modules.
// Phase-2 split: extracted the Jito-vault flow + csSOL-WT lifecycle
// and the Solstice (eUSX/USX) unwrap-redeem flow into
// `instructions/jito.rs` and `instructions/solstice.rs`. The
// `#[program]` block keeps the original `pub fn` declarations (so
// Anchor ix discriminators stay byte-identical to the deployed
// binary) but their bodies are now one-line delegations into the
// instruction modules.
//
// Still inline in this file: pool init / management, admin /
// whitelist ixes, plain wrap-unwrap (cUSDY-style), wrap_native /
// unwrap_native (cSOL pool). Future phases can move these into
// `instructions/{pool,admin,wrap,wrap_native}.rs` using the same
// pattern.
pub mod constants;
pub mod state;
pub mod errors;
pub mod events;
pub mod instructions;

pub use constants::*;
pub use state::*;
pub use errors::*;
pub use events::*;
pub use instructions::*;

declare_id!("6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi");

#[program]
pub mod governor {
    use super::*;

    /// Create a new KYC-gated lending pool.
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        params: PoolParams,
    ) -> Result<()> {
        instructions::pool::initialize_pool(ctx, params)
    }

    /// Register the klend market and reserve addresses.
    /// Transitions Initializing → Active. Only root authority.
    pub fn register_lending_market(
        ctx: Context<RootOnly>,
        lending_market: Pubkey,
        collateral_reserve: Pubkey,
        borrow_reserve: Pubkey,
    ) -> Result<()> {
        instructions::pool::register_lending_market(ctx, lending_market, collateral_reserve, borrow_reserve)
    }

    /// Add an admin to the pool. Only the root authority can add admins.
    pub fn add_admin(ctx: Context<ManageAdmin>) -> Result<()> {
        instructions::admin::add_admin(ctx)
    }

    /// Remove an admin. Only root authority.
    pub fn remove_admin(_ctx: Context<RemoveAdmin>) -> Result<()> {
        instructions::admin::remove_admin(_ctx)
    }

    /// Add a participant via pool PDA (for pools where wrapping is activated).
    /// The pool PDA signs as the delta-mint authority (since authority was transferred).
    /// Can be called by root authority OR any admin.
    pub fn add_participant_via_pool(
        ctx: Context<AddParticipantViaPool>,
        role: ParticipantRole,
    ) -> Result<()> {
        instructions::admin::add_participant_via_pool(ctx, role)
    }

    /// Add a participant on a *secondary* MintConfig owned by the pool PDA
    /// (e.g. csSOL-WT, ceUSX-WT). The primary `add_participant_via_pool`
    /// pins `dm_mint_config` to `pool_config.dm_mint_config`, which only
    /// covers the wrap-token MintConfig — withdraw-ticket MintConfigs live
    /// outside that field. This ix accepts any MintConfig and signs as
    /// pool PDA = `MintConfig.authority` via the regular (non-co-authority)
    /// add_to_whitelist path.
    pub fn add_wt_participant_via_pool(
        ctx: Context<AddWtParticipantViaPool>,
        role: ParticipantRole,
    ) -> Result<()> {
        instructions::admin::add_wt_participant_via_pool(ctx, role)
    }

    /// Add a participant (KYC'd holder or liquidator bot).
    /// Can be called by root authority OR any admin.
    /// NOTE: Only works on pools where wrapping is NOT activated (authority not transferred).
    /// For activated pools, use add_participant_via_pool.
    pub fn add_participant(
        ctx: Context<AddParticipant>,
        role: ParticipantRole,
    ) -> Result<()> {
        instructions::admin::add_participant(ctx, role)
    }

    /// Mint wrapped tokens to a whitelisted holder.
    /// Can be called by root authority OR any admin.
    pub fn mint_wrapped(ctx: Context<MintWrapped>, amount: u64) -> Result<()> {
        instructions::wrap::mint_wrapped(ctx, amount)
    }

    /// Convert eUSX → ceUSX-WT (collateral swap leg). The user must
    /// already hold `amount` eUSX in their ATA at the moment this ix
    /// runs (typically obtained via a top-level `legacy_governor.unwrap`
    /// CPI in the same tx, after a klend collateral-swap that moved
    /// the user's ceUSX out of the obligation).
    ///
    /// CPIs Solstice's YieldVault `Unlock` (ix disc 0x1513d02bed3eff57,
    /// 13 accounts per the on-chain sample) which burns the user's eUSX
    /// and queues `amount` USX in the user's pending-unlock PDA. Then
    /// mints `amount` ceUSX-WT to the user via delta-mint, signed by
    /// the host pool PDA (pool_config).
    ///
    /// Atomicity: both halves run inside this ix, so the WT supply
    /// always equals the queued USX in Solstice (no over-mint).
    pub fn enqueue_eusx_unlock_via_pool(
        ctx: Context<EnqueueEusxUnlockViaPool>,
        amount: u64,
    ) -> Result<()> {
        instructions::solstice::enqueue_eusx_unlock_via_pool(ctx, amount)
    }

    /// Unwind ceUSX-WT → USX. Burns `amount` ceUSX-WT from the user
    /// (Token-2022, user signs directly), then CPIs Solstice's
    /// YieldVault `Withdraw` (disc 0xb712469c946da122, 8 accounts) which
    /// claims the matured queue entry and mints `amount` USX into the
    /// user's USX ATA.
    ///
    /// `Withdraw` takes no amount arg — it claims the full pending
    /// amount. We still take `amount` as the WT-burn quantity. They
    /// should match in healthy use; mismatch is the caller's problem
    /// (e.g. they queued more USX than they have WT for).
    ///
    /// The downstream Solstice `RequestRedeem` + `ConfirmRedeem`
    /// (USX → USDC) and the klend flash-repay are top-level user-signed
    /// ixes in the same tx, NOT CPI'd from here. Keeps account count
    /// manageable.
    pub fn redeem_ceusx_wt(ctx: Context<RedeemCeusxWt>, amount: u64) -> Result<()> {
        instructions::solstice::redeem_ceusx_wt(ctx, amount)
    }

    /// Mint a WT-style "secondary" wrapped token whose MintConfig authority
    /// is this pool — but whose mint pubkey is NOT `pool_config.wrapped_mint`.
    /// Sibling of `mint_wrapped`; only the constraint on `wrapped_mint`
    /// differs. Used to seed klend reserves for ceUSX-WT / future WT mints
    /// before their dedicated `enqueue_*_via_pool` ix is deployed.
    ///
    /// Authority gate: same `is_authorized` check as `mint_wrapped` — must
    /// be pool root or admin. This is a v1 bootstrap-only convenience and
    /// will be removed once the production WT-issuance ixes ship.
    ///
    /// Runtime safety: we read the MintConfig.authority field (offset
    /// 8..40 of the account data) and require it equals this pool's PDA,
    /// so cross-pool minting can't happen even if the caller passes the
    /// wrong MintConfig.
    pub fn admin_mint_wt(ctx: Context<AdminMintWt>, amount: u64) -> Result<()> {
        instructions::solstice::admin_mint_wt(ctx, amount)
    }

    /// Set the Civic gatekeeper network for self-registration.
    /// Only root authority. Pass Pubkey::default() to disable self-registration.
    /// Handles migration from pre-v2 PoolConfig accounts (expands if needed).
    pub fn set_gatekeeper_network(
        ctx: Context<SetGatekeeperNetwork>,
        gatekeeper_network: Pubkey,
    ) -> Result<()> {
        instructions::pool::set_gatekeeper_network(ctx, gatekeeper_network)
    }

    /// Set the klend elevation group for this pool. Only root authority.
    /// Handles migration from pre-v3 PoolConfig accounts (expands if needed).
    /// Note: this only updates the off-chain pool record; the actual klend
    /// reserve config still has to be applied via `update_reserve_config`.
    pub fn set_elevation_group(
        ctx: Context<SetElevationGroup>,
        elevation_group: u8,
    ) -> Result<()> {
        instructions::pool::set_elevation_group(ctx, elevation_group)
    }

    /// Self-register as a KYC'd holder by proving a valid Civic gateway token.
    /// The user signs and pays for their own whitelist PDA.
    /// Requires a valid, non-expired Civic pass from the pool's gatekeeper network.
    pub fn self_register(ctx: Context<SelfRegister>) -> Result<()> {
        instructions::admin::self_register(ctx)
    }

    /// Native-pool variant of `self_register`. Used by cSOL / cUSDC and
    /// any future native-wrap pool. Same Civic-gated permissionless
    /// onboarding semantics as `self_register`, but signs the
    /// delta-mint CPI with the native-pool PDA seeds
    /// `["native_pool", wrapped_mint]`. The original `self_register`
    /// can't be reused because Anchor's `seeds` constraint on
    /// `pool_config` rejects native-pool accounts before the handler
    /// runs (`ConstraintSeeds 2006`). Pair with `self_register` in a
    /// single signed tx so retail UIs can onboard a wallet onto
    /// every applicable pool in one Civic ceremony.
    pub fn self_register_native(ctx: Context<SelfRegisterNative>) -> Result<()> {
        instructions::admin::self_register_native(ctx)
    }

    /// Wrap underlying tokens into d-tokens (KYC-wrapped).
    /// User deposits underlying tokens (e.g., tUSDY) into the pool vault,
    /// and receives an equal amount of d-tokens (e.g., dtUSDY) in return.
    /// Requires the user to be KYC-whitelisted.
    pub fn wrap(ctx: Context<WrapTokens>, amount: u64) -> Result<()> {
        instructions::wrap::wrap(ctx, amount)
    }

    /// Wrap underlying into d-tokens AND deposit the underlying into a
    /// Jito Vault in the same transaction. The Jito Vault holds the
    /// canonical backing (VRT minted to a pool-PDA-owned VRT vault); the
    /// d-token (csSOL) is minted to the user 1:1 with the underlying as
    /// a fungible KYC-gated claim against pool VRT. This replaces the
    /// older `wrap`'s "park wSOL in a pool ATA" backing model.
    ///
    /// Flow:
    ///   1. Validate KYC (delta-mint::mint_to checks whitelist via CPI).
    ///   2. CPI Jito Vault MintTo. The pool PDA signs as `mintBurnAdmin`,
    ///      so the Vault's gate is satisfied without rotating it. User's
    ///      underlying ATA → vault's wSOL ATA. VRT → pool VRT vault.
    ///   3. CPI delta-mint::mint_to. Mints `amount` d-tokens to the user.
    ///
    /// Requires:
    ///   - Vault's `mintBurnAdmin` set to `pool_config` PDA
    ///     (one-time SetSecondaryAdmin during deploy).
    ///   - Pool VRT vault pre-created at ATA(vrt_mint, pool_pda, off_curve).
    ///   - User KYC-whitelisted on delta-mint.
    pub fn wrap_with_jito_vault(ctx: Context<WrapWithJitoVault>, amount: u64) -> Result<()> {
        instructions::jito::wrap_with_jito_vault(ctx, amount)
    }

    /// Unwrap d-tokens back into underlying tokens.
    /// User burns d-tokens and receives underlying tokens from the vault.
    /// Requires the user to be KYC-whitelisted.
    pub fn unwrap(ctx: Context<UnwrapTokens>, amount: u64) -> Result<()> {
        instructions::wrap::unwrap(ctx, amount)
    }

    /// Transfer delta-mint authority from deployer → pool PDA.
    /// This enables the wrap/unwrap flow. Call AFTER whitelisting is done.
    /// Only the root authority (current delta-mint authority) can call this.
    pub fn activate_wrapping(ctx: Context<ActivateWrapping>) -> Result<()> {
        instructions::pool::activate_wrapping(ctx)
    }

    /// Fix co_authority on an activated pool's MintConfig.
    /// Sets co_authority = pool PDA so whitelist_via_pool works.
    pub fn fix_co_authority(ctx: Context<FixCoAuthority>) -> Result<()> {
        instructions::admin::fix_co_authority(ctx)
    }

    /// Freeze or unfreeze the pool. Only root authority.
    pub fn set_pool_status(ctx: Context<RootOnly>, status: PoolStatus) -> Result<()> {
        instructions::pool::set_pool_status(ctx, status)
    }

    /// Set the borrow rate curve on a klend reserve via CPI.
    /// Authority must be both pool authority (or admin) AND the klend market owner.
    /// The curve is validated for monotonicity and bounds before forwarding to klend.
    pub fn set_borrow_rate_curve(
        ctx: Context<SetBorrowRateCurve>,
        reserve_type: ReserveType,
        curve: BorrowRateCurve,
    ) -> Result<()> {
        instructions::pool::set_borrow_rate_curve(ctx, reserve_type, curve)
    }

    // -----------------------------------------------------------------
    // csSOL-WT (withdraw ticket) flow — enqueue / mature / redeem
    // -----------------------------------------------------------------

    /// Pool-authority-only: register a Jito withdrawal ticket that
    /// already exists on-chain but is missing from the queue. Used to
    /// recover tickets stranded by layout migrations or by an early
    /// failure-then-success sequence where the ticket got created but
    /// the queue write didn't (e.g. partial-success orphans across our
    /// own program upgrades).
    ///
    /// The on-chain ticket account must:
    ///   - exist and be owned by the Jito Vault program
    ///   - have its `staker` field equal to the `staker` arg passed in
    ///   - have its `vault` field equal to the pool's csSOL Jito vault
    ///
    /// Validation lives in this ix (we read the raw bytes); we do NOT
    /// require the queue to deserialize correctly so this works after
    /// arbitrary layout changes.
    pub fn import_orphan_ticket(ctx: Context<ImportOrphanTicket>, staker: Pubkey, cssol_wt_amount: u64) -> Result<()> {
        instructions::jito::import_orphan_ticket(ctx, staker, cssol_wt_amount)
    }

    /// Pool-authority-only: closes the WithdrawQueue PDA and refunds
    /// rent to the authority. Required when the layout changes (we
    /// added `staker: Pubkey` to WithdrawTicket post-v1) — Anchor's
    /// strict `Account<WithdrawQueue>` would refuse to deserialize the
    /// old-layout account, so we use UncheckedAccount + verify the PDA
    /// derivation ourselves. Re-run `init_withdraw_queue` afterwards.
    pub fn close_withdraw_queue(ctx: Context<CloseWithdrawQueue>) -> Result<()> {
        instructions::jito::close_withdraw_queue(ctx)
    }

    /// One-shot init of the per-pool `WithdrawQueue` PDA. Holds a bounded
    /// list of `{ticket_pda, staker, cssol_wt_amount, created_at_slot}` records,
    /// plus a counter of pending wSOL backing already in the pool's
    /// `pending_wsol_pool` ATA but not yet redeemed.
    pub fn init_withdraw_queue(ctx: Context<InitWithdrawQueue>) -> Result<()> {
        instructions::jito::init_withdraw_queue(ctx)
    }

    /// User-facing entry that converts X csSOL into X csSOL-WT and
    /// queues X VRT for unstaking via Jito Vault. Permissionless (any
    /// KYC-whitelisted holder of csSOL can call). Inside one ix:
    ///
    ///   1. Token-2022 burn — X csSOL out of user's ATA (user signs as
    ///      authority; whitelist checked at the program level via the
    ///      `whitelist_entry` PDA passed in).
    ///   2. Jito EnqueueWithdrawal CPI — pool PDA (staker) burns X VRT
    ///      from `POOL_VRT_ATA`, ticket PDA + ticket-VRT-ATA hold the
    ///      VRT until epoch unlock. Pool PDA also signs as `base` and
    ///      `burn_signer` (mintBurnAdmin role on the vault).
    ///   3. delta-mint mint_to CPI — mints X csSOL-WT to user via the
    ///      pool PDA acting as authority on the *second* delta-mint
    ///      MintConfig (one per token).
    ///   4. Append a ticket record to the WithdrawQueue PDA.
    ///
    /// Calldata: u64 amount (in csSOL/VRT base units, decimals = 9).
    pub fn enqueue_withdraw_via_pool(ctx: Context<EnqueueWithdrawViaPool>, amount: u64) -> Result<()> {
        instructions::jito::enqueue_withdraw_via_pool(ctx, amount)
    }

    /// Permissionless: once a Jito withdrawal ticket has cleared its
    /// epoch-lock window, anyone can call this to:
    ///   1. CPI BurnWithdrawalTicket on the Jito Vault — pool PDA signs as
    ///      `staker` + `burn_signer`. Underlying wSOL flows from the Jito
    ///      vault's `vault_token_account` into the pool's
    ///      `pending_wsol_pool` ATA.
    ///   2. Mark the matching queue entry `redeemed = true` and bump
    ///      `pending_wsol`.
    ///
    /// Multiple tickets per call are not supported in v1 — caller fires
    /// one ix per matured ticket. Cheap enough at devnet/mainnet rates,
    /// and keeps account-list sizing bounded.
    pub fn mature_withdrawal_tickets(ctx: Context<MatureWithdrawalTicket>) -> Result<()> {
        instructions::jito::mature_withdrawal_tickets(ctx)
    }

    /// User burns X csSOL-WT and receives X wSOL from the pool's
    /// `pending_wsol_pool`. Permissionless (any holder of csSOL-WT). The
    /// burn does not go through delta-mint — Token-2022 burn is a
    /// permissionless authority-of-holder action — but the user must
    /// have wSOL ATA receiving capability (whitelist not strictly
    /// required to receive wSOL, since wSOL is not delta-mint-gated).
    ///
    /// Reverts with `RedeemExceedsPending` if the queue's matured
    /// pool is short. Caller should fire `mature_withdrawal_tickets`
    /// against any unlocked ticket first.
    pub fn redeem_cssol_wt(ctx: Context<RedeemCsSolWt>, amount: u64) -> Result<()> {
        instructions::jito::redeem_cssol_wt(ctx, amount)
    }

    // -----------------------------------------------------------------------
    // Native-wrap pool (cSOL, cUSDC, …)
    //
    // A simpler pool than the Jito-vault staker pool: 1:1 KYC-wrapper of an
    // SPL/SPL-2022 underlying. Mints the wrapper on `wrap_native`, burns
    // it on `unwrap_native`. Used for the loan-asset side of the credit
    // trade (cSOL ↔ wSOL, cUSDC ↔ Solstice USDC, etc.).
    //
    // Seeds: `[b"native_pool", wrapped_mint.as_ref()]` — distinct from
    // the staker pool's `[b"pool", underlying_mint]` to avoid PDA
    // collisions when underlying = wSOL (which the csSOL pool already
    // uses).
    // -----------------------------------------------------------------------

    /// Create a native-wrap pool. The wrapped mint must already exist
    /// (delta-mint MintConfig set up separately via `initialize_mint`).
    /// Same activate-wrapping flow as the staker pool — call
    /// `activate_wrapping_native` to transfer delta-mint authority to
    /// the pool PDA.
    pub fn initialize_native_pool(
        ctx: Context<InitializeNativePool>,
        params: NativePoolParams,
    ) -> Result<()> {
        instructions::pool::initialize_native_pool(ctx, params)
    }

    /// Wrap underlying (e.g. wSOL) → KYC wrapper (e.g. cSOL) 1:1.
    /// Whitelist check fires inside delta-mint's `mint_to`.
    pub fn wrap_native(ctx: Context<WrapNative>, amount: u64) -> Result<()> {
        instructions::wrap_native::wrap_native(ctx, amount)
    }

    /// Unwrap wrapper → underlying 1:1. No whitelist check on burn —
    /// the wrapper had to pass through KYC to be in circulation, and
    /// the borrower path of the credit trade depends on this being
    /// unconditionally callable (so klend-borrowed cSOL can be
    /// auto-unwrapped to wSOL in the same tx).
    pub fn unwrap_native(ctx: Context<UnwrapNative>, amount: u64) -> Result<()> {
        instructions::wrap_native::unwrap_native(ctx, amount)
    }

    /// Whitelist a wallet on a native-wrap pool. Mirrors
    /// `add_participant_via_pool` for the native_pool seed shape so
    /// post-activation pools (where the pool PDA is delta-mint
    /// co_authority) can issue whitelist entries via CPI.
    pub fn add_participant_native_via_pool(
        ctx: Context<AddParticipantNativeViaPool>,
        role: ParticipantRole,
    ) -> Result<()> {
        instructions::admin::add_participant_native_via_pool(ctx, role)
    }

    /// Mint a wrapper to a whitelisted destination via the native pool.
    /// Used by the bootstrap to seed klend reserves with ≥1 unit of the
    /// wrapper before `init_reserve`.
    pub fn mint_wrapped_native(ctx: Context<MintWrappedNative>, amount: u64) -> Result<()> {
        instructions::wrap_native::mint_wrapped_native(ctx, amount)
    }

    /// Transfer delta-mint authority → native pool PDA.
    /// Mirrors `activate_wrapping` for the staker pool.
    pub fn activate_wrapping_native(ctx: Context<ActivateWrappingNative>) -> Result<()> {
        instructions::pool::activate_wrapping_native(ctx)
    }
}

// ---------------------------------------------------------------------------
// Helper: check if signer is root authority or has an admin PDA
// ---------------------------------------------------------------------------

pub fn is_authorized(signer: &Pubkey, pool_authority: &Pubkey, pool_key: &Pubkey, admin_entry: &Option<Account<AdminEntry>>) -> bool {
    if signer == pool_authority {
        return true;
    }
    if let Some(admin) = admin_entry {
        return admin.wallet == *signer && admin.pool == *pool_key;
    }
    false
}

// ---------------------------------------------------------------------------
// Account Contexts
// ---------------------------------------------------------------------------












// ----------------------------------------------------------------------
// Native-wrap pool accounts (cSOL, cUSDC, …)
// ----------------------------------------------------------------------















// Account contexts for the csSOL-WT flow
// ---------------------------------------------------------------------------






