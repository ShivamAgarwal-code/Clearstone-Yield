//! Admin / whitelist ixes — pool authority management plus the various
//! ways a wallet can land on a delta-mint MintConfig whitelist.
//!
//! * `add_admin` / `remove_admin` — pool root authority manages a list
//!   of co-admins.
//! * `fix_co_authority` — repair a missing co_authority field on the
//!   pool's MintConfig (one-time migration helper).
//! * `add_participant` — root/admin path that ONLY works pre-activation
//!   (delta-mint authority still held by deployer).
//! * `add_participant_via_pool` — root/admin path that signs as the
//!   pool PDA via co-authority. Pinned to `pool_config.dm_mint_config`.
//! * `add_wt_participant_via_pool` — sibling that accepts any MintConfig
//!   owned by the pool PDA (e.g. csSOL-WT, csUSDC). Used for the
//!   unified whitelist bundle.
//! * `add_participant_native_via_pool` — same as above but for cSOL /
//!   cUSDC native-wrap pools.
//! * `self_register` — permissionless if pool has a Civic gatekeeper.

use anchor_lang::prelude::*;
use delta_mint::cpi as delta_cpi;
use delta_mint::cpi::accounts as delta_accounts;
use delta_mint::program::DeltaMint as DeltaMintProgram;

use crate::civic_pass::Pass;
use crate::state::*;
use crate::errors::*;
use crate::events::*;
use crate::is_authorized;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub fn add_admin(ctx: Context<ManageAdmin>) -> Result<()> {
    let admin = &mut ctx.accounts.admin_entry;
    admin.pool = ctx.accounts.pool_config.key();
    admin.wallet = ctx.accounts.new_admin.key();
    admin.added_by = ctx.accounts.authority.key();
    admin.bump = ctx.bumps.admin_entry;
    Ok(())
}

pub fn remove_admin(_ctx: Context<RemoveAdmin>) -> Result<()> {
    // Account is closed by the `close` attribute
    Ok(())
}

