#!/bin/bash
# Start a local validator with devnet-cloned accounts + patched oracles.
#
# Pre-requisites: Run `npx tsx scripts/setup-localnet-accounts.ts` first to
# save devnet accounts and create oracle overrides in /tmp/localnet-accounts/.
#
# Usage:
#   bash scripts/start-localnet.sh          # foreground (Ctrl+C to stop)
#   bash scripts/start-localnet.sh &        # background

set -e

VALIDATOR=~/.local/share/solana/install/active_release/bin/solana-test-validator
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$SCRIPT_DIR/../target/deploy"
ACCOUNTS_DIR="/tmp/localnet-accounts"
LEDGER="/tmp/delta-localnet"

# Kill existing
pkill -9 -f solana-test-validator 2>/dev/null || true
sleep 1
rm -rf "$LEDGER"

# Check accounts exist
if [ ! -f "$ACCOUNTS_DIR/klend.so" ]; then
  echo "ERROR: Account files not found in $ACCOUNTS_DIR"
  echo "Run: npx tsx scripts/setup-localnet-accounts.ts"
  exit 1
fi

echo "============================================"
echo "  Starting Local Validator"
echo "============================================"
echo "  Ledger:   $LEDGER"
echo "  Accounts: $ACCOUNTS_DIR"
echo "  RPC:      http://localhost:8899"
echo "============================================"

exec "$VALIDATOR" \
  --reset \
  --account BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W "$ACCOUNTS_DIR/BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W.json" \
  --account 45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98 "$ACCOUNTS_DIR/45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98.json" \
  --account D4qXufDqBjU5iTbVMHfdxDrpYnz31sed1oQCJbWoVGmH "$ACCOUNTS_DIR/D4qXufDqBjU5iTbVMHfdxDrpYnz31sed1oQCJbWoVGmH.json" \
  --account HoEa26bHi96mwAu3joQZKcyxhG9jXyJvaxLNuvjcwZmw "$ACCOUNTS_DIR/HoEa26bHi96mwAu3joQZKcyxhG9jXyJvaxLNuvjcwZmw.json" \
  --account E4pitSrZV9MWSspahe2vr26Cwsn3podnvHvW3cuT74R4 "$ACCOUNTS_DIR/usdy-oracle.json" \
  --bpf-program KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD "$ACCOUNTS_DIR/klend.so" \
  --bpf-program gSbePebfvPy7tRqimPoVecS2UsBvYv46ynrzWocc92s "$ACCOUNTS_DIR/pyth.so" \
  --bpf-program 13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn "$DEPLOY_DIR/delta_mint.so" \
  --bpf-program BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh "$DEPLOY_DIR/governor.so" \
  --ledger "$LEDGER" \
  --rpc-port 8899
