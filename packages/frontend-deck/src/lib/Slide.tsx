import type { ReactNode } from "react";

export type SlideTheme = "deep" | "rise" | "fade" | "light" | "soft";

const themeClass: Record<SlideTheme, string> = {
  deep:  "",
  rise:  "slide--rise",
  fade:  "slide--fade",
  light: "slide--light",
  soft:  "slide--soft",
};

export function Slide({
  theme = "deep",
  grid = false,
  children,
  number,
  total,
}: {
  theme?: SlideTheme;
  grid?: boolean;
  children: ReactNode;
  number?: number;
  total?: number;
}) {
  return (
    <section className={`slide ${themeClass[theme]} ${grid ? "slide--grid" : ""}`}>
      {children}
      <div className="footer-line">
        <span className="brand">clearstone <span style={{ opacity: 0.55 }}>fusion</span></span>
        {number != null && total != null && (
          <span>{String(number).padStart(2, "0")} / {String(total).padStart(2, "0")}</span>
        )}
      </div>
    </section>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="eyebrow">{children}</span>;
}
