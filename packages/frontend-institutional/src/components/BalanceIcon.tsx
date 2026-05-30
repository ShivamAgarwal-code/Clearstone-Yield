import { TokenIcon, TokenIconProps } from "@clearstone/design-system";
import { useTokenBalance } from "../hooks/useWalletBalances";

/**
 * BalanceIcon — TokenIcon wrapped with the live wallet balance tooltip.
 *
 * Drop-in replacement for `<TokenIcon>` in any context where the user
 * benefits from seeing how much of the token they actually hold (table
 * rows, EG flow, addons, etc.). When the balance is unknown or the
 * caller passes its own `tip`, the wrapper falls through and acts like
 * a plain TokenIcon.
 */
export default function BalanceIcon(props: TokenIconProps) {
  const balance = useTokenBalance(props.symbol);

  // Caller-provided tip wins (e.g. status callouts, info chips).
  if (props.tip !== undefined) {
    return <TokenIcon {...props} />;
  }

  // No balance for unknown tokens — render bare icon, no tooltip.
  if (!balance) {
    return <TokenIcon {...props} />;
  }

  return <TokenIcon {...props} tip={balance.tip} />;
}
