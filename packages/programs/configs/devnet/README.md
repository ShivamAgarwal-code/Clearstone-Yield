# Devnet Configuration

## Deployment Order

```bash
# 1. Deploy programs (delta-mint + governor)
pnpm deploy:mnemonic                # or pnpm deploy:devnet

# 2. Create mock USDC oracle (no V2 USDC feed on devnet)
pnpm devnet:oracles

# 3. Initialize governor pool + create cUSDY mint
pnpm devnet:governor

# 4. Create klend market, reserves, configure oracles, register with governor
pnpm devnet:market

# Or run all setup steps in sequence:
pnpm devnet:full
```

## Oracle Status on Devnet

| Feed | Pyth V2 Status | Address |
|------|---------------|---------|
| USDY/USD | Native | `E4pitSrZV9MWSspahe2vr26Cwsn3podnvHvW3cuT74R4` |
| USDC/USD | **Mock** (created by script) | Set after `pnpm devnet:oracles` |
| DAI/USD | Native (backup) | `A8XFp1YSUqyDDvTwRXM1vmhPHCLxziv9FWFkPpLY` |
| SOL/USD | Native (reference) | `J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix` |

klend on devnet uses the same program as mainnet (`KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`) and reads Pyth V2 format (3312-byte accounts owned by the V2 oracle program).

## Files

| File | Purpose |
|------|---------|
| `oracle-feeds.json` | All available Pyth feed addresses (V2 + push) |
| `delta_usdy_reserve.json` | cUSDY collateral reserve config (Pyth V2 USDY) |
| `usdc_borrow_reserve.json` | USDC borrow reserve config (mock oracle) |
| `deployment.json` | Generated — governor pool addresses |
| `oracles-deployed.json` | Generated — deployed oracle addresses |
| `market-deployed.json` | Generated — klend market + reserve addresses |

## Known Limitations

1. **USDC oracle is mocked** — fixed at $1.00, no live price updates
2. **Mock oracle owner** — owned by System Program, not Pyth V2. If klend validates the account owner, use localnet with `--clone` from mainnet instead
3. **No canonical devnet USDC** — script creates a test SPL token mint
4. **Pyth V2 USDY feed** — live but may have stale prices (depends on Pyth publisher activity on devnet)
