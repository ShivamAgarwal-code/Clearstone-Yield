/**
 * Delegation scanning.
 *
 * For the permissionless (user-signed) roll path, the keeper needs to
 * know which users have live `RollDelegation` PDAs. We use a single
 * `getProgramAccounts` call with a `dataSize: 123` filter — cheap
 * and O(N) in active delegations, not in total program accounts.
 *
 * Grouped by vault pubkey for O(1) lookup inside the tick loop.
 */
import { PublicKey } from "@solana/web3.js";
import { fixedYield } from "@delta/calldata-sdk-solana";
/** Curator program id. Operators can override for custom deployments. */
const CURATOR_PROGRAM_ID = new PublicKey("831zw8r2fGwRB1QpuRU3gZHZBFYYHBHeG7RbKUz9ssGm");
/**
 * Fetch every live `RollDelegation` across all vaults the curator
 * program knows about.
 *
 * Returns a `Map<vault_pubkey_base58, LiveDelegation[]>` — grouping
 * at fetch time saves repeated filtering inside the tick loop.
 */
export async function scanDelegations(conn, programId = CURATOR_PROGRAM_ID) {
    const accounts = await conn.getProgramAccounts(programId, {
        filters: [
            { dataSize: fixedYield.delegation.ROLL_DELEGATION_ACCOUNT_SIZE },
            // Optional: additional discriminator filter. If the curator
            // program ever adds another 123-byte account type, add a
            // `memcmp` on the first 8 bytes here.
        ],
    });
    const byVault = new Map();
    for (const { pubkey, account } of accounts) {
        try {
            const decoded = fixedYield.delegation.decodeRollDelegation(account.data);
            const key = decoded.vault.toBase58();
            const list = byVault.get(key) ?? [];
            list.push({ ...decoded, pda: pubkey });
            byVault.set(key, list);
        }
        catch {
            // Skip accounts that failed to decode (wrong discriminator,
            // truncated, etc.) — getProgramAccounts with dataSize filter
            // is loose, so the occasional false positive is expected.
        }
    }
    return byVault;
}
/**
 * Filter delegations by the current slot — keepers only crank live
 * ones. Expired delegations need to be revoked by the user (or left
 * to decay; the PDA just sits unused).
 */
export function filterLive(delegations, nowSlot) {
    return delegations.filter((d) => nowSlot < d.expiresAtSlot);
}
//# sourceMappingURL=delegations.js.map