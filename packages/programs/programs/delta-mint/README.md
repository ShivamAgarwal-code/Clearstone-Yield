# Delta Mint

Privacy-centric token program built on Solana Token-2022 with KYC-gated minting and confidential transfer support.

**Program ID:** `13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn`

## Architecture

```
                    ┌─────────────────────┐
                    │     Authority        │
                    │  (deployer / admin)  │
                    └─────────┬───────────┘
                              │
               ┌──────────────┼──────────────┐
               │              │              │
               ▼              ▼              ▼
        ┌────────────┐ ┌────────────┐ ┌────────────┐
        │ Whitelist  │ │ Whitelist  │ │   Mint     │
        │   Mgmt     │ │   Check    │ │  Tokens    │
        └─────┬──────┘ └─────┬──────┘ └─────┬──────┘
              │              │              │
              ▼              ▼              ▼
   ┌──────────────────────────────────────────────┐
   │              MintConfig PDA                   │
   │  seeds: ["mint_config", mint_pubkey]          │
   │                                               │
   │  - authority        - decimals                │
   │  - mint             - total_whitelisted       │
   │  - bump             - mint_authority_bump     │
   └──────────────────────┬───────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼                               ▼
 ┌──────────────────┐          ┌────────────────────┐
 │ MintAuthority PDA│          │  Token-2022 Mint    │
 │ (program-owned)  │◄─────── │  + Confidential     │
 │                  │  mint    │    Transfer Ext.    │
 │ seeds:           │  auth    │                     │
 │ ["mint_authority",│         │  - ElGamal-encrypted│
 │  mint_pubkey]    │          │    balances         │
 └──────────────────┘          │  - Auto-approve     │
                               └────────────────────┘

 ┌──────────────────┐
 │ WhitelistEntry   │  One PDA per approved wallet
 │ PDA              │
 │                  │
 │ seeds:           │
 │ ["whitelist",    │
 │  mint_config,    │
 │  wallet_pubkey]  │
 └──────────────────┘
```

### Key Design Decisions

- **Mint authority is a PDA** — no external key can mint tokens directly; all minting must go through this program's `mint_to` instruction, which enforces the whitelist check.
- **Whitelist is on-chain** — a wallet's KYC status is represented by the existence (and `approved` flag) of a `WhitelistEntry` PDA. No off-chain oracle needed.
- **Confidential transfers via Token-2022** — the mint is created with the `ConfidentialTransferMint` extension, allowing holders to encrypt their balances using ElGamal encryption. On-chain observers cannot see transfer amounts.
- **Auto-approve** is enabled so token account holders can immediately configure confidential transfers without an additional authority approval step.
- **Events** are emitted for all state changes (`WhitelistEvent`, `MintEvent`) to support off-chain indexing and audit trails.

## Instructions

### `initialize_mint(decimals: u8)`

Creates a new Token-2022 mint with the confidential transfer extension. Sets up the `MintConfig` PDA and assigns a program-owned PDA as the mint and freeze authority.

| Account         | Type             | Description                              |
|-----------------|------------------|------------------------------------------|
| `authority`     | `Signer` (mut)   | Pays for account creation; becomes admin |
| `mint`          | `Signer` (mut)   | New mint keypair (generated client-side) |
| `mintConfig`    | PDA (init)       | `["mint_config", mint]`                  |
| `mintAuthority` | PDA              | `["mint_authority", mint]`               |
| `tokenProgram`  | Token-2022       | Must be the Token-2022 program           |
| `systemProgram` | System           |                                          |

### `add_to_whitelist()`

Adds a wallet to the KYC whitelist by creating a `WhitelistEntry` PDA. Increments the `total_whitelisted` counter. Emits `WhitelistEvent`.

