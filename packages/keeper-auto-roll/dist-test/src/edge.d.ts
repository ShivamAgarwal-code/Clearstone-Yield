/**
 * Backend-edge HTTP client. Minimal — just the endpoints the keeper
 * needs, typed narrowly.
 */
export interface CuratorVaultSnapshot {
    id: string;
    label: string;
    baseSymbol: string;
    baseMint: string;
    baseDecimals: number;
    kycGated: boolean;
    vault: string;
    curator: string;
    baseEscrow: string;
    totalAssets: string;
    totalShares: string;
    feeBps: number;
    nextAutoRollTs: number | null;
    allocations: Array<{
        market: string;
        weightBps: number;
        deployedBase: string;
    }>;
    /**
     * Optional adapter override. When present, the keeper uses these
     * pubkeys verbatim instead of deriving them off the
     * `[b"sy_market", base_mint]` seed. That seed only matches the
     * `generic_exchange_rate_sy` adapter; Kamino (and future adapters)
     * publish their own sy_market / adapter_base_vault addresses.
     *
     * Once the backend-edge indexer populates this, mixed-adapter vaults
     * can be cranked without an SDK change. See FOLLOWUPS.md
     * :: KEEPER_SY_ADAPTER_SEED.
     */
    adapter?: {
        syMarket: string;
        adapterBaseVault: string;
    };
}
export declare function fetchCuratorVaults(edgeUrl: string): Promise<CuratorVaultSnapshot[]>;
//# sourceMappingURL=edge.d.ts.map