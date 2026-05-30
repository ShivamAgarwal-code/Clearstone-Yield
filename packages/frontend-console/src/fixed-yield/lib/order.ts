// Browser-side fusion `OrderConfig` builder + ed25519 signing helper.
//
// Mirrors `tests/fusion_sign.ts` but runs in the browser:
//   - hashing via `crypto.subtle.digest("SHA-256", ...)` (sha256 in
//     fusion's order_hash matches Solana's hashv).
//   - signing via the connected wallet's `signMessage()` (Phantom + most
//     wallet-adapter wallets implement this).
//   - borsh encoding of `OrderConfig` is delegated to anchor's IDL coder
//     once a `Program<ClearstoneFusion>` is instantiated; we accept a
//     pre-encoded `orderBytes` here to keep this file IDL-free.
//
// This is meant for the demo's self-solve flow: the same wallet signs
// AND fills, so we don't need separate maker/solver keypairs.

import { PublicKey } from "@solana/web3.js";

/**
 * Subset of fusion's `OrderConfig` the demo cares about. All fields
 * present in the on-chain struct, but the demo defaults Dutch-auction
 * + fees to off and uses the permissionless resolver policy.
 */
export interface DemoOrderConfig {
  id: number;
  srcAmount: bigint;
  minDstAmount: bigint;
  estimatedDstAmount: bigint;
  expirationTimeSec: number;
  /** Solver allowlist; empty = permissionless. */
  resolverAllowlist: PublicKey[];
}

/** Compute the fusion order_hash. Pubkey order matches lib.rs:order_hash. */
export async function orderHash(args: {
  fusionProgramId: PublicKey;
  /** Borsh-encoded OrderConfig bytes. Get this from
   *  `program.coder.types.encode("orderConfig", config)`. */
  orderBytes: Uint8Array;
  protocolDstAcc: PublicKey | null;
  integratorDstAcc: PublicKey | null;
  srcMint: PublicKey;
  dstMint: PublicKey;
  makerReceiver: PublicKey;
}): Promise<Uint8Array> {
  // Mirror the Rust `Option<Pubkey>::try_to_vec()` borsh layout:
  //   None         → [0]
  //   Some(Pubkey) → [1, <32 bytes>]
  const encOpt = (p: PublicKey | null): Uint8Array =>
    p == null
      ? new Uint8Array([0])
      : new Uint8Array([1, ...p.toBytes()]);

  const parts: Uint8Array[] = [
    args.fusionProgramId.toBytes(),
    args.orderBytes,
    encOpt(args.protocolDstAcc),
    encOpt(args.integratorDstAcc),
    args.srcMint.toBytes(),
    args.dstMint.toBytes(),
    args.makerReceiver.toBytes(),
  ];

  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return new Uint8Array(digest);
}

/**
 * Sign the order hash with the connected wallet. `signMessage` is the
 * standard wallet-adapter primitive — Phantom, Backpack, Solflare, etc.
 * all implement it. Hardware wallets that DON'T expose signMessage
 * won't work for fusion orders; that's a real-world constraint, not a
 * UI limitation.
 */
export type SignMessageFn = (message: Uint8Array) => Promise<Uint8Array>;

export async function signOrderHash(
  signMessage: SignMessageFn,
  hash: Uint8Array
): Promise<Uint8Array> {
  return signMessage(hash);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0) throw new Error("hex must be even length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}
