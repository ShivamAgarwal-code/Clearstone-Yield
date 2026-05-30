/**
 * Themed select dropdown — design-system styled wrapper around native
 * <select>. Matches the height + radius + focus ring of <Input> so
 * rows of mixed Dropdown + Input + Button align on the same baseline.
 *
 * Native <select> still owns the open menu (we can't restyle the
 * popup cross-browser without going custom), but the closed control
 * is now visibly part of the same field family as everything else.
 */

interface DropdownOption {
  value: string | number;
  label: string;
}

interface DropdownProps {
  options: DropdownOption[];
  value: string | number;
  onChange: (value: string | number) => void;
  className?: string;
  placeholder?: string;
}

export default function Dropdown({ options, value, onChange, className = "" }: DropdownProps) {
  return (
    <div className={`relative ${className}`}>
      <select
        value={value}
        onChange={(e) => {
          const opt = options.find((o) => String(o.value) === e.target.value);
          if (opt) onChange(opt.value);
        }}
        className={[
          "w-full h-10 pl-3.5 pr-9 rounded-lg",
          "border border-base-300 bg-base-200 text-base-content text-sm",
          "shadow-[inset_0_1px_2px_rgba(31,45,72,0.05)]",
          "appearance-none cursor-pointer outline-none",
          "transition-[border-color,box-shadow,background-color] duration-150 ease-out",
          "hover:border-base-content/35",
          "focus:border-primary/70 focus:shadow-[inset_0_1px_2px_rgba(31,45,72,0.05),0_0_0_3px_rgba(31,45,72,0.10)]",
        ].join(" ")}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-base-content/55">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
    </div>
  );
}