pub fn fix_co_authority(ctx: Context<FixCoAuthority>) -> Result<()> {
    let pool_key = ctx.accounts.pool_config.key();
    let underlying = ctx.accounts.pool_config.underlying_mint;
    let bump = ctx.accounts.pool_config.bump;
    let seeds = &[b"pool".as_ref(), underlying.as_ref(), &[bump]];

    delta_cpi::set_co_authority(
        CpiContext::new_with_signer(
            ctx.accounts.delta_mint_program.to_account_info(),
            delta_accounts::SetCoAuthority {
                authority: ctx.accounts.pool_config.to_account_info(),
                mint_config: ctx.accounts.dm_mint_config.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[seeds],
        ),
        pool_key,
    )?;

    msg!("Co-authority set to pool PDA: {}", pool_key);
    Ok(())
}

pub fn add_participant(
    ctx: Context<AddParticipant>,
    role: ParticipantRole,
) -> Result<()> {
    let cpi_program = ctx.accounts.delta_mint_program.to_account_info();
    let cpi_accounts = delta_accounts::AddToWhitelist {
        authority: ctx.accounts.authority.to_account_info(),
        mint_config: ctx.accounts.dm_mint_config.to_account_info(),
        wallet: ctx.accounts.wallet.to_account_info(),
        whitelist_entry: ctx.accounts.whitelist_entry.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
    };

    match role {
        ParticipantRole::Holder => {
            delta_cpi::add_to_whitelist(CpiContext::new(cpi_program, cpi_accounts))?;
        }
        ParticipantRole::Liquidator => {
            delta_cpi::add_liquidator(CpiContext::new(cpi_program, cpi_accounts))?;
        }
        ParticipantRole::Escrow => {
            delta_cpi::add_escrow(CpiContext::new(cpi_program, cpi_accounts))?;
        }
    }

    Ok(())
}

pub fn add_participant_via_pool(
    ctx: Context<AddParticipantViaPool>,
    role: ParticipantRole,
) -> Result<()> {
    let underlying = ctx.accounts.pool_config.underlying_mint;
    let bump = ctx.accounts.pool_config.bump;
    let seeds = &[b"pool".as_ref(), underlying.as_ref(), &[bump]];

    let cpi_program = ctx.accounts.delta_mint_program.to_account_info();
    // Use co_authority path — pool PDA is both authority AND co_authority after activate_wrapping
    let cpi_accounts = delta_accounts::AddToWhitelistCoAuth {
        co_authority: ctx.accounts.pool_config.to_account_info(),
        payer: ctx.accounts.authority.to_account_info(),
        mint_config: ctx.accounts.dm_mint_config.to_account_info(),
        wallet: ctx.accounts.wallet.to_account_info(),
        whitelist_entry: ctx.accounts.whitelist_entry.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
    };

    match role {
        ParticipantRole::Holder => {
            delta_cpi::add_to_whitelist_with_co_authority(
                CpiContext::new_with_signer(cpi_program, cpi_accounts, &[seeds])
            )?;
        }
        ParticipantRole::Liquidator => {
            delta_cpi::add_liquidator_with_co_authority(
                CpiContext::new_with_signer(cpi_program, cpi_accounts, &[seeds])
            )?;
        }
        ParticipantRole::Escrow => {
            delta_cpi::add_escrow_with_co_authority(
                CpiContext::new_with_signer(cpi_program, cpi_accounts, &[seeds])
            )?;
        }
    }

    Ok(())
}

pub fn add_wt_participant_via_pool(
    ctx: Context<AddWtParticipantViaPool>,
    role: ParticipantRole,
) -> Result<()> {
    let underlying = ctx.accounts.pool_config.underlying_mint;
    let bump = ctx.accounts.pool_config.bump;
    let seeds = &[b"pool".as_ref(), underlying.as_ref(), &[bump]];

    let cpi_program = ctx.accounts.delta_mint_program.to_account_info();
    // Use the co-authority path: pool PDA signs as co_authority while
    // the deployer/admin signer pays the rent for the new whitelist
    // entry. Required because the regular AddToWhitelist init uses
    // `payer = authority`, which fails when authority is a PDA with
    // account data ("Transfer: from must not carry data").
    let cpi_accounts = delta_accounts::AddToWhitelistCoAuth {
        co_authority: ctx.accounts.pool_config.to_account_info(),
        payer: ctx.accounts.authority.to_account_info(),
        mint_config: ctx.accounts.dm_mint_config.to_account_info(),
        wallet: ctx.accounts.wallet.to_account_info(),
        whitelist_entry: ctx.accounts.whitelist_entry.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
    };

    match role {
        ParticipantRole::Holder => {
            delta_cpi::add_to_whitelist_with_co_authority(
                CpiContext::new_with_signer(cpi_program, cpi_accounts, &[seeds]),
            )?;
        }
        ParticipantRole::Liquidator => {
            delta_cpi::add_liquidator_with_co_authority(
                CpiContext::new_with_signer(cpi_program, cpi_accounts, &[seeds]),
            )?;
        }
        ParticipantRole::Escrow => {
            delta_cpi::add_escrow_with_co_authority(
                CpiContext::new_with_signer(cpi_program, cpi_accounts, &[seeds]),
            )?;
        }
    }

    Ok(())
}

pub fn add_participant_native_via_pool(
    ctx: Context<AddParticipantNativeViaPool>,
    role: ParticipantRole,
) -> Result<()> {
    let wrapped_key = ctx.accounts.pool_config.wrapped_mint;
    let bump = ctx.accounts.pool_config.bump;
    let seeds: &[&[u8]] = &[b"native_pool", wrapped_key.as_ref(), &[bump]];

    let cpi_program = ctx.accounts.delta_mint_program.to_account_info();
    let cpi_accounts = delta_accounts::AddToWhitelistCoAuth {
        co_authority: ctx.accounts.pool_config.to_account_info(),
        payer: ctx.accounts.authority.to_account_info(),
        mint_config: ctx.accounts.dm_mint_config.to_account_info(),
        wallet: ctx.accounts.wallet.to_account_info(),
        whitelist_entry: ctx.accounts.whitelist_entry.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
    };

    match role {
        ParticipantRole::Holder => delta_cpi::add_to_whitelist_with_co_authority(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, &[seeds]),
        )?,
        ParticipantRole::Liquidator => delta_cpi::add_liquidator_with_co_authority(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, &[seeds]),
        )?,
        ParticipantRole::Escrow => delta_cpi::add_escrow_with_co_authority(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, &[seeds]),
        )?,
    }
    Ok(())
}

