#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
#  Full Deployment Pipeline — Delta Mint + Governor + Kamino Market
# ============================================================================
#
#  Deploys everything from scratch to devnet (or mainnet-beta).
#
#  Usage:
#    bash scripts/deploy-all.sh [devnet|mainnet-beta]
#
#  Prerequisites:
#    - Solana CLI installed
#    - Anchor CLI installed
#    - Wallet funded (5+ SOL for devnet, 10+ SOL for mainnet)
#    - Programs built: pnpm build
#
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOLANA="$HOME/.local/share/solana/install/active_release/bin/solana"

# --- Parse cluster ---
CLUSTER="${1:-devnet}"
case "$CLUSTER" in
  devnet)       RPC="https://api.devnet.solana.com" ;;
  mainnet-beta) RPC="https://api.mainnet-beta.solana.com" ;;
  localnet)     RPC="http://127.0.0.1:8899" ;;
  *) echo "ERROR: Unknown cluster '$CLUSTER'. Use: devnet | mainnet-beta | localnet"; exit 1 ;;
esac

WALLET=$($SOLANA address 2>/dev/null || echo "unknown")
BALANCE=$($SOLANA balance --url "$RPC" 2>/dev/null | awk '{print $1}' || echo "0")

echo ""
echo "============================================"
echo "  Delta Deployment Pipeline"
echo "============================================"
echo "  Cluster:   $CLUSTER"
echo "  RPC:       $RPC"
echo "  Wallet:    $WALLET"
echo "  Balance:   $BALANCE SOL"
echo "============================================"
echo ""

# --- Check balance ---
MIN_BALANCE=5
if (( $(echo "$BALANCE < $MIN_BALANCE" | bc -l 2>/dev/null || echo 1) )); then
  echo "WARNING: Balance may be too low. Need ~5 SOL for devnet deployment."
  if [ "$CLUSTER" = "mainnet-beta" ]; then
    echo "ERROR: Insufficient balance for mainnet. Need 10+ SOL."
    exit 1
  fi
fi

# --- Step 0: Build ---
echo "=== Step 0: Build programs ==="
cd "$ROOT"
PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH" anchor build -p delta_mint 2>&1 | tail -2
PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH" anchor build -p governor 2>&1 | tail -2
echo "  Build complete."
echo ""

# --- Step 1: Deploy programs ---
echo "=== Step 1: Deploy programs ==="

deploy_program() {
  local name="$1"
  local so="$ROOT/target/deploy/${name}.so"
  local kp="$ROOT/target/deploy/${name}-keypair.json"
  local id
  id=$($SOLANA address -k "$kp" 2>/dev/null)

  if ! [ -f "$so" ]; then
    echo "  ERROR: $so not found. Run 'anchor build' first."
    return 1
  fi

  # Check if already deployed
  if $SOLANA program show "$id" --url "$RPC" &>/dev/null; then
    echo "  $name ($id) — already deployed, upgrading..."
  else
    echo "  $name ($id) — first-time deploy..."
  fi

  $SOLANA program deploy \
    --url "$RPC" \
    --program-id "$kp" \
    "$so" \
    --use-rpc 2>&1 | grep -E "Program Id|Error" || true
}

deploy_program delta_mint
deploy_program governor
echo ""

# --- Step 2: Setup oracles + governor + market ---
echo "=== Step 2: Setup oracles ==="
cd "$ROOT"
npx tsx scripts/setup-devnet-oracles.ts 2>&1 | grep -v "^npm warn\|DEP0040\|trace-deprecation"
echo ""

echo "=== Step 3: Initialize governor pool ==="
npx tsx scripts/deploy-governor-devnet.ts 2>&1 | grep -v "^npm warn\|DEP0040\|trace-deprecation\|bigint:"
echo ""

echo "=== Step 4: Create lending market + USDC reserve ==="
npx tsx scripts/setup-devnet-market.ts 2>&1 | grep -v "^npm warn\|DEP0040\|trace-deprecation\|bigint:"
echo ""

echo "=== Step 5: Complete setup (whitelist + mint + dUSDY reserve + config) ==="
npx tsx scripts/complete-devnet-setup.ts 2>&1 | grep -v "^npm warn\|DEP0040\|trace-deprecation\|bigint:"
echo ""

# --- Summary ---
echo "============================================"
echo "  Deployment Pipeline Complete"
echo "============================================"
echo "  Cluster: $CLUSTER"
echo "  Wallet:  $WALLET"
echo ""
echo "  Configs saved to: configs/devnet/"
echo "    - deployment.json     (governor pool + programs)"
echo "    - market-deployed.json (klend market + reserves)"
echo "    - oracles-deployed.json (oracle feeds)"
echo ""
echo "  Next steps:"
echo "    - Verify on Solana Explorer"
echo "    - Test deposit/borrow flow"
echo "    - Add more whitelist entries"
echo "============================================"
