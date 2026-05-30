use anchor_lang::prelude::*;

declare_id!("8GjxQkJ82LrxpKPYkXw8hpbgCt17hDGk2rcYhqmeR3Ec");

/// Accrual Oracle — wraps a Pyth Solana Receiver (`PriceUpdateV2`) feed with a
/// linear time-based accrual index and writes the result back into a second
/// `PriceUpdateV2`-shaped account that klend will accept.
///
/// Use case: csSOL = 1.0 SOL at issuance; price grows over time as the
/// underlying validator earns staking rewards. We model this as
///
///     output_price = source_price * index_now
///     index_now    = base_index_e9 * (1 + rate_bps_per_year * dt / SECONDS_PER_YEAR / 10_000)
///
/// where `dt = now - last_index_update_ts`. Linear accrual is fine for small
/// rates (≤ 12 % APY) refreshed at least once per epoch; switch to a
/// fixed-point compounding form if a higher rate ever lands here.
///
/// Setting `rate_bps_per_year = 0` makes the oracle a transparent passthrough
/// — same shape as the source feed. That's the baseline csSOL ships with.
#[program]
pub mod accrual_oracle {
    use super::*;

    /// Create a new accrual feed. The signer becomes the authority and pays
    /// rent for the 133-byte output account if it does not yet exist.
    ///
    /// `source_program` + `feed_id` together identify the upstream price.
    /// The `refresh` ix accepts ANY `PriceUpdateV2` account owned by
    /// `source_program` whose feed_id matches — typically a freshly
    /// `post_update_atomic`-created Pyth Receiver account that lives just
    /// long enough for one refresh tx.
    pub fn initialize(
        ctx: Context<Initialize>,
        base_index_e9: u64,
        rate_bps_per_year: i32,
        min_rate_change_delay_secs: u32,
        max_rate_delta_bps_per_change: u32,
        source_program: Pubkey,
        feed_id: [u8; 32],
    ) -> Result<()> {
        require!(base_index_e9 > 0, OracleError::InvalidIndex);
        require!(max_rate_delta_bps_per_change > 0, OracleError::InvalidRateBound);
        let now = Clock::get()?.unix_timestamp;

        let cfg = &mut ctx.accounts.feed_config;
        cfg.authority = ctx.accounts.authority.key();
        cfg.source_program = source_program;
        cfg.feed_id = feed_id;
        cfg.output = ctx.accounts.output.key();
        cfg.base_index_e9 = base_index_e9;
        cfg.rate_bps_per_year = rate_bps_per_year;
        cfg.last_index_update_ts = now;
        cfg.min_rate_change_delay_secs = min_rate_change_delay_secs;
        cfg.max_rate_delta_bps_per_change = max_rate_delta_bps_per_change;
        cfg.pending_rate_bps_per_year = rate_bps_per_year;
        cfg.pending_activation_ts = 0; // 0 = no proposal in flight
        cfg.bump = ctx.bumps.feed_config;
        cfg.vault = Pubkey::default(); // bind via set_vault later if Vault-mode is desired

        // Seed the output account with the discriminator + authority + verification level
        // so the first refresh has a well-formed account to overwrite.
        let mut data = ctx.accounts.output.try_borrow_mut_data()?;
        require!(data.len() == PRICE_UPDATE_V2_LEN, OracleError::InvalidOutputSize);
        data[0..8].copy_from_slice(&PRICE_UPDATE_V2_DISC);
        data[8..40].copy_from_slice(&ctx.accounts.authority.key().to_bytes());
        data[40] = 1; // verification_level = Full

        Ok(())
    }

    /// Propose a new accrual rate. Only authority. The change is bounded by
    /// `max_rate_delta_bps_per_change` and does NOT take effect until
    /// `activate_pending_rate` is called after `min_rate_change_delay_secs`.
    /// Calling this overwrites any prior in-flight proposal, restarting the
    /// cooldown — which is intentional: there's never a race window where a
    /// half-prepared rate is committed silently.
    pub fn propose_rate(ctx: Context<AdminOnly>, new_rate_bps_per_year: i32) -> Result<()> {
        let cfg = &mut ctx.accounts.feed_config;
        let delta = (new_rate_bps_per_year as i64 - cfg.rate_bps_per_year as i64).unsigned_abs();
        require!(
            delta <= cfg.max_rate_delta_bps_per_change as u64,
            OracleError::RateDeltaTooLarge
        );
        let now = Clock::get()?.unix_timestamp;
        cfg.pending_rate_bps_per_year = new_rate_bps_per_year;
        cfg.pending_activation_ts = now.saturating_add(cfg.min_rate_change_delay_secs as i64);

        emit!(RateProposedEvent {
            feed_config: cfg.key(),
            current_rate_bps: cfg.rate_bps_per_year,
            pending_rate_bps: new_rate_bps_per_year,
            activation_ts: cfg.pending_activation_ts,
        });
        Ok(())
    }

    /// Commit the pending rate. Permissionless after the cooldown elapses.
    /// Rolls the index forward at the OLD rate up to the activation moment,
    /// then swaps in the new rate. Calling this with no proposal in flight or
    /// before the cooldown is a no-op error.
    pub fn activate_pending_rate(ctx: Context<Activate>) -> Result<()> {
        let cfg = &mut ctx.accounts.feed_config;
        require!(cfg.pending_activation_ts > 0, OracleError::NoPendingRate);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= cfg.pending_activation_ts, OracleError::CooldownNotElapsed);

        let dt = cfg.pending_activation_ts - cfg.last_index_update_ts;
        let rolled = compute_index(cfg.base_index_e9, cfg.rate_bps_per_year, dt)?;
        cfg.base_index_e9 = rolled;
        cfg.last_index_update_ts = cfg.pending_activation_ts;
        cfg.rate_bps_per_year = cfg.pending_rate_bps_per_year;
        cfg.pending_activation_ts = 0;