| Account          | Type             | Description                                       |
|------------------|------------------|---------------------------------------------------|
| `authority`      | `Signer` (mut)   | Must match `mintConfig.authority`                  |
| `mintConfig`     | PDA (mut)        | The mint's config account                          |
| `wallet`         | `UncheckedAccount`| The wallet being approved (doesn't need to sign) |
| `whitelistEntry` | PDA (init)       | `["whitelist", mint_config, wallet]`               |
| `systemProgram`  | System           |                                                    |

### `remove_from_whitelist()`

Removes a wallet from the whitelist by closing the `WhitelistEntry` PDA. Rent is returned to the authority. Decrements the counter. Emits `WhitelistEvent`.

| Account          | Type             | Description                            |
|------------------|------------------|----------------------------------------|
| `authority`      | `Signer` (mut)   | Must match `mintConfig.authority`      |
| `mintConfig`     | PDA (mut)        | The mint's config account              |
| `whitelistEntry` | PDA (close)      | The entry to remove                    |

### `mint_to(amount: u64)`

Mints tokens to a whitelisted recipient's token account. Fails with `NotWhitelisted` if the recipient has no valid whitelist entry, or `InvalidAmount` if amount is zero.

| Account          | Type                | Description                                  |
|------------------|---------------------|----------------------------------------------|
| `authority`      | `Signer` (mut)      | Must match `mintConfig.authority`             |
| `mintConfig`     | PDA                 | The mint's config account                     |
| `mint`           | `UncheckedAccount`  | Token-2022 mint (validated via address check) |
| `mintAuthority`  | PDA                 | `["mint_authority", mint]`                    |
| `whitelistEntry` | PDA                 | Must exist and have `approved = true`         |
| `destination`    | `UncheckedAccount`  | Recipient's Token-2022 token account          |
| `tokenProgram`   | Token-2022          | Must be the Token-2022 program                |

## State Accounts

### `MintConfig` (75 bytes + 8 discriminator)

| Field                | Type     | Size   | Description                        |
|----------------------|----------|--------|------------------------------------|
| `authority`          | `Pubkey` | 32     | Admin who can whitelist and mint   |
| `mint`               | `Pubkey` | 32     | The Token-2022 mint address        |
| `decimals`           | `u8`     | 1      | Mint decimals                      |
| `bump`               | `u8`     | 1      | PDA bump for this account          |
| `mint_authority_bump` | `u8`    | 1      | PDA bump for the mint authority    |
| `total_whitelisted`  | `u64`   | 8      | Count of whitelisted wallets       |

### `WhitelistEntry` (74 bytes + 8 discriminator)

| Field        | Type     | Size | Description                       |
|--------------|----------|------|-----------------------------------|
| `wallet`     | `Pubkey` | 32   | The approved wallet address       |
| `mint_config`| `Pubkey` | 32   | Parent mint config                |
| `approved`   | `bool`   | 1    | Whether currently approved        |
| `approved_at`| `i64`    | 8    | Unix timestamp of approval        |
| `bump`       | `u8`     | 1    | PDA bump for this account         |

## Errors

| Code | Name              | Message                                            |
|------|-------------------|----------------------------------------------------|
| 6000 | `NotWhitelisted`  | Recipient is not on the KYC whitelist              |
| 6001 | `InvalidAmount`   | Mint amount must be greater than zero              |
| 6002 | `MintInitFailed`  | Failed to initialize Token-2022 mint with extensions|

## Events

- **`WhitelistEvent`** — emitted on `add_to_whitelist` and `remove_from_whitelist`
  - `wallet: Pubkey`, `mint: Pubkey`, `approved: bool`, `timestamp: i64`
- **`MintEvent`** — emitted on `mint_to`
  - `recipient: Pubkey`, `mint: Pubkey`, `amount: u64`, `timestamp: i64`

## Test Coverage

Tests are in `tests/delta-mint.ts` and run against a local validator via `anchor test`.

```
delta-mint
  ✔ initializes the mint with confidential transfer extension
  ✔ adds a wallet to the KYC whitelist
  ✔ mints tokens to a whitelisted recipient
  ✔ rejects minting to a non-whitelisted wallet
  ✔ removes a wallet from the whitelist
```

| Test                                     | Instruction(s) Covered     | What it Verifies                                                                 |
|------------------------------------------|----------------------------|----------------------------------------------------------------------------------|
| Initialize mint with CT extension        | `initialize_mint`          | Config state (authority, mint, decimals, counters), Token-2022 mint creation     |
| Add wallet to KYC whitelist              | `add_to_whitelist`         | WhitelistEntry PDA fields, `approved = true`, counter incremented to 1           |
| Mint tokens to whitelisted recipient     | `mint_to`                  | ATA creation, CPI mint via PDA authority, token balance = 1,000,000 (1 token)    |
| Reject minting to non-whitelisted wallet | `mint_to` (failure path)   | Non-existent whitelist PDA causes deserialization failure — mint blocked          |
| Remove wallet from whitelist             | `remove_from_whitelist`    | Counter decremented to 0, whitelist PDA account closed (null)                    |

### Coverage Summary

| Instruction              | Happy Path | Error Path |
|--------------------------|:----------:|:----------:|
| `initialize_mint`        |     Yes    |     —      |
| `add_to_whitelist`       |     Yes    |     —      |
| `mint_to`                |     Yes    |    Yes     |
| `remove_from_whitelist`  |     Yes    |     —      |

## Running

```bash
# Build
anchor build -p delta_mint

# Test (starts local validator automatically)
anchor test

# Deploy to devnet
anchor deploy --provider.cluster devnet
```
