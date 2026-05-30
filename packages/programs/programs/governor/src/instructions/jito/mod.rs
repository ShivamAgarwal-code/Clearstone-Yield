//! Jito-vault flow + csSOL-WT (withdraw-ticket) lifecycle.
//!
//! Wrap path (`wrap_with_jito_vault`): atomically MintTo-stakes user
//! wSOL into a KYC-gated Jito Vault, sweeps the freshly-minted VRT into
//! a pool-owned vault, and mints csSOL to the user via delta-mint —
//! pool PDA is the vault's `mintBurnAdmin` and delta-mint's mint
//! authority post-`activate_wrapping`.
//!
//! Unwrap-via-collateral-swap path: the multi-tx chain that lets a
//! leveraged csSOL position exit the Jito epoch lock without sourcing
//! external SOL liquidity:
//!   1. `enqueue_withdraw_via_pool` — burns user csSOL, mints
//!      csSOL-WT 1:1, queues a Jito unstake ticket.
//!   2. `mature_withdrawal_tickets` — once Jito's epoch lock has
//!      elapsed, burns the ticket and sweeps wSOL into the pool's
//!      pending pool.
//!   3. `redeem_cssol_wt` — burns user's csSOL-WT, transfers wSOL out
//!      of `pool_pending_wsol` (PDA-signed).
//!
//! Plus the queue-management trio: `init_withdraw_queue`,
//! `close_withdraw_queue`, `import_orphan_ticket`.
//!
//! Function names match the original `#[program]` block exactly so
//! Anchor ix discriminators (`sha256("global:<name>")[..8]`) stay
//! identical to the deployed binary.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_spl::token_interface;
use delta_mint::cpi as delta_cpi;
use delta_mint::cpi::accounts as delta_accounts;
use delta_mint::program::DeltaMint as DeltaMintProgram;

use crate::constants::*;
use crate::state::*;
use crate::errors::*;
use crate::events::*;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub fn wrap_with_jito_vault(ctx: Context<WrapWithJitoVault>, amount: u64) -> Result<()> {
    require!(
        ctx.accounts.pool_config.status == PoolStatus::Active,
        GovernorError::PoolNotActive
    );
    require!(amount > 0, GovernorError::InvalidPoolStatus);

    let underlying = ctx.accounts.pool_config.underlying_mint;
    let bump = ctx.accounts.pool_config.bump;
    let pool_pda_seeds: &[&[u8]] = &[b"pool".as_ref(), underlying.as_ref(), &[bump]];

    // 1. Build + invoke Jito Vault MintTo manually. The Vault SDK is
    //    @solana/kit-native; we bypass it and emit the canonical ix.
    //    Account ordering per @jito-foundation/vault-sdk MintToInput:
    //       config, vault, vrtMint, depositor (signer, W),
    //       depositorTokenAccount (W), vaultTokenAccount (W),
    //       depositorVrtTokenAccount (W), vaultFeeTokenAccount (W),
    //       tokenProgram, mintSigner (signer).
    //    Args: u8 disc | u64 amountIn | u64 minAmountOut.
    let mut data = Vec::with_capacity(1 + 8 + 8);
    data.push(JITO_VAULT_MINT_TO_DISC);
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes()); // minAmountOut = 0 (no slippage check at this layer)

    // Jito Vault enforces `depositor_vrt_token_account.owner == depositor`,
    // so VRT must mint to the user's own VRT ATA in this CPI. We then
    // transfer it onward to the pool VRT vault below — net effect: VRT
    // ends up under pool custody, csSOL is the user-facing token.
    let metas = vec![
        AccountMeta::new_readonly(ctx.accounts.jito_vault_config.key(), false),
        AccountMeta::new(ctx.accounts.jito_vault.key(), false),
        AccountMeta::new(ctx.accounts.vrt_mint.key(), false),
        AccountMeta::new(ctx.accounts.user.key(), true),
        AccountMeta::new(ctx.accounts.user_underlying_ata.key(), false),
        AccountMeta::new(ctx.accounts.vault_st_token_account.key(), false),
        AccountMeta::new(ctx.accounts.user_vrt_token_account.key(), false),
        AccountMeta::new(ctx.accounts.vault_fee_token_account.key(), false),
        AccountMeta::new_readonly(ctx.accounts.spl_token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.pool_config.key(), true),
    ];

    let ix = Instruction {
        program_id: JITO_VAULT_PROGRAM_ID,
        accounts: metas,
        data,
    };

    invoke_signed(
        &ix,
        &[
            ctx.accounts.jito_vault_program.to_account_info(),
            ctx.accounts.jito_vault_config.to_account_info(),
            ctx.accounts.jito_vault.to_account_info(),
            ctx.accounts.vrt_mint.to_account_info(),
            ctx.accounts.user.to_account_info(),
            ctx.accounts.user_underlying_ata.to_account_info(),
            ctx.accounts.vault_st_token_account.to_account_info(),
            ctx.accounts.user_vrt_token_account.to_account_info(),
            ctx.accounts.vault_fee_token_account.to_account_info(),
            ctx.accounts.spl_token_program.to_account_info(),
            ctx.accounts.pool_config.to_account_info(),
        ],
        &[pool_pda_seeds],
    )?;

    // 1b. Sweep the freshly-minted VRT from user → pool VRT vault. The
    //     user signs as the source authority (already a Signer in this
    //     ix's accounts). After this transfer the VRT is under pool
    //     custody — pool can later redeem it through Jito Vault on
    //     behalf of csSOL holders during unwrap.
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.spl_token_program.to_account_info(),
            token_interface::TransferChecked {
                from: ctx.accounts.user_vrt_token_account.to_account_info(),
                mint: ctx.accounts.vrt_mint.to_account_info(),
                to: ctx.accounts.pool_vrt_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
        // VRT mint decimals == underlying decimals (set at vault init = 9 for our wSOL vault).
        ctx.accounts.pool_config.decimals,
    )?;

    // 2. Mint d-tokens to user via delta-mint CPI. The pool PDA is
    //    delta-mint's mint authority post-`activate_wrapping`.
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
            &[pool_pda_seeds],
        ),
        amount,
    )?;

    emit!(WrapWithJitoVaultEvent {
        pool: ctx.accounts.pool_config.key(),
        user: ctx.accounts.user.key(),
        jito_vault: ctx.accounts.jito_vault.key(),
        pool_vrt_token_account: ctx.accounts.pool_vrt_token_account.key(),
        underlying_amount: amount,
        wrapped_amount: amount,
    });

    Ok(())
}

