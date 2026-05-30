import { ButtonHTMLAttributes, CSSProperties, ReactNode, createContext, useContext, useId } from "react";
import { cn } from "../lib/cn";

/**
 * Tabs — controlled tab system with explicit visual states.
 *
 * Four shapes:
 *   * `underline` — page-level (Position / Collateral / Trade). Active
 *     tab gets a 2px primary stripe + a soft underline glow.
 *   * `pill` — sub-section. Active pill is a filled white chip lifted
 *     by a shadow; rest sit inside a tinted rail.
 *   * `segmented` — binary toggles (Conservative / Aggressive). Active
 *     segment is filled with primary; rest are transparent.
 *   * `section` — card-style at section level. Active card lifts off
 *     a recessed rail with a primary-tinted halo and a left-edge
 *     accent bar (bookmark feel). Used for top-of-page mode switchers.
 *
 * Triggers can carry an `icon` (TokenIcon, step number, etc.) and a
 * `badge` (count chip, status pill). All variants share the same
 * accessible markup (role=tablist / role=tab / aria-selected).
 */

export type TabsVariant = "underline" | "pill" | "segmented" | "section";

interface TabsContextValue {
  value: string;
  setValue: (v: string) => void;
  variant: TabsVariant;
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error(`<${component}> must be used inside <Tabs.Root>.`);
  return ctx;
}

export interface TabsRootProps {
  value: string;
  onValueChange: (v: string) => void;
  variant?: TabsVariant;
  children: ReactNode;
  className?: string;
}

