use anchor_lang::prelude::*;

declare_id!("BbjcMyV2yQaxsgTZAdMFXxFiXSeaUWggoRJMLvZhYFzU");

/// TradeDesk Oracle — Institutional price feed management.
///
/// Designed for bank trade-desk operators to publish and manage price feeds
/// for RWA tokens and stablecoins. Each desk has its own configuration,
/// operators, and set of managed feeds.
///
/// Architecture:
///   Desk (PDA) → managed by desk_admin + operators
///     └─ Feed (PDA) → individual price feeds (e.g., "USDY/USD", "USDC/USD")
///
/// Switchboard V2 integration:
///   A Switchboard V2 aggregator can be configured with a CacheTask job that
///   reads from a Feed PDA. This makes the price available in a Switchboard-owned
///   account that klend (Kamino Lend) accepts.
///
/// Flow: Operator → set_price(Feed) → Switchboard crank reads Feed → klend reads Switchboard
#[program]
pub mod mock_oracle {
    use super::*;

    // -----------------------------------------------------------------------
    // Desk management
    // -----------------------------------------------------------------------

    /// Create a new trade desk. The signer becomes the desk admin.
    pub fn create_desk(
        ctx: Context<CreateDesk>,
        name: String,
        description: String,
    ) -> Result<()> {
        let desk = &mut ctx.accounts.desk;
        desk.admin = ctx.accounts.admin.key();
        desk.name = pad_string::<64>(&name);
        desk.description = pad_string::<128>(&description);
        desk.feed_count = 0;
        desk.operator_count = 0;
        desk.created_at = Clock::get()?.unix_timestamp;
        desk.bump = ctx.bumps.desk;
        Ok(())
    }

    /// Add an operator to the desk. Only desk admin.
    pub fn add_operator(ctx: Context<ManageOperator>) -> Result<()> {
        let entry = &mut ctx.accounts.operator_entry;
        entry.desk = ctx.accounts.desk.key();
        entry.wallet = ctx.accounts.operator.key();
        entry.added_by = ctx.accounts.admin.key();
        entry.added_at = Clock::get()?.unix_timestamp;
        entry.bump = ctx.bumps.operator_entry;

        let desk = &mut ctx.accounts.desk;
        desk.operator_count += 1;
        Ok(())
    }