pub fn self_register(ctx: Context<SelfRegister>) -> Result<()> {
    let pool = &ctx.accounts.pool_config;

    // Ensure self-registration is enabled
    require!(
        pool.gatekeeper_network != Pubkey::default(),
        GovernorError::SelfRegisterDisabled
    );

    // Verify Civic gateway token
    let gateway_data = ctx.accounts.gateway_token.try_borrow_data()?;
    let pass = Pass::try_deserialize_unchecked(&gateway_data[..])
        .map_err(|_| GovernorError::InvalidGatewayToken)?;
    require!(
        pass.valid(ctx.accounts.user.key, &pool.gatekeeper_network),
        GovernorError::InvalidGatewayToken
    );

    // CPI to delta-mint: whitelist the user via co-authority.
    // The pool_config PDA signs as the co_authority for delta-mint.
    let underlying = pool.underlying_mint;
    let bump = pool.bump;
    let seeds = &[
        b"pool".as_ref(),
        underlying.as_ref(),
        &[bump],
    ];

    delta_cpi::add_to_whitelist_with_co_authority(CpiContext::new_with_signer(
        ctx.accounts.delta_mint_program.to_account_info(),
        delta_accounts::AddToWhitelistCoAuth {
            co_authority: ctx.accounts.pool_config.to_account_info(),
            payer: ctx.accounts.user.to_account_info(),
            mint_config: ctx.accounts.dm_mint_config.to_account_info(),
            wallet: ctx.accounts.user.to_account_info(),
            whitelist_entry: ctx.accounts.whitelist_entry.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
        &[seeds],
    ))?;

    emit!(SelfRegisterEvent {
        pool: ctx.accounts.pool_config.key(),
        wallet: ctx.accounts.user.key(),
        gatekeeper_network: pool.gatekeeper_network,
    });

    Ok(())
}

/// Self-register variant for native-wrap pools (e.g. cSOL). Mirrors
/// `self_register` but signs the delta-mint CPI with the native-pool
/// PDA seeds `["native_pool", wrapped_mint]` instead of the regular
/// `["pool", underlying_mint]`. The original handler can't be reused
/// for native pools because Anchor enforces the seed shape on the
/// `pool_config` account, so cSOL etc. would fail with
/// `ConstraintSeeds (2006)` before the handler ran.
///
/// Same Civic-gated permissionless onboarding semantics — any wallet
/// holding a valid, non-expired pass from the pool's gatekeeper
/// network can self-onboard. Lets retail flows (e.g. SOL deposit ->
/// wrap_native -> klend) onboard with a single signature, matching
/// the v1 dtUSDY / ceUSX onboarding UX.
pub fn self_register_native(ctx: Context<SelfRegisterNative>) -> Result<()> {
    let pool = &ctx.accounts.pool_config;

    require!(
        pool.gatekeeper_network != Pubkey::default(),
        GovernorError::SelfRegisterDisabled
    );

    let gateway_data = ctx.accounts.gateway_token.try_borrow_data()?;
    let pass = Pass::try_deserialize_unchecked(&gateway_data[..])
        .map_err(|_| GovernorError::InvalidGatewayToken)?;
    require!(
        pass.valid(ctx.accounts.user.key, &pool.gatekeeper_network),
        GovernorError::InvalidGatewayToken
    );

    // CPI to delta-mint: whitelist the user via co-authority. The
    // native-pool PDA signs as co_authority — seed shape mirrors the
    // wrap_native / unwrap_native handlers in `instructions/wrap_native`.
    let wrapped = pool.wrapped_mint;
    let bump = pool.bump;
    let seeds = &[
        b"native_pool".as_ref(),
        wrapped.as_ref(),
        &[bump],
    ];

    delta_cpi::add_to_whitelist_with_co_authority(CpiContext::new_with_signer(
        ctx.accounts.delta_mint_program.to_account_info(),
        delta_accounts::AddToWhitelistCoAuth {
            co_authority: ctx.accounts.pool_config.to_account_info(),
            payer: ctx.accounts.user.to_account_info(),
            mint_config: ctx.accounts.dm_mint_config.to_account_info(),
            wallet: ctx.accounts.user.to_account_info(),
            whitelist_entry: ctx.accounts.whitelist_entry.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
        &[seeds],
    ))?;

    emit!(SelfRegisterEvent {
        pool: ctx.accounts.pool_config.key(),
        wallet: ctx.accounts.user.key(),
        gatekeeper_network: pool.gatekeeper_network,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/// Add a new admin — root authority only.
#[derive(Accounts)]
pub struct ManageAdmin<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(has_one = authority)]
    pub pool_config: Account<'info, PoolConfig>,

    /// CHECK: The wallet to grant admin role.
    pub new_admin: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + AdminEntry::INIT_SPACE,
        seeds = [b"admin", pool_config.key().as_ref(), new_admin.key().as_ref()],
        bump,
    )]
    pub admin_entry: Account<'info, AdminEntry>,

    pub system_program: Program<'info, System>,
}

/// Remove an admin — root authority only.
#[derive(Accounts)]
pub struct RemoveAdmin<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(has_one = authority)]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        mut,
        close = authority,
        seeds = [b"admin", pool_config.key().as_ref(), admin_entry.wallet.as_ref()],
        bump = admin_entry.bump,
    )]
    pub admin_entry: Account<'info, AdminEntry>,
}

