export type Env = {
    AUDIT_KV: KVNamespace;
    WHITELIST_CACHE: KVNamespace;
    SOLANA_RPC_URL: string;
    ADMIN_KEYPAIR_JSON?: string;
};
export interface AuditLogEntry {
    wallet: string;
    action: string;
    actor: string;
    metadata?: Record<string, unknown>;
    timestamp: string;
}
export interface WhitelistRecord {
    wallet: string;
    mintConfig: string;
    poolName: string;
    role: "Holder" | "Liquidator";
    approved: boolean;
    approvedAt: number;
}
//# sourceMappingURL=types.d.ts.map