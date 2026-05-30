use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token_interface;
use spl_token_2022::{
    extension::{
        confidential_transfer::instruction as ct_instruction,
        ExtensionType,
    },
    instruction as token_instruction,
    state::Mint as Token2022Mint,
};

declare_id!("BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy");

#[program]
pub mod delta_mint {
    use super::*;

    /// Creates a Token-2022 mint with the confidential transfer extension.
    /// The mint authority is a PDA owned by this program, ensuring all minting
    /// goes through the KYC whitelist check.
    pub fn initialize_mint(
        ctx: Context<InitializeMint>,
        decimals: u8,
    ) -> Result<()> {
        let config = &mut ctx.accounts.mint_config;
        config.authority = ctx.accounts.authority.key();
        config.mint = ctx.accounts.mint.key();
        config.decimals = decimals;
        config.bump = ctx.bumps.mint_config;
        config.mint_authority_bump = ctx.bumps.mint_authority;
        config.total_whitelisted = 0;

        // Calculate space for mint + confidential transfer extension
        let extension_types = &[ExtensionType::ConfidentialTransferMint];
        let mint_size = ExtensionType::try_calculate_account_len::<Token2022Mint>(extension_types)
            .map_err(|_| DeltaError::MintInitFailed)?;

        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(mint_size);

        // 1. Create the mint account with enough space for extensions
        invoke(
            &system_instruction::create_account(
                ctx.accounts.authority.key,
                ctx.accounts.mint.key,
                lamports,
                mint_size as u64,
                ctx.accounts.token_program.key,
            ),
            &[
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.mint.to_account_info(),
            ],
        )?;

        // 2. Initialize confidential transfer extension on the mint.
        //    - authority: the program's PDA (can approve accounts later)
        //    - auto_approve: false (authority must approve each account for CT)
        //      Kamino requires auto_approve=false for liquidity tokens.
        //    - auditor: none (can be set later for compliance auditing)
        invoke(
            &ct_instruction::initialize_mint(
                ctx.accounts.token_program.key,
                ctx.accounts.mint.key,
                Some(ctx.accounts.mint_authority.key()),
                false,
                None,
            )?,
            &[ctx.accounts.mint.to_account_info()],
        )?;

        // 3. Initialize the mint itself with the PDA as mint + freeze authority
        invoke(
            &token_instruction::initialize_mint2(
                ctx.accounts.token_program.key,
                ctx.accounts.mint.key,
                &ctx.accounts.mint_authority.key(),
                Some(&ctx.accounts.mint_authority.key()),
                decimals,
            )?,
            &[ctx.accounts.mint.to_account_info()],
        )?;

        Ok(())
    }

    /// Adds a wallet to the KYC whitelist, allowing it to receive minted tokens.
    /// Only the mint config authority can approve wallets.
    pub fn add_to_whitelist(ctx: Context<AddToWhitelist>) -> Result<()> {
        let entry = &mut ctx.accounts.whitelist_entry;
        entry.wallet = ctx.accounts.wallet.key();
        entry.mint_config = ctx.accounts.mint_config.key();
        entry.approved = true;
        entry.role = WhitelistRole::Holder;
        entry.approved_at = Clock::get()?.unix_timestamp;
        entry.bump = ctx.bumps.whitelist_entry;

        let config = &mut ctx.accounts.mint_config;
        config.total_whitelisted = config.total_whitelisted.checked_add(1).unwrap();

        emit!(WhitelistEvent {
            wallet: entry.wallet,
            mint: config.mint,
            approved: true,
            timestamp: entry.approved_at,
        });

        Ok(())
    }