function Root({ value, onValueChange, variant = "underline", children, className }: TabsRootProps) {
  const baseId = useId();
  return (
    <TabsContext.Provider value={{ value, setValue: onValueChange, variant, baseId }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export interface TabsListProps {
  children: ReactNode;
  className?: string;
  /** underline-only: render a thin divider under the list. */
  withRail?: boolean;
}

function List({ children, className, withRail }: TabsListProps) {
  const { variant } = useTabsContext("Tabs.List");

  if (variant === "pill") {
    return (
      <div
        role="tablist"
        className={cn(
          "inline-flex items-center gap-1 p-1 rounded-lg",
          "bg-base-100/80 border border-base-300/70",
          className,
        )}
      >
        {children}
      </div>
    );
  }

  if (variant === "segmented") {
    return (
      <div
        role="tablist"
        className={cn(
          "inline-flex items-center rounded-lg",
          "bg-base-200 border border-base-300 overflow-hidden",
          "shadow-[inset_0_1px_2px_rgba(31,45,72,0.04)]",
          "[&>[role=tab]]:border-r [&>[role=tab]:last-child]:border-r-0 [&>[role=tab]]:border-base-300",
          className,
        )}
      >
        {children}
      </div>
    );
  }

  if (variant === "section") {
    // Outer rail: page-tint surface so the white active card lifts off
    // it. Stronger inset shadow than v1 because the previous opacity
    // wasn't enough to read as "recessed" against the new warm body
    // gradient — the active card was floating over a near-identical
    // wash. Padding lets the active card's halo render without clipping.
    return (
      <div
        role="tablist"
        className={cn(
          "flex items-stretch gap-1.5 p-2 rounded-2xl",
          "bg-base-100 border border-base-300",
          "shadow-[inset_0_2px_4px_rgba(31,45,72,0.10),inset_0_0_0_1px_rgba(31,45,72,0.04)]",
          className,
        )}
      >
        {children}
      </div>
    );
  }

  // underline
  return (
    <div
      role="tablist"
      className={cn(
        "flex items-center gap-1",
        withRail && "border-b border-base-300",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface TabsTriggerProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value"> {
  value: string;
  children: ReactNode;
  /** Optional badge rendered after the label (count, status). */
  badge?: ReactNode;
  /** Optional icon at the start (TokenIcon, step circle, etc). */
  icon?: ReactNode;
}

function Trigger({ value, children, badge, icon, className, disabled, ...rest }: TabsTriggerProps) {
  const { value: active, setValue, variant, baseId } = useTabsContext("Tabs.Trigger");
  const isActive = active === value;

  const common = variant === "section"
    ? cn(
        "relative block select-none overflow-hidden cursor-pointer",
        "transition-[transform,box-shadow,background-color,color,border-color] duration-300 ease-out",
        "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/50",
        "disabled:cursor-not-allowed disabled:opacity-40",
      )
    : cn(
        "inline-flex items-center justify-center gap-2 select-none whitespace-nowrap cursor-pointer",
        "transition-all duration-200 ease-out",
        "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/50",
        "disabled:cursor-not-allowed disabled:opacity-40",
      );

  const styles = (() => {
    if (variant === "pill") {
      return cn(
        "h-9 px-3.5 text-xs font-semibold rounded-md",
        isActive
          ? "bg-base-200 text-base-content shadow-[0_1px_2px_rgba(31,45,72,0.10),0_4px_10px_-4px_rgba(31,45,72,0.18)]"
          : "text-base-content/60 hover:text-base-content hover:bg-base-200/60",
      );
    }
    if (variant === "segmented") {
      return cn(
        "h-9 px-4 text-xs font-semibold flex-1",
        isActive
          ? "bg-primary text-primary-content shadow-[inset_0_1px_0_rgba(255,255,255,0.10)]"
          : "bg-transparent text-base-content/65 hover:bg-base-300/50 hover:text-base-content",
      );
    }
    if (variant === "section") {
      // Active = white card lifted off the recessed rail with a real
      // shadow + bookmark stripe. Inactive sits flat against the rail
      // at /45 text — fades back so the active card unambiguously wins
      // the user's eye.
      return cn(
        "flex-1 min-w-0 rounded-xl px-5 py-4 text-left",
        isActive
          ? cn(
              "bg-base-200 text-base-content",
              "shadow-[0_1px_3px_rgba(31,45,72,0.10),0_20px_40px_-14px_rgba(31,45,72,0.45)]",
              "border border-base-300/80",
            )
          : cn(
              "bg-transparent text-base-content/45",
              "border border-transparent",
              "hover:bg-base-200/50 hover:text-base-content/80",
            ),
      );
    }
    // underline — emphasised active state. Thicker rail, semibold
    // weight, faint primary-tinted background pill, plus a small
    // primary-coloured glow under the stripe so it pops against the
    // white nav. Inactive tabs preview the active treatment on hover
    // (stronger bg + a lower-opacity primary stripe) so the affordance
    // is unmistakable instead of just a quiet text-color shift.
    return cn(
      "relative h-11 px-4 text-sm rounded-md",
      "after:content-[''] after:absolute after:left-3 after:right-3 after:bottom-[-1px] after:h-[3px]",
      "after:rounded-full after:transition-[background-color,box-shadow,opacity] after:duration-200",
      isActive
        ? cn(
            "text-base-content font-semibold",
            "bg-primary/[0.06]",
            "after:bg-primary after:shadow-[0_2px_8px_-2px_rgba(31,45,72,0.45)]",
          )
        : cn(
            "text-base-content/55 font-medium",
            "hover:text-base-content hover:bg-base-content/[0.07]",
            // Hover preview of the active stripe — primary at 35% opacity
            // sits under the label so the user reads it as a "click here
            // to activate" preview, not as the active state itself.
            "after:bg-transparent",
            "hover:after:bg-primary/35",
          ),
    );
  })();

  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-trigger-${value}`}
      aria-selected={isActive}
      aria-controls={`${baseId}-panel-${value}`}
      tabIndex={isActive ? 0 : -1}
      disabled={disabled}
      onClick={() => setValue(value)}
      className={cn(common, styles, className)}
      style={
        variant === "section" && isActive
          ? ({ "--cs-tab-halo": "var(--color-primary, #1F2D48)" } as CSSProperties)
          : undefined
      }
      {...rest}
    >
      {/* section: bookmark accent + active halo bloom */}
      {variant === "section" && (
        <>
          <span
            aria-hidden
            className={cn(
              "absolute left-2.5 top-3 bottom-3 w-[3px] rounded-full transition-colors duration-300",
              isActive ? "bg-primary" : "bg-transparent",
            )}
          />
          {isActive && (
            <span
              aria-hidden
              className="pointer-events-none absolute -top-12 -right-12 h-36 w-36 rounded-full opacity-25 blur-2xl"
              style={{ background: `radial-gradient(closest-side, var(--cs-tab-halo), transparent 70%)` }}
            />
          )}
        </>
      )}

      {variant === "section" ? (
        <div className="relative z-10 flex items-start gap-3 pl-3">
          {icon && (
            <div className="flex-shrink-0 mt-0.5 drop-shadow-[0_2px_6px_rgba(31,45,72,0.12)]">
              {icon}
            </div>
          )}
          <div className="min-w-0 flex-1">{children}</div>
          {badge != null && (
            <div className="flex-shrink-0 mt-0.5">{badge}</div>
          )}
        </div>
      ) : (
        <>
          {icon && (
            // `inline-flex items-center` on the icon span and `leading-none`
            // on the adjacent text — without leading-none the text's
            // line-box is taller than the icon and the flex `items-center`
            // on the parent button shifts the icon up by half the
            // line-height delta, producing the "icon hovers above text"
            // misalignment.
            <span className="flex-shrink-0 inline-flex items-center justify-center leading-none">
              {icon}
            </span>
          )}
          <span className="leading-none">{children}</span>
          {badge != null && <span className="flex-shrink-0 inline-flex items-center leading-none">{badge}</span>}
        </>
      )}
    </button>
  );
}

export interface TabsContentProps {
  value: string;
  children: ReactNode;
  className?: string;
  keepMounted?: boolean;
}

function Content({ value, children, className, keepMounted }: TabsContentProps) {
  const { value: active, baseId } = useTabsContext("Tabs.Content");
  const isActive = active === value;
  if (!isActive && !keepMounted) return null;
  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-trigger-${value}`}
      hidden={!isActive}
      className={className}
    >
      {children}
    </div>
  );
}

export const Tabs = { Root, List, Trigger, Content };
