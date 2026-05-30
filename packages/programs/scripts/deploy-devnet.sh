#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
#  Deploy delta-mint + governor to Solana devnet
# ============================================================================
#
#  Prerequisites:
#    1. `solana config set --url devnet`
#    2. Wallet at ~/.config/solana/id.json with devnet SOL
#    3. Programs built: `anchor build`
#
#  Usage:
#    bash scripts/deploy-devnet.sh
#
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DELTA_MINT_ID="13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn"
GOVERNOR_ID="BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh"
DELTA_MINT_SO="$ROOT/target/deploy/delta_mint.so"
GOVERNOR_SO="$ROOT/target/deploy/governor.so"
DELTA_MINT_KP="$ROOT/target/deploy/delta_mint-keypair.json"
GOVERNOR_KP="$ROOT/keypairs/governor-keypair.json"

CLUSTER="devnet"
RPC="https://api.devnet.solana.com"
WALLET=$(~/.local/share/solana/install/active_release/bin/solana address)

echo "============================================"
echo "  Deploy to Solana Devnet"
echo "============================================"
echo "  Wallet:    $WALLET"
echo "  Cluster:   $CLUSTER"
echo "  delta-mint: $DELTA_MINT_ID"
echo "  governor:   $GOVERNOR_ID"
echo "============================================"
echo ""

# --- Check balances ---
BALANCE=$(~/.local/share/solana/install/active_release/bin/solana balance --url "$RPC" | awk '{print $1}')
echo "Wallet balance: $BALANCE SOL"

MIN_BALANCE=5
if (( $(echo "$BALANCE < $MIN_BALANCE" | bc -l) )); then
  echo "WARNING: Balance is low. Requesting airdrop..."
  ~/.local/share/solana/install/active_release/bin/solana airdrop 2 --url "$RPC" || echo "  Airdrop failed (rate limit?) — fund manually"
fi

# --- Build ---
echo ""
echo "Building programs..."
cd "$ROOT"
~/.local/share/solana/install/active_release/bin/anchor build 2>&1 | tail -5

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
if ~/.local/share/solana/install/active_release/bin/solana program show "$DELTA_MINT_ID" --url "$RPC" &>/dev/null; then
  echo "  delta-mint already deployed — upgrading..."
  ~/.local/share/solana/install/active_release/bin/solana program deploy \
    --url "$RPC" \
    --program-id "$DELTA_MINT_KP" \
    "$DELTA_MINT_SO"
else
  echo "  First-time deploy..."
  ~/.local/share/solana/install/active_release/bin/solana program deploy \
    --url "$RPC" \
    --program-id "$DELTA_MINT_KP" \
    "$DELTA_MINT_SO"
fi
echo "  ✔ delta-mint deployed: $DELTA_MINT_ID"

# --- Deploy governor ---
echo ""
echo "Deploying governor..."
if ~/.local/share/solana/install/active_release/bin/solana program show "$GOVERNOR_ID" --url "$RPC" &>/dev/null; then
  echo "  governor already deployed — upgrading..."
  ~/.local/share/solana/install/active_release/bin/solana program deploy \
    --url "$RPC" \
    --program-id "$GOVERNOR_KP" \
    "$GOVERNOR_SO"
else
  echo "  First-time deploy..."
  ~/.local/share/solana/install/active_release/bin/solana program deploy \
    --url "$RPC" \
    --program-id "$GOVERNOR_KP" \
    "$GOVERNOR_SO"
fi
echo "  ✔ governor deployed: $GOVERNOR_ID"

# --- Summary ---
echo ""
echo "============================================"
echo "  Deployment Complete"
echo "============================================"
echo "  Cluster:     $CLUSTER"
echo "  delta-mint:  $DELTA_MINT_ID"
echo "  governor:    $GOVERNOR_ID"
echo "  Wallet:      $WALLET"
echo ""
echo "  Next steps:"
echo "    1. Initialize dUSDY mint:"
echo "       npx ts-node scripts/init-mint-devnet.ts"
echo "    2. Or use the calldata-sdk-solana:"
echo "       import { admin } from '@delta/calldata-sdk-solana'"
echo "============================================"
