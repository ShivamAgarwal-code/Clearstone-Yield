/**
 * Re-export from `@clearstone/design-system` so existing institutional
 * imports keep working. The implementation lives in the design-system
 * package now — both retail and institutional render tx-success toasts
 * with identical shape (Explorer link + copy-sig button + truncated
 * `sig=…` detail line).
 */
export { TxActionButtons, shortSig } from "@clearstone/design-system";
export type { TxActionButtonsProps } from "@clearstone/design-system";