pub fn import_orphan_ticket(
    ctx: Context<ImportOrphanTicket>,
    staker: Pubkey,
    cssol_wt_amount: u64,
) -> Result<()> {
    // Read the Jito ticket bytes directly: discriminator(8) +
    // vault(32) + staker(32) + base(32) + vrt_amount(u64=8) +
    // slot_unstaked(u64=8) + ...
    let ticket_ai = &ctx.accounts.vault_staker_withdrawal_ticket;
    require_keys_eq!(
        *ticket_ai.owner,
        JITO_VAULT_PROGRAM_ID,
        GovernorError::Unauthorized
    );
    let data = ticket_ai.try_borrow_data()?;
    require!(data.len() >= 120, GovernorError::TicketNotFound);
    let onchain_vault = Pubkey::try_from(&data[8..40]).unwrap();
    let onchain_staker = Pubkey::try_from(&data[40..72]).unwrap();
    let slot_unstaked = u64::from_le_bytes(data[112..120].try_into().unwrap());
    drop(data);

    // The Jito ticket must belong to the right vault + the staker arg.
    require_keys_eq!(
        onchain_vault,
        ctx.accounts.jito_vault.key(),
        GovernorError::ReserveMismatch
    );
    require_keys_eq!(onchain_staker, staker, GovernorError::Unauthorized);

    // Reject duplicates.
    let queue = &mut ctx.accounts.withdraw_queue;
    let already = queue.tickets.iter().any(|t| t.ticket_pda == ticket_ai.key());
    require!(!already, GovernorError::WithdrawQueueFull);

    let live_count = queue.tickets.iter().filter(|t| !t.redeemed).count();
    require!(
        live_count < MAX_WITHDRAW_QUEUE_TICKETS,
        GovernorError::WithdrawQueueFull
    );

    queue.tickets.push(WithdrawTicket {
        ticket_pda: ticket_ai.key(),
        staker,
        cssol_wt_amount,
        created_at_slot: slot_unstaked,
        redeemed: false,
    });
    queue.total_cssol_wt_minted = queue.total_cssol_wt_minted.saturating_add(cssol_wt_amount);

    msg!(
        "Imported orphan ticket {} (staker={}, amount={}, slot_unstaked={})",
        ticket_ai.key(),
        staker,
        cssol_wt_amount,
        slot_unstaked,
    );
    Ok(())
}

