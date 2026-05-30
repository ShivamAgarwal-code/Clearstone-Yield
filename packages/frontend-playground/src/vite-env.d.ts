/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string;
  readonly VITE_JITO_VAULT_PROGRAM?: string;
  readonly VITE_CSSOL_VAULT?: string;
  readonly VITE_CSSOL_VRT_MINT?: string;
  readonly VITE_CSSOL_VAULT_ST_TOKEN_ACCOUNT?: string;
  readonly VITE_GOVERNOR_PROGRAM?: string;
  readonly VITE_DELTA_MINT_PROGRAM?: string;
  readonly VITE_POOL_PDA?: string;
  readonly VITE_CSSOL_MINT?: string;
  readonly VITE_DM_MINT_CONFIG?: string;
  readonly VITE_DM_MINT_AUTHORITY?: string;
  readonly VITE_POOL_VRT_ATA?: string;
  readonly VITE_KLEND_PROGRAM?: string;
  readonly VITE_KLEND_MARKET?: string;
  readonly VITE_CSSOL_RESERVE?: string;
  readonly VITE_WSOL_RESERVE?: string;
  readonly VITE_CSSOL_RESERVE_ORACLE?: string;
  readonly VITE_WSOL_RESERVE_ORACLE?: string;
  readonly VITE_DEPOSIT_LUT?: string;
  readonly VITE_CSSOL_WT_MINT?: string;
  readonly VITE_POOL_PENDING_WSOL_ACCOUNT?: string;
  readonly VITE_CSSOL_WT_RESERVE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
