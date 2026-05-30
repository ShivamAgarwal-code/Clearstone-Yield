#!/usr/bin/env bash
#
# Full-flow test using solana-test-validator (real BPF VM).
# Pre-fetches mainnet accounts, extracts klend ELF, starts validator offline.
#
# Usage:
#   cd packages/programs
#   bash scripts/test-validator-flow.sh
#
set -euo pipefail

SOLANA_BIN="$HOME/.local/share/solana/install/active_release/bin"
export PATH="$SOLANA_BIN:$PATH"

KLEND="KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
KLEND_PROGRAMDATA="9uSbGW1y9H5Av6H5TKxQ1wnFApSq2t3oEpfF2YfjDQGA"
KLEND_GLOBAL_CONFIG="BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W"
USDC_MINT="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDY_MINT="A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6"
PYTH_USDY="BkN8hYgRjhyH18aBsuzvMSyMTBRkDrGs1PTgMbBFpnLb"
PYTH_USDC="Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD"
KAMINO_MAIN_MARKET="7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"

DELTA_MINT_ID="13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn"
GOVERNOR_ID="BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh"

RPC_URL="${ANCHOR_PROVIDER_URL:-https://api.mainnet-beta.solana.com}"
WALLET_PATH="${HOME}/.config/solana/id.json"
WALLET=$(solana-keygen pubkey "$WALLET_PATH")

# Kill any stale validator from a previous run
pkill -f solana-test-validator 2>/dev/null && sleep 1 || true

echo "============================================"
echo "  Full-Flow Test (solana-test-validator)"
echo "============================================"
echo "  Wallet:  $WALLET"
echo "  RPC:     $RPC_URL"
echo "============================================"

SNAP_DIR=$(mktemp -d /tmp/klend-snap-XXXXXX)
VALIDATOR_PID=""
cleanup() {
  [ -n "$VALIDATOR_PID" ] && kill "$VALIDATOR_PID" 2>/dev/null || true
  rm -rf "$SNAP_DIR"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Pre-fetch accounts from mainnet (quiet — no base64 dumps)
# ---------------------------------------------------------------------------
echo ""
echo "Fetching mainnet accounts..."

fetch_account() {
  local addr="$1" label="$2"
  local out="$SNAP_DIR/$addr.json"
  if solana account "$addr" --url "$RPC_URL" --output json --output-file "$out" >/dev/null 2>&1; then
    # Fix rentEpoch float overflow: replace the u64-max float with 0
    sed -i 's/1.8446744073709552e+19/0/g; s/1.844674407370955e+19/0/g; s/18446744073709551615/0/g' "$out"
    echo "  ✔ $label"
    return 0
  else
    echo "  ✗ $label (failed)"
    return 1
  fi
}

# NOTE: klend program is loaded via --clone (not --account) to avoid
# "program cache hit max limit" — the runtime handles --clone programs
# differently during genesis compilation.

# Data accounts
fetch_account "$KLEND_GLOBAL_CONFIG" "klend global config" || true; sleep 0.3
fetch_account "$USDC_MINT" "USDC mint" || true; sleep 0.3
fetch_account "$USDY_MINT" "USDY mint" || true; sleep 0.3
fetch_account "$PYTH_USDC" "Pyth USDC oracle" || true; sleep 0.3
fetch_account "$KAMINO_MAIN_MARKET" "Kamino main market" || true

# USDY has no push oracle on Solana — create a mock by copying USDC oracle data
echo -n "  Creating mock Pyth USDY oracle (copy of USDC price)... "
if [ -f "$SNAP_DIR/$PYTH_USDC.json" ]; then
  # Copy the USDC oracle JSON and change the pubkey to the USDY oracle address
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('$SNAP_DIR/$PYTH_USDC.json', 'utf8'));
    data.pubkey = '$PYTH_USDY';
    fs.writeFileSync('$SNAP_DIR/$PYTH_USDY.json', JSON.stringify(data));
  " 2>/dev/null
  echo "OK"
else
  echo "FAILED (no USDC oracle to copy from)"
fi

# ---------------------------------------------------------------------------
# 2. klend loaded as upgradeable program via --account (correct loader + heap)
# ---------------------------------------------------------------------------
echo ""