pub fn close_withdraw_queue(ctx: Context<CloseWithdrawQueue>) -> Result<()> {
    let pool_key = ctx.accounts.pool_config.key();
    let (expected, _bump) = Pubkey::find_program_address(
        &[b"withdraw_queue", pool_key.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(
        ctx.accounts.withdraw_queue.key(),
        expected,
        GovernorError::Unauthorized
    );
    require!(
        ctx.accounts.withdraw_queue.owner == &crate::ID,
        GovernorError::Unauthorized
    );

    // Drain lamports → authority and zero out the data, then
    // re-assign to the system program so a future
    // `init_withdraw_queue` can re-create the account fresh.
    let queue_ai = ctx.accounts.withdraw_queue.to_account_info();
    let auth_ai = ctx.accounts.authority.to_account_info();

    let lamports = queue_ai.lamports();
    **queue_ai.try_borrow_mut_lamports()? = 0;
    **auth_ai.try_borrow_mut_lamports()? = auth_ai.lamports().checked_add(lamports).unwrap();

    queue_ai.assign(&anchor_lang::solana_program::system_program::ID);
    queue_ai.resize(0)?;
    Ok(())
}

pub fn init_withdraw_queue(ctx: Context<InitWithdrawQueue>) -> Result<()> {
    let pool_key = ctx.accounts.pool_config.key();
    let queue = &mut ctx.accounts.withdraw_queue;
    queue.pool_config = pool_key;
    queue.pending_wsol = 0;
    queue.total_cssol_wt_minted = 0;
    queue.total_cssol_wt_redeemed = 0;
    queue.tickets = Vec::new();
    queue.bump = ctx.bumps.withdraw_queue;
    msg!("WithdrawQueue initialized for pool {}", pool_key);
    Ok(())
}

pub fn enqueue_withdraw_via_pool(ctx: Context<EnqueueWithdrawViaPool>, amount: u64) -> Result<()> {
    require!(
        ctx.accounts.pool_config.status == PoolStatus::Active,
        GovernorError::PoolNotActive
    );
    require!(amount > 0, GovernorError::InvalidPoolStatus);

    // Reject before any CPI if the queue is at cap. Each redeemed
    // entry is freed eagerly on `mature_withdrawal_tickets`, so a
    // healthy queue should never hit this.
    let live_count = ctx
        .accounts
        .withdraw_queue
        .tickets
        .iter()
        .filter(|t| !t.redeemed)
        .count();
    require!(
        live_count < MAX_WITHDRAW_QUEUE_TICKETS,
        GovernorError::WithdrawQueueFull
    );

    let underlying = ctx.accounts.pool_config.underlying_mint;
    let bump = ctx.accounts.pool_config.bump;
    let pool_seeds: &[&[u8]] = &[b"pool".as_ref(), underlying.as_ref(), &[bump]];

    // 1. Burn X csSOL from user — Token-2022 path. csSOL is the
    //    `wrapped_mint` on the pool config. The user is the
    //    authority on their own ATA, so this is a direct CPI with
    //    only the user signing (no PDA seeds).
    token_interface::burn(
        CpiContext::new(
            ctx.accounts.cssol_token_program.to_account_info(),
            token_interface::Burn {
                mint: ctx.accounts.cssol_mint.to_account_info(),
                from: ctx.accounts.user_cssol_ata.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // 2. Move X VRT from POOL_VRT_ATA → user's VRT ATA. Pool PDA
    //    signs as the source authority. This puts the VRT under the
    //    user's wallet *transiently* — long enough for the next CPI
    //    (Jito EnqueueWithdrawal) to consume it, where the user is
    //    the staker.
    //    Why we can't keep VRT in pool custody and use pool_pda as
    //    the staker: Jito's EnqueueWithdrawal funds the new ticket
    //    PDA's rent via system_program::transfer(from=staker, ...),
    //    which requires `from` to be system-owned (no data). pool_pda
    //    is an Anchor-managed PoolConfig account with data → fails.
    //    User wallets are system-owned → works.
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.spl_token_program.to_account_info(),
            token_interface::TransferChecked {
                from: ctx.accounts.pool_vrt_token_account.to_account_info(),
                mint: ctx.accounts.vrt_mint.to_account_info(),
                to: ctx.accounts.user_vrt_token_account.to_account_info(),
                authority: ctx.accounts.pool_config.to_account_info(),
            },
            &[pool_seeds],
        ),
        amount,
        ctx.accounts.pool_config.decimals, // VRT mint decimals = underlying decimals (9)
    )?;

    // 3. Jito EnqueueWithdrawal — split-signer setup:
    //    - staker = user (system-owned, funds the ticket PDA's
    //      rent via system_program::transfer).
    //    - base = governor-derived PDA per (pool, queue.total_minted)
    //      (signed via invoke_signed); each enqueue gets a unique
    //      ticket address. Replaces the v1 ephemeral-keypair pattern.
    //    - burn_signer = pool_pda (the vault's mint_burn_admin set
    //      at init, gates VRT-burning operations).
    //    User signs the outer governor ix (covers `staker`);
    //    invoke_signed adds PDA signatures for base + burn_signer.
    let mut data = Vec::with_capacity(1 + 8);
    data.push(JITO_VAULT_ENQUEUE_WITHDRAWAL_DISC);
    data.extend_from_slice(&amount.to_le_bytes());

    let metas = vec![
        AccountMeta::new_readonly(ctx.accounts.jito_vault_config.key(), false),
        AccountMeta::new(ctx.accounts.jito_vault.key(), false),
        AccountMeta::new(ctx.accounts.vault_staker_withdrawal_ticket.key(), false),
        AccountMeta::new(ctx.accounts.vault_staker_withdrawal_ticket_token_account.key(), false),
        AccountMeta::new(ctx.accounts.user.key(), true),                 // staker (W, signer = user)
        AccountMeta::new(ctx.accounts.user_vrt_token_account.key(), false), // staker_vrt_token_account (W)
        AccountMeta::new_readonly(ctx.accounts.base.key(), true),        // base (RO, signer = ephemeral keypair)
        AccountMeta::new_readonly(ctx.accounts.spl_token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.pool_config.key(), true), // burn_signer (RO, signer = pool_pda)
    ];

    let ix = Instruction {
        program_id: JITO_VAULT_PROGRAM_ID,
        accounts: metas,
        data,
    };

    // Bump for the `base` PDA — Anchor populated it from the seeds
    // constraint on the EnqueueWithdrawViaPool struct.
    let base_bump = ctx.bumps.base;
    let pool_key = ctx.accounts.pool_config.key();
    let nonce_le = ctx.accounts.withdraw_queue.total_cssol_wt_minted.to_le_bytes();
    let base_seeds: &[&[u8]] = &[
        b"wt_base".as_ref(),
        pool_key.as_ref(),
        nonce_le.as_ref(),
        &[base_bump],
    ];

    invoke_signed(
        &ix,
        &[
            ctx.accounts.jito_vault_program.to_account_info(),
            ctx.accounts.jito_vault_config.to_account_info(),
            ctx.accounts.jito_vault.to_account_info(),
            ctx.accounts.vault_staker_withdrawal_ticket.to_account_info(),
            ctx.accounts.vault_staker_withdrawal_ticket_token_account.to_account_info(),
            ctx.accounts.user.to_account_info(),
            ctx.accounts.user_vrt_token_account.to_account_info(),
            ctx.accounts.base.to_account_info(),
            ctx.accounts.spl_token_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.pool_config.to_account_info(),
        ],
        &[pool_seeds, base_seeds], // signs as burn_signer (pool PDA) AND base (per-enqueue PDA)
    )?;

    // 3. Mint X csSOL-WT to user via delta-mint CPI. The pool PDA
    //    is the authority on the csSOL-WT mint config (set up by
    //    a separate one-time `activate_wt_wrapping`-equivalent
    //    deploy step). Whitelist is enforced inside delta-mint::mint_to.
    delta_cpi::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.delta_mint_program.to_account_info(),
            delta_accounts::MintTokens {
                authority: ctx.accounts.pool_config.to_account_info(),
                mint_config: ctx.accounts.cssol_wt_mint_config.to_account_info(),
                mint: ctx.accounts.cssol_wt_mint.to_account_info(),
                mint_authority: ctx.accounts.cssol_wt_mint_authority.to_account_info(),
                whitelist_entry: ctx.accounts.whitelist_entry.to_account_info(),
                destination: ctx.accounts.user_cssol_wt_ata.to_account_info(),
                token_program: ctx.accounts.cssol_wt_token_program.to_account_info(),
            },
            &[pool_seeds],
        ),
        amount,
    )?;

    // 4. Append a ticket record to the queue. We always push a fresh
    //    entry; matured/redeemed slots are not reused (they're
    //    cleaned up on `mature_withdrawal_tickets` by truncating the
    //    leading run of redeemed entries).
    let ticket_pda = ctx.accounts.vault_staker_withdrawal_ticket.key();
    let staker = ctx.accounts.user.key();
    let now_slot = Clock::get()?.slot;
    let queue = &mut ctx.accounts.withdraw_queue;
    queue.tickets.push(WithdrawTicket {
        ticket_pda,
        staker,
        cssol_wt_amount: amount,
        created_at_slot: now_slot,
        redeemed: false,
    });
    queue.total_cssol_wt_minted = queue.total_cssol_wt_minted.saturating_add(amount);

    emit!(EnqueueWithdrawEvent {
        pool: ctx.accounts.pool_config.key(),
        user: ctx.accounts.user.key(),
        ticket: ticket_pda,
        cssol_burned: amount,
        cssol_wt_minted: amount,
        slot: now_slot,
    });

    Ok(())
}

pub fn mature_withdrawal_tickets(ctx: Context<MatureWithdrawalTicket>) -> Result<()> {
    let underlying = ctx.accounts.pool_config.underlying_mint;
    let bump = ctx.accounts.pool_config.bump;
    let pool_seeds: &[&[u8]] = &[b"pool".as_ref(), underlying.as_ref(), &[bump]];

    // Verify the ticket is in the queue, not yet redeemed, AND owned
    // by the calling user (matches Jito's own ticket.staker check —
    // error 1042 — but enforced earlier here so users get a clear
    // governor-side error if they try to crank someone else's ticket).
    let ticket_key = ctx.accounts.vault_staker_withdrawal_ticket.key();
    let user_key = ctx.accounts.user.key();
    let queue = &mut ctx.accounts.withdraw_queue;
    let entry_idx = queue
        .tickets
        .iter()
        .position(|t| t.ticket_pda == ticket_key && !t.redeemed)
        .ok_or(GovernorError::TicketNotFound)?;
    require!(
        queue.tickets[entry_idx].staker == user_key,
        GovernorError::Unauthorized
    );
    let cssol_wt_amount = queue.tickets[entry_idx].cssol_wt_amount;

    // 1. CPI BurnWithdrawalTicket — user is staker (matches the
    //    on-chain ticket.staker), pool PDA is burn_signer (matches
    //    vault.mint_burn_admin). wSOL flows from Jito vault to the
    //    user's wSOL ATA.
    let metas = vec![
        AccountMeta::new_readonly(ctx.accounts.jito_vault_config.key(), false),
        AccountMeta::new(ctx.accounts.jito_vault.key(), false),
        AccountMeta::new(ctx.accounts.vault_st_token_account.key(), false), // vault_token_account
        AccountMeta::new(ctx.accounts.vrt_mint.key(), false),
        AccountMeta::new(ctx.accounts.user.key(), false),                   // staker (NOT signer per IDL — but address must match ticket.staker)
        AccountMeta::new(ctx.accounts.user_wsol_ata.key(), false),          // staker_token_account = where wSOL lands
        AccountMeta::new(ctx.accounts.vault_staker_withdrawal_ticket.key(), false),
        AccountMeta::new(ctx.accounts.vault_staker_withdrawal_ticket_token_account.key(), false),
        AccountMeta::new(ctx.accounts.vault_fee_token_account.key(), false),
        AccountMeta::new(ctx.accounts.program_fee_token_account.key(), false),
        AccountMeta::new_readonly(ctx.accounts.spl_token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.pool_config.key(), true),    // burn_signer (signer = pool PDA)
    ];

    let ix = Instruction {
        program_id: JITO_VAULT_PROGRAM_ID,
        accounts: metas,
        data: vec![JITO_VAULT_BURN_WITHDRAWAL_TICKET_DISC],
    };

    invoke_signed(
        &ix,
        &[
            ctx.accounts.jito_vault_program.to_account_info(),
            ctx.accounts.jito_vault_config.to_account_info(),
            ctx.accounts.jito_vault.to_account_info(),
            ctx.accounts.vault_st_token_account.to_account_info(),
            ctx.accounts.vrt_mint.to_account_info(),
            ctx.accounts.user.to_account_info(),
            ctx.accounts.user_wsol_ata.to_account_info(),
            ctx.accounts.vault_staker_withdrawal_ticket.to_account_info(),
            ctx.accounts.vault_staker_withdrawal_ticket_token_account.to_account_info(),
            ctx.accounts.vault_fee_token_account.to_account_info(),
            ctx.accounts.program_fee_token_account.to_account_info(),
            ctx.accounts.spl_token_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.pool_config.to_account_info(),
        ],
        &[pool_seeds],
    )?;

    // 2. Sweep the freshly-received wSOL from user's wSOL ATA into
    //    the pool's pending pool. User signs as authority (covered
    //    by the outer ix's user signature). Net effect: from the
    //    user's wallet view, the wSOL just transits — they get the
    //    1:1 redemption later via `redeem_cssol_wt` against the same
    //    pool.
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.spl_token_program.to_account_info(),
            token_interface::TransferChecked {
                from: ctx.accounts.user_wsol_ata.to_account_info(),
                mint: ctx.accounts.wsol_mint.to_account_info(),
                to: ctx.accounts.pool_pending_wsol_ata.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        cssol_wt_amount,
        ctx.accounts.pool_config.decimals,
    )?;

    // 3. Mark the entry redeemed + bump pending_wsol.
    queue.tickets[entry_idx].redeemed = true;
    queue.pending_wsol = queue.pending_wsol.saturating_add(cssol_wt_amount);

    // Compact the head: drop leading runs of redeemed entries to
    // keep the live-count probe in `enqueue_withdraw_via_pool` cheap.
    let drop = queue.tickets.iter().take_while(|t| t.redeemed).count();
    if drop > 0 {
        queue.tickets.drain(0..drop);
    }

    emit!(MatureTicketEvent {
        pool: ctx.accounts.pool_config.key(),
        ticket: ticket_key,
        wsol_payout: cssol_wt_amount,
    });

    Ok(())
}

pub fn redeem_cssol_wt(ctx: Context<RedeemCsSolWt>, amount: u64) -> Result<()> {
    require!(amount > 0, GovernorError::InvalidPoolStatus);
    require!(
        ctx.accounts.withdraw_queue.pending_wsol >= amount,
        GovernorError::RedeemExceedsPending
    );

    let underlying = ctx.accounts.pool_config.underlying_mint;
    let bump = ctx.accounts.pool_config.bump;
    let pool_seeds: &[&[u8]] = &[b"pool".as_ref(), underlying.as_ref(), &[bump]];

    // 1. Burn X csSOL-WT from user (Token-2022, user signs as
    //    authority on their own ATA).
    token_interface::burn(
        CpiContext::new(
            ctx.accounts.cssol_wt_token_program.to_account_info(),
            token_interface::Burn {
                mint: ctx.accounts.cssol_wt_mint.to_account_info(),
                from: ctx.accounts.user_cssol_wt_ata.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // 2. Transfer X wSOL from pool's pending_wsol_pool → user's
    //    wSOL ATA. Pool PDA signs.
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.spl_token_program.to_account_info(),
            token_interface::TransferChecked {
                from: ctx.accounts.pool_pending_wsol_ata.to_account_info(),
                mint: ctx.accounts.wsol_mint.to_account_info(),
                to: ctx.accounts.user_wsol_ata.to_account_info(),
                authority: ctx.accounts.pool_config.to_account_info(),
            },
            &[pool_seeds],
        ),
        amount,
        ctx.accounts.pool_config.decimals,
    )?;

    let queue = &mut ctx.accounts.withdraw_queue;
    queue.pending_wsol = queue.pending_wsol.saturating_sub(amount);
    queue.total_cssol_wt_redeemed = queue.total_cssol_wt_redeemed.saturating_add(amount);

    emit!(RedeemCsSolWtEvent {
        pool: ctx.accounts.pool_config.key(),
        user: ctx.accounts.user.key(),
        cssol_wt_burned: amount,
        wsol_paid: amount,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/// Wrap underlying into d-tokens AND deposit underlying into a Jito Vault
/// in one tx. Pool PDA signs CPI MintTo as the Vault's `mintBurnAdmin`.
#[derive(Accounts)]
pub struct WrapWithJitoVault<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// Pool config — keyed by underlying mint, signs CPIs as mintBurnAdmin
    /// + delta-mint authority. Marked mut because delta-mint::mint_to
    /// expects the signer (us, via PDA) as a writable account.
    #[account(
        mut,
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// User's underlying token account — source of wSOL transferred into
    /// the Jito Vault during MintTo.
    #[account(mut)]
    pub user_underlying_ata: InterfaceAccount<'info, token_interface::TokenAccount>,

    // ── Jito Vault accounts ─────────────────────────────────────────────
    /// CHECK: program id check inside the ix.
    #[account(address = JITO_VAULT_PROGRAM_ID)]
    pub jito_vault_program: UncheckedAccount<'info>,

    /// CHECK: Jito Vault Config singleton PDA.
    pub jito_vault_config: UncheckedAccount<'info>,

    /// CHECK: our Jito Vault PDA.
    #[account(mut)]
    pub jito_vault: UncheckedAccount<'info>,

    /// CHECK: VRT mint owned by Jito Vault.
    #[account(mut)]
    pub vrt_mint: UncheckedAccount<'info>,

    /// CHECK: Vault's underlying-token ATA — receives the user's wSOL.
    #[account(mut)]
    pub vault_st_token_account: UncheckedAccount<'info>,

    /// CHECK: User's VRT ATA — Jito Vault MintTo enforces
    /// `depositor_vrt.owner == depositor`, so VRT mints here first. The
    /// next step in the same ix sweeps it to `pool_vrt_token_account`.
    #[account(mut)]
    pub user_vrt_token_account: UncheckedAccount<'info>,

    /// CHECK: Pool's VRT vault — ATA(vrt_mint, pool_pda, off_curve).
    /// Final destination of the freshly-minted VRT. Pool holds the
    /// canonical backing for csSOL supply.
    #[account(mut)]
    pub pool_vrt_token_account: UncheckedAccount<'info>,

    /// CHECK: Vault's fee VRT ATA — checked by Jito Vault program.
    #[account(mut)]
    pub vault_fee_token_account: UncheckedAccount<'info>,

    /// CHECK: SPL Token program (Jito Vault expects classic SPL Token for wSOL/VRT).
    pub spl_token_program: UncheckedAccount<'info>,

    // ── delta-mint accounts ─────────────────────────────────────────────
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

    /// CHECK: User's d-token ATA — destination for minted csSOL.
    #[account(mut)]
    pub user_wrapped_ata: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub wrapped_token_program: Interface<'info, token_interface::TokenInterface>,
}

#[derive(Accounts)]
pub struct ImportOrphanTicket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
        has_one = authority,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        mut,
        seeds = [b"withdraw_queue", pool_config.key().as_ref()],
        bump = withdraw_queue.bump,
        has_one = pool_config,
    )]
    pub withdraw_queue: Account<'info, WithdrawQueue>,

    /// CHECK: csSOL Jito vault — used to verify the orphan's vault.
    pub jito_vault: UncheckedAccount<'info>,

    /// CHECK: orphan ticket PDA on the Jito Vault program. Validated
    /// inside the ix (owner must equal Jito Vault, vault field must
    /// match `jito_vault`, staker field must match the `staker` arg).
    pub vault_staker_withdrawal_ticket: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CloseWithdrawQueue<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
        has_one = authority,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// CHECK: validated inside the ix via PDA derivation against the
    /// pool config; we use UncheckedAccount so old-layout queues can
    /// still be closed (the old data won't deserialize against the
    /// new WithdrawQueue layout).
    #[account(mut)]
    pub withdraw_queue: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitWithdrawQueue<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
        has_one = authority,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + WithdrawQueue::INIT_SPACE,
        seeds = [b"withdraw_queue", pool_config.key().as_ref()],
        bump,
    )]
    pub withdraw_queue: Account<'info, WithdrawQueue>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EnqueueWithdrawViaPool<'info> {
    /// The user requesting the unstake. Pays the Jito ticket creation
    /// rent + the Solana base fee; signs the Token-2022 burn for csSOL.
    #[account(mut)]
    pub user: Signer<'info>,

    /// Per-enqueue base PDA used as Jito's `base` for the ticket PDA
    /// derivation, so each enqueue produces a unique ticket address.
    /// Seeds: [b"wt_base", pool_config, withdraw_queue.total_cssol_wt_minted_le].
    /// Using the queue's running mint counter as the nonce ensures
    /// uniqueness across all enqueues (counter only ever increases).
    /// Replaces the v1 ephemeral-keypair approach so the user only
    /// needs one wallet signature — fewer "suspicious tx" wallet
    /// warnings.
    /// CHECK: address derivation enforced via seeds + bump constraint.
    #[account(
        seeds = [
            b"wt_base",
            pool_config.key().as_ref(),
            &withdraw_queue.total_cssol_wt_minted.to_le_bytes(),
        ],
        bump,
    )]
    pub base: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        mut,
        seeds = [b"withdraw_queue", pool_config.key().as_ref()],
        bump = withdraw_queue.bump,
        has_one = pool_config,
    )]
    pub withdraw_queue: Account<'info, WithdrawQueue>,

    // ── csSOL (the token being burned) ──
    /// CHECK: csSOL Token-2022 mint, pinned via pool_config.wrapped_mint.
    #[account(mut, address = pool_config.wrapped_mint)]
    pub cssol_mint: UncheckedAccount<'info>,

    /// CHECK: user's csSOL ATA, validated by the Token-2022 burn CPI.
    #[account(mut)]
    pub user_cssol_ata: UncheckedAccount<'info>,

    /// SPL Token-2022 program (csSOL is a Token-2022 mint).
    pub cssol_token_program: Interface<'info, token_interface::TokenInterface>,

    // ── Jito Vault EnqueueWithdrawal accounts ──
    /// CHECK: Jito Vault Config PDA — validated by Jito CPI.
    pub jito_vault_config: UncheckedAccount<'info>,
    /// CHECK: Jito Vault account (the csSOL Jito vault).
    #[account(mut)]
    pub jito_vault: UncheckedAccount<'info>,
    /// CHECK: VaultStakerWithdrawalTicket PDA — created by the Jito CPI.
    #[account(mut)]
    pub vault_staker_withdrawal_ticket: UncheckedAccount<'info>,
    /// CHECK: ticket-owned VRT ATA — created by the Jito CPI.
    #[account(mut)]
    pub vault_staker_withdrawal_ticket_token_account: UncheckedAccount<'info>,
    /// CHECK: pool's VRT ATA — source of VRT moved transiently to user
    /// before the Jito EnqueueWithdrawal CPI. Pool PDA is the authority.
    #[account(mut)]
    pub pool_vrt_token_account: UncheckedAccount<'info>,

    /// CHECK: VRT mint — needed for transfer_checked decimals validation
    /// when moving VRT pool→user.
    pub vrt_mint: UncheckedAccount<'info>,

    /// CHECK: user's VRT ATA — VRT lands here transiently from pool, then
    /// is consumed by the Jito EnqueueWithdrawal CPI within the same ix.
    #[account(mut)]
    pub user_vrt_token_account: UncheckedAccount<'info>,

    /// CHECK: Jito Vault program ID.
    #[account(address = JITO_VAULT_PROGRAM_ID)]
    pub jito_vault_program: UncheckedAccount<'info>,

    /// SPL Token program (regular, not 2022) — VRT is SPL Token.
    /// CHECK: pinned to canonical Token program by Jito CPI.
    pub spl_token_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    // ── delta-mint csSOL-WT mint accounts ──
    /// CHECK: csSOL-WT mint config (a *separate* delta-mint MintConfig
    /// from the csSOL one). Validated by the delta-mint CPI.
    #[account(mut)]
    pub cssol_wt_mint_config: UncheckedAccount<'info>,
    /// CHECK: csSOL-WT mint (Token-2022, KYC-gated via delta-mint).
    #[account(mut)]
    pub cssol_wt_mint: UncheckedAccount<'info>,
    /// CHECK: delta-mint MintAuthority PDA for csSOL-WT.
    pub cssol_wt_mint_authority: UncheckedAccount<'info>,
    /// CHECK: user's whitelist entry on the csSOL-WT mint config —
    /// validated by delta-mint::mint_to.
    pub whitelist_entry: UncheckedAccount<'info>,
    /// CHECK: user's csSOL-WT ATA — receives the freshly-minted WT.
    #[account(mut)]
    pub user_cssol_wt_ata: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,

    /// SPL Token-2022 program (csSOL-WT is also Token-2022).
    pub cssol_wt_token_program: Interface<'info, token_interface::TokenInterface>,
}

