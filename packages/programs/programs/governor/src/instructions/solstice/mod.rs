//! Solstice (eUSX / USX) ix family. Three handlers + their accounts:
//!
//! * `enqueue_eusx_unlock_via_pool` — burns user's eUSX via Solstice
//!   YieldVault `Unlock`, queues USX in Solstice's pending-unlock PDA,
//!   mints ceUSX-WT 1:1 to the user. Atomic.
//! * `redeem_ceusx_wt` — burns ceUSX-WT, claims the matured Solstice
//!   pending entry via `Withdraw`, USX lands in the user's USX ATA.
//! * `admin_mint_wt` — bootstrap-only convenience to seed klend reserves
//!   for any WT mint owned by this pool, before the dedicated
//!   `enqueue_*_via_pool` ix ships. Authority-gated.
//!
//! Function names match the original `#[program]` block exactly so
//! Anchor ix discriminators (`sha256("global:<name>")[..8]`) stay
//! identical to the deployed binary.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_spl::token_interface;
use delta_mint::cpi as delta_cpi;
use delta_mint::cpi::accounts as delta_accounts;
use delta_mint::program::DeltaMint as DeltaMintProgram;

use crate::state::*;
use crate::errors::*;
use crate::is_authorized;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub fn enqueue_eusx_unlock_via_pool(
    ctx: Context<EnqueueEusxUnlockViaPool>,
    amount: u64,
) -> Result<()> {
    require!(
        ctx.accounts.pool_config.status == PoolStatus::Active,
        GovernorError::PoolNotActive
    );
    require!(amount > 0, GovernorError::InvalidPoolStatus);

    // Validate the WT MintConfig.authority equals this pool — same
    // runtime check as admin_mint_wt. Layout: 8 disc + 32 authority.
    {
        let mc_data = ctx.accounts.wt_mint_config.try_borrow_data()?;
        require!(mc_data.len() >= 40, GovernorError::InvalidPoolStatus);
        let stored_authority = Pubkey::try_from(&mc_data[8..40])
            .map_err(|_| GovernorError::Unauthorized)?;
        require_keys_eq!(
            stored_authority,
            ctx.accounts.pool_config.key(),
            GovernorError::Unauthorized
        );
    }

    // 1. CPI Solstice YieldVault.Unlock — burns user's eUSX, queues
    //    USX in pending-unlock PDA. The 13-account list is taken
    //    from the on-chain Unlock sample (see /tmp/usx-idl/samples/
    //    yieldvault_Unlock.json). User signs as outer-tx signer;
    //    this CPI just passes them through.
    let unlock_disc: [u8; 8] = [0x15, 0x13, 0xd0, 0x2b, 0xed, 0x3e, 0xff, 0x57];
    let mut unlock_data = Vec::with_capacity(8 + 8);
    unlock_data.extend_from_slice(&unlock_disc);
    unlock_data.extend_from_slice(&amount.to_le_bytes());
    let unlock_metas = vec![
        AccountMeta::new(ctx.accounts.user.key(), true),                       // [0] user (signer)
        AccountMeta::new(ctx.accounts.user.key(), true),                       // [1] user (dup)
        AccountMeta::new(ctx.accounts.solstice_vault_state.key(), false),      // [2]
        AccountMeta::new(ctx.accounts.solstice_vault_eusx_account.key(), false), // [3]
        AccountMeta::new(ctx.accounts.eusx_mint.key(), false),                 // [4]
        AccountMeta::new(ctx.accounts.user_eusx_ata.key(), false),             // [5]
        AccountMeta::new(ctx.accounts.usx_mint.key(), false),                  // [6]
        AccountMeta::new(ctx.accounts.solstice_config_a.key(), false),         // [7]
        AccountMeta::new(ctx.accounts.solstice_config_b.key(), false),         // [8]
        AccountMeta::new(ctx.accounts.user_pending_unlock_pda.key(), false),   // [9]
        AccountMeta::new(ctx.accounts.user_pending_unlock_pda_b.key(), false), // [10]
        AccountMeta::new_readonly(ctx.accounts.solstice_token_program.key(), false), // [11]
        AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),   // [12]
    ];
    invoke(
        &Instruction {
            program_id: ctx.accounts.solstice_yield_vault_program.key(),
            accounts: unlock_metas,
            data: unlock_data,
        },
        &[
            ctx.accounts.solstice_yield_vault_program.to_account_info(),
            ctx.accounts.user.to_account_info(),
            ctx.accounts.solstice_vault_state.to_account_info(),
            ctx.accounts.solstice_vault_eusx_account.to_account_info(),
            ctx.accounts.eusx_mint.to_account_info(),
            ctx.accounts.user_eusx_ata.to_account_info(),
            ctx.accounts.usx_mint.to_account_info(),
            ctx.accounts.solstice_config_a.to_account_info(),
            ctx.accounts.solstice_config_b.to_account_info(),
            ctx.accounts.user_pending_unlock_pda.to_account_info(),
            ctx.accounts.user_pending_unlock_pda_b.to_account_info(),
            ctx.accounts.solstice_token_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    // 2. Mint ceUSX-WT to user. Pool PDA signs as MintConfig
    //    authority. Reuses the same seed-derivation logic as
    //    admin_mint_wt (handles both staker and native pool seeds).
    let underlying = ctx.accounts.pool_config.underlying_mint;
    let wrapped = ctx.accounts.pool_config.wrapped_mint;
    let bump = ctx.accounts.pool_config.bump;
    let staker_seeds: &[&[u8]] = &[b"pool", underlying.as_ref(), &[bump]];
    let native_seeds: &[&[u8]] = &[b"native_pool", wrapped.as_ref(), &[bump]];
    let (staker_pda, _) = Pubkey::find_program_address(
        &[b"pool", underlying.as_ref()], &crate::ID,
    );
    let signer_seeds: &[&[&[u8]]] = if staker_pda == ctx.accounts.pool_config.key() {
        &[staker_seeds]
    } else {
        &[native_seeds]
    };

    delta_cpi::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.delta_mint_program.to_account_info(),
            delta_accounts::MintTokens {
                authority: ctx.accounts.pool_config.to_account_info(),
                mint_config: ctx.accounts.wt_mint_config.to_account_info(),
                mint: ctx.accounts.wt_mint.to_account_info(),
                mint_authority: ctx.accounts.wt_mint_authority.to_account_info(),
                whitelist_entry: ctx.accounts.user_wt_whitelist_entry.to_account_info(),
                destination: ctx.accounts.user_wt_ata.to_account_info(),
                token_program: ctx.accounts.wt_token_program.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    Ok(())
}

pub fn redeem_ceusx_wt(ctx: Context<RedeemCeusxWt>, amount: u64) -> Result<()> {
    require!(
        ctx.accounts.pool_config.status == PoolStatus::Active,
        GovernorError::PoolNotActive
    );
    require!(amount > 0, GovernorError::InvalidPoolStatus);

    // 1. Burn ceUSX-WT from user (user is authority on their own
    //    ATA — no PDA signer needed).
    token_interface::burn(
        CpiContext::new(
            ctx.accounts.wt_token_program.to_account_info(),
            token_interface::Burn {
                mint: ctx.accounts.wt_mint.to_account_info(),
                from: ctx.accounts.user_wt_ata.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // 2. CPI Solstice.Withdraw (no args — claims full pending). The
    //    8-account list is from the on-chain Withdraw sample.
    let withdraw_disc: [u8; 8] = [0xb7, 0x12, 0x46, 0x9c, 0x94, 0x6d, 0xa1, 0x22];
    let withdraw_metas = vec![
        AccountMeta::new(ctx.accounts.user.key(), true),
        AccountMeta::new(ctx.accounts.user.key(), true),
        AccountMeta::new(ctx.accounts.solstice_vault_state.key(), false),
        AccountMeta::new(ctx.accounts.usx_mint.key(), false),
        AccountMeta::new(ctx.accounts.user_pending_unlock_pda.key(), false),
        AccountMeta::new(ctx.accounts.user_usx_ata.key(), false),
        AccountMeta::new(ctx.accounts.solstice_vault_usx_account.key(), false),
        AccountMeta::new_readonly(ctx.accounts.solstice_token_program.key(), false),
    ];
    invoke(
        &Instruction {
            program_id: ctx.accounts.solstice_yield_vault_program.key(),
            accounts: withdraw_metas,
            data: withdraw_disc.to_vec(),
        },
        &[
            ctx.accounts.solstice_yield_vault_program.to_account_info(),
            ctx.accounts.user.to_account_info(),
            ctx.accounts.solstice_vault_state.to_account_info(),
            ctx.accounts.usx_mint.to_account_info(),
            ctx.accounts.user_pending_unlock_pda.to_account_info(),
            ctx.accounts.user_usx_ata.to_account_info(),
            ctx.accounts.solstice_vault_usx_account.to_account_info(),
            ctx.accounts.solstice_token_program.to_account_info(),
        ],
    )?;

    Ok(())
}

pub fn admin_mint_wt(ctx: Context<AdminMintWt>, amount: u64) -> Result<()> {
    require!(
        ctx.accounts.pool_config.status == PoolStatus::Active,
        GovernorError::PoolNotActive
    );

    // Validate that the supplied MintConfig is owned-by-authority by
    // this pool — i.e. we can sign for it. MintConfig layout:
    //   8 bytes Anchor disc + 32 bytes authority + ... .
    let mc_data = ctx.accounts.dm_mint_config.try_borrow_data()?;
    require!(mc_data.len() >= 40, GovernorError::InvalidPoolStatus);
    let stored_authority = Pubkey::try_from(&mc_data[8..40])
        .map_err(|_| GovernorError::Unauthorized)?;
    drop(mc_data);
    require_keys_eq!(
        stored_authority,
        ctx.accounts.pool_config.key(),
        GovernorError::Unauthorized
    );

    // Sign with the pool PDA — same seed shape as the rest of the
    // pool-CPI ixes (`[b"pool", underlying_mint, bump]` for
    // initialize_pool pools; `[b"native_pool", wrapped_mint, bump]`
    // for native pools). Try the staker shape first; fall back to
    // native if needed.
    let underlying = ctx.accounts.pool_config.underlying_mint;
    let wrapped = ctx.accounts.pool_config.wrapped_mint;
    let bump = ctx.accounts.pool_config.bump;
    let staker_seeds: &[&[u8]] = &[b"pool", underlying.as_ref(), &[bump]];
    let native_seeds: &[&[u8]] = &[b"native_pool", wrapped.as_ref(), &[bump]];

    // Re-derive both possibilities and pick the one matching the
    // pool's actual key. This makes the ix work for both pool seed
    // shapes without forcing the caller to know which one.
    let (staker_pda, _) = Pubkey::find_program_address(
        &[b"pool", underlying.as_ref()], &crate::ID,
    );
    let signer_seeds: &[&[&[u8]]] = if staker_pda == ctx.accounts.pool_config.key() {
        &[staker_seeds]
    } else {
        &[native_seeds]
    };

    delta_cpi::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.delta_mint_program.to_account_info(),
            delta_accounts::MintTokens {
                authority: ctx.accounts.pool_config.to_account_info(),
                mint_config: ctx.accounts.dm_mint_config.to_account_info(),
                mint: ctx.accounts.wt_mint.to_account_info(),
                mint_authority: ctx.accounts.dm_mint_authority.to_account_info(),
                whitelist_entry: ctx.accounts.whitelist_entry.to_account_info(),
                destination: ctx.accounts.destination.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/// Accounts for `enqueue_eusx_unlock_via_pool`. Carries every account
/// the Solstice YieldVault `Unlock` CPI needs (13 from the on-chain
/// sample) plus the delta-mint accounts to mint ceUSX-WT against the
/// host pool's authority.
///
/// Why pool_config is `mut`: same as `admin_mint_wt` — we use
/// `pool_config.to_account_info()` as the `authority` of the inner
/// `delta_mint::mint_to` CPI, whose authority slot is `mut` in
/// delta-mint, and Solana's CPI privilege rules require the outer
/// scope to also be writable.
#[derive(Accounts)]
pub struct EnqueueEusxUnlockViaPool<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub pool_config: Account<'info, PoolConfig>,

    // ── ceUSX-WT mint side (delta-mint) ──
    /// CHECK: ceUSX-WT MintConfig — authority validated at runtime.
    #[account(mut)]
    pub wt_mint_config: UncheckedAccount<'info>,

    /// CHECK: ceUSX-WT mint.
    #[account(mut)]
    pub wt_mint: UncheckedAccount<'info>,

    /// CHECK: ceUSX-WT delta-mint authority PDA.
    pub wt_mint_authority: UncheckedAccount<'info>,

    /// CHECK: User's whitelist entry for the ceUSX-WT MintConfig.
    pub user_wt_whitelist_entry: UncheckedAccount<'info>,

    /// CHECK: User's ceUSX-WT ATA (destination).
    #[account(mut)]
    pub user_wt_ata: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,

    /// CHECK: Token-2022 (ceUSX-WT mint program).
    pub wt_token_program: UncheckedAccount<'info>,

    // ── Solstice YieldVault Unlock side ──
    /// CHECK: Solstice YieldVault program.
    pub solstice_yield_vault_program: UncheckedAccount<'info>,

    /// CHECK: YieldVault state (acc[2]).
    #[account(mut)]
    pub solstice_vault_state: UncheckedAccount<'info>,

    /// CHECK: YieldVault eUSX-side token account (acc[3]).
    #[account(mut)]
    pub solstice_vault_eusx_account: UncheckedAccount<'info>,

    /// CHECK: eUSX mint (acc[4]).
    #[account(mut)]
    pub eusx_mint: UncheckedAccount<'info>,

    /// CHECK: User's eUSX ATA (acc[5]). User must already hold `amount`
    /// here at ix entry; Solstice burns from this.
    #[account(mut)]
    pub user_eusx_ata: UncheckedAccount<'info>,

    /// CHECK: USX mint (acc[6]).
    #[account(mut)]
    pub usx_mint: UncheckedAccount<'info>,

    /// CHECK: Solstice config-A (acc[7] in Unlock sample). Per-vault
    /// PDA whose role we haven't pinned without an IDL; passed as-is.
    #[account(mut)]
    pub solstice_config_a: UncheckedAccount<'info>,

    /// CHECK: Solstice config-B (acc[8] in Unlock sample).
    #[account(mut)]
    pub solstice_config_b: UncheckedAccount<'info>,

    /// CHECK: User's pending-unlock PDA (acc[9]). YieldVault writes
    /// `amount` and the unlock-after timestamp here.
    #[account(mut)]
    pub user_pending_unlock_pda: UncheckedAccount<'info>,

    /// CHECK: Second per-user PDA (acc[10] in Unlock sample). Possibly
    /// a redeemable-amount tracker.
    #[account(mut)]
    pub user_pending_unlock_pda_b: UncheckedAccount<'info>,

    /// CHECK: SPL Token program (acc[11] = TokenkegQ…).
    pub solstice_token_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Accounts for `redeem_ceusx_wt`. Burns ceUSX-WT (Token-2022, user is
/// authority on their own ATA), then CPIs Solstice's YieldVault
/// `Withdraw` (8 accounts from the on-chain sample) which delivers the
/// queued USX into `user_usx_ata`.
#[derive(Accounts)]
pub struct RedeemCeusxWt<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    pub pool_config: Account<'info, PoolConfig>,

    // ── ceUSX-WT burn side ──
    /// CHECK: ceUSX-WT mint.
    #[account(mut)]
    pub wt_mint: UncheckedAccount<'info>,

    /// CHECK: User's ceUSX-WT ATA (source — burned).
    #[account(mut)]
    pub user_wt_ata: UncheckedAccount<'info>,

    /// CHECK: Token-2022.
    pub wt_token_program: UncheckedAccount<'info>,

    // ── Solstice YieldVault Withdraw side ──
    /// CHECK: Solstice YieldVault program.
    pub solstice_yield_vault_program: UncheckedAccount<'info>,

    /// CHECK: YieldVault state (Withdraw acc[2]).
    #[account(mut)]
    pub solstice_vault_state: UncheckedAccount<'info>,

    /// CHECK: USX mint (Withdraw acc[3]).
    #[account(mut)]
    pub usx_mint: UncheckedAccount<'info>,

    /// CHECK: User's pending-unlock PDA (Withdraw acc[4]).
    #[account(mut)]
    pub user_pending_unlock_pda: UncheckedAccount<'info>,

    /// CHECK: User's USX ATA (Withdraw acc[5] — destination).
    #[account(mut)]
    pub user_usx_ata: UncheckedAccount<'info>,

    /// CHECK: YieldVault USX vault (Withdraw acc[6]). Note: this is a
    /// DIFFERENT token account than `solstice_vault_eusx_account` used
    /// during Unlock — Solstice keeps eUSX and USX in separate vaults.
    #[account(mut)]
    pub solstice_vault_usx_account: UncheckedAccount<'info>,

    /// CHECK: SPL Token program.
    pub solstice_token_program: UncheckedAccount<'info>,
}

/// Accounts for the bootstrap-only `admin_mint_wt` ix. Mirrors
/// `MintWrapped` except (a) `wt_mint` carries no `address = ...`
/// constraint (so any mint whose MintConfig.authority equals this pool
/// can be passed), and (b) `dm_mint_config` likewise — the runtime
/// check inside the handler enforces the authority match against the
/// pool PDA. Used to seed klend reserves before the production WT
/// issuance ixes ship.
#[derive(Accounts)]
pub struct AdminMintWt<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Pool whose PDA is the MintConfig authority. Marked writable
    /// because we pass `pool_config.to_account_info()` as the `authority`
    /// of the inner `delta_mint::mint_to` CPI; that CPI's authority
    /// account is `mut` in the delta-mint program, and Solana's CPI
    /// privilege rules require the outer scope to be writable too.
    #[account(
        mut,
        constraint = is_authorized(
            &authority.key(),
            &pool_config.authority,
            &pool_config.key(),
            &admin_entry,
        ) @ GovernorError::Unauthorized
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// Optional admin PDA. Pass if signer is not root authority.
    pub admin_entry: Option<Account<'info, AdminEntry>>,

    /// CHECK: delta-mint MintConfig — authority is validated at runtime
    /// in the handler against `pool_config.key()`. Cannot use the static
    /// `address = pool_config.dm_mint_config` constraint because we
    /// explicitly want this to differ from the pool's primary wrapped mint.
    #[account(mut)]
    pub dm_mint_config: UncheckedAccount<'info>,

    /// CHECK: Token-2022 WT mint to mint into. No constraint vs
    /// pool_config; the MintConfig.authority check is the gate.
    #[account(mut)]
    pub wt_mint: UncheckedAccount<'info>,

    /// CHECK: delta-mint mint authority PDA — supplied by caller, the
    /// delta-mint program validates it against the MintConfig.
    pub dm_mint_authority: UncheckedAccount<'info>,

    /// CHECK: WhitelistEntry — validated by delta-mint CPI.
    pub whitelist_entry: UncheckedAccount<'info>,

    /// CHECK: Recipient token account.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub token_program: Interface<'info, token_interface::TokenInterface>,
}