    /// Remove an operator. Only desk admin.
    pub fn remove_operator(ctx: Context<RemoveOperator>) -> Result<()> {
        let desk = &mut ctx.accounts.desk;
        desk.operator_count = desk.operator_count.saturating_sub(1);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Feed management
    // -----------------------------------------------------------------------

    /// Create a new price feed under a desk.
    /// Only the desk admin or an operator can create feeds.
    pub fn create_feed(
        ctx: Context<CreateFeed>,
        label: String,
        base_asset: String,
        quote_asset: String,
        expo: i32,
        initial_price: i64,
    ) -> Result<()> {
        require!(
            is_desk_authorized(
                &ctx.accounts.authority.key(),
                &ctx.accounts.desk.admin,
                &ctx.accounts.desk.key(),
                &ctx.accounts.operator_entry,
            ),
            OracleError::Unauthorized
        );

        let feed = &mut ctx.accounts.price_feed;
        feed.desk = ctx.accounts.desk.key();
        feed.label = pad_string::<32>(&label);
        feed.base_asset = pad_string::<16>(&base_asset);
        feed.quote_asset = pad_string::<16>(&quote_asset);
        feed.price = initial_price;
        feed.expo = expo;
        feed.confidence = 10000; // default tight confidence
        feed.status = FeedStatus::Active;
        feed.last_update_slot = Clock::get()?.slot;
        feed.last_update_ts = Clock::get()?.unix_timestamp;
        feed.updated_by = ctx.accounts.authority.key();
        feed.switchboard_feed = Pubkey::default();
        feed.bump = ctx.bumps.price_feed;

        let desk = &mut ctx.accounts.desk;
        desk.feed_count += 1;

        emit!(FeedCreatedEvent {
            desk: desk.key(),
            feed: ctx.accounts.price_feed.key(),
            label: label.clone(),
            price: initial_price,
            expo,
        });

        Ok(())
    }

    /// Update the price of a feed. Desk admin or operator.
    pub fn set_price(
        ctx: Context<UpdatePrice>,
        price: i64,
        confidence: u64,
    ) -> Result<()> {
        require!(
            is_desk_authorized(
                &ctx.accounts.authority.key(),
                &ctx.accounts.desk.admin,
                &ctx.accounts.desk.key(),
                &ctx.accounts.operator_entry,
            ),
            OracleError::Unauthorized
        );

        let feed = &mut ctx.accounts.price_feed;
        require!(
            feed.status == FeedStatus::Active,
            OracleError::FeedNotActive
        );

        let old_price = feed.price;
        feed.price = price;
        feed.confidence = confidence;
        feed.last_update_slot = Clock::get()?.slot;
        feed.last_update_ts = Clock::get()?.unix_timestamp;
        feed.updated_by = ctx.accounts.authority.key();

        emit!(PriceUpdatedEvent {
            feed: ctx.accounts.price_feed.key(),
            old_price,
            new_price: price,
            updated_by: ctx.accounts.authority.key(),
        });

        Ok(())
    }

    /// Halt a feed (e.g., during market disruption). Desk admin only.
    pub fn set_feed_status(
        ctx: Context<AdminUpdateFeed>,
        status: FeedStatus,
    ) -> Result<()> {
        ctx.accounts.price_feed.status = status;
        Ok(())
    }

    /// Link a Switchboard V2 aggregator to this feed.
    /// The Switchboard aggregator should have a CacheTask job that reads this feed PDA.
    pub fn link_switchboard(
        ctx: Context<AdminUpdateFeed>,
        switchboard_feed: Pubkey,
    ) -> Result<()> {
        ctx.accounts.price_feed.switchboard_feed = switchboard_feed;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Raw Switchboard-compatible write (for direct Switchboard integration)
    // -----------------------------------------------------------------------

    /// Write arbitrary bytes to a raw account owned by this program.
    /// Used to create oracle accounts in any format (Pyth Receiver, Scope, etc).
    pub fn write_raw(
        ctx: Context<WriteRawData>,
        offset: u32,
        data: Vec<u8>,
    ) -> Result<()> {
        let feed = &ctx.accounts.raw_feed;
        let mut account_data = feed.try_borrow_mut_data()?;
        let start = offset as usize;
        let end = start + data.len();
        require!(end <= account_data.len(), OracleError::FeedNotActive);
        account_data[start..end].copy_from_slice(&data);
        Ok(())
    }

    /// Write Pyth V2-compatible binary data to a raw account owned by this program.
    /// Kept for backwards compatibility with existing devnet setup.
    pub fn write_pyth_v2(
        ctx: Context<WriteRawData>,
        price: i64,
        expo: i32,
    ) -> Result<()> {
        let feed = &ctx.accounts.raw_feed;
        let slot = Clock::get()?.slot;
        let mut data = feed.try_borrow_mut_data()?;

        write_le(&mut data, 0, &0xa1b2c3d4u32.to_le_bytes());
        write_le(&mut data, 4, &2u32.to_le_bytes());
        write_le(&mut data, 8, &3u32.to_le_bytes());
        write_le(&mut data, 20, &expo.to_le_bytes());
        write_le(&mut data, 24, &2u32.to_le_bytes());
        write_le(&mut data, 32, &slot.to_le_bytes());
        write_le(&mut data, 40, &slot.to_le_bytes());
        let ts = Clock::get()?.unix_timestamp;
        write_le(&mut data, 48, &ts.to_le_bytes());
        write_le(&mut data, 56, &1u32.to_le_bytes());
        write_le(&mut data, 208, &price.to_le_bytes());
        write_le(&mut data, 216, &10000u64.to_le_bytes());
        write_le(&mut data, 224, &1u32.to_le_bytes());
        write_le(&mut data, 232, &slot.to_le_bytes());
        write_le(&mut data, 240, &slot.to_le_bytes());
        write_le(&mut data, 248, &price.to_le_bytes());
        write_le(&mut data, 256, &10000u64.to_le_bytes());

        msg!("Pyth V2 data written: price={}, expo={}, slot={}", price, expo, slot);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn is_desk_authorized(
    signer: &Pubkey,
    desk_admin: &Pubkey,
    desk_key: &Pubkey,
    operator_entry: &Option<Account<OperatorEntry>>,
) -> bool {
    if signer == desk_admin {
        return true;
    }
    if let Some(entry) = operator_entry {
        return entry.wallet == *signer && entry.desk == *desk_key;
    }
    false
}

fn pad_string<const N: usize>(s: &str) -> [u8; N] {
    let mut buf = [0u8; N];
    let bytes = s.as_bytes();
    let len = bytes.len().min(N);
    buf[..len].copy_from_slice(&bytes[..len]);
    buf
}

fn write_le(data: &mut [u8], offset: usize, bytes: &[u8]) {
    data[offset..offset + bytes.len()].copy_from_slice(bytes);
}

// ---------------------------------------------------------------------------
// Account Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(name: String)]
pub struct CreateDesk<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Desk::INIT_SPACE,
        seeds = [b"desk", admin.key().as_ref(), name.as_bytes()],
        bump,
    )]
    pub desk: Account<'info, Desk>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ManageOperator<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut, has_one = admin)]
    pub desk: Account<'info, Desk>,

    /// CHECK: The wallet to add as operator.
    pub operator: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + OperatorEntry::INIT_SPACE,
        seeds = [b"operator", desk.key().as_ref(), operator.key().as_ref()],
        bump,
    )]
    pub operator_entry: Account<'info, OperatorEntry>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveOperator<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut, has_one = admin)]
    pub desk: Account<'info, Desk>,

    #[account(
        mut,
        close = admin,
        seeds = [b"operator", desk.key().as_ref(), operator_entry.wallet.as_ref()],
        bump = operator_entry.bump,
    )]
    pub operator_entry: Account<'info, OperatorEntry>,
}