    /// Removes a wallet from the whitelist. Closes the PDA and returns rent to authority.
    pub fn remove_from_whitelist(ctx: Context<RemoveFromWhitelist>) -> Result<()> {
        let config = &mut ctx.accounts.mint_config;
        config.total_whitelisted = config.total_whitelisted.saturating_sub(1);

        emit!(WhitelistEvent {
            wallet: ctx.accounts.whitelist_entry.wallet,
            mint: config.mint,
            approved: false,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Adds a wallet as an approved liquidator.
    /// Liquidators can receive cUSDY collateral during Kamino liquidations
    /// without going through full KYC — they are pre-vetted bot operators.
    pub fn add_liquidator(ctx: Context<AddToWhitelist>) -> Result<()> {
        let entry = &mut ctx.accounts.whitelist_entry;
        entry.wallet = ctx.accounts.wallet.key();
        entry.mint_config = ctx.accounts.mint_config.key();
        entry.approved = true;
        entry.role = WhitelistRole::Liquidator;
        entry.approved_at = Clock::get()?.unix_timestamp;
        entry.bump = ctx.bumps.whitelist_entry;

        let config = &mut ctx.accounts.mint_config;
        config.total_whitelisted = config.total_whitelisted.checked_add(1).unwrap();

        emit!(WhitelistEvent {
            wallet: entry.wallet,
            mint: config.mint,
            approved: true,
            timestamp: entry.approved_at,
        });

        Ok(())
    }

    /// Adds a wallet as an approved liquidator via a co-authority (PDA signer).
    /// Mirror of `add_liquidator` for activated pools where mint authority has
    /// been transferred to a pool PDA. Previously unavailable, which forced
    /// `add_participant_via_pool(Liquidator)` to fall back to the Holder path
    /// and store the wrong role.
    pub fn add_liquidator_with_co_authority(ctx: Context<AddToWhitelistCoAuth>) -> Result<()> {
        let entry = &mut ctx.accounts.whitelist_entry;
        entry.wallet = ctx.accounts.wallet.key();
        entry.mint_config = ctx.accounts.mint_config.key();
        entry.approved = true;
        entry.role = WhitelistRole::Liquidator;
        entry.approved_at = Clock::get()?.unix_timestamp;
        entry.bump = ctx.bumps.whitelist_entry;

        let config = &mut ctx.accounts.mint_config;
        config.total_whitelisted = config.total_whitelisted.checked_add(1).unwrap();

        emit!(WhitelistEvent {
            wallet: entry.wallet,
            mint: config.mint,
            approved: true,
            timestamp: entry.approved_at,
        });

        Ok(())
    }

    /// Adds a program-owned custody PDA to the whitelist as an Escrow role.
    /// Used by integrating protocols (e.g. clearstone_core) so their SY escrows
    /// and fee treasuries can hold the KYC-gated mint. Eligible to RECEIVE
    /// transfers; NOT eligible for `mint_to`.
    pub fn add_escrow(ctx: Context<AddToWhitelist>) -> Result<()> {
        let entry = &mut ctx.accounts.whitelist_entry;
        entry.wallet = ctx.accounts.wallet.key();
        entry.mint_config = ctx.accounts.mint_config.key();
        entry.approved = true;
        entry.role = WhitelistRole::Escrow;
        entry.approved_at = Clock::get()?.unix_timestamp;
        entry.bump = ctx.bumps.whitelist_entry;

        let config = &mut ctx.accounts.mint_config;
        config.total_whitelisted = config.total_whitelisted.checked_add(1).unwrap();

        emit!(WhitelistEvent {
            wallet: entry.wallet,
            mint: config.mint,
            approved: true,
            timestamp: entry.approved_at,
        });

        Ok(())
    }

    /// Adds an escrow PDA via a co-authority (PDA signer). Used on activated
    /// pools where mint authority has moved to a pool PDA, e.g. a governor
    /// pool CPI'ing on behalf of an integrating protocol.
    pub fn add_escrow_with_co_authority(ctx: Context<AddToWhitelistCoAuth>) -> Result<()> {
        let entry = &mut ctx.accounts.whitelist_entry;
        entry.wallet = ctx.accounts.wallet.key();
        entry.mint_config = ctx.accounts.mint_config.key();
        entry.approved = true;
        entry.role = WhitelistRole::Escrow;
        entry.approved_at = Clock::get()?.unix_timestamp;
        entry.bump = ctx.bumps.whitelist_entry;

        let config = &mut ctx.accounts.mint_config;
        config.total_whitelisted = config.total_whitelisted.checked_add(1).unwrap();

        emit!(WhitelistEvent {
            wallet: entry.wallet,
            mint: config.mint,
            approved: true,
            timestamp: entry.approved_at,
        });

        Ok(())
    }

    /// Transfer mint config authority to a new address (e.g., governor PDA).
    /// Only current authority can call this.
    pub fn transfer_authority(ctx: Context<TransferAuthority>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.mint_config.authority = new_authority;
        // Also set co_authority to the new authority so it can whitelist via co_authority path
        ctx.accounts.mint_config.co_authority = new_authority;
        Ok(())
    }

    /// Add a wallet to the whitelist using a co-signer.
    /// The co_authority must be registered in mint_config.co_authority.
    /// This enables permissionless flows where a PDA (e.g., governor pool)
    /// can whitelist on behalf of the authority.
    pub fn add_to_whitelist_with_co_authority(ctx: Context<AddToWhitelistCoAuth>) -> Result<()> {
        let entry = &mut ctx.accounts.whitelist_entry;
        entry.wallet = ctx.accounts.wallet.key();
        entry.mint_config = ctx.accounts.mint_config.key();
        entry.approved = true;
        entry.role = WhitelistRole::Holder;
        entry.approved_at = Clock::get()?.unix_timestamp;
        entry.bump = ctx.bumps.whitelist_entry;

        let config = &mut ctx.accounts.mint_config;
        config.total_whitelisted = config.total_whitelisted.checked_add(1).unwrap();

        emit!(WhitelistEvent {
            wallet: entry.wallet,
            mint: config.mint,
            approved: true,
            timestamp: entry.approved_at,
        });

        Ok(())
    }

    /// Set a co-authority that can also whitelist wallets.
    /// Only the main authority can set this. Pass Pubkey::default() to disable.
    /// Handles migration from pre-v2 MintConfig accounts (expands if needed).
    pub fn set_co_authority(ctx: Context<SetCoAuthority>, co_authority: Pubkey) -> Result<()> {
        let account_info = &ctx.accounts.mint_config;
        let new_size = 8 + MintConfig::INIT_SPACE;

        // Verify owner is this program
        require!(
            account_info.owner == &crate::ID,
            DeltaError::MintInitFailed
        );

        // Read the authority field (at offset 8, first 32 bytes after discriminator)
        let data = account_info.try_borrow_data()?;
        require!(data.len() >= 8 + 32, DeltaError::MintInitFailed);
        let stored_authority = Pubkey::try_from(&data[8..40]).unwrap();
        require!(
            stored_authority == ctx.accounts.authority.key(),
            DeltaError::NotWhitelisted // reusing error — signer != authority
        );
        drop(data);

        // Realloc if needed
        if account_info.data_len() < new_size {
            let rent = Rent::get()?;
            let diff = rent.minimum_balance(new_size).saturating_sub(account_info.lamports());
            if diff > 0 {
                invoke(
                    &system_instruction::transfer(
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

        // Write co_authority at the correct offset (end of struct)
        // Layout: disc(8) + authority(32) + mint(32) + decimals(1) + bump(1) + mint_auth_bump(1) + total_whitelisted(8) + co_authority(32)
        let co_auth_offset = 8 + 32 + 32 + 1 + 1 + 1 + 8; // = 83
        let mut data = account_info.try_borrow_mut_data()?;
        data[co_auth_offset..co_auth_offset + 32].copy_from_slice(&co_authority.to_bytes());

        Ok(())
    }

    /// Mints tokens to a whitelisted recipient's token account.
    /// Fails if the recipient is not on the KYC whitelist.
    pub fn mint_to(ctx: Context<MintTokens>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.whitelist_entry.approved,
            DeltaError::NotWhitelisted
        );
        require!(
            ctx.accounts.whitelist_entry.role == WhitelistRole::Holder,
            DeltaError::LiquidatorCannotMint
        );
        require!(amount > 0, DeltaError::InvalidAmount);

        let config = &ctx.accounts.mint_config;
        let seeds = &[
            b"mint_authority".as_ref(),
            config.mint.as_ref(),
            &[config.mint_authority_bump],
        ];

        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token_interface::MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        emit!(MintEvent {
            recipient: ctx.accounts.whitelist_entry.wallet,
            mint: config.mint,
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeMint<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// New Token-2022 mint keypair (generated client-side).
    #[account(mut)]
    pub mint: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + MintConfig::INIT_SPACE,
        seeds = [b"mint_config", mint.key().as_ref()],
        bump,
    )]
    pub mint_config: Account<'info, MintConfig>,

    /// CHECK: PDA used as mint authority — verified by seeds constraint.
    #[account(
        seeds = [b"mint_authority", mint.key().as_ref()],
        bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    pub token_program: Interface<'info, token_interface::TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddToWhitelist<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut, has_one = authority)]
    pub mint_config: Account<'info, MintConfig>,

    /// CHECK: The wallet being whitelisted — does not need to sign.
    pub wallet: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + WhitelistEntry::INIT_SPACE,
        seeds = [b"whitelist", mint_config.key().as_ref(), wallet.key().as_ref()],
        bump,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,

    pub system_program: Program<'info, System>,
}

/// Whitelist via co-authority (PDA signer from governor).
#[derive(Accounts)]
pub struct AddToWhitelistCoAuth<'info> {
    /// The co-authority (e.g., governor pool PDA). Must match mint_config.co_authority.
    pub co_authority: Signer<'info>,

    /// The wallet paying rent for the new whitelist entry.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        constraint = mint_config.co_authority == co_authority.key() @ DeltaError::NotWhitelisted,
    )]
    pub mint_config: Account<'info, MintConfig>,

    /// CHECK: The wallet being whitelisted.
    pub wallet: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + WhitelistEntry::INIT_SPACE,
        seeds = [b"whitelist", mint_config.key().as_ref(), wallet.key().as_ref()],
        bump,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut, has_one = authority)]
    pub mint_config: Account<'info, MintConfig>,
}

/// SetCoAuthority supports migration from pre-v2 accounts (no co_authority field).
/// We use UncheckedAccount to handle both old (83 byte) and new (115 byte) layouts.
#[derive(Accounts)]
pub struct SetCoAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: MintConfig PDA — manually validated and reallocated if needed.
    #[account(mut)]
    pub mint_config: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveFromWhitelist<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut, has_one = authority)]
    pub mint_config: Account<'info, MintConfig>,

    #[account(
        mut,
        close = authority,
        seeds = [b"whitelist", mint_config.key().as_ref(), whitelist_entry.wallet.as_ref()],
        bump = whitelist_entry.bump,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
}

