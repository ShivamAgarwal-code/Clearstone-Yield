/**
 * Public surface of @clearstone/design-system.
 *
 * Components live in src/components, low-level helpers in src/lib.
 * CSS entry points (theme.css, styles.css, fonts.css) are not re-exported
 * — consumers `@import` them from their app entry CSS so Tailwind / DaisyUI
 *  pick up the tokens at build time.
 */

export { Button } from "./components/Button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./components/Button";

export { default as Snackbar } from "./components/Snackbar";
export type { SnackbarProps, SnackbarType } from "./components/Snackbar";

export { TxActionButtons, shortSig } from "./components/TxActionButtons";
export type { TxActionButtonsProps } from "./components/TxActionButtons";

export { Tabs } from "./components/Tabs";
export type {
  TabsRootProps,
  TabsListProps,
  TabsTriggerProps,
  TabsContentProps,
  TabsVariant,
} from "./components/Tabs";

export {
  Eyebrow,
  PageHeader,
  SectionHeader,
  FieldGroupHeading,
} from "./components/Heading";
export type {
  EyebrowProps,
  PageHeaderProps,
  SectionHeaderProps,
  FieldGroupHeadingProps,
} from "./components/Heading";

export { Card, CardHeader, CardFooter } from "./components/Card";
export type {
  CardProps,
  CardHeaderProps,
  CardFooterProps,
  CardTone,
  CardSize,
} from "./components/Card";

export { Badge } from "./components/Badge";
export type { BadgeProps, BadgeTone, BadgeStyle, BadgeSize } from "./components/Badge";

export { Input } from "./components/Input";
export type { InputProps, InputSize } from "./components/Input";

export { FormLabel, StatLabel, KeyValue } from "./components/Label";
export type { FormLabelProps, StatLabelProps, KeyValueProps } from "./components/Label";

export { Stat } from "./components/Stat";
export type { StatProps, StatAccent, StatSize } from "./components/Stat";

export { TokenAmountInput } from "./components/TokenAmountInput";
export type { TokenAmountInputProps, TokenAmountInputSize } from "./components/TokenAmountInput";

export { TokenIcon, tokenBrandColor } from "./components/TokenIcon";
export type { TokenIconProps, TokenIconSize, TokenSymbol, TokenIconKind } from "./components/TokenIcon";

export { cn } from "./lib/cn";
