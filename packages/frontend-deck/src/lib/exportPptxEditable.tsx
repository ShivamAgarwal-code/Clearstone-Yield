import { createRoot } from "react-dom/client";
import { exportToPptx as domToPptx } from "dom-to-pptx";
import { SLIDES } from "../slides";

const SLIDE_W = 1920;
const SLIDE_H = 1080;

// Editable PPTX export via dom-to-pptx: it scrapes the computed geometry +
// styles of every node and emits NATIVE PowerPoint text boxes and shapes
// (not a flat image). Trade-offs vs the image export (exportPptx.tsx):
//   + Text is selectable/editable and keeps its font face (Manrope/Geist).
//   + SVG grids stay vector (svgAsVector) — "Convert to Shape" in PPT.
//   - radial-gradient backgrounds (title/closing soft mesh, logo halo)
//     don't map and are dropped/approximated.
//   - Fonts render correctly only if the opener has them installed. We
//     don't embed here because Google serves woff2, which dom-to-pptx's
//     embedder can't parse (needs ttf/otf/woff — a local-font follow-up).
export async function exportToPptxEditable(): Promise<void> {
  await preloadFonts();

  const { host, cleanup } = mountAllSlides();
  try {
    // Let React commit, fonts settle, and images load before measuring.
    await waitForRender(host);

    // dom-to-pptx scrapes the DOM as-is; these passes rewrite the few
    // constructs it can't translate (see each helper for the why).
    await prepareForExport(host);
    // One more frame so the table→image swaps re-layout before measuring.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    const slides = Array.from(host.querySelectorAll<HTMLElement>(".slide"));
    if (slides.length === 0) throw new Error("No .slide elements mounted");

    await domToPptx(slides, {
      fileName: "Clearstone-Fusion-Deck.pptx",
      layout: "LAYOUT_16x9",
      svgAsVector: true,
      // Skip auto-embed: our fonts come from Google as woff2 (unembeddable
      // by this lib). Text still carries the right font NAME, so it renders
      // correctly for anyone with Manrope/Geist installed.
      autoEmbedFonts: false,
    });
  } finally {
    cleanup();
  }
}

// Mounts every slide at native 1920×1080 into a single invisible overlay so
// dom-to-pptx can measure real layout. opacity:0 (not display:none, which
// would zero every getBoundingClientRect) and pointer-events:none keep it
// off the user's screen. Slides stack vertically; dom-to-pptx measures each
// child relative to its slide root, so the y-offset is irrelevant.
function mountAllSlides(): { host: HTMLElement; cleanup: () => void } {
  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position: fixed",
    "top: 0",
    "left: 0",
    `width: ${SLIDE_W}px`,
    "height: auto",
    "background: transparent",
    "pointer-events: none",
    "z-index: 2147483646",
    "opacity: 0",
    "overflow: hidden",
  ].join(";");
  document.body.appendChild(overlay);

  const host = document.createElement("div");
  overlay.appendChild(host);

  const root = createRoot(host);
  root.render(
    <>
      {SLIDES.map((s, i) => (
        // Force native 1920×1080 per slide regardless of viewport scale.
        <div key={s.id} style={{ width: SLIDE_W, height: SLIDE_H }}>
          {s.render({ number: i + 1, total: SLIDES.length })}
        </div>
      ))}
    </>,
  );

  return {
    host,
    cleanup: () => {
      root.unmount();
      overlay.remove();
    },
  };
}

// Three DOM rewrites that make the mounted (throwaway) slides survive
// dom-to-pptx's scraper. These mutate the export copy only — the live deck
// is a separate React tree and is never touched.
async function prepareForExport(host: HTMLElement): Promise<void> {
  nativizeBullets(host);
  await inlineImages(host);
  await rasterizeTables(host);
}