#[derive(Accounts)]
pub struct MintTokens<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(has_one = authority)]
    pub mint_config: Account<'info, MintConfig>,

    /// CHECK: Token-2022 mint — validated via address constraint against mint_config.
    #[account(
        mut,
        address = mint_config.mint,
    )]
    pub mint: UncheckedAccount<'info>,

    /// CHECK: PDA mint authority — verified by seeds constraint.
    #[account(
        seeds = [b"mint_authority", mint.key().as_ref()],
        bump = mint_config.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        seeds = [b"whitelist", mint_config.key().as_ref(), whitelist_entry.wallet.as_ref()],
        bump = whitelist_entry.bump,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,

    /// CHECK: Recipient's Token-2022 token account — ownership verified via token_program CPI.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    pub token_program: Interface<'info, token_interface::TokenInterface>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct MintConfig {
    /// The authority that can whitelist wallets and trigger mints.
    pub authority: Pubkey,
    /// The Token-2022 mint address.
    pub mint: Pubkey,
    /// Mint decimals.
    pub decimals: u8,
    /// Bump for this PDA.
    pub bump: u8,
    /// Bump for the mint_authority PDA.
    pub mint_authority_bump: u8,
    /// Number of currently whitelisted wallets.
    pub total_whitelisted: u64,
    /// Co-authority (e.g., governor PDA) that can also whitelist wallets.
    /// Pubkey::default() means disabled. Added in v2 — must be at the end
    /// so existing accounts deserialize correctly (trailing zeros = default).
    pub co_authority: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct WhitelistEntry {
    /// The whitelisted wallet address.
    pub wallet: Pubkey,
    /// The mint config this entry belongs to.
    pub mint_config: Pubkey,
    /// Whether the wallet is currently approved.
    pub approved: bool,
    /// Role: Holder (KYC'd, can mint/hold) or Liquidator (can receive via liquidation only).
    pub role: WhitelistRole,
    /// Unix timestamp when the wallet was approved.
    pub approved_at: i64,
    /// Bump for this PDA.
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum WhitelistRole {
    /// Full KYC'd holder — can receive minted tokens and hold.
    Holder,
    /// Approved liquidator bot — can receive collateral during Kamino liquidations.
    /// Cannot mint new tokens, only receive via protocol liquidation flows.
    Liquidator,
    /// Program-owned custody PDA from an integrating protocol (e.g.
    /// clearstone_core escrow_sy / token_fee_treasury_sy). Whitelisted so it
    /// can hold the mint, but ineligible for `mint_to` — authority-mint stays
    /// pointed at real KYC'd users only.
    Escrow,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct WhitelistEvent {
    pub wallet: Pubkey,
    pub mint: Pubkey,
    pub approved: bool,
    pub timestamp: i64,
}

#[event]
pub struct MintEvent {
    pub recipient: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum DeltaError {
    #[msg("Recipient is not on the KYC whitelist")]
    NotWhitelisted,
    #[msg("Mint amount must be greater than zero")]
    InvalidAmount,
    #[msg("Liquidator role cannot mint new tokens")]
    LiquidatorCannotMint,
    #[msg("Failed to initialize Token-2022 mint with extensions")]
    MintInitFailed,
}