# ---------------------------------------------------------------------------
# 3. Generate pre-funded USDC token account
# ---------------------------------------------------------------------------
USDC_ATA_FILE="$SNAP_DIR/usdc-ata.json"
USDC_ATA=$(node -e "
const { PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
const mint = new PublicKey('$USDC_MINT');
const owner = new PublicKey('$WALLET');
const ata = getAssociatedTokenAddressSync(mint, owner, false);
const data = Buffer.alloc(165);
mint.toBuffer().copy(data, 0);
owner.toBuffer().copy(data, 32);
data.writeBigUInt64LE(10000000000n, 64);
data[108] = 1;
const json = { pubkey: ata.toBase58(), account: {
  lamports: 2039280, data: [data.toString('base64'), 'base64'],
  owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  executable: false, rentEpoch: 0
}};
require('fs').writeFileSync('$USDC_ATA_FILE', JSON.stringify(json));
console.log(ata.toBase58());
" 2>/dev/null)
echo "  USDC ATA: $USDC_ATA (10,000 USDC)"

# ---------------------------------------------------------------------------
# 4. Build programs if needed
# ---------------------------------------------------------------------------
if [ ! -f "target/deploy/delta_mint.so" ] || [ ! -f "target/deploy/governor.so" ]; then
  echo ""; echo "Building programs..."
  anchor build -p delta_mint
  anchor build -p governor
fi

# ---------------------------------------------------------------------------
# 5. Build --account flags for data accounts (skip klend program/programdata)
# ---------------------------------------------------------------------------
ACCOUNT_FLAGS=""
for ADDR in "$KLEND_GLOBAL_CONFIG" "$USDC_MINT" "$USDY_MINT" "$PYTH_USDC" "$PYTH_USDY" "$KAMINO_MAIN_MARKET"; do
  FILE="$SNAP_DIR/$ADDR.json"
  if [ -f "$FILE" ]; then
    ACCOUNT_FLAGS="$ACCOUNT_FLAGS --account $ADDR $FILE"
  fi
done

# ---------------------------------------------------------------------------
# 6. Start test-validator
# ---------------------------------------------------------------------------
echo ""
echo "Starting solana-test-validator..."

eval solana-test-validator \
  --url "$RPC_URL" \
  --clone "$KLEND" \
  --clone "$KLEND_PROGRAMDATA" \
  $ACCOUNT_FLAGS \
  --account "$USDC_ATA" "$USDC_ATA_FILE" \
  --bpf-program "$DELTA_MINT_ID" target/deploy/delta_mint.so \
  --bpf-program "$GOVERNOR_ID" target/deploy/governor.so \
  --reset \
  --quiet \
  &
VALIDATOR_PID=$!

echo "Waiting for validator..."
for i in $(seq 1 60); do
  if solana cluster-version -u localhost >/dev/null 2>&1; then
    echo "Validator ready."
    break
  fi
  if ! kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    echo "ERROR: Validator died. Snap dir preserved: $SNAP_DIR"
    trap - EXIT; exit 1
  fi
  sleep 1
done

echo "Airdropping 500 SOL..."
solana airdrop 500 "$WALLET" -u localhost --commitment finalized >/dev/null 2>&1

# Warm up the program cache — klend is large and needs time to JIT compile
echo "Warming up program cache (advancing slots)..."
for i in $(seq 1 10); do
  solana transfer "$WALLET" 0.001 -u localhost --allow-unfunded-recipient --commitment confirmed >/dev/null 2>&1 || true
  sleep 0.5
done
echo "  Cache warmup done."

echo ""
echo "Verifying accounts..."
solana account "$KLEND" -u localhost >/dev/null 2>&1 && echo "  ✔ klend program" || echo "  ✗ klend program"
solana account "$KLEND_GLOBAL_CONFIG" -u localhost >/dev/null 2>&1 && echo "  ✔ klend global config" || echo "  ✗ klend global config"
solana account "$USDC_MINT" -u localhost >/dev/null 2>&1 && echo "  ✔ USDC mint" || echo "  ✗ USDC mint"
solana account "$PYTH_USDY" -u localhost >/dev/null 2>&1 && echo "  ✔ Pyth USDY" || echo "  ✗ Pyth USDY"
solana account "$PYTH_USDC" -u localhost >/dev/null 2>&1 && echo "  ✔ Pyth USDC" || echo "  ✗ Pyth USDC"
solana account "$USDC_ATA" -u localhost >/dev/null 2>&1 && echo "  ✔ USDC ATA" || echo "  ✗ USDC ATA"

# ---------------------------------------------------------------------------
# 7. Run test
# ---------------------------------------------------------------------------
echo ""
echo "============================================"
echo "  Running full-flow test..."
echo "============================================"
echo ""

ANCHOR_PROVIDER_URL=http://localhost:8899 \
ANCHOR_WALLET="$WALLET_PATH" \
  pnpm ts-mocha -p ./tsconfig.json -t 1000000 tests/kamino-full-flow.validator.ts

echo ""
echo "============================================"
echo "  Done."
echo "============================================"
