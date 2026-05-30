import { useEffect, useRef, useState } from "react";
import { useDeck, useStageScale } from "./lib/useDeck";
import { SLIDES } from "./slides";

export default function App() {
  useStageScale();
  const total = SLIDES.length;
  const { index, setIndex, overview, setOverview } = useDeck(total);

  // PPTX export: shows progress in the button label so the user knows it's
  // working (each slide takes ~half a second to render + capture).
  const [pptxStatus, setPptxStatus] = useState<string | null>(null);
  async function handlePptxExport() {
    if (pptxStatus) return;
    setPptxStatus("…");
    try {
      // Lazy-loaded so pptxgenjs + modern-screenshot only ship when the
      // user actually clicks the export button.
      const { exportToPptx } = await import("./lib/exportPptx");
      await exportToPptx((cur, tot) => setPptxStatus(`${cur}/${tot}`));
    } catch (err) {
      console.error("PPTX export failed:", err);
      alert("PPTX export failed — check the console.");
    } finally {
      setPptxStatus(null);
    }
  }

  // Editable PPTX export (native text/shapes via dom-to-pptx). Separate
  // button so the reliable image export stays the default — this one trades
  // some visual fidelity (radial gradients) for editable text.
  const [pptxEditStatus, setPptxEditStatus] = useState<string | null>(null);
  async function handlePptxEditableExport() {
    if (pptxEditStatus) return;
    setPptxEditStatus("…");
    try {
      const { exportToPptxEditable } = await import("./lib/exportPptxEditable");
      await exportToPptxEditable();
    } catch (err) {
      console.error("Editable PPTX export failed:", err);
      alert("Editable PPTX export failed — check the console.");
    } finally {
      setPptxEditStatus(null);
    }
  }

  const current = SLIDES[index - 1];

  // Touch swipe nav: horizontal swipes move between slides on mobile /
  // tablet. 60px threshold avoids triggering on accidental scrolls.
  const touchRef = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchRef.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchRef.current;
    touchRef.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy)) return; // ignore vertical / tiny swipes
    if (dx < 0) setIndex((i) => Math.min(total, i + 1));
    else        setIndex((i) => Math.max(1, i - 1));
  };

  return (
    <>
      {/* ---- Screen view: only the active slide is shown, scaled to fit.
              The theme class on .deck-screen makes the letterbox bars
              (visible on non-16:9 viewports) match the active slide's
              bg color, so light slides don't get framed by dark bars. */}
      <div
        className={`deck-screen deck-screen-active deck-screen--${current.theme}`}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div className="deck-stage">
          {current.render({ number: index, total })}
        </div>
      </div>

      {/* ---- Print view: every slide rendered, one per page, full size. */}
      <div className="deck-print-stack">
        {SLIDES.map((s, i) => (
          <div key={s.id}>{s.render({ number: i + 1, total })}</div>
        ))}
      </div>

      {/* ---- Chrome: page number + controls (hidden in print). */}
      <div className="deck-chrome deck-chrome--br">
        {String(index).padStart(2, "0")} / {String(total).padStart(2, "0")}
      </div>
      <div className="deck-chrome deck-chrome--bl">
        <button onClick={() => setOverview((o) => !o)} title="Overview (o)">overview</button>
        <button onClick={() => window.print()} title="Print / Save as PDF (p)">pdf</button>
        <button onClick={handlePptxExport} disabled={!!pptxStatus} title="Export to PowerPoint — image slides, pixel-perfect (.pptx)">
          {pptxStatus ? `pptx ${pptxStatus}` : "pptx"}
        </button>
        <button onClick={handlePptxEditableExport} disabled={!!pptxEditStatus} title="Export to PowerPoint — editable text/shapes (.pptx)">
          {pptxEditStatus ? `pptx✎ ${pptxEditStatus}` : "pptx✎"}
        </button>
      </div>

      {/* ---- Overview mode: thumbnail grid. */}
      {overview && (
        <Overview
          activeIndex={index}
          onPick={(i) => {
            setIndex(i);
            setOverview(false);
          }}
        />
      )}
    </>
  );
}

/* ---- Overview grid ------------------------------------------- */
function Overview({
  activeIndex,
  onPick,
}: {
  activeIndex: number;
  onPick: (i: number) => void;
}) {
  return (
    <div className="deck-overview">
      <div style={{ marginBottom: 24, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ color: "#7C8BA3", fontSize: 12, letterSpacing: "0.22em", textTransform: "uppercase" }}>
          Overview · {SLIDES.length} slides · press O or Esc to exit
        </div>
        <div style={{ color: "#7C8BA3", fontSize: 12 }}>
          ← → space · home · end · o · p
        </div>
      </div>
      <div className="deck-overview-grid">
        {SLIDES.map((s, i) => (
          <Thumb
            key={s.id}
            number={i + 1}
            active={i + 1 === activeIndex}
            title={s.title}
            onClick={() => onPick(i + 1)}
          >
            {s.render({ number: i + 1, total: SLIDES.length })}
          </Thumb>
        ))}
      </div>
    </div>
  );
}

function Thumb({
  number,
  active,
  title,
  children,
  onClick,
}: {
  number: number;
  active: boolean;
  title: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  // Each thumbnail mounts a real 1920×1080 slide and scales it down to
  // fit the thumbnail tile. Keeps fidelity 1:1 with the live slide.
  // The tile's height is governed by CSS aspect-ratio (16/9), so we only
  // need to set the inner transform here — writing `tile.style.height`
  // triggers a feedback loop with the ResizeObserver and on a transient
  // zero-width frame the scale collapses to 0 ("zooms out to nothing").
  const innerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const tile = el.parentElement!;
    let lastScale = -1;
    const apply = () => {
      const w = tile.clientWidth;
      if (w <= 0) return; // ignore frames before layout settles
      const s = w / 1920;
      if (Math.abs(s - lastScale) < 0.0005) return; // idempotent: no-op writes
      lastScale = s;
      el.style.transform = `scale(${s})`;
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(tile);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      className={`deck-thumb ${active ? "deck-thumb--active" : ""}`}
      onClick={onClick}
      title={title}
    >
      <div ref={innerRef} className="deck-thumb-inner">{children}</div>
      <span className="deck-thumb-num">{String(number).padStart(2, "0")} · {title}</span>
    </div>
  );
}
