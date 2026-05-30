#!/usr/bin/env bash
# Devnet deploy pass for the fixed-yield stack + first market.
#
# This is the operator's one-shot from "nothing deployed" to "retail
# frontend sees a real PT market and can deposit". Steps:
#
#   1. anchor deploy of clearstone_core, clearstone_router,
#      generic_exchange_rate_sy (or kamino_sy_adapter), and any
#      periphery programs we want live.
#   2. init_vault + market_two_init using the curator wallet.
#   3. Seed AMM liquidity so the market has a tradeable PT price.
#   4. Emit a JSON blob containing the MARKET_REGISTRY entry that the
#      backend worker consumes.
#
# This script is the skeleton — the actual clearstone-fixed-yield side
# commands live in that repo. Run from /home/axtar-1/clearstone-fixed-yield
# as a standalone pnpm task; this script assumes the programs are
# already deployed and collects their pubkeys.
set -euo pipefail

cd "$(dirname "$0")/../.."

: "${ANCHOR_PROVIDER_URL:=https://api.devnet.solana.com}"
: "${FORK_DIR:=/home/axtar-1/clearstone-fixed-yield}"
: "${CURATOR_KEYPAIR:=$HOME/.config/solana/id.json}"
: "${REGISTRY_OUT:=./devnet-market-registry.json}"

echo "[1/4] Deploying clearstone-fixed-yield programs to devnet…"
(
  cd "$FORK_DIR"
  ANCHOR_PROVIDER_URL="$ANCHOR_PROVIDER_URL" anchor deploy \
    --provider.cluster "$ANCHOR_PROVIDER_URL"
)

echo "[2/4] Reading program IDs from fork Anchor.toml…"
CORE_ID=$(grep -E '^clearstone_core' "$FORK_DIR/Anchor.toml" | head -1 | awk '{print $3}' | tr -d '"')
ROUTER_ID=$(grep -E '^clearstone_router' "$FORK_DIR/Anchor.toml" | head -1 | awk '{print $3}' | tr -d '"')
SY_PROG_ID=$(grep -E '^generic_exchange_rate_sy|^kamino_sy_adapter' "$FORK_DIR/Anchor.toml" | head -1 | awk '{print $3}' | tr -d '"')
echo "  clearstone_core:  $CORE_ID"
echo "  clearstone_router: $ROUTER_ID"
echo "  SY program:        $SY_PROG_ID"

echo "[3/4] Initializing vault + market_two + seeding AMM liquidity."
echo "       (Run init scripts from the fork repo; examples in"
echo "        clearstone-fixed-yield/migrations/.)"

cat <<EOF

Next steps (manual — fork repo has the init scripts):

  cd "$FORK_DIR"
  anchor run initialize-vault    # prompts for curator fee, duration, SY program
  anchor run initialize-market   # seed_id, initial PT liquidity, fee bps
  anchor run seed-amm            # initial SY+PT deposits to set PT price

Each script prints the pubkeys it creates — vault, market, mint_pt/yt,
mint_lp, escrows, ALTs. Feed those into the MARKET_REGISTRY block
below.

EOF

echo "[4/4] Emit MARKET_REGISTRY template (fill pubkeys + re-set on edge worker)."
cat > "$REGISTRY_OUT" <<'JSON'
[
  {
    "id": "usdc-FIRST-30d",
    "label": "USDC · 30d",
    "baseSymbol": "USDC",
    "baseDecimals": 6,
    "kycGated": false,
    "vault": "<VAULT_PUBKEY>",
    "market": "<MARKET_PUBKEY>",
    "baseMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "accounts": {
      "syProgram": "<SY_PROGRAM_ID>",
      "syMarket": "<SY_MARKET_PDA>",
      "syMint": "<SY_MINT>",
      "baseVault": "<ADAPTER_BASE_VAULT>",
      "vaultAuthority": "<VAULT_AUTHORITY_PDA>",
      "yieldPosition": "<VAULT_YIELD_POSITION>",
      "mintPt": "<MINT_PT>",
      "mintYt": "<MINT_YT>",
      "escrowSy": "<VAULT_ESCROW_SY>",
      "vaultAlt": "<VAULT_ALT>",
      "coreEventAuthority": "<CLEARSTONE_CORE_EVENT_AUTHORITY>",
      "mintLp": "<MINT_LP>",
      "marketEscrowPt": "<MARKET_ESCROW_PT>",
      "marketEscrowSy": "<MARKET_ESCROW_SY>",
      "marketAlt": "<MARKET_ALT>",
      "tokenFeeTreasurySy": "<TOKEN_FEE_TREASURY_SY>"
    }
  }
]
JSON
echo
echo "Wrote registry template → $REGISTRY_OUT"
echo
echo "After filling the pubkeys, push to backend-edge:"
echo "  wrangler secret put MARKET_REGISTRY < $REGISTRY_OUT"
echo
echo "Point the retail frontend at the edge worker:"
echo "  VITE_EDGE_URL=https://<your-worker>.workers.dev pnpm --filter frontend-retail build"
echo
echo "Done."