/// Fix co_authority — uses pool PDA to sign as authority.
#[derive(Accounts)]
pub struct FixCoAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority,
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// CHECK: delta-mint MintConfig.
    #[account(mut, address = pool_config.dm_mint_config)]
    pub dm_mint_config: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub system_program: Program<'info, System>,
}

/// Add participant — root authority OR admin.
/// NOTE: Only for non-activated pools.
#[derive(Accounts)]
pub struct AddParticipant<'info> {
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
    #[account(mut, address = pool_config.dm_mint_config)]
    pub dm_mint_config: UncheckedAccount<'info>,

    /// CHECK: The wallet to whitelist.
    pub wallet: UncheckedAccount<'info>,

    /// CHECK: WhitelistEntry PDA — created by delta-mint CPI.
    #[account(mut)]
    pub whitelist_entry: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub system_program: Program<'info, System>,
}

/// Add participant via pool PDA (for activated pools where authority was transferred).
#[derive(Accounts)]
pub struct AddParticipantViaPool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
        constraint = is_authorized(
            &authority.key(),
            &pool_config.authority,
            &pool_config.key(),
            &admin_entry,
        ) @ GovernorError::Unauthorized
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// Optional admin PDA.
    pub admin_entry: Option<Account<'info, AdminEntry>>,

    /// CHECK: delta-mint MintConfig.
    #[account(mut, address = pool_config.dm_mint_config)]
    pub dm_mint_config: UncheckedAccount<'info>,

    /// CHECK: The wallet to whitelist.
    pub wallet: UncheckedAccount<'info>,

    /// CHECK: WhitelistEntry PDA — created by delta-mint CPI.
    #[account(mut)]
    pub whitelist_entry: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub system_program: Program<'info, System>,
}

