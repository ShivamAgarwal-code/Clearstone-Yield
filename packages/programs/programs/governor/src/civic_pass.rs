//! Minimal inlined re-implementation of the subset of
//! `solana-gateway-anchor::Pass` that this program uses.
//!
//! Previously we depended on `solana-gateway-anchor = "0.1.3"`, which pulls
//! `solana-gateway` → `solana-program = "=1.18"`. That hard pin is
//! incompatible with `anchor-lang 0.31.x` (which wants the `solana-pubkey` /
//! `zeroize` line from solana-program 2.x). Rather than carry the upstream
//! dep we inline the minimum needed to validate a Civic gateway token.
//!
//! Binary format matches [`solana_gateway::state::GatewayToken`] so this
//! correctly deserialises existing Civic pass accounts on mainnet.

use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default, Debug, PartialEq)]
pub struct Pass {
    /// Version flag — ignored, currently 0.
    pub version: u8,
    /// Deprecated, always `None` — kept for on-chain layout compat.
    pub parent_gateway_token: Option<Pubkey>,
    /// Wallet to which the pass was issued.
    pub owner_wallet: Pubkey,
    /// Deprecated, always `None` — kept for on-chain layout compat.
    pub owner_identity: Option<Pubkey>,
    /// The gatekeeper network (e.g. Civic-uniqueness pass) that issued the pass.
    pub gatekeeper_network: Pubkey,
    /// The specific gatekeeper operator that signed the pass.
    pub issuing_gatekeeper: Pubkey,
    /// Lifecycle state. See [`GatewayTokenState`].
    pub state: GatewayTokenState,
    /// Optional unix-timestamp expiry.
    pub expire_time: Option<i64>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, Default, Debug, PartialEq)]
#[repr(u8)]
pub enum GatewayTokenState {
    #[default]
    Active = 0,
    Frozen = 1,
    Revoked = 2,
}

impl Pass {
    /// Deserialise a Civic gateway-token account. Upstream accounts are borsh
    /// with a fixed footprint (see `solana_gateway::state::GatewayToken::SIZE`)
    /// that may pad unused fields with trailing bytes. `BorshDeserialize::deserialize`
    /// consumes only what it needs and leaves any trailing bytes alone — that's
    /// the equivalent of upstream's `try_from_slice_incomplete`.
    pub fn try_deserialize_unchecked(data: &[u8]) -> Result<Self> {
        let mut slice = data;
        <Self as AnchorDeserialize>::deserialize(&mut slice)
            .map_err(|_| ProgramError::InvalidAccountData.into())
    }

    /// The subset of `Gateway::verify_gateway_token` this program relies on:
    /// owner matches, network matches, state is Active, not expired.
    pub fn valid(&self, recipient: &Pubkey, gatekeeper_network: &Pubkey) -> bool {
        if self.owner_wallet != *recipient {
            return false;
        }
        if self.gatekeeper_network != *gatekeeper_network {
            return false;
        }
        if self.state != GatewayTokenState::Active {
            return false;
        }
        if let Some(expire) = self.expire_time {
            let now = match Clock::get() {
                Ok(c) => c.unix_timestamp,
                Err(_) => return false,
            };
            if now >= expire {
                return false;
            }
        }
        true
    }
}
