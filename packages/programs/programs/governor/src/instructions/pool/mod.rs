//! Pool lifecycle ixes — create / configure / freeze.
//!
//! * `initialize_pool` — non-native (cUSDY-style) pool with explicit
//!   borrow leg and klend reserve wiring.
//! * `register_lending_market` — late-bind a klend market post-init.
//! * `set_elevation_group` — assign the pool's reserves to a klend EG.
//! * `set_pool_status` — manual freeze toggle.
//! * `set_borrow_rate_curve` — push a klend `update_reserve_config`
//!   curve update for either the collateral or borrow reserve.
//! * `activate_wrapping` — flip MintConfig authority to the pool PDA so
//!   `wrap` / `unwrap` can sign mint_to / burn via the co-authority path.
//! * `initialize_native_pool` + `activate_wrapping_native` — the cSOL /
//!   cUSDC variant where the pool just custody-wraps native assets,
//!   no klend reserve init.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{invoke, invoke_signed};
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

pub fn initialize_pool(
    ctx: Context<InitializePool>,
    params: PoolParams,
) -> Result<()> {
    let pool_key = ctx.accounts.pool_config.key();
    let authority_key = ctx.accounts.authority.key();
    let underlying_key = ctx.accounts.underlying_mint.key();
    let wrapped_key = ctx.accounts.wrapped_mint.key();
    let dm_config_key = ctx.accounts.dm_mint_config.key();

    let pool = &mut ctx.accounts.pool_config;
    pool.authority = authority_key;
    pool.underlying_mint = underlying_key;
    pool.underlying_oracle = params.underlying_oracle;
    pool.borrow_mint = params.borrow_mint;
    pool.borrow_oracle = params.borrow_oracle;
    pool.wrapped_mint = wrapped_key;
    pool.dm_mint_config = dm_config_key;
    pool.decimals = params.decimals;
    pool.ltv_pct = params.ltv_pct;
    pool.liquidation_threshold_pct = params.liquidation_threshold_pct;
    pool.bump = ctx.bumps.pool_config;
    pool.gatekeeper_network = Pubkey::default();
    pool.elevation_group = params.elevation_group;
    pool.status = PoolStatus::Initializing;

    delta_cpi::initialize_mint(
        CpiContext::new(
            ctx.accounts.delta_mint_program.to_account_info(),
            delta_accounts::InitializeMint {
                authority: ctx.accounts.authority.to_account_info(),
                mint: ctx.accounts.wrapped_mint.to_account_info(),
                mint_config: ctx.accounts.dm_mint_config.to_account_info(),
                mint_authority: ctx.accounts.dm_mint_authority.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        ),
        params.decimals,
    )?;

    // NOTE: delta-mint authority is initially the deployer.
    // Call `activate_wrapping` after whitelisting to transfer authority to pool PDA.

    emit!(PoolCreatedEvent {
        pool: pool_key,
        underlying_mint: underlying_key,
        wrapped_mint: wrapped_key,
        authority: authority_key,
    });

    Ok(())
}

pub fn register_lending_market(
    ctx: Context<RootOnly>,
    lending_market: Pubkey,
    collateral_reserve: Pubkey,
    borrow_reserve: Pubkey,
) -> Result<()> {
    let pool = &mut ctx.accounts.pool_config;
    require!(
        pool.status == PoolStatus::Initializing,
        GovernorError::InvalidPoolStatus
    );
    pool.lending_market = lending_market;
    pool.collateral_reserve = collateral_reserve;
    pool.borrow_reserve = borrow_reserve;
    pool.status = PoolStatus::Active;
    Ok(())
}

pub fn set_gatekeeper_network(
    ctx: Context<SetGatekeeperNetwork>,
    gatekeeper_network: Pubkey,
) -> Result<()> {
    let account_info = &ctx.accounts.pool_config;
    let new_size = 8 + PoolConfig::INIT_SPACE;

    require!(
        account_info.owner == &crate::ID,
        GovernorError::Unauthorized
    );

    // Verify authority (at offset 8, first 32 bytes)
    let data = account_info.try_borrow_data()?;
    require!(data.len() >= 40, GovernorError::Unauthorized);
    let stored_authority = Pubkey::try_from(&data[8..40]).unwrap();
    require!(
        stored_authority == ctx.accounts.authority.key(),
        GovernorError::Unauthorized
    );
    drop(data);

    // Realloc if needed
    if account_info.data_len() < new_size {
        let rent = Rent::get()?;
        let diff = rent.minimum_balance(new_size).saturating_sub(account_info.lamports());
        if diff > 0 {
            anchor_lang::solana_program::program::invoke(
                &anchor_lang::solana_program::system_instruction::transfer(
                    ctx.accounts.authority.key,
                    account_info.key,
                    diff,
                ),
                &[
                    ctx.accounts.authority.to_account_info(),
                    account_info.to_account_info(),
                ],
            )?;
        }
        account_info.realloc(new_size, false)?;
    }

    // Write gatekeeper_network at offset (last field)
    // Layout: disc(8) + 10*pubkey(320) + decimals(1) + ltv(1) + liq_thresh(1)
    //   + status(1) + bump(1) = 333 bytes, then gatekeeper_network(32)
    let gk_offset = 8 + 32 * 10 + 5; // = 333
    let mut data = account_info.try_borrow_mut_data()?;
    data[gk_offset..gk_offset + 32].copy_from_slice(&gatekeeper_network.to_bytes());

    Ok(())
}

pub fn set_elevation_group(
    ctx: Context<SetElevationGroup>,
    elevation_group: u8,
) -> Result<()> {
    let account_info = &ctx.accounts.pool_config;
    let new_size = 8 + PoolConfig::INIT_SPACE;

    require!(
        account_info.owner == &crate::ID,
        GovernorError::Unauthorized
    );

    // Verify authority (at offset 8, first 32 bytes)
    let data = account_info.try_borrow_data()?;
    require!(data.len() >= 40, GovernorError::Unauthorized);
    let stored_authority = Pubkey::try_from(&data[8..40]).unwrap();
    require!(
        stored_authority == ctx.accounts.authority.key(),
        GovernorError::Unauthorized
    );
    drop(data);

    if account_info.data_len() < new_size {
        let rent = Rent::get()?;
        let diff = rent.minimum_balance(new_size).saturating_sub(account_info.lamports());
        if diff > 0 {
            anchor_lang::solana_program::program::invoke(
                &anchor_lang::solana_program::system_instruction::transfer(
                    ctx.accounts.authority.key,
                    account_info.key,
                    diff,
                ),
                &[
                    ctx.accounts.authority.to_account_info(),
                    account_info.to_account_info(),
                ],
            )?;
        }
        account_info.realloc(new_size, false)?;
    }

    // Layout: disc(8) + 10*pubkey(320) + 5 small fields + gatekeeper(32) = 365,
    // then elevation_group(1).
    let eg_offset = 8 + 32 * 10 + 5 + 32; // = 365
    let mut data = account_info.try_borrow_mut_data()?;
    data[eg_offset] = elevation_group;

    Ok(())
}

pub fn set_pool_status(ctx: Context<RootOnly>, status: PoolStatus) -> Result<()> {
    ctx.accounts.pool_config.status = status;
    Ok(())
}

pub fn set_borrow_rate_curve(
    ctx: Context<SetBorrowRateCurve>,
    reserve_type: ReserveType,
    curve: BorrowRateCurve,
) -> Result<()> {
    let pool = &ctx.accounts.pool_config;
    require!(
        pool.status == PoolStatus::Active,
        GovernorError::PoolNotActive
    );

    // Validate the reserve address matches the pool config
    let expected_reserve = match reserve_type {
        ReserveType::Collateral => pool.collateral_reserve,
        ReserveType::Borrow => pool.borrow_reserve,
    };
    require!(
        ctx.accounts.reserve.key() == expected_reserve,
        GovernorError::ReserveMismatch
    );
    require!(
        ctx.accounts.lending_market.key() == pool.lending_market,
        GovernorError::MarketMismatch
    );

    // Validate the curve
    curve.validate()?;

    // Serialize the 11-point curve into 88 bytes
    let mut curve_data = [0u8; 88];
    for (i, point) in curve.points.iter().enumerate() {
        let offset = i * 8;
        curve_data[offset..offset + 4].copy_from_slice(&point.utilization_rate_bps.to_le_bytes());
        curve_data[offset + 4..offset + 8].copy_from_slice(&point.borrow_rate_bps.to_le_bytes());
    }

    // Build klend updateReserveConfig instruction data:
    //   disc(8) + mode(u8) + vec_len(u32) + curve(88) + skip_validation(u8)
    // sha256("global:update_reserve_config")[0..8]
    let disc: [u8; 8] = [0x3d, 0x94, 0x64, 0x46, 0x8f, 0x6b, 0x11, 0x0d];
    let mode: u8 = 23; // UpdateBorrowRateCurve
    let vec_len: u32 = 88;
    let skip_validation: u8 = 1; // skip klend config integrity check (governor validates the curve itself)

    let mut data = Vec::with_capacity(8 + 1 + 4 + 88 + 1);
    data.extend_from_slice(&disc);
    data.push(mode);
    data.extend_from_slice(&vec_len.to_le_bytes());
    data.extend_from_slice(&curve_data);
    data.push(skip_validation);

    // CPI into klend — authority signs the outer tx and the signature passes through
    let ix = Instruction {
        program_id: ctx.accounts.klend_program.key(),
        accounts: vec![
            AccountMeta::new_readonly(ctx.accounts.authority.key(), true),
            AccountMeta::new_readonly(ctx.accounts.klend_global_config.key(), false),
            AccountMeta::new_readonly(ctx.accounts.lending_market.key(), false),
            AccountMeta::new(ctx.accounts.reserve.key(), false),
        ],
        data,
    };

    invoke(
        &ix,
        &[
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.klend_global_config.to_account_info(),
            ctx.accounts.lending_market.to_account_info(),
            ctx.accounts.reserve.to_account_info(),
            ctx.accounts.klend_program.to_account_info(),
        ],
    )?;

    emit!(BorrowRateCurveUpdated {
        pool: ctx.accounts.pool_config.key(),
        reserve: ctx.accounts.reserve.key(),
        reserve_type,
    });

    Ok(())
}

pub fn activate_wrapping(ctx: Context<ActivateWrapping>) -> Result<()> {
    let pool_key = ctx.accounts.pool_config.key();

    delta_cpi::transfer_authority(
        CpiContext::new(
            ctx.accounts.delta_mint_program.to_account_info(),
            delta_accounts::TransferAuthority {
                authority: ctx.accounts.authority.to_account_info(),
                mint_config: ctx.accounts.dm_mint_config.to_account_info(),
            },
        ),
        pool_key,
    )?;

    msg!("Delta-mint authority transferred to pool PDA: {}", pool_key);
    Ok(())
}

pub fn initialize_native_pool(
    ctx: Context<InitializeNativePool>,
    params: NativePoolParams,
) -> Result<()> {
    let pool_key = ctx.accounts.pool_config.key();
    let underlying_key = ctx.accounts.underlying_mint.key();
    let wrapped_key = ctx.accounts.wrapped_mint.key();
    let dm_config_key = ctx.accounts.dm_mint_config.key();
    let authority_key = ctx.accounts.authority.key();

    let pool = &mut ctx.accounts.pool_config;
    pool.authority = authority_key;
    pool.underlying_mint = underlying_key;
    pool.underlying_oracle = params.underlying_oracle;
    pool.borrow_mint = Pubkey::default();
    pool.borrow_oracle = Pubkey::default();
    pool.wrapped_mint = wrapped_key;
    pool.dm_mint_config = dm_config_key;
    pool.lending_market = Pubkey::default();
    pool.collateral_reserve = Pubkey::default();
    pool.borrow_reserve = Pubkey::default();
    pool.decimals = params.decimals;
    pool.ltv_pct = 0;
    pool.liquidation_threshold_pct = 0;
    pool.bump = ctx.bumps.pool_config;
    pool.gatekeeper_network = Pubkey::default();
    pool.elevation_group = 0;
    pool.status = PoolStatus::Active; // no separate "register lending market" step here

    // Atomically initialize the wrapped mint via delta-mint CPI —
    // mirrors the staker pool's `initialize_pool` flow. After this
    // the mint exists with delta-mint as authority and the deployer
    // as first-tier authority. Call `activate_wrapping_native` to
    // hand authority off to the pool PDA once whitelisting is set.
    delta_cpi::initialize_mint(
        CpiContext::new(
            ctx.accounts.delta_mint_program.to_account_info(),
            delta_accounts::InitializeMint {
                authority: ctx.accounts.authority.to_account_info(),
                mint: ctx.accounts.wrapped_mint.to_account_info(),
                mint_config: ctx.accounts.dm_mint_config.to_account_info(),
                mint_authority: ctx.accounts.dm_mint_authority.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        ),
        params.decimals,
    )?;

    emit!(PoolCreatedEvent {
        pool: pool_key,
        underlying_mint: underlying_key,
        wrapped_mint: wrapped_key,
        authority: authority_key,
    });

    Ok(())
}

pub fn activate_wrapping_native(ctx: Context<ActivateWrappingNative>) -> Result<()> {
    let pool_key = ctx.accounts.pool_config.key();
    delta_cpi::transfer_authority(
        CpiContext::new(
            ctx.accounts.delta_mint_program.to_account_info(),
            delta_accounts::TransferAuthority {
                authority: ctx.accounts.authority.to_account_info(),
                mint_config: ctx.accounts.dm_mint_config.to_account_info(),
            },
        ),
        pool_key,
    )?;
    msg!("Delta-mint authority transferred to native pool PDA: {}", pool_key);
    Ok(())
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + PoolConfig::INIT_SPACE,
        seeds = [b"pool", underlying_mint.key().as_ref()],
        bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// CHECK: The underlying token mint (e.g., USDY).
    pub underlying_mint: UncheckedAccount<'info>,

    #[account(mut)]
    pub wrapped_mint: Signer<'info>,

    /// CHECK: delta-mint MintConfig PDA.
    #[account(mut)]
    pub dm_mint_config: UncheckedAccount<'info>,

    /// CHECK: delta-mint mint authority PDA.
    pub dm_mint_authority: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub token_program: Interface<'info, token_interface::TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Root-authority-only operations (register market, freeze, manage admins).
#[derive(Accounts)]
pub struct RootOnly<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut, has_one = authority)]
    pub pool_config: Account<'info, PoolConfig>,
}