#[derive(Accounts)]
pub struct MatureWithdrawalTicket<'info> {
    /// The original ticket creator. Must match the staker recorded in
    /// the queue entry AND in the underlying Jito ticket. Pays the
    /// base fee. Maturation is therefore NOT permissionless — only
    /// the user who enqueued can mature their own ticket. This is a
    /// requirement of Jito's `ticket.staker == provided_staker` check
    /// and a correctness requirement of our pool accounting (we sweep
    /// the matured wSOL through this user's wSOL ATA).
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        mut,
        seeds = [b"withdraw_queue", pool_config.key().as_ref()],
        bump = withdraw_queue.bump,
        has_one = pool_config,
    )]
    pub withdraw_queue: Account<'info, WithdrawQueue>,

    // ── Jito Vault BurnWithdrawalTicket accounts ──
    /// CHECK: Jito Vault Config PDA.
    pub jito_vault_config: UncheckedAccount<'info>,
    /// CHECK: csSOL Jito Vault account.
    #[account(mut)]
    pub jito_vault: UncheckedAccount<'info>,
    /// CHECK: vault's underlying (wSOL) ATA — wSOL flows out from here.
    #[account(mut)]
    pub vault_st_token_account: UncheckedAccount<'info>,
    /// CHECK: VRT mint.
    #[account(mut)]
    pub vrt_mint: UncheckedAccount<'info>,
    /// CHECK: NATIVE_MINT (wSOL) — needed for transfer_checked.
    pub wsol_mint: UncheckedAccount<'info>,
    /// CHECK: user's wSOL ATA — Jito BurnWithdrawalTicket sends wSOL
    /// here first, then we sweep it into pool_pending_wsol_ata
    /// inside the same ix.
    #[account(mut)]
    pub user_wsol_ata: UncheckedAccount<'info>,
    /// CHECK: pool's pending-wSOL ATA — final destination of the wSOL
    /// after the same-ix sweep. Used by `redeem_cssol_wt` as the
    /// payout source.
    #[account(mut)]
    pub pool_pending_wsol_ata: UncheckedAccount<'info>,
    /// CHECK: ticket PDA being burned.
    #[account(mut)]
    pub vault_staker_withdrawal_ticket: UncheckedAccount<'info>,
    /// CHECK: ticket's VRT ATA being closed.
    #[account(mut)]
    pub vault_staker_withdrawal_ticket_token_account: UncheckedAccount<'info>,
    /// CHECK: vault fee ATA.
    #[account(mut)]
    pub vault_fee_token_account: UncheckedAccount<'info>,
    /// CHECK: program fee ATA.
    #[account(mut)]
    pub program_fee_token_account: UncheckedAccount<'info>,

    /// CHECK: Jito Vault program.
    #[account(address = JITO_VAULT_PROGRAM_ID)]
    pub jito_vault_program: UncheckedAccount<'info>,

    /// CHECK: SPL Token program (regular Token, not Token-2022 — wSOL is SPL Token).
    pub spl_token_program: Interface<'info, token_interface::TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RedeemCsSolWt<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        mut,
        seeds = [b"withdraw_queue", pool_config.key().as_ref()],
        bump = withdraw_queue.bump,
        has_one = pool_config,
    )]
    pub withdraw_queue: Account<'info, WithdrawQueue>,

    // csSOL-WT side (burn) — Token-2022.
    /// CHECK: csSOL-WT mint.
    #[account(mut)]
    pub cssol_wt_mint: UncheckedAccount<'info>,
    /// CHECK: user's csSOL-WT ATA.
    #[account(mut)]
    pub user_cssol_wt_ata: UncheckedAccount<'info>,
    pub cssol_wt_token_program: Interface<'info, token_interface::TokenInterface>,

    // wSOL side (transfer pool→user).
    /// CHECK: NATIVE_MINT pubkey, fixed.
    pub wsol_mint: UncheckedAccount<'info>,
    /// CHECK: pool's pending-wSOL ATA.
    #[account(mut)]
    pub pool_pending_wsol_ata: UncheckedAccount<'info>,
    /// CHECK: user's wSOL ATA.
    #[account(mut)]
    pub user_wsol_ata: UncheckedAccount<'info>,
    /// CHECK: SPL Token program (wSOL is regular SPL Token).
    pub spl_token_program: UncheckedAccount<'info>,
}

