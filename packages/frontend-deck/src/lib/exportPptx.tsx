import { createRoot } from "react-dom/client";
import { domToPng } from "modern-screenshot";
import pptxgen from "pptxgenjs";
import { SLIDES } from "../slides";

const SLIDE_W = 1920;
const SLIDE_H = 1080;
// 2× supersample → 3840×2160 PNGs (~384 DPI inside the 10″×5.625″ slide).
// PowerPoint downscales smoothly, so text and thin strokes stay crisp on
// 4K projectors and retina displays. Bumping to 3× was tried but produced
// ~25MB files for a 10-slide deck with minimal visual gain.
const RENDER_SCALE = 2;

// Renders each slide into a real, on-screen-but-hidden 1920×1080 host and
// rasterizes it with modern-screenshot (a maintained, bug-fixed fork of
// html-to-image). modern-screenshot uses SVG foreignObject + inline styles
// like html-to-image but adds workarounds for the classic blank-capture
// cases (Tailwind v4 @layer/@property, @import-loaded Google Fonts, CSS
// variables, pseudo-elements). Picked over html2canvas because html2canvas
// crashes on radial-gradient → createPattern with 0-size canvases on the
// title and closing slides.
export async function exportToPptx(
  onProgress?: (current: number, total: number) => void,
): Promise<void> {
  // Pre-load brand fonts so text metrics are stable before the first
  // capture. Without this, the first 1-2 slides often render with fallback
  // metrics, producing visible reflow in the exported deck.
  await preloadFonts();

  const { host, cleanup } = mountCaptureHost();
  const root = createRoot(host);

  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_16x9";
  pptx.title = "Clearstone Fusion Deck";

  try {
    for (let i = 0; i < SLIDES.length; i++) {
      const s = SLIDES[i];
      onProgress?.(i + 1, SLIDES.length);

      root.render(s.render({ number: i + 1, total: SLIDES.length }) as React.ReactElement);
      await waitForRender(host);

      const dataUrl = await domToPng(host, {
        width: SLIDE_W,
        height: SLIDE_H,
        backgroundColor: "#070D1F",
        scale: RENDER_SCALE,
        // Inline @import-loaded Google Font CSS into the SVG so text
        // renders with the correct Manrope/Geist faces inside the
        // foreignObject. Without this, captures fall back to a system
        // font for everything — or, on Chromium, produce blank text.
        font: { cssText: undefined },
        // Don't bust cache for same-origin assets; cacheBust adds query
        // params that can trip CORS preflight on the SVG-image roundtrip.
        // (modern-screenshot defaults to false, kept explicit here.)
        features: {
          // Remove control characters that can break SVG serialization on
          // Chromium when slide text contains stray U+200B etc.
          removeControlCharacter: true,
        },
      });

      const slide = pptx.addSlide();
      slide.background = { color: "070D1F" };
      slide.addImage({ data: dataUrl, x: 0, y: 0, w: "100%", h: "100%" });
    }

    await pptx.writeFile({ fileName: "Clearstone-Fusion-Deck.pptx" });
  } finally {
    root.unmount();
    cleanup();
  }
}

// Mounts a 1920×1080 host that is fully painted by the browser (so layout
// is real and the capture lib can read it) but invisible to the user. We
// use a fixed full-viewport opacity:0 overlay — NOT `left: -100000px` or
// `z-index: -1`, both of which can cause some browsers to skip painting
// the descendants, producing blank captures.
function mountCaptureHost(): { host: HTMLElement; cleanup: () => void } {
  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position: fixed",
    "inset: 0",
    "background: transparent",
    "pointer-events: none",
    "z-index: 2147483646",
    "opacity: 0",
    "overflow: hidden",
  ].join(";");

  const host = document.createElement("div");
  host.style.cssText = [
    "position: absolute",
    "top: 0",
    "left: 0",
    `width: ${SLIDE_W}px`,
    `height: ${SLIDE_H}px`,
    "background: #070D1F",
    "transform-origin: top left",
    // No transform/scale — the host renders at its native 1920×1080 size
    // so the capture is crisp. The opacity:0 parent keeps it invisible.
  ].join(";");
  overlay.appendChild(host);
  document.body.appendChild(overlay);

  return {
    host,
    cleanup: () => overlay.remove(),
  };
}

// Make sure brand fonts are actually loaded before we start capturing, so
// text width/height is correct on the very first slide.
async function preloadFonts(): Promise<void> {
  if (!document.fonts) return;
  try {
    await Promise.all([
      document.fonts.load("600 144px Manrope"),
      document.fonts.load("500 42px Manrope"),
      document.fonts.load("400 26px Geist"),
      document.fonts.load("400 15px 'Geist Mono'"),
      document.fonts.ready,
    ]);
  } catch {
    // Best-effort — fallbacks are fine if a font fails to load.
  }
}

// Waits for React commit (2 RAFs), fonts, and any <img> tags inside the
// slide to load. Falls back after 2s in case an image hangs — partial
// capture is better than failing the whole export.
async function waitForRender(host: HTMLElement): Promise<void> {
  await new Promise<void>((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r())),
  );
  if (document.fonts && document.fonts.ready) {
    await document.fonts.ready;
  }
  const imgs = Array.from(host.querySelectorAll("img"));
  await Promise.race([
    Promise.all(
      imgs.map((img) =>
        img.complete && img.naturalWidth > 0
          ? Promise.resolve()
          : new Promise<void>((res) => {
              img.addEventListener("load", () => res(), { once: true });
              img.addEventListener("error", () => res(), { once: true });
            }),
      ),
    ),
    new Promise<void>((r) => setTimeout(r, 2000)),
  ]);
  // One more RAF after images load so the browser commits the final layout.
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
}
