//! Native-asset wrap / unwrap (cSOL, cUSDC). Counterpart to the
//! cUSDY-style flow in [`super::wrap`]; the difference is the underlying
//! is a SPL Token (wSOL / sUSDC) rather than a delta-mint d-token, so
//! the pool just custody-vaults it without the Jito-vault staking step
//! that [`super::jito::wrap_with_jito_vault`] adds.
//!
//! * `wrap_native` — user wraps wSOL / sUSDC into the KYC d-token.
//! * `unwrap_native` — burns the d-token, returns the underlying.
//! * `mint_wrapped_native` — admin-only seed mint.

use anchor_lang::prelude::*;
use anchor_spl::token_interface;
use delta_mint::cpi as delta_cpi;
use delta_mint::cpi::accounts as delta_accounts;
use delta_mint::program::DeltaMint as DeltaMintProgram;

use crate::state::*;
use crate::errors::*;
use crate::events::*;
use crate::is_authorized;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub fn wrap_native(ctx: Context<WrapNative>, amount: u64) -> Result<()> {
    require!(
        ctx.accounts.pool_config.status == PoolStatus::Active,
        GovernorError::PoolNotActive
    );
    require!(amount > 0, GovernorError::InvalidPoolStatus);

    // 1. user_underlying_ata → pool_vault (transfer_checked enforces mint+decimals)
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.underlying_token_program.to_account_info(),
            token_interface::TransferChecked {
                from: ctx.accounts.user_underlying_ata.to_account_info(),
                mint: ctx.accounts.underlying_mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.pool_config.decimals,
    )?;

    // 2. Mint wrapper to user via delta-mint CPI; pool PDA signs as
    //    delta-mint authority post-`activate_wrapping`.
    let wrapped_key = ctx.accounts.pool_config.wrapped_mint;
    let bump = ctx.accounts.pool_config.bump;
    let pool_seeds: &[&[u8]] = &[b"native_pool", wrapped_key.as_ref(), &[bump]];

    delta_cpi::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.delta_mint_program.to_account_info(),
            delta_accounts::MintTokens {
                authority: ctx.accounts.pool_config.to_account_info(),
                mint_config: ctx.accounts.dm_mint_config.to_account_info(),
                mint: ctx.accounts.wrapped_mint.to_account_info(),
                mint_authority: ctx.accounts.dm_mint_authority.to_account_info(),
                whitelist_entry: ctx.accounts.whitelist_entry.to_account_info(),
                destination: ctx.accounts.user_wrapped_ata.to_account_info(),
                token_program: ctx.accounts.wrapped_token_program.to_account_info(),
            },
            &[pool_seeds],
        ),
        amount,
    )?;

    emit!(WrapNativeEvent {
        pool: ctx.accounts.pool_config.key(),
        user: ctx.accounts.user.key(),
        underlying_amount: amount,
        wrapped_amount: amount,
    });

    Ok(())
}

pub fn unwrap_native(ctx: Context<UnwrapNative>, amount: u64) -> Result<()> {
    require!(
        ctx.accounts.pool_config.status == PoolStatus::Active,
        GovernorError::PoolNotActive
    );
    require!(amount > 0, GovernorError::InvalidPoolStatus);

    // 1. Burn wrapper from user
    token_interface::burn(
        CpiContext::new(
            ctx.accounts.wrapped_token_program.to_account_info(),
            token_interface::Burn {
                mint: ctx.accounts.wrapped_mint.to_account_info(),
                from: ctx.accounts.user_wrapped_ata.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // 2. Transfer underlying: vault → recipient (signed by pool PDA)
    let wrapped_key = ctx.accounts.pool_config.wrapped_mint;
    let bump = ctx.accounts.pool_config.bump;
    let pool_seeds: &[&[u8]] = &[b"native_pool", wrapped_key.as_ref(), &[bump]];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.underlying_token_program.to_account_info(),
            token_interface::TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.underlying_mint.to_account_info(),
                to: ctx.accounts.recipient_underlying_ata.to_account_info(),
                authority: ctx.accounts.pool_config.to_account_info(),
            },
            &[pool_seeds],
        ),
        amount,
        ctx.accounts.pool_config.decimals,
    )?;

    emit!(UnwrapNativeEvent {
        pool: ctx.accounts.pool_config.key(),
        user: ctx.accounts.user.key(),
        underlying_amount: amount,
        wrapped_amount: amount,
    });

    Ok(())
}

