#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
#  Deploy delta-mint + governor to Solana using a BIP-39 mnemonic
# ============================================================================
#
#  This script derives a Solana keypair from a BIP-39 mnemonic phrase and uses
#  it as the deployment authority / fee payer.
#
#  Prerequisites:
#    1. solana CLI installed
#    2. anchor CLI installed
#    3. Programs built: `anchor build`
#
#  Usage:
#    # Via environment variable:
#    DEPLOY_MNEMONIC="your twelve word mnemonic phrase here" \
#      bash scripts/deploy-mnemonic.sh [devnet|mainnet-beta|localnet]
#
#    # Or it will prompt interactively if DEPLOY_MNEMONIC is not set.
#
#  Example mnemonic (DO NOT USE IN PRODUCTION — this is a well-known test mnemonic):
#    abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about
#
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOLANA_BIN="$HOME/.local/share/solana/install/active_release/bin"
SOLANA="$SOLANA_BIN/solana"
ANCHOR="$SOLANA_BIN/anchor"

# --- Parse cluster argument ---
CLUSTER="${1:-devnet}"
case "$CLUSTER" in
  devnet)       RPC="https://api.devnet.solana.com" ;;
  mainnet-beta) RPC="https://api.mainnet-beta.solana.com" ;;
  localnet)     RPC="http://127.0.0.1:8899" ;;
  *)
    echo "ERROR: Unknown cluster '$CLUSTER'. Use: devnet | mainnet-beta | localnet"
    exit 1
    ;;
esac

# --- Get mnemonic ---
if [ -z "${DEPLOY_MNEMONIC:-}" ]; then
  echo "Enter your BIP-39 mnemonic (12 or 24 words):"
  read -r -s DEPLOY_MNEMONIC
  echo "(mnemonic read)"
fi

# Validate word count
WORD_COUNT=$(echo "$DEPLOY_MNEMONIC" | wc -w)
if [ "$WORD_COUNT" -ne 12 ] && [ "$WORD_COUNT" -ne 24 ]; then
  echo "ERROR: Mnemonic must be 12 or 24 words (got $WORD_COUNT)"
  exit 1
fi

# --- Derive keypair from mnemonic ---
# solana-keygen can recover a keypair from a mnemonic via stdin
TMPDIR_DEPLOY=$(mktemp -d)
DEPLOY_KEYPAIR="$TMPDIR_DEPLOY/deploy-keypair.json"
trap 'rm -rf "$TMPDIR_DEPLOY"' EXIT

echo "Deriving keypair from mnemonic..."
echo "$DEPLOY_MNEMONIC" | $SOLANA_BIN/solana-keygen recover -o "$DEPLOY_KEYPAIR" --force 2>/dev/null

WALLET=$($SOLANA address -k "$DEPLOY_KEYPAIR")

# --- Program IDs ---
DELTA_MINT_ID="13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn"
GOVERNOR_ID="BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh"
DELTA_MINT_SO="$ROOT/target/deploy/delta_mint.so"
GOVERNOR_SO="$ROOT/target/deploy/governor.so"
DELTA_MINT_KP="$ROOT/target/deploy/delta_mint-keypair.json"
GOVERNOR_KP="$ROOT/keypairs/governor-keypair.json"

echo ""
echo "============================================"
echo "  Deploy via Mnemonic"
echo "============================================"
echo "  Wallet:      $WALLET"
echo "  Cluster:     $CLUSTER"
echo "  RPC:         $RPC"
echo "  delta-mint:  $DELTA_MINT_ID"
echo "  governor:    $GOVERNOR_ID"
echo "============================================"
echo ""

# --- Check balance ---
BALANCE=$($SOLANA balance -k "$DEPLOY_KEYPAIR" --url "$RPC" | awk '{print $1}')
echo "Wallet balance: $BALANCE SOL"

MIN_BALANCE=5
if (( $(echo "$BALANCE < $MIN_BALANCE" | bc -l) )); then
  if [ "$CLUSTER" = "devnet" ] || [ "$CLUSTER" = "localnet" ]; then
    echo "WARNING: Balance is low. Requesting airdrop..."
    $SOLANA airdrop 2 "$WALLET" --url "$RPC" || echo "  Airdrop failed (rate limit?) — fund wallet manually"
  else
    echo "ERROR: Insufficient balance for mainnet deployment. Fund $WALLET with at least $MIN_BALANCE SOL."
    exit 1
  fi
fi

# --- Build ---
echo ""
echo "Building programs..."
cd "$ROOT"
$ANCHOR build 2>&1 | tail -5

# --- Check binaries exist ---
for so in "$DELTA_MINT_SO" "$GOVERNOR_SO"; do
  if [ ! -f "$so" ]; then
    echo "ERROR: $so not found. Run 'anchor build' first."
    exit 1
  fi
done

# --- Deploy delta-mint ---
echo ""
echo "Deploying delta-mint..."
if $SOLANA program show "$DELTA_MINT_ID" --url "$RPC" &>/dev/null; then
  echo "  delta-mint already deployed — upgrading..."
fi
$SOLANA program deploy \
  --url "$RPC" \
  --keypair "$DEPLOY_KEYPAIR" \
  --program-id "$DELTA_MINT_KP" \
  "$DELTA_MINT_SO"
echo "  ✔ delta-mint deployed: $DELTA_MINT_ID"

# --- Deploy governor ---
echo ""
echo "Deploying governor..."
if $SOLANA program show "$GOVERNOR_ID" --url "$RPC" &>/dev/null; then
  echo "  governor already deployed — upgrading..."
fi
$SOLANA program deploy \
  --url "$RPC" \
  --keypair "$DEPLOY_KEYPAIR" \
  --program-id "$GOVERNOR_KP" \
  "$GOVERNOR_SO"
echo "  ✔ governor deployed: $GOVERNOR_ID"

# --- Summary ---
echo ""
echo "============================================"
echo "  Deployment Complete"
echo "============================================"
echo "  Cluster:     $CLUSTER"
echo "  Wallet:      $WALLET"
echo "  delta-mint:  $DELTA_MINT_ID"
echo "  governor:    $GOVERNOR_ID"
echo ""
echo "  Next steps:"
echo "    1. Initialize dUSDY mint:"
echo "       npx ts-node scripts/init-mint-devnet.ts"
echo "    2. Create Kamino lending market + reserves"
echo "    3. Configure oracle feeds via updateReserveConfig"
echo "============================================"