/// Add participant on a secondary (e.g. WT) MintConfig owned by the pool.
/// Mirrors `AddParticipantViaPool` but without the
/// `dm_mint_config == pool_config.dm_mint_config` constraint, since WT
/// MintConfigs aren't tracked on PoolConfig. delta-mint will reject the
/// CPI if the pool PDA isn't actually the MintConfig's authority, so the
/// missing Anchor-level address pin is safe.
#[derive(Accounts)]
pub struct AddWtParticipantViaPool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
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

    /// CHECK: any MintConfig whose `authority` is the pool PDA — verified
    /// inside delta-mint's add_to_whitelist handler.
    #[account(mut)]
    pub dm_mint_config: UncheckedAccount<'info>,

    /// CHECK: the wallet to whitelist.
    pub wallet: UncheckedAccount<'info>,

    /// CHECK: WhitelistEntry PDA — created by the delta-mint CPI.
    #[account(mut)]
    pub whitelist_entry: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddParticipantNativeViaPool<'info> {
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

    /// CHECK: The wallet to whitelist.
    pub wallet: UncheckedAccount<'info>,

    /// CHECK: The PDA created by delta-mint.
    #[account(mut)]
    pub whitelist_entry: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub system_program: Program<'info, System>,
}

/// Self-register via Civic gateway token — permissionless.
#[derive(Accounts)]
pub struct SelfRegister<'info> {
    /// The user who wants to self-register. They sign and pay rent.
    #[account(mut)]
    pub user: Signer<'info>,

    /// Pool config — used to read gatekeeper_network and as PDA signer for CPI.
    #[account(
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// CHECK: Civic gateway token — deserialized and verified in handler via Pass.
    pub gateway_token: UncheckedAccount<'info>,

    /// CHECK: delta-mint MintConfig — validated by address constraint.
    #[account(mut, address = pool_config.dm_mint_config)]
    pub dm_mint_config: UncheckedAccount<'info>,

    /// CHECK: WhitelistEntry PDA — created by delta-mint CPI.
    #[account(mut)]
    pub whitelist_entry: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub system_program: Program<'info, System>,
}

/// Self-register on a native-wrap pool (cSOL, cUSDC, …) via Civic.
/// Account-shape twin of [`SelfRegister`] — the only differences are:
///   * `pool_config` seeds are `[b"native_pool", wrapped_mint]` so the
///     account validates against the cSOL/cUSDC pool layout (the v1
///     `[b"pool", underlying_mint]` shape rejects with ConstraintSeeds
///     before the handler runs).
///   * Handler signs the delta-mint CPI with the matching native-pool
///     seeds (see `self_register_native`).
/// Use in tandem with [`SelfRegister`] in a single signed tx so a
/// Civic-verified wallet picks up whitelist entries on every pool
/// the retail flow touches in one signature.
#[derive(Accounts)]
pub struct SelfRegisterNative<'info> {
    /// The user who wants to self-register. They sign and pay rent.
    #[account(mut)]
    pub user: Signer<'info>,

    /// Pool config — native-pool seed shape, used both for reading
    /// `gatekeeper_network` and as the PDA signer for the delta-mint CPI.
    #[account(
        seeds = [b"native_pool", pool_config.wrapped_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// CHECK: Civic gateway token — deserialized and verified in handler via Pass.
    pub gateway_token: UncheckedAccount<'info>,

    /// CHECK: delta-mint MintConfig — validated by address constraint.
    #[account(mut, address = pool_config.dm_mint_config)]
    pub dm_mint_config: UncheckedAccount<'info>,

    /// CHECK: WhitelistEntry PDA — created by delta-mint CPI.
    #[account(mut)]
    pub whitelist_entry: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub system_program: Program<'info, System>,
}

