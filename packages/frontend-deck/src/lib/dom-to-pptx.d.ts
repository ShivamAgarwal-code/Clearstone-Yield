// dom-to-pptx ships no type definitions. This declares the single function
// we use. See https://www.npmjs.com/package/dom-to-pptx for the full API.
declare module "dom-to-pptx" {
  export interface DomToPptxFont {
    name: string;
    url: string;
  }

  export interface DomToPptxOptions {
    fileName?: string;
    /** Prevents the browser auto-download; resolve the Blob instead. */
    skipDownload?: boolean;
    /** Auto-detect + embed web fonts. Needs CORS-clean font files. */
    autoEmbedFonts?: boolean;
    /** Explicit font files to embed: { name, url }. Must be ttf/otf/woff
     *  (NOT woff2 — the embedder can't parse woff2). */
    fonts?: DomToPptxFont[];
    /** Keep SVG elements as editable vectors instead of rasterizing. */
    svgAsVector?: boolean;
    /** e.g. "LAYOUT_16x9" (default), "LAYOUT_WIDE", "LAYOUT_4x3". */
    layout?: string;
    /** Custom slide size in inches (both required together). */
    width?: number;
    height?: number;
    listConfig?: {
      color?: string;
      spacing?: { before?: number; after?: number };
    };
  }

  export function exportToPptx(
    target: HTMLElement | string | Array<HTMLElement | string>,
    options?: DomToPptxOptions,
  ): Promise<Blob>;
}
