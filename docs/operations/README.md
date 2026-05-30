# Operations Reference

Operator playbooks and design references for live subsystems. Updated
whenever the runtime behaviour changes.

| Doc | Scope |
|---|---|
| [KAMINO_INTEGRATION.md](KAMINO_INTEGRATION.md) | Klend market layout, reserve config, oracle wiring, liquidation. The reference that scripts `setup-cssol-market.ts` / `setup-cssol-wt-reserve.ts` and the frontend's `addresses.ts` both keep in lockstep. |
| [KEEPER_PERMISSIONS.md](KEEPER_PERMISSIONS.md) | Auto-roll keeper service: who signs, what it can do, how to rotate keys. |
| [IRM_NOTES.md](IRM_NOTES.md) | Interest-rate model parameters and the slope/utilization calibration we use across live reserves. |

For deployment runbooks see top-level [`DEPLOY.md`](../../DEPLOY.md);
for the big-picture system map see [`ARCHITECTURE.md`](../../ARCHITECTURE.md).
