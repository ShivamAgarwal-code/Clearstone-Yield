To create a reusable Liquid Staking Token (LST) on Solana Devnet with built-in KYC, the most robust approach is to combine the SPL Stake Pool Program for the staking logic and Token Extensions (Token-2022) for the KYC compliance features. 
Solana
Solana
 +1
Implementation Plan
1. Environment Setup (Devnet)
Install Tools: Ensure you have the Solana CLI and SPL Token CLI installed.
Configure Network: Set your CLI to Devnet and fund your wallet with test SOL:
bash
solana config set --url devnet
solana airdrop 2
Use code with caution.
 
Medium
Medium
 +1
2. Create the Compliant LST (Token Mint) 
Instead of a standard SPL token, use Token-2022 with the Transfer Hook or Default Account State extension to enforce KYC. 
Binance
Binance
 +1
Initialize Mint: Create the token with metadata and specific extensions.
KYC via Default Account State: Set the default state of all new token accounts to Frozen. This requires a "KYC Authority" to manually Thaw an account only after the user passes verification.
KYC via Transfer Hook: For more automated control, implement a Transfer Hook program that checks an on-chain "allow-list" before any transfer can succeed. 
Binance
Binance
 +3
3. Deploy the Liquid Staking Pool 
Use the SPL Stake Pool Program to manage the SOL-to-LST conversion. 
GitHub
GitHub
 +1
Create Pool: Use the spl-stake-pool CLI to initialize your pool.
Link Your Mint: During creation, specify the Token-2022 mint you created in Step 2 as the pool's token.
Validator Strategy: Add validators to your pool to begin earning staking rewards on Devnet. 
GitHub
GitHub
 +3
4. Reusability & Testing
Standard Interfaces: By using the SPL Stake Pool and Token-2022 standards, your LST will be compatible with Devnet versions of Jupiter and other DeFi protocols.
Automated KYC: To make it "reusable" for testers, you can build a simple script or frontend that automatically thaws accounts (KYC) for any wallet that connects to your Devnet site. 
Solana
Solana
 +1
Key Technical Components
Feature 	Implementation Method
LST Logic	SPL Stake Pool Program (Redeems SOL for your token)
KYC Enforcement	Token-2022 Default Account State (Requires account thawing)
Yield (MEV)	Use the Jito-Solana Client if running your own validator
Metadata	Token Extensions Metadata (Name, Symbol, Logo)
Would you like a specific code example for the Transfer Hook or more details on configuring the Stake Pool fees?
AI responses may include mistakes. Learn more









16 sites
Create Solana Token The Smart & Scalable Way - Webisoft Blog
16 Nov 2025 — So, turn your Solana token idea into reality by contacting Webisoft's blockchain experts. It's the best way to create Solana token...


Webisoft
Solana launches SPL token standard with 13 new features ...
24 Jan 2024 — Their specific functions and officially recommended use cases are summarized as follows by Odaily Planet Daily based on the promot...


Binance
Reference Stake Pool (Solana Blockchain) · GitHub
Conceive and implement a strategy for choosing validators to be added to the pool and distributing the stake among these validator...


GitHub
Show all
also add the devent addresses
To build your custom LST on Solana Devnet, you will interact with established system programs and deploy your own logic for the KYC components. Below are the essential Devnet addresses and a step-by-step technical implementation path.
1. Essential Devnet Program Addresses
These are the standard program IDs on Devnet you will use for the LST and token features:
Token-2022 Program: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
Role: Handles the underlying token mint, transfers, and the compliance extensions (KYC).
SPL Stake Pool Program: SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy
Role: Manages the liquid staking logic (depositing SOL to mint your LST).
Associated Token Account Program: ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
Role: Used to derive the unique wallet addresses for your users' LST accounts. 
Solana Stack Exchange
Solana Stack Exchange
 +2
2. Implementation Steps
Step A: Initialize the KYC-Enabled Mint
Create a token using the Token-2022 standard with the Default Account State extension. This ensures any new account created for your token is automatically "Frozen" until you manually verify (KYC) the user. 
Generate a new Mint Keypair for your LST.
Initialize the Mint with the DefaultAccountState set to Frozen.
Command Example:
bash
spl-token --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  create-token --default-account-state frozen
Use code with caution.
 
Step B: Deploy the Stake Pool
Use the SPL Stake Pool CLI to link your custom Mint to a new staking pool.
Initialize Pool: Run spl-stake-pool create-pool on Devnet.
Set Your Mint: Use the address generated in Step A as the pool's token mint.
Authority: Set your admin wallet as the manager so you can add validators later. 
Step C: Build the KYC "Thaw" Trigger
Since accounts are frozen by default, you need a way to verify users.
Off-chain: Perform your KYC check (e.g., via a third-party provider).
On-chain Action: Once verified, your admin wallet calls the thaw-account instruction. This "unlocks" the user's LST account so they can transfer or trade their tokens. 
Solana Stack Exchange
Solana Stack Exchange
3. Reusability on Devnet
To ensure your LST is reusable and testable:
Open Access: You can set up a "Devnet Faucet" style site where users "Verify" (simulated KYC) to have their accounts thawed automatically.
Integration: Because you are using the standard SPoo1... Stake Pool program, your LST will be compatible with the Devnet instances of Jupiter and Orca for testing liquidity swaps.
Would you like the Rust code snippet for a Transfer Hook if you prefer automated on-chain KYC over manual account thawing?