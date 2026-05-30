/**
 * Curator-admin instruction builders — for the **keeper service**.
 *
 * All ixs here require the curator wallet as signer (see
 * KEEPER_PERMISSIONS.md). The retail SDK surfaces are in `curator.ts`;
 * keep these separate so a compromised frontend can't accidentally
 * expose them.
 */
import { TransactionInstruction, SystemProgram, } from "@solana/web3.js";
import BN from "bn.js";
import { CLEARSTONE_CURATOR_PROGRAM_ID, CLEARSTONE_CORE_PROGRAM_ID, GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, } from "../common/constants.js";
import { CURATOR_ADMIN_DISC } from "./constants.js";
const ro = (pubkey) => ({
    pubkey,
    isSigner: false,
    isWritable: false,
});
const rw = (pubkey) => ({
    pubkey,
    isSigner: false,
    isWritable: true,
});
const signer = (pubkey, writable = true) => ({
    pubkey,
    isSigner: true,
    isWritable: writable,
});
function u64le(n) {
    const v = typeof n === "bigint" ? new BN(n.toString()) : new BN(n);
    return v.toArrayLike(Buffer, "le", 8);
}
function i64le(n) {
    const v = typeof n === "bigint" ? new BN(n.toString()) : new BN(n);
    return v.toTwos(64).toArrayLike(Buffer, "le", 8);
}
function u16le(n) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n & 0xffff, 0);
    return b;
}
function reallocateKeys(p, includeSystem) {
    const keys = [
        signer(p.curator),
        rw(p.vault),
        ro(p.baseMint),
        rw(p.baseEscrow),
        ro(p.syMarket),
        rw(p.syMint),
        rw(p.adapterBaseVault),
        rw(p.vaultSyAta),
        rw(p.market),
        rw(p.marketEscrowPt),
        rw(p.marketEscrowSy),
        rw(p.tokenFeeTreasurySy),
        ro(p.marketAlt),
        ro(p.mintPt),
        rw(p.mintLp),
        rw(p.vaultPtAta),
        rw(p.vaultLpAta),
        ro(p.tokenProgram ?? TOKEN_PROGRAM_ID),
        ro(p.syProgram ?? GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID),
        ro(p.coreProgram ?? CLEARSTONE_CORE_PROGRAM_ID),
        ro(p.coreEventAuthority),
    ];
    if (includeSystem) {
        // reallocate_to_market has `init_if_needed` ATAs → needs ATA + System program.
        keys.push(ro(p.associatedTokenProgram ?? ASSOCIATED_TOKEN_PROGRAM_ID), ro(SystemProgram.programId));
    }
    return keys;
}
export function buildReallocateToMarket(p) {
    return new TransactionInstruction({
        programId: p.programId ?? CLEARSTONE_CURATOR_PROGRAM_ID,
        keys: reallocateKeys(p, true),
        data: Buffer.concat([
            CURATOR_ADMIN_DISC.reallocateToMarket,
            u16le(p.allocationIndex),
            u64le(p.baseIn),
            u64le(p.ptBuyAmount),
            i64le(p.maxSyIn),
            u64le(p.ptIntent),
            u64le(p.syIntent),
            u64le(p.minLpOut),
        ]),
    });
}
export function buildReallocateFromMarket(p) {
    return new TransactionInstruction({
        programId: p.programId ?? CLEARSTONE_CURATOR_PROGRAM_ID,
        // reallocate_from does not have init_if_needed ATAs, so no ATA/System.
        keys: reallocateKeys(p, false),
        data: Buffer.concat([
            CURATOR_ADMIN_DISC.reallocateFromMarket,
            u16le(p.allocationIndex),
            u64le(p.lpIn),
            u64le(p.minPtOut),
            u64le(p.minSyOut),
            u64le(p.ptSellAmount),
            i64le(p.minSyForPt),
            u64le(p.syRedeemAmount),
            u64le(p.baseOutExpected),
        ]),
    });
}
export function buildMarkToMarket(p) {
    return new TransactionInstruction({
        programId: p.programId ?? CLEARSTONE_CURATOR_PROGRAM_ID,
        keys: [rw(p.vault), ro(p.coreVault), ro(p.market)],
        data: Buffer.concat([CURATOR_ADMIN_DISC.markToMarket, u16le(p.allocationIndex)]),
    });
}