        emit!(RateActivatedEvent {
            feed_config: cfg.key(),
            new_rate_bps: cfg.rate_bps_per_year,
            committed_index_e9: cfg.base_index_e9,
            ts: cfg.last_index_update_ts,
        });
        Ok(())
    }

    /// Cancel a pending rate proposal before it activates. Authority only.
    pub fn cancel_pending_rate(ctx: Context<AdminOnly>) -> Result<()> {
        let cfg = &mut ctx.accounts.feed_config;
        require!(cfg.pending_activation_ts > 0, OracleError::NoPendingRate);
        cfg.pending_rate_bps_per_year = cfg.rate_bps_per_year;
        cfg.pending_activation_ts = 0;
        Ok(())
    }

    /// Replace the authority. Only current authority.
    pub fn set_authority(ctx: Context<AdminOnly>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.feed_config.authority = new_authority;
        Ok(())
    }

    /// Refresh the output feed. Permissionless — anyone can call.
    /// Reads `source_price` from the source PriceUpdateV2 account, multiplies
    /// by the running accrual index, and writes the resulting price into the
    /// output PriceUpdateV2 account.
    ///
    /// Source and output share the same `exponent`; only `price`, `ema_price`,
    /// `publish_time`, `prev_publish_time`, and `posted_slot` change.
    pub fn refresh(ctx: Context<Refresh>) -> Result<()> {
        let cfg = &ctx.accounts.feed_config;
        require!(ctx.accounts.output.key() == cfg.output, OracleError::OutputMismatch);
        require_keys_eq!(
            *ctx.accounts.source.owner,
            cfg.source_program,
            OracleError::SourceOwnerMismatch
        );

        let now = Clock::get()?.unix_timestamp;
        let slot = Clock::get()?.slot;
        let dt = now.saturating_sub(cfg.last_index_update_ts);
        let index_e9 = compute_index(cfg.base_index_e9, cfg.rate_bps_per_year, dt)?;

        let src = ctx.accounts.source.try_borrow_data()?;
        require!(src.len() >= PRICE_UPDATE_V2_LEN, OracleError::InvalidSourceSize);
        require!(&src[0..8] == PRICE_UPDATE_V2_DISC, OracleError::InvalidSourceDisc);
        // PriceUpdateV2 layout: feed_id is 32 bytes at offset 41..73.
        require!(&src[41..73] == cfg.feed_id, OracleError::FeedIdMismatch);

        let src_price = i64::from_le_bytes(src[73..81].try_into().unwrap());
        let src_conf = u64::from_le_bytes(src[81..89].try_into().unwrap());
        let src_expo = i32::from_le_bytes(src[89..93].try_into().unwrap());
        let src_pub_time = i64::from_le_bytes(src[93..101].try_into().unwrap());
        // Source EMA at offsets 109..117 (price) / 117..125 (conf). Reading
        // these and scaling them independently preserves the price/EMA
        // distinction klend's RequestElevationGroup checks against —
        // duplicating out_price into the EMA slot leaves PriceStatusFlags
        // bit 1 (PYTH_EMA) cleared and the elevation-join ix rejects the
        // obligation as stale even after a same-slot RefreshObligation.
        let src_ema_price = i64::from_le_bytes(src[109..117].try_into().unwrap());
        let src_ema_conf = u64::from_le_bytes(src[117..125].try_into().unwrap());
        drop(src);

        // out_price = src_price * index_e9 / 1e9. Use i128 to avoid overflow.
        let scaled = (src_price as i128).saturating_mul(index_e9 as i128) / 1_000_000_000i128;
        let out_price = i64::try_from(scaled).map_err(|_| OracleError::PriceOverflow)?;
        // Confidence scales the same way (price-relative), so multiply by the
        // index too — preserves the relative confidence band the source feed reports.
        let scaled_conf = (src_conf as u128).saturating_mul(index_e9 as u128) / 1_000_000_000u128;
        let out_conf = u64::try_from(scaled_conf).unwrap_or(u64::MAX);

        // Same scaling for the EMA price/conf so klend's PYTH_EMA check
        // sees a non-degenerate (price ≠ ema) update.
        let scaled_ema = (src_ema_price as i128).saturating_mul(index_e9 as i128) / 1_000_000_000i128;
        let out_ema_price = i64::try_from(scaled_ema).map_err(|_| OracleError::PriceOverflow)?;
        let scaled_ema_conf = (src_ema_conf as u128).saturating_mul(index_e9 as u128) / 1_000_000_000u128;
        let out_ema_conf = u64::try_from(scaled_ema_conf).unwrap_or(u64::MAX);

        let mut out = ctx.accounts.output.try_borrow_mut_data()?;
        require!(out.len() == PRICE_UPDATE_V2_LEN, OracleError::InvalidOutputSize);
        require!(&out[0..8] == PRICE_UPDATE_V2_DISC, OracleError::InvalidOutputDisc);

        out[73..81].copy_from_slice(&out_price.to_le_bytes());
        out[81..89].copy_from_slice(&out_conf.to_le_bytes());
        out[89..93].copy_from_slice(&src_expo.to_le_bytes());
        let prev_pub_time = i64::from_le_bytes(out[93..101].try_into().unwrap());
        out[93..101].copy_from_slice(&src_pub_time.max(now).to_le_bytes());
        out[101..109].copy_from_slice(&prev_pub_time.to_le_bytes());
        out[109..117].copy_from_slice(&out_ema_price.to_le_bytes());
        out[117..125].copy_from_slice(&out_ema_conf.to_le_bytes());
        out[125..133].copy_from_slice(&slot.to_le_bytes());

        emit!(RefreshEvent {
            feed_config: cfg.key(),
            output: ctx.accounts.output.key(),
            source_price: src_price,
            output_price: out_price,
            index_e9,
            ts: now,
        });

        Ok(())
    }

    /// Refresh the output feed using a Jito Vault's on-chain exchange rate
    /// instead of the authority-set time-based rate.
    ///
    ///   index_e9 = vault.tokensDeposited / vault.vrtSupply * 1e9
    ///
    /// This makes the index a pure function of the Vault's state — no
    /// authority knob is involved. As NCN operators distribute rewards into
    /// the Vault (or as it gets slashed), `tokensDeposited` shifts relative
    /// to `vrtSupply` and the derived index moves accordingly.
    ///
    /// Permissionless. Caller passes the Vault account; we validate its
    /// owner matches the configured `vault_program` and read the offsets
    /// fixed by the Jito Vault on-chain layout.
    pub fn refresh_with_vault(ctx: Context<RefreshWithVault>) -> Result<()> {
        let cfg = &ctx.accounts.feed_config;
        require!(ctx.accounts.output.key() == cfg.output, OracleError::OutputMismatch);
        require_keys_eq!(
            *ctx.accounts.source.owner,
            cfg.source_program,
            OracleError::SourceOwnerMismatch
        );
        // Optional vault binding — when set, we require the passed vault to
        // match exactly. When unset we accept any Jito-Vault-owned account.
        let configured_vault = cfg.vault;
        if configured_vault != Pubkey::default() {
            require_keys_eq!(ctx.accounts.vault.key(), configured_vault, OracleError::VaultMismatch);
        }
        require_keys_eq!(
            *ctx.accounts.vault.owner,
            JITO_VAULT_PROGRAM_ID,
            OracleError::VaultOwnerMismatch
        );

        let now = Clock::get()?.unix_timestamp;
        let slot = Clock::get()?.slot;

        // Vault layout (validated by the SDK type defs we cross-checked):
        //   8..40   base
        //   40..72  vrtMint
        //   72..104 supportedMint
        //   104..112 vrtSupply (u64 LE)
        //   112..120 tokensDeposited (u64 LE)
        let vault_data = ctx.accounts.vault.try_borrow_data()?;
        require!(vault_data.len() >= 120, OracleError::InvalidVaultSize);
        let vrt_supply = u64::from_le_bytes(vault_data[104..112].try_into().unwrap());
        let tokens_deposited = u64::from_le_bytes(vault_data[112..120].try_into().unwrap());
        drop(vault_data);

        // index_e9 = tokens_deposited * 1e9 / vrt_supply, clamped to 1.0 when
        // the vault is empty (avoids div-by-zero at bootstrap and gives a
        // sane passthrough until any deposits land).
        let index_e9: u64 = if vrt_supply == 0 {
            1_000_000_000
        } else {
            let scaled = (tokens_deposited as u128).saturating_mul(1_000_000_000u128) / (vrt_supply as u128);
            u64::try_from(scaled).map_err(|_| error!(OracleError::IndexOverflow))?
        };

        // Read source price (same shape as `refresh`).
        let src = ctx.accounts.source.try_borrow_data()?;
        require!(src.len() >= PRICE_UPDATE_V2_LEN, OracleError::InvalidSourceSize);
        require!(&src[0..8] == PRICE_UPDATE_V2_DISC, OracleError::InvalidSourceDisc);
        require!(&src[41..73] == cfg.feed_id, OracleError::FeedIdMismatch);
        let src_price = i64::from_le_bytes(src[73..81].try_into().unwrap());
        let src_conf = u64::from_le_bytes(src[81..89].try_into().unwrap());
        let src_expo = i32::from_le_bytes(src[89..93].try_into().unwrap());
        let src_pub_time = i64::from_le_bytes(src[93..101].try_into().unwrap());
        let src_ema_price = i64::from_le_bytes(src[109..117].try_into().unwrap());
        let src_ema_conf = u64::from_le_bytes(src[117..125].try_into().unwrap());
        drop(src);

        let scaled = (src_price as i128).saturating_mul(index_e9 as i128) / 1_000_000_000i128;
        let out_price = i64::try_from(scaled).map_err(|_| OracleError::PriceOverflow)?;
        let scaled_conf = (src_conf as u128).saturating_mul(index_e9 as u128) / 1_000_000_000u128;
        let out_conf = u64::try_from(scaled_conf).unwrap_or(u64::MAX);

        // Independent EMA scaling — see `refresh` for why this matters
        // (klend's RequestElevationGroup PYTH_EMA flag check).
        let scaled_ema = (src_ema_price as i128).saturating_mul(index_e9 as i128) / 1_000_000_000i128;
        let out_ema_price = i64::try_from(scaled_ema).map_err(|_| OracleError::PriceOverflow)?;
        let scaled_ema_conf = (src_ema_conf as u128).saturating_mul(index_e9 as u128) / 1_000_000_000u128;
        let out_ema_conf = u64::try_from(scaled_ema_conf).unwrap_or(u64::MAX);

        let mut out = ctx.accounts.output.try_borrow_mut_data()?;
        require!(out.len() == PRICE_UPDATE_V2_LEN, OracleError::InvalidOutputSize);
        require!(&out[0..8] == PRICE_UPDATE_V2_DISC, OracleError::InvalidOutputDisc);

        out[73..81].copy_from_slice(&out_price.to_le_bytes());
        out[81..89].copy_from_slice(&out_conf.to_le_bytes());
        out[89..93].copy_from_slice(&src_expo.to_le_bytes());
        let prev_pub_time = i64::from_le_bytes(out[93..101].try_into().unwrap());
        out[93..101].copy_from_slice(&src_pub_time.max(now).to_le_bytes());
        out[101..109].copy_from_slice(&prev_pub_time.to_le_bytes());
        out[109..117].copy_from_slice(&out_ema_price.to_le_bytes());
        out[117..125].copy_from_slice(&out_ema_conf.to_le_bytes());
        out[125..133].copy_from_slice(&slot.to_le_bytes());

        emit!(VaultRefreshEvent {
            feed_config: cfg.key(),
            output: ctx.accounts.output.key(),
            vault: ctx.accounts.vault.key(),
            tokens_deposited,
            vrt_supply,
            index_e9,
            source_price: src_price,
            output_price: out_price,
            ts: now,
        });

        Ok(())
    }

    /// Bind a Jito Vault address to the FeedConfig, enabling `refresh_with_vault`
    /// to enforce that ONLY this vault's state can drive the index. Authority only.
    /// Passing `Pubkey::default()` unbinds (any Jito-Vault-owned account accepted).
    pub fn set_vault(ctx: Context<AdminOnly>, vault: Pubkey) -> Result<()> {
        ctx.accounts.feed_config.vault = vault;
        Ok(())
    }

    /// One-shot migration of pre-v4 FeedConfig accounts (which lack the
    /// `vault: Pubkey` field at the end of the struct). Reallocs the
    /// account up to the new INIT_SPACE and zero-fills the appended bytes
    /// so the new layout deserializes cleanly. Authority-gated via raw
    /// byte comparison since `Account<FeedConfig>` would itself fail to
    /// deserialize on a pre-v4 account.
    pub fn migrate_to_v4(ctx: Context<MigrateToV4>) -> Result<()> {
        let account_info = &ctx.accounts.feed_config;
        let new_size = 8 + FeedConfig::INIT_SPACE;

        require!(account_info.owner == &crate::ID, OracleError::Unauthorized);

        let data = account_info.try_borrow_data()?;
        require!(data.len() >= 40, OracleError::Unauthorized);
        let stored_authority = Pubkey::try_from(&data[8..40]).unwrap();
        require!(
            stored_authority == ctx.accounts.authority.key(),
            OracleError::Unauthorized
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
            account_info.realloc(new_size, true)?; // zero-init new bytes
        }

        // The realloc(true) zero-fills the appended region, which is
        // exactly the layout for `vault: Pubkey = default()`. Done.
        Ok(())
    }
}