pub fn mint_wrapped_native(ctx: Context<MintWrappedNative>, amount: u64) -> Result<()> {
    require!(
        ctx.accounts.pool_config.status == PoolStatus::Active,
        GovernorError::PoolNotActive
    );
    require!(amount > 0, GovernorError::InvalidPoolStatus);

    let wrapped_key = ctx.accounts.pool_config.wrapped_mint;
    let bump = ctx.accounts.pool_config.bump;
    let seeds: &[&[u8]] = &[b"native_pool", wrapped_key.as_ref(), &[bump]];

    delta_cpi::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.delta_mint_program.to_account_info(),
            delta_accounts::MintTokens {
                authority: ctx.accounts.pool_config.to_account_info(),
                mint_config: ctx.accounts.dm_mint_config.to_account_info(),
                mint: ctx.accounts.wrapped_mint.to_account_info(),
                mint_authority: ctx.accounts.dm_mint_authority.to_account_info(),
                whitelist_entry: ctx.accounts.whitelist_entry.to_account_info(),
                destination: ctx.accounts.destination.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct WrapNative<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"native_pool", pool_config.wrapped_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// Underlying mint (e.g. wSOL).
    #[account(address = pool_config.underlying_mint)]
    pub underlying_mint: InterfaceAccount<'info, token_interface::Mint>,

    /// User's underlying ATA (source).
    #[account(mut)]
    pub user_underlying_ata: InterfaceAccount<'info, token_interface::TokenAccount>,

    /// Pool's underlying vault — token account owned by pool PDA. Created
    /// externally before first wrap (associated token account is fine).
    #[account(mut)]
    pub vault: InterfaceAccount<'info, token_interface::TokenAccount>,

    /// CHECK: Wrapper mint — address validated.
    #[account(mut, address = pool_config.wrapped_mint)]
    pub wrapped_mint: UncheckedAccount<'info>,

    /// CHECK: delta-mint MintConfig.
    #[account(address = pool_config.dm_mint_config)]
    pub dm_mint_config: UncheckedAccount<'info>,

    /// CHECK: delta-mint mint authority PDA.
    pub dm_mint_authority: UncheckedAccount<'info>,

    /// CHECK: User's whitelist entry — validated by delta-mint CPI.
    pub whitelist_entry: UncheckedAccount<'info>,

    /// CHECK: User's wrapper ATA (destination for minted wrappers).
    #[account(mut)]
    pub user_wrapped_ata: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub underlying_token_program: Interface<'info, token_interface::TokenInterface>,
    pub wrapped_token_program: Interface<'info, token_interface::TokenInterface>,
}

#[derive(Accounts)]
pub struct UnwrapNative<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"native_pool", pool_config.wrapped_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// Underlying mint (e.g. wSOL).
    #[account(address = pool_config.underlying_mint)]
    pub underlying_mint: InterfaceAccount<'info, token_interface::Mint>,

    /// CHECK: Wrapper mint — address validated.
    #[account(mut, address = pool_config.wrapped_mint)]
    pub wrapped_mint: UncheckedAccount<'info>,

    /// User's wrapper ATA (source — burned).
    #[account(mut)]
    pub user_wrapped_ata: InterfaceAccount<'info, token_interface::TokenAccount>,

    /// Pool's underlying vault — token account owned by pool PDA.
    #[account(mut)]
    pub vault: InterfaceAccount<'info, token_interface::TokenAccount>,

    /// Recipient's underlying ATA (destination — credit-trade flow
    /// usually passes user's own wSOL ATA so the auto-unwrap lands
    /// in the user's wallet).
    #[account(mut)]
    pub recipient_underlying_ata: InterfaceAccount<'info, token_interface::TokenAccount>,

    pub underlying_token_program: Interface<'info, token_interface::TokenInterface>,
    pub wrapped_token_program: Interface<'info, token_interface::TokenInterface>,
}

#[derive(Accounts)]
pub struct MintWrappedNative<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"native_pool", pool_config.wrapped_mint.as_ref()],
        bump = pool_config.bump,
        constraint = is_authorized(
            &authority.key(),
            &pool_config.authority,
            &pool_config.key(),
            &admin_entry,
        ) @ GovernorError::Unauthorized
    )]
    pub pool_config: Account<'info, PoolConfig>,

    pub admin_entry: Option<Account<'info, AdminEntry>>,

    /// CHECK: delta-mint MintConfig.
    #[account(mut, address = pool_config.dm_mint_config)]
    pub dm_mint_config: UncheckedAccount<'info>,

    /// CHECK: Wrapper mint.
    #[account(mut, address = pool_config.wrapped_mint)]
    pub wrapped_mint: UncheckedAccount<'info>,

    /// CHECK: delta-mint mint authority PDA.
    pub dm_mint_authority: UncheckedAccount<'info>,

    /// CHECK: Whitelist entry — validated by delta-mint CPI.
    pub whitelist_entry: UncheckedAccount<'info>,

    /// CHECK: Destination ATA.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub token_program: Interface<'info, token_interface::TokenInterface>,
}