/// Set gatekeeper network — supports pre-v2 account migration.
#[derive(Accounts)]
pub struct SetGatekeeperNetwork<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: PoolConfig PDA — manually validated and reallocated if needed.
    #[account(mut)]
    pub pool_config: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Set elevation group — supports pre-v3 account migration.
#[derive(Accounts)]
pub struct SetElevationGroup<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: PoolConfig PDA — manually validated and reallocated if needed.
    #[account(mut)]
    pub pool_config: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Set borrow rate curve on a klend reserve — root authority OR admin.
/// Authority must also be the klend market owner.
#[derive(Accounts)]
pub struct SetBorrowRateCurve<'info> {
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

    /// CHECK: klend lending market — validated against pool_config.
    pub lending_market: UncheckedAccount<'info>,

    /// CHECK: klend reserve to update — validated against pool_config.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,

    /// CHECK: klend global config account.
    pub klend_global_config: UncheckedAccount<'info>,

    /// CHECK: klend program — invoked via CPI.
    pub klend_program: UncheckedAccount<'info>,
}

/// Activate wrapping — transfers delta-mint authority to pool PDA.
#[derive(Accounts)]
pub struct ActivateWrapping<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(has_one = authority)]
    pub pool_config: Account<'info, PoolConfig>,

    /// CHECK: delta-mint MintConfig — authority validated by delta-mint CPI.
    #[account(mut, address = pool_config.dm_mint_config)]
    pub dm_mint_config: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
}

#[derive(Accounts)]
pub struct InitializeNativePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + PoolConfig::INIT_SPACE,
        seeds = [b"native_pool", wrapped_mint.key().as_ref()],
        bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// CHECK: The underlying token mint (e.g. wSOL / Solstice USDC).
    pub underlying_mint: UncheckedAccount<'info>,

    /// Fresh wrapper mint keypair — initialized in this ix via
    /// delta-mint CPI (mirrors the staker pool flow).
    #[account(mut)]
    pub wrapped_mint: Signer<'info>,

    /// CHECK: delta-mint MintConfig PDA — created by delta-mint CPI.
    #[account(mut)]
    pub dm_mint_config: UncheckedAccount<'info>,

    /// CHECK: delta-mint mint authority PDA — derived by delta-mint.
    pub dm_mint_authority: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub token_program: Interface<'info, token_interface::TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ActivateWrappingNative<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(has_one = authority)]
    pub pool_config: Account<'info, PoolConfig>,

    /// CHECK: delta-mint MintConfig — authority validated by delta-mint CPI.
    #[account(mut, address = pool_config.dm_mint_config)]
    pub dm_mint_config: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
}