/// Jito Vault program ID (same on devnet + mainnet).
const JITO_VAULT_PROGRAM_ID: Pubkey = anchor_lang::solana_program::pubkey!("Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8");

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

const SECONDS_PER_YEAR: i64 = 365 * 24 * 60 * 60;
pub const PRICE_UPDATE_V2_LEN: usize = 133;
pub const PRICE_UPDATE_V2_DISC: [u8; 8] = [0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd];

/// `index * (1 + rate_bps_per_year * dt_secs / 10_000 / SECONDS_PER_YEAR)`,
/// computed in i128 to avoid intermediate overflow. Negative rates are
/// supported (de-peg / slashing scenarios) but the result is clamped to 1
/// since a non-positive index would underflow downstream price math.
fn compute_index(base_index_e9: u64, rate_bps_per_year: i32, dt_secs: i64) -> Result<u64> {
    if rate_bps_per_year == 0 || dt_secs <= 0 {
        return Ok(base_index_e9);
    }
    let delta = (base_index_e9 as i128)
        .saturating_mul(rate_bps_per_year as i128)
        .saturating_mul(dt_secs as i128)
        / (10_000i128 * SECONDS_PER_YEAR as i128);
    let next = (base_index_e9 as i128).saturating_add(delta);
    if next <= 0 {
        return Ok(1);
    }
    u64::try_from(next).map_err(|_| error!(OracleError::IndexOverflow))
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(
    base_index_e9: u64,
    rate_bps_per_year: i32,
    min_rate_change_delay_secs: u32,
    max_rate_delta_bps_per_change: u32,
    source_program: Pubkey,
    feed_id: [u8; 32],
)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + FeedConfig::INIT_SPACE,
        seeds = [b"accrual", feed_id.as_ref(), output.key().as_ref()],
        bump,
    )]
    pub feed_config: Account<'info, FeedConfig>,

    /// CHECK: PriceUpdateV2 output — owned by this program, pre-allocated by
    /// the caller (System::create_account with space=133, owner=accrual_oracle).
    #[account(mut, owner = crate::ID)]
    pub output: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub authority: Signer<'info>,

    #[account(mut, has_one = authority)]
    pub feed_config: Account<'info, FeedConfig>,
}

