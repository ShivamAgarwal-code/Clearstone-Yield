//! Plain wrap / unwrap (cUSDY-style — pool holds the underlying in a
//! token vault and the wrapped d-token is 1:1 against it). The Jito-vault
//! variant lives in [`super::jito`]; the native-asset variant in
//! [`super::wrap_native`].
//!
//! * `wrap` — user deposits underlying, receives d-tokens.
//! * `unwrap` — user burns d-tokens, receives underlying back.
//! * `mint_wrapped` — admin-only direct mint (used to seed klend reserves
//!   before the user-facing wrap path is enabled).

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

pub fn wrap(ctx: Context<WrapTokens>, amount: u64) -> Result<()> {
    require!(
        ctx.accounts.pool_config.status == PoolStatus::Active,
        GovernorError::PoolNotActive
    );
    require!(amount > 0, GovernorError::InvalidPoolStatus);

    // 1. Transfer underlying tokens from user → vault
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

    // 2. Mint d-tokens to user via delta-mint CPI
    let underlying = ctx.accounts.pool_config.underlying_mint;
    let bump = ctx.accounts.pool_config.bump;
    let seeds = &[b"pool".as_ref(), underlying.as_ref(), &[bump]];

    // The pool_config PDA is the authority on the delta-mint MintConfig
    // (set during initialize_pool). We CPI as the pool PDA.
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
            &[seeds],
        ),
        amount,
    )?;

    emit!(WrapEvent {
        pool: ctx.accounts.pool_config.key(),
        user: ctx.accounts.user.key(),
        underlying_amount: amount,
        wrapped_amount: amount,
    });

    Ok(())
}

pub fn unwrap(ctx: Context<UnwrapTokens>, amount: u64) -> Result<()> {
    require!(
        ctx.accounts.pool_config.status == PoolStatus::Active,
        GovernorError::PoolNotActive
    );
    require!(amount > 0, GovernorError::InvalidPoolStatus);

    // 1. Burn d-tokens from user
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

    // 2. Transfer underlying from vault → user (pool PDA owns the vault, signs)
    let underlying = ctx.accounts.pool_config.underlying_mint;
    let bump = ctx.accounts.pool_config.bump;
    let pool_seeds = &[b"pool".as_ref(), underlying.as_ref(), &[bump]];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.underlying_token_program.to_account_info(),
            token_interface::TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.underlying_mint.to_account_info(),
                to: ctx.accounts.user_underlying_ata.to_account_info(),
                authority: ctx.accounts.pool_config.to_account_info(),
            },
            &[pool_seeds],
        ),
        amount,
        ctx.accounts.pool_config.decimals,
    )?;

    emit!(UnwrapEvent {
        pool: ctx.accounts.pool_config.key(),
        user: ctx.accounts.user.key(),
        underlying_amount: amount,
        wrapped_amount: amount,
    });

    Ok(())
}

pub fn mint_wrapped(ctx: Context<MintWrapped>, amount: u64) -> Result<()> {
    require!(
        ctx.accounts.pool_config.status == PoolStatus::Active,
        GovernorError::PoolNotActive
    );

    delta_cpi::mint_to(
        CpiContext::new(
            ctx.accounts.delta_mint_program.to_account_info(),
            delta_accounts::MintTokens {
                authority: ctx.accounts.authority.to_account_info(),
                mint_config: ctx.accounts.dm_mint_config.to_account_info(),
                mint: ctx.accounts.wrapped_mint.to_account_info(),
                mint_authority: ctx.accounts.dm_mint_authority.to_account_info(),
                whitelist_entry: ctx.accounts.whitelist_entry.to_account_info(),
                destination: ctx.accounts.destination.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ),
        amount,
    )?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/// Wrap underlying → d-tokens. Any whitelisted user can call this.
/// The vault is a token account owned by the pool PDA.
#[derive(Accounts)]
pub struct WrapTokens<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// The underlying token mint (e.g., tUSDY). Must match pool_config.
    #[account(address = pool_config.underlying_mint)]
    pub underlying_mint: InterfaceAccount<'info, token_interface::Mint>,

    /// User's token account for the underlying (source).
    #[account(mut)]
    pub user_underlying_ata: InterfaceAccount<'info, token_interface::TokenAccount>,

    /// Pool vault — token account for underlying, owned by pool PDA.
    /// CHECK: Validated by constraint. Created externally before first wrap.
    #[account(mut)]
    pub vault: InterfaceAccount<'info, token_interface::TokenAccount>,

    /// CHECK: delta-mint MintConfig — address validated.
    #[account(address = pool_config.dm_mint_config)]
    pub dm_mint_config: UncheckedAccount<'info>,

    /// CHECK: Wrapped Token-2022 mint — address validated.
    #[account(mut, address = pool_config.wrapped_mint)]
    pub wrapped_mint: UncheckedAccount<'info>,

    /// CHECK: delta-mint mint authority PDA.
    pub dm_mint_authority: UncheckedAccount<'info>,

    /// CHECK: User's whitelist entry — validated by delta-mint CPI.
    pub whitelist_entry: UncheckedAccount<'info>,

    /// CHECK: User's d-token ATA (destination for minted d-tokens).
    #[account(mut)]
    pub user_wrapped_ata: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub underlying_token_program: Interface<'info, token_interface::TokenInterface>,
    pub wrapped_token_program: Interface<'info, token_interface::TokenInterface>,
}

/// Unwrap d-tokens → underlying tokens.
#[derive(Accounts)]
pub struct UnwrapTokens<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// The underlying token mint.
    #[account(address = pool_config.underlying_mint)]
    pub underlying_mint: InterfaceAccount<'info, token_interface::Mint>,

    /// User's underlying token account (destination).
    #[account(mut)]
    pub user_underlying_ata: InterfaceAccount<'info, token_interface::TokenAccount>,

    /// Pool vault — underlying tokens transferred out.
    #[account(mut)]
    pub vault: InterfaceAccount<'info, token_interface::TokenAccount>,

    /// Wrapped Token-2022 mint (tokens burned from user).
    #[account(mut, address = pool_config.wrapped_mint)]
    pub wrapped_mint: InterfaceAccount<'info, token_interface::Mint>,

    /// User's d-token account (source — burned).
    #[account(mut)]
    pub user_wrapped_ata: InterfaceAccount<'info, token_interface::TokenAccount>,

    pub underlying_token_program: Interface<'info, token_interface::TokenInterface>,
    pub wrapped_token_program: Interface<'info, token_interface::TokenInterface>,
}

/// Mint wrapped tokens — root authority OR admin (legacy, mints without backing).
#[derive(Accounts)]
pub struct MintWrapped<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
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

    /// CHECK: delta-mint MintConfig.
    #[account(address = pool_config.dm_mint_config)]
    pub dm_mint_config: UncheckedAccount<'info>,

    /// CHECK: Wrapped Token-2022 mint.
    #[account(mut, address = pool_config.wrapped_mint)]
    pub wrapped_mint: UncheckedAccount<'info>,

    /// CHECK: delta-mint mint authority PDA.
    pub dm_mint_authority: UncheckedAccount<'info>,

    /// CHECK: WhitelistEntry — validated by delta-mint CPI.
    pub whitelist_entry: UncheckedAccount<'info>,

    /// CHECK: Recipient token account.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub token_program: Interface<'info, token_interface::TokenInterface>,
}