// dom-to-pptx serializes each <svg> (and embeds each <img>) but keeps any
// relative URL — which PowerPoint can't resolve, so logos render blank.
// Inlining every <img src> and SVG <image href> as a data-URI embeds the
// actual bytes so they survive serialization.
async function inlineImages(host: HTMLElement): Promise<void> {
  const XLINK = "http://www.w3.org/1999/xlink";

  const htmlImgs = Array.from(host.querySelectorAll("img"));
  const svgImgs = Array.from(host.querySelectorAll("image"));

  await Promise.all([
    ...htmlImgs.map(async (img) => {
      const src = img.getAttribute("src");
      if (!src || src.startsWith("data:")) return;
      const data = await urlToDataUri(src);
      if (data) img.setAttribute("src", data);
    }),
    ...svgImgs.map(async (im) => {
      const href =
        im.getAttribute("href") || im.getAttributeNS(XLINK, "href");
      if (!href || href.startsWith("data:")) return;
      const data = await urlToDataUri(href);
      if (!data) return;
      // Set both the SVG2 and the legacy xlink attribute: PowerPoint's SVG
      // renderer historically only honors xlink:href on <image>.
      im.setAttribute("href", data);
      im.setAttributeNS(XLINK, "xlink:href", data);
    }),
  ]);
}

async function urlToDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string | null>((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : null);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

// Our lists use `list-style:none` + an absolutely-positioned custom marker
// (a background-color dot, or a "›" glyph). dom-to-pptx reads list-style
// none → emits no bullet, and the absolute marker contributes no text run,
// so the items render as flat unindented lines. We swap each custom marker
// for an inline colored bullet glyph that the scraper captures as text.
function nativizeBullets(host: HTMLElement): void {
  const lists = Array.from(host.querySelectorAll("ul"));
  for (const ul of lists) {
    const lis = Array.from(ul.children).filter(
      (c): c is HTMLElement => c.tagName === "LI",
    );
    for (const li of lis) {
      // The marker is the li's absolutely-positioned direct child element.
      const marker = Array.from(li.children).find(
        (c): c is HTMLElement =>
          c instanceof HTMLElement &&
          getComputedStyle(c).position === "absolute",
      );
      if (!marker) continue;

      const ms = getComputedStyle(marker);
      const glyphText = (marker.textContent || "").trim();
      // Text marker (e.g. "›") keeps its glyph + text color; a bare dot
      // (no text, colored via background) becomes a "•" in that color.
      const glyph = glyphText || "•";
      const color = glyphText ? ms.color : ms.backgroundColor;

      marker.remove();

      const inlineBullet = document.createElement("span");
      // Gap glyph<->text. dom-to-pptx collapses whitespace runs (/\s{2,}/)
      // and trims trailing whitespace, so plain spaces vanish. Non-breaking
      // spaces fenced by zero-width spaces survive: the ZWSP breaks the
      // collapse run, and a trailing ZWSP (non-whitespace) blocks the trim.
      inlineBullet.textContent = glyph + "\u00A0\u200B\u00A0\u200B";
      inlineBullet.style.color = color;
      inlineBullet.style.fontWeight = ms.fontWeight || "400";
      li.insertBefore(inlineBullet, li.firstChild);

      // The custom marker lived in the li's left padding; with an inline
      // bullet that padding would now double-indent the text.
      li.style.paddingLeft = "0";
    }
  }
}

// dom-to-pptx renders a <table>'s header row but drops body rows whose
// cells contain nested blocks (two-line cells, verdict chips). Rather than
// degrade those cells to flat text, snapshot the whole table to a crisp
// transparent PNG and drop it in place — fidelity stays 1:1, only the table
// loses editability (acceptable for a dense reference grid).
async function rasterizeTables(host: HTMLElement): Promise<void> {
  const tables = Array.from(host.querySelectorAll("table"));
  if (tables.length === 0) return;

  const { domToPng } = await import("modern-screenshot");
  for (const table of tables) {
    const rect = table.getBoundingClientRect();
    const w = Math.ceil(rect.width);
    const h = Math.ceil(rect.height);
    if (w === 0 || h === 0) continue;

    const dataUrl = await domToPng(table, { width: w, height: h, scale: 2 });

    const img = document.createElement("img");
    img.src = dataUrl;
    img.style.width = `${w}px`;
    img.style.height = `${h}px`;
    img.style.display = "block";
    table.replaceWith(img);
  }
}

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

// Waits for React commit (2 RAFs), fonts, and any <img> tags to load.
// Falls back after 2s so a hung image can't block the whole export.
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
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
}