#[derive(Accounts)]
#[instruction(label: String)]
pub struct CreateFeed<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub desk: Account<'info, Desk>,

    /// Optional operator PDA. Pass if signer is not desk admin.
    pub operator_entry: Option<Account<'info, OperatorEntry>>,

    #[account(
        init,
        payer = authority,
        space = 8 + PriceFeed::INIT_SPACE,
        seeds = [b"feed", desk.key().as_ref(), label.as_bytes()],
        bump,
    )]
    pub price_feed: Account<'info, PriceFeed>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePrice<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub desk: Account<'info, Desk>,

    /// Optional operator PDA.
    pub operator_entry: Option<Account<'info, OperatorEntry>>,

    #[account(mut, constraint = price_feed.desk == desk.key() @ OracleError::FeedDeskMismatch)]
    pub price_feed: Account<'info, PriceFeed>,
}

#[derive(Accounts)]
pub struct AdminUpdateFeed<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(has_one = admin)]
    pub desk: Account<'info, Desk>,

    #[account(mut, constraint = price_feed.desk == desk.key() @ OracleError::FeedDeskMismatch)]
    pub price_feed: Account<'info, PriceFeed>,
}

#[derive(Accounts)]
pub struct WriteRawData<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Raw account owned by this program.
    #[account(mut, owner = crate::ID)]
    pub raw_feed: AccountInfo<'info>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Desk {
    /// Desk administrator (can add/remove operators, create feeds).
    pub admin: Pubkey,
    /// Human-readable desk name (e.g., "RWA Trading Desk").
    pub name: [u8; 64],
    /// Description of the desk's mandate.
    pub description: [u8; 128],
    /// Number of active feeds managed by this desk.
    pub feed_count: u32,
    /// Number of authorized operators.
    pub operator_count: u32,
    /// Unix timestamp when the desk was created.
    pub created_at: i64,
    /// PDA bump.
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct OperatorEntry {
    /// The desk this operator belongs to.
    pub desk: Pubkey,
    /// The operator's wallet.
    pub wallet: Pubkey,
    /// Who added this operator.
    pub added_by: Pubkey,
    /// When added.
    pub added_at: i64,
    /// PDA bump.
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PriceFeed {
    /// The desk that manages this feed.
    pub desk: Pubkey,
    /// Feed label (e.g., "USDY/USD").
    pub label: [u8; 32],
    /// Base asset symbol (e.g., "USDY").
    pub base_asset: [u8; 16],
    /// Quote asset symbol (e.g., "USD").
    pub quote_asset: [u8; 16],
    /// Current price (scaled by 10^|expo|).
    pub price: i64,
    /// Price exponent (e.g., -8 means price is in units of 10^-8).
    pub expo: i32,
    /// Confidence interval (same scale as price).
    pub confidence: u64,
    /// Feed status.
    pub status: FeedStatus,
    /// Last update slot.
    pub last_update_slot: u64,
    /// Last update Unix timestamp.
    pub last_update_ts: i64,
    /// Wallet that last updated the price.
    pub updated_by: Pubkey,
    /// Linked Switchboard V2 aggregator (if any). Pubkey::default() = not linked.
    pub switchboard_feed: Pubkey,
    /// PDA bump.
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum FeedStatus {
    /// Feed is active and accepting price updates.
    Active,
    /// Feed is halted (e.g., market disruption). Price reads return stale.
    Halted,
    /// Feed is deprecated. No updates accepted.
    Deprecated,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct FeedCreatedEvent {
    pub desk: Pubkey,
    pub feed: Pubkey,
    pub label: String,
    pub price: i64,
    pub expo: i32,
}

#[event]
pub struct PriceUpdatedEvent {
    pub feed: Pubkey,
    pub old_price: i64,
    pub new_price: i64,
    pub updated_by: Pubkey,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum OracleError {
    #[msg("Signer is not the desk admin or an authorized operator")]
    Unauthorized,
    #[msg("Feed is not in Active status")]
    FeedNotActive,
    #[msg("Feed does not belong to this desk")]
    FeedDeskMismatch,
}