#[derive(Accounts)]
pub struct Activate<'info> {
    #[account(mut)]
    pub feed_config: Account<'info, FeedConfig>,
}

#[derive(Accounts)]
pub struct Refresh<'info> {
    #[account(seeds = [b"accrual", feed_config.feed_id.as_ref(), feed_config.output.as_ref()], bump = feed_config.bump)]
    pub feed_config: Account<'info, FeedConfig>,

    /// CHECK: validated by owner == feed_config.source_program AND
    /// data[41..73] (PriceUpdateV2.feed_id) == feed_config.feed_id, plus
    /// the canonical discriminator. Permissionless — any account satisfying
    /// those checks is acceptable, which is exactly what lets us consume a
    /// freshly-posted Pyth Receiver account that gets closed in the same tx.
    pub source: UncheckedAccount<'info>,

    /// CHECK: validated against feed_config.output + program ownership.
    #[account(mut, owner = crate::ID)]
    pub output: AccountInfo<'info>,
}

/// Authority-gated migration. Uses `UncheckedAccount` so the ix can run
/// against pre-v4 accounts that the strict `Account<FeedConfig>`
/// deserializer would reject.
#[derive(Accounts)]
pub struct MigrateToV4<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: validated and reallocated inside the ix.
    #[account(mut)]
    pub feed_config: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefreshWithVault<'info> {
    #[account(seeds = [b"accrual", feed_config.feed_id.as_ref(), feed_config.output.as_ref()], bump = feed_config.bump)]
    pub feed_config: Account<'info, FeedConfig>,

    /// CHECK: validated by owner == feed_config.source_program + disc + feed_id.
    pub source: UncheckedAccount<'info>,

    /// CHECK: must be a Jito Vault account (owner check inside the ix).
    pub vault: UncheckedAccount<'info>,

    /// CHECK: validated against feed_config.output + program ownership.
    #[account(mut, owner = crate::ID)]
    pub output: AccountInfo<'info>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct FeedConfig {
    /// Authority that can propose / cancel rate changes and rotate authority.
    pub authority: Pubkey,
    /// Owner program of accepted source PriceUpdateV2 accounts. For real
    /// Pyth feeds this is the Pyth Solana Receiver:
    /// `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`.
    pub source_program: Pubkey,
    /// Pyth feed identifier (32 bytes). Refresh accepts any source account
    /// whose `feed_id` matches.
    pub feed_id: [u8; 32],
    /// Output PriceUpdateV2 account that klend reads.
    pub output: Pubkey,
    /// Running index, scaled by 1e9. 1.0 = 1_000_000_000.
    pub base_index_e9: u64,
    /// Annualized accrual rate in bps. Positive = appreciation; 0 = passthrough.
    pub rate_bps_per_year: i32,
    /// Last time `base_index_e9` was committed.
    pub last_index_update_ts: i64,
    /// Minimum delay between `propose_rate` and `activate_pending_rate`.
    /// Stops the authority from snapping the rate around inside a single
    /// block / transaction window. ~1 epoch (172 800 s) on mainnet, shorter
    /// is fine on devnet.
    pub min_rate_change_delay_secs: u32,
    /// Hard cap on `|new_rate − current_rate|` per proposal, in bps.
    /// e.g. 200 = the authority can only move APY by ±2 % per cooldown.
    pub max_rate_delta_bps_per_change: u32,
    /// Pending rate awaiting activation. Equal to `rate_bps_per_year` when
    /// no proposal is in flight.
    pub pending_rate_bps_per_year: i32,
    /// Unix timestamp at which `activate_pending_rate` becomes legal.
    /// 0 means no proposal is pending.
    pub pending_activation_ts: i64,
    pub bump: u8,
    /// Optional Jito Vault binding for `refresh_with_vault`. When set,
    /// the ix requires the passed vault to match exactly. When zeroed,
    /// any Jito-Vault-program-owned account is accepted (less strict;
    /// useful for migrations). Added in v4 — must remain last for
    /// backwards-compatible reallocation of pre-v4 accounts.
    pub vault: Pubkey,
}

