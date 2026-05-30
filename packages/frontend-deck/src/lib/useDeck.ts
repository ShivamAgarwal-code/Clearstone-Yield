import { useEffect, useState } from "react";

/** Read the slide index from the URL hash (`#/3` → 3, 1-indexed). */
function readHash(total: number): number {
  const m = /^#\/(\d+)$/.exec(window.location.hash);
  if (!m) return 1;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(1, n), total);
}

/** Keyboard-driven deck nav with hash routing + overview toggle. */
export function useDeck(total: number) {
  const [index, setIndex] = useState<number>(() => readHash(total));
  const [overview, setOverview] = useState(false);

  // Keep URL hash in sync with index so slides are linkable.
  useEffect(() => {
    const target = `#/${index}`;
    if (window.location.hash !== target) {
      history.replaceState(null, "", target);
    }
  }, [index]);

  // React to back/forward hash changes too.
  useEffect(() => {
    const onHash = () => setIndex(readHash(total));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [total]);

  // Keyboard handlers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore when user is typing in a form field.
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        setIndex((i) => Math.min(total, i + 1));
        setOverview(false);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        setIndex((i) => Math.max(1, i - 1));
        setOverview(false);
      } else if (e.key === "Home") {
        e.preventDefault();
        setIndex(1);
      } else if (e.key === "End") {
        e.preventDefault();
        setIndex(total);
      } else if (e.key === "o" || e.key === "Escape") {
        setOverview((o) => !o);
      } else if (e.key === "p") {
        // Quick PDF export: open the print dialog.
        window.print();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [total]);

  return { index, setIndex, overview, setOverview };
}

/** Compute the screen scale so a 1920×1080 stage fits the viewport.
 *
 *  Reads from the LAYOUT viewport (`window.innerWidth/innerHeight`) on
 *  purpose — *not* `visualViewport`. visualViewport reports the visible
 *  chunk during pinch-zoom, so refitting against it would shrink the
 *  content the moment the user pinches in, canceling the zoom and
 *  preventing any pan. By reading the layout viewport instead, our
 *  scale stays put under pinch and the browser handles the visual
 *  zoom + pan natively (you can drag a zoomed-in slide around).
 *
 *  Known limitation: desktop browser zoom (Ctrl+/-) does change the
 *  layout viewport, so it still partly cancels. That's a separate
 *  fundamental tension between "auto-fit" and "user zoom"; if it
 *  matters, add a chrome toggle to disable auto-fit. */
export function useStageScale() {
  useEffect(() => {
    const root = document.documentElement;
    let last = -1;
    const apply = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (vw <= 0 || vh <= 0) return;
      const s = Math.min(vw / 1920, vh / 1080);
      if (Math.abs(s - last) < 0.0005) return;
      last = s;
      root.style.setProperty("--slide-scale", String(s));
    };
    apply();
    // ResizeObserver on documentElement catches every layout-viewport
    // change including devtools docking/undocking and CSS-driven resizes
    // that don't fire window.resize on every browser.
    const ro = new ResizeObserver(apply);
    ro.observe(document.documentElement);
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
    };
  }, []);
}
