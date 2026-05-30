// Shared program-id + RPC handles for the demo UI.
//
// All program IDs match the workspace's `Anchor.toml` `[programs.devnet]`
// block. If the integrator forks the workspace and re-keys the programs,
// they need to update both Anchor.toml AND this file. We don't auto-derive
// from the IDL because the UI is meant to be readable as a reference, not
// a bundled SDK.

import { PublicKey } from "@solana/web3.js";

export const CLEARSTONE_CORE = new PublicKey(
  "DZmP7zaBrc6FdJc842aeexnGV5YwPucg2Jv8p6Szh6hW"
);
export const CLEARSTONE_ROUTER = new PublicKey(
  "DenU4j4oV4wCMCsytrfYuFwAumTE1abFAPmpYDpjWmsW"
);
export const CLEARSTONE_CURATOR = new PublicKey(
  "831zw8r2fGwRB1QpuRU3gZHZBFYYHBHeG7RbKUz9ssGm"
);
export const CLEARSTONE_REWARDS = new PublicKey(
  "7ddrynBQiCNjxejxRwxvSbDb56k8F8Yp4KwYgfiaHX8g"
);
export const CLEARSTONE_SOLVER_CALLBACK = new PublicKey(
  "27UhEF34wbyPdZw4nnAFUREU5LHMFs55PethnhJ6yNCP"
);
export const CLEARSTONE_FUSION = new PublicKey(
  "9ShSnLUcWeg5BZzokj8mdo9cNHARCKa42kwmqSdBNM6J"
);
export const GENERIC_EXCHANGE_RATE_SY = new PublicKey(
  "HA1T2p7DkktepgtwrVqNBK8KidAYr5wvS1uKqzvScNm3"
);
export const KAMINO_SY_ADAPTER = new PublicKey(
  "29tisXppYM4NcAEJfzMe1aqyuf2M7w9StTtiXBHxTKxd"
);