// ---------------------------------------------------------------------------
// Events / Errors
// ---------------------------------------------------------------------------

#[event]
pub struct RefreshEvent {
    pub feed_config: Pubkey,
    pub output: Pubkey,
    pub source_price: i64,
    pub output_price: i64,
    pub index_e9: u64,
    pub ts: i64,
}

#[event]
pub struct RateProposedEvent {
    pub feed_config: Pubkey,
    pub current_rate_bps: i32,
    pub pending_rate_bps: i32,
    pub activation_ts: i64,
}

#[event]
pub struct RateActivatedEvent {
    pub feed_config: Pubkey,
    pub new_rate_bps: i32,
    pub committed_index_e9: u64,
    pub ts: i64,
}

#[event]
pub struct VaultRefreshEvent {
    pub feed_config: Pubkey,
    pub output: Pubkey,
    pub vault: Pubkey,
    pub tokens_deposited: u64,
    pub vrt_supply: u64,
    pub index_e9: u64,
    pub source_price: i64,
    pub output_price: i64,
    pub ts: i64,
}

#[error_code]
pub enum OracleError {
    #[msg("Source account is not owned by feed_config.source_program")]
    SourceOwnerMismatch,
    #[msg("Source PriceUpdateV2.feed_id does not match feed_config.feed_id")]
    FeedIdMismatch,
    #[msg("Output account does not match the configured output")]
    OutputMismatch,
    #[msg("Source account is not 133 bytes (PriceUpdateV2)")]
    InvalidSourceSize,
    #[msg("Output account is not 133 bytes (PriceUpdateV2)")]
    InvalidOutputSize,
    #[msg("Source account discriminator does not match PriceUpdateV2")]
    InvalidSourceDisc,
    #[msg("Output account discriminator does not match PriceUpdateV2")]
    InvalidOutputDisc,
    #[msg("Output price overflowed i64")]
    PriceOverflow,
    #[msg("Accrual index overflowed u64")]
    IndexOverflow,
    #[msg("Initial index must be non-zero")]
    InvalidIndex,
    #[msg("max_rate_delta_bps_per_change must be > 0")]
    InvalidRateBound,
    #[msg("Proposed rate exceeds max_rate_delta_bps_per_change")]
    RateDeltaTooLarge,
    #[msg("No pending rate proposal in flight")]
    NoPendingRate,
    #[msg("Cooldown has not elapsed yet")]
    CooldownNotElapsed,
    #[msg("Passed vault does not match feed_config.vault")]
    VaultMismatch,
    #[msg("Vault account is not owned by the Jito Vault program")]
    VaultOwnerMismatch,
    #[msg("Vault account is too small to be a Jito Vault")]
    InvalidVaultSize,
    #[msg("Signer is not the FeedConfig authority")]
    Unauthorized,
}
