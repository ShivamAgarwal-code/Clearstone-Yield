import type { ReactNode } from "react";
import { Slide, Eyebrow } from "../lib/Slide";

const logo = "/logo.svg";

/* ---- Title slide --------------------------------------------- */
function TitleSlide() {
  return (
    <Slide theme="light">
      {/* Soft mesh gradient - gives the page subtle depth without
          competing with the logo. Two off-axis radial blobs layered
          on top of the slide's base linear gradient. */}
      <div style={{
        position: "absolute",
        inset: 0,
        background: `
          radial-gradient(50% 40% at 28% 26%, rgba(166,179,197,0.28) 0%, transparent 72%),
          radial-gradient(45% 35% at 78% 72%, rgba(31,45,72,0.10) 0%, transparent 72%)
        `,
        pointerEvents: "none",
      }} />

      {/* Faint vector grid - barely there, adds a sense of structure. */}
      <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.05, pointerEvents: "none" }}>
        <defs>
          <pattern id="title-grid" width="64" height="64" patternUnits="userSpaceOnUse">
            <path d="M 64 0 L 0 0 0 64" fill="none" stroke="#1F2D48" strokeWidth="0.6" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#title-grid)" />
      </svg>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center", position: "relative", zIndex: 1 }}>
        {/* Logo with a soft cool halo behind it for visual emphasis. */}
        <div style={{ position: "relative", marginBottom: 48 }}>
          <div style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            width: 480,
            height: 480,
            transform: "translate(-50%, -50%)",
            borderRadius: "50%",
            background: "radial-gradient(50% 50% at 50% 50%, rgba(166,179,197,0.42) 0%, rgba(166,179,197,0.14) 38%, transparent 72%)",
            pointerEvents: "none",
          }} />
          <img src={logo} alt="" style={{ height: 260, width: "auto", position: "relative", display: "block" }} />
        </div>

        {/* Wordmark - slightly tighter letter spacing for a sharper crown. */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 24, marginBottom: 28 }}>
          <span className="brand-wordmark" style={{ fontFamily: "var(--font-display, Manrope)", fontSize: 144, color: "#1F2D48", letterSpacing: "-0.025em", fontWeight: 600, lineHeight: 1 }}>
            clearstone
          </span>
          <span className="brand-wordmark-thin" style={{ fontFamily: "var(--font-display, Manrope)", fontSize: 64, color: "#7C8BA3", fontWeight: 200, letterSpacing: "-0.005em", lineHeight: 1 }}>
            fusion
          </span>
        </div>

        {/* Thin gradient divider - anchors the wordmark above and the
            tagline below into a single composition. */}
        <div style={{ width: 96, height: 1, background: "linear-gradient(90deg, transparent, rgba(31,45,72,0.4), transparent)", marginBottom: 32 }} />

        {/* Tagline - punchy short form. */}
        <p style={{ fontSize: 42, color: "#1F2D48", fontWeight: 500, maxWidth: 1400, lineHeight: 1.18, margin: 0, letterSpacing: "-0.008em" }}>
          Institutional DeFi infrastructure.
        </p>

        {/* Subtitle - descriptive, smaller, secondary. */}
        <p style={{ fontSize: 26, color: "#4F607C", maxWidth: 1100, lineHeight: 1.45, marginTop: 18 }}>
          Software, programs, and rails for banks, fintechs, and asset managers - running on permissionless liquidity.
        </p>

        {/* Metadata strip - three small mono chips for visual rhythm. */}
        <div style={{ display: "flex", gap: 14, marginTop: 56 }}>
          {["Solana-native", "Audit-first", "White-label"].map((t) => (
            <span key={t} style={{
              fontFamily: "var(--font-mono, 'Geist Mono', ui-monospace, monospace)",
              fontSize: 15,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: "#4F607C",
              padding: "9px 20px",
              border: "1px solid rgba(31,45,72,0.18)",
              borderRadius: 999,
              background: "rgba(255,255,255,0.45)",
            }}>{t}</span>
          ))}
        </div>
      </div>
    </Slide>
  );
}

/* ---- Problem -------------------------------------------------- */
function ProblemSlide() {
  // Two emphasis tones: white-bold for load-bearing nouns, amber-bold
  // for the alarm phrase naming the structural failure. Declared above
  // the incidents array so the summaries below can use <Alert> on the
  // dollar figures.
  const Key   = ({ children }: { children: React.ReactNode }) => (
    <span style={{ color: "#F4F6FB", fontWeight: 600 }}>{children}</span>
  );
  const Alert = ({ children }: { children: React.ReactNode }) => (
    <span style={{ color: "#C9A766", fontWeight: 600 }}>{children}</span>
  );

  // Two real incidents, two distinct audiences. Aave/rsETH shows the
  // failure mode for retail depositors; Stream Finance shows it for
  // protocols and credit traders (xUSD held as collateral on Compound,
  // Euler, Morpho, cascading $283M of borrowings into bad debt).
  // Together they argue the structural risk hits both ends.
  const incidents = [
    {
      tag:       "RETAIL · APR 2026 · AAVE",
      title:     "Stolen rsETH",
      summary:   <>Attacker supplied <Alert>$221M</Alert> of stolen rsETH on Aave and borrowed <Alert>~$190M</Alert> of ETH against it. Retail depositors left holding collateral that may be frozen or clawed back.</>,
      cite:      "governance.aave.com",
      href:      "https://governance.aave.com/t/rseth-incident-report-april-20-2026/24580",
      image:     "/images/rseth-aave.svg",
      imageW:    182,
      imageTop:  -16,
    },
    {
      tag:       "PROTOCOLS · NOV 2025 · STREAM FINANCE",
      title:     "xUSD contagion",
      summary:   <>Stream Finance lost <Alert>$93M</Alert> of user funds. Its xUSD synthetic dollar sat as collateral on Compound, Euler, Morpho - <Alert>$283M</Alert> cascaded into bad debt for protocols and credit traders.</>,
      cite:      "yahoo / stream-finance",
      href:      "https://finance.yahoo.com/news/stream-finance-debacle-affected-rest-173634768.html",
      image:     "/images/stream-finance.svg",
    },
  ] as { tag: string; title: string; summary: ReactNode; cite: string; href: string; image?: string; imageW?: number; imageTop?: number }[];
  return (
    <Slide theme="rise" grid>
      <Eyebrow>The problem</Eyebrow>
      <h1 style={{ maxWidth: 1500, marginBottom: 32, fontSize: 88, lineHeight: 1.06 }}>
        Bad collateral cascades.<br />From retail to risk managers.
      </h1>
      <p className="lead" style={{ maxWidth: 1500, color: "#A6B3C5", marginBottom: 44, fontSize: 32 }}>
        Same structural failure, two audiences. <Key>Retail bag-holders</Key> on
        one side. <Key>Protocol-level contagion</Key> on the other. Permissionless
        lending has <Alert>no path to recovery</Alert> - and no way to refuse
        what comes in.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28, marginBottom: 24 }}>
        {incidents.map((it) => (
          <div key={it.tag} className="deck-card" style={{ display: "flex", flexDirection: "column", borderColor: "rgba(201,167,102,0.45)", position: "relative", overflow: "hidden" }}>
            {it.image && (
              <img src={it.image} alt="" aria-hidden="true"
                   style={{
                     position: "absolute",
                     right: 18,
                     top: it.imageTop ?? 14,
                     width: it.imageW ?? 180,
                     height: "auto",
                     pointerEvents: "none",
                   }} />
            )}
            <div style={{ fontFamily: "var(--font-mono, 'Geist Mono', monospace)", fontSize: 18, color: "#C9A766", letterSpacing: "0.22em", marginBottom: 14 }}>
              {it.tag}
            </div>
            <div style={{ fontFamily: "var(--font-display, Manrope)", fontSize: 36, fontWeight: 600, color: "#F4F6FB", marginBottom: 14 }}>
              {it.title}
            </div>
            <p style={{ fontSize: 22, color: "#A6B3C5", lineHeight: 1.45, marginBottom: 24, flex: 1 }}>
              {it.summary}
            </p>
            <a href={it.href} target="_blank" rel="noopener noreferrer"
               style={{ fontFamily: "var(--font-mono, 'Geist Mono', monospace)", fontSize: 16, color: "#7C8BA3", letterSpacing: "0.14em", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 8, alignSelf: "flex-start" }}>
              <span style={{ borderBottom: "1px solid rgba(124,139,163,0.45)", paddingBottom: 2 }}>{it.cite}</span>
              <span>↗</span>
            </a>
          </div>
        ))}
      </div>
    </Slide>
  );
}

/* ---- Three surfaces ------------------------------------------ */
function SurfacesSlide() {
  // Light-bg variants of the deck's emphasis tones. Key = dark navy
  // bold for load-bearing facts; Highlight = deep teal for outlook /
  // differentiator claims (the same tonal pair as Solution, just
  // re-tuned for legibility on the soft white background).
  const Key = ({ children }: { children: ReactNode }) => (
    <span style={{ color: "#1F2D48", fontWeight: 600 }}>{children}</span>
  );
  const Highlight = ({ children }: { children: ReactNode }) => (
    <span style={{ color: "#2B6F7B", fontWeight: 600 }}>{children}</span>
  );
  const items: { tag: string; title: string; body: ReactNode; host: string; shot: string }[] = [
    {
      tag: "white-label · savings",
      title: "Retail savings",
      body: (
        <>
          <Key>USDC</Key> and <Key>SOL</Key> savings on <Key>Kamino</Key>. KYC-gated. Your brand.
        </>
      ),
      host: "retail.clearstone.ai",
      shot: "/screenshots/retail.png",
    },
    {
      tag: "B2B · trading",
      title: "Trading desks",
      body: (
        <>
          <Key>Credit trades</Key> and <Key>leveraged (re-)staking</Key> via <Key>Jito</Key>. KYB-gated. Audit trail.
        </>
      ),
      host: "institutional.clearstone.ai",
      shot: "/screenshots/institutional.png",
    },
    {
      tag: "internal · ops",
      title: "Operator console",
      body: (
        <>
          <Key>Reserve config</Key>, vaults, oracles, keepers. Your ops team's <Highlight>cockpit</Highlight>.
        </>
      ),
      host: "console.clearstone.ai",
      shot: "/screenshots/console.png",
    },
  ];
  return (
    <Slide theme="soft">
      <Eyebrow>Product portfolio</Eyebrow>
      <h1 style={{ maxWidth: 1500, marginBottom: 14, fontSize: 88, lineHeight: 1.06 }}>
        Three white-label products.
      </h1>
      <p style={{ maxWidth: 1500, marginBottom: 28, fontSize: 28, color: "#4F607C", lineHeight: 1.35, fontWeight: 300 }}>
        Providing <span style={{ color: "#1F2D48", fontWeight: 500 }}>institutional access</span> to on-chain infrastructure.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24, marginTop: 32 }}>
        {items.map((it) => (
          <div key={it.tag} className="deck-card--light" style={{ display: "flex", flexDirection: "column", padding: 0, overflow: "hidden" }}>
            {/* Screenshot at top, edge-to-edge. 16/9 aspect with
                objectPosition top shows the hero/nav region of each app
                (sources are roughly 4:3 so the bottom ~30% is cropped).
                Subtle gradient is the fallback if the image is missing. */}
            <div style={{ aspectRatio: "16/9", width: "100%", background: "linear-gradient(135deg, #EEF1F5 0%, #DCE2EC 100%)", borderBottom: "1px solid #DCE2EC", overflow: "hidden" }}>
              <img
                src={it.shot}
                alt={`${it.title} UI`}
                style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top left", display: "block" }}
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              />
            </div>
            <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", flex: 1 }}>
            <span style={{ textTransform: "uppercase", letterSpacing: "0.22em", fontSize: 16, color: "#7C8BA3", fontWeight: 600, marginBottom: 16 }}>
              {it.tag}
            </span>
            <h3 style={{ marginBottom: 16, color: "#1F2D48" }}>{it.title}</h3>
            <p style={{ fontSize: 22, color: "#4F607C", lineHeight: 1.5, marginBottom: 24 }}>{it.body}</p>
            <div style={{ marginTop: "auto", paddingTop: 16, borderTop: "1px solid rgba(31,45,72,0.12)", fontFamily: "var(--font-mono, Geist Mono, monospace)", fontSize: 16 }}>
              <a href={`https://${it.host}`} target="_blank" rel="noopener noreferrer"
                 style={{ color: "#2B6F7B", letterSpacing: "0.04em", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
                {it.host}
                <span aria-hidden="true">↗</span>
              </a>
            </div>
            </div>
          </div>
        ))}
      </div>
    </Slide>
  );
}

/* ---- Architecture diagram ------------------------------------ */

// Inline 22×22 line icons for the Products row. Stroke-based so they
// render crisply at any scale and embed cleanly into PDF export.
const ProductIcons = {
  savings: ( // vault: rectangle with combination dial
    <g fill="none" stroke="#F4F6FB" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <rect x={2} y={3} width={18} height={14} rx={1.5} />
      <circle cx={13} cy={10} r={3} />
      <line x1={13} y1={10} x2={13} y2={7.2} />
      <line x1={4}  y1={17} x2={4}  y2={19.5} />
      <line x1={18} y1={17} x2={18} y2={19.5} />
    </g>
  ),
  trading: ( // ascending bars
    <g fill="none" stroke="#F4F6FB" strokeWidth={2} strokeLinecap="round">
      <line x1={5}  y1={18} x2={5}  y2={13} />
      <line x1={11} y1={18} x2={11} y2={9}  />
      <line x1={17} y1={18} x2={17} y2={5}  />
      <line x1={3}  y1={20} x2={19} y2={20} strokeWidth={1} />
    </g>
  ),
  console: ( // monitor with prompt cursor
    <g fill="none" stroke="#F4F6FB" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <rect x={2} y={3} width={18} height={13} rx={1.5} />
      <polyline points="6,8 9,11 6,14" />
      <line x1={11} y1={14} x2={15} y2={14} />
      <line x1={8}  y1={19} x2={14} y2={19} />
    </g>
  ),
};

function ArchitectureSlide() {
  // Three top-row surfaces each get a distinct accent (amber / teal /
  // indigo) so they read as different products. Every gradient bottoms
  // out at the same #1F2D48 navy so the rows still feel unified.
  const surfaces: { x: number; label: string; grad: string; accent: string; icon: ReactNode; pill?: string }[] = [
    { x: 80,  label: "Savings app",  grad: "diag-amber",  accent: "#C9A766", icon: ProductIcons.savings, pill: "KYC" },
    { x: 380, label: "Trading desk", grad: "diag-teal",   accent: "#6BB0BA", icon: ProductIcons.trading, pill: "KYB" },
    { x: 680, label: "Ops console",  grad: "diag-indigo", accent: "#8C7FBE", icon: ProductIcons.console },
  ];
  // Row labels: monospace number + tracked-out caps, all in the same
  // cool-stone tone. Numbers carry the ordering (top-down stack); the
  // categorical color story already lives in the boxes themselves, so
  // the labels stay neutral.
  const rowLabels = [
    { y: 14,  num: "01", label: "PRODUCTS"       },
    { y: 152, num: "02", label: "PLATFORM"       },
    { y: 292, num: "03", label: "INFRASTRUCTURE" },
  ];
  return (
    <Slide theme="fade">
      <Eyebrow>What we provide</Eyebrow>
      <h1 style={{ maxWidth: 1500, marginBottom: 18, fontSize: 84, lineHeight: 1.06 }}>
        Infrastructure, not an app.
      </h1>
      <p style={{ maxWidth: 1500, marginBottom: 36, fontSize: 32, color: "#A6B3C5", lineHeight: 1.35, fontWeight: 300 }}>
        Institutions plug in their{" "}
        <span style={{ color: "#F4F6FB", fontWeight: 500 }}>existing KYC</span>{" "}
        and <span style={{ color: "#6BB0BA", fontWeight: 500 }}>orchestrate</span> DeFi infrastructure -{" "}
        <span style={{ color: "#6BB0BA", fontWeight: 500 }}>all on-chain</span>.
      </p>

      {/* minHeight:0 lets the flex child shrink so the SVG never pushes
          past the slide footer. maxHeight on the SVG caps it explicitly. */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0 }}>
        <svg
          viewBox="0 0 900 380"
          preserveAspectRatio="xMidYMid meet"
          style={{ width: "100%", maxWidth: 1500, maxHeight: 600, height: "auto", display: "block" }}
        >
          <defs>
            {/* Box gradients - each row has its own accent at the top,
                all share the same navy floor for cohesion. */}
            <linearGradient id="diag-amber"  x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%"  stopColor="#C9A766" />
              <stop offset="100%" stopColor="#1F2D48" />
            </linearGradient>
            <linearGradient id="diag-teal"   x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%"  stopColor="#6BB0BA" />
              <stop offset="100%" stopColor="#1F2D48" />
            </linearGradient>
            <linearGradient id="diag-indigo" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%"  stopColor="#8C7FBE" />
              <stop offset="100%" stopColor="#1F2D48" />
            </linearGradient>
            <linearGradient id="diag-stone"  x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%"  stopColor="#7990AE" />
              <stop offset="100%" stopColor="#1F2D48" />
            </linearGradient>
            {/* Infrastructure row - darker and slightly cooler than the
                platform row's stone gradient so the foundation visually
                recedes (and the platform reads as the protagonist). */}
            <linearGradient id="diag-under"  x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%"  stopColor="#2C3845" />
              <stop offset="100%" stopColor="#0E1822" />
            </linearGradient>

            {/* Drop shadow gives boxes depth - printed PDFs preserve it. */}
            <filter id="boxShadow" x="-20%" y="-50%" width="140%" height="200%">
              <feDropShadow dx="0" dy="6" stdDeviation="9" floodColor="#000814" floodOpacity={0.55} />
            </filter>
            {/* Arrowhead used by the governance spine. */}
            <marker id="gov-cap" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#C5CFDC" />
            </marker>
            {/* Arrowhead used by the products-row connectors. fill =
                context-stroke so each arrow inherits its line's accent
                color (amber / teal) without duplicating marker defs. */}
            <marker id="surface-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="4" markerHeight="4" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
          </defs>

          {/* Row labels - mono number + tracked-out caps, neutral tone. */}
          {rowLabels.map((l) => (
            <g key={l.label}>
              <text x={20} y={l.y} fill="#8895AC" fontFamily="Geist Mono, ui-monospace, monospace" fontSize={11} fontWeight={600} letterSpacing={0.5}>
                {l.num}
              </text>
              <text x={48} y={l.y} fill="#D4DDE8" fontFamily="Geist, sans-serif" fontSize={11} letterSpacing={2.5} fontWeight={500}>
                {l.label}
              </text>
            </g>
          ))}

          {/* Top row - three surfaces. Each box has a top-left circular
              badge holding its line icon, with the label centered below.
              The badge carries the categorical accent (amber/teal/indigo)
              so the previous separate top-edge strip is no longer needed. */}
          {surfaces.map((s) => (
            <g key={s.label}>
              <rect x={s.x} y={20} width={140} height={70} rx={16}
                    fill={`url(#${s.grad})`} stroke={s.accent} strokeOpacity={0.6} strokeWidth={1.4}
                    filter="url(#boxShadow)" />
              {/* Icon horizontally centered above the label, no chrome.
                  The 22-wide icon centers at box midpoint x=s.x+70, so
                  translate by 70 - 11. */}
              <g transform={`translate(${s.x + 59}, 28)`}>{s.icon}</g>
              <text x={s.x + 70} y={72} textAnchor="middle"
                    fill="#F4F6FB" fontFamily="Manrope, sans-serif" fontWeight={600} fontSize={15}>
                {s.label}
              </text>
            </g>
          ))}

          {/* Connectors middle → top. Drawn bottom-to-top so the
              markerEnd arrow lands ON the product (showing governance
              flowing UP through the KYC/KYB pill into the surface).
              Surfaces without a compliance gate (Ops console) keep a
              plain dashed connector - no arrow. */}
          {surfaces.map((s) => (
            <line key={s.label}
                  x1={s.x + 70} y1={160} x2={s.x + 70} y2={90}
                  stroke={s.accent} strokeWidth={2.2} strokeLinecap="round"
                  strokeDasharray="3 6" opacity={0.75}
                  markerEnd={s.pill ? "url(#surface-arrow)" : undefined} />
          ))}

          {/* Compliance pills sitting on the connector lines - KYC for
              the retail savings app, KYB for the institutional trading
              desk. The opaque dark fill visually breaks the dashed
              connector at the gate, so the pill reads as the gate
              the connection passes through. */}
          {surfaces.map((s) => s.pill && (
            <g key={`pill-${s.label}`}>
              <rect x={s.x + 45} y={114} width={50} height={22} rx={11}
                    fill="#070D1F"
                    stroke={s.accent} strokeOpacity={0.9} strokeWidth={1.3} />
              <text x={s.x + 70} y={130} textAnchor="middle"
                    fill={s.accent}
                    fontFamily="Geist Mono, ui-monospace, monospace"
                    fontSize={12} letterSpacing={1.5} fontWeight={600}>
                {s.pill}
              </text>
            </g>
          ))}

          {/* Middle row - Clearstone Fusion (the protagonist). The brand
              mark sits on the left and replaces the redundant
              "Clearstone Fusion ·" text prefix. No top accent strip on
              this row - it had no categorical role and read as orphan. */}
          <rect x={80} y={160} width={740} height={70} rx={16}
                fill="url(#diag-stone)" stroke="#C5CFDC" strokeOpacity={0.55} strokeWidth={1.6}
                filter="url(#boxShadow)" />
          {/* Brand banner - Clearstone mark + "clearstone / fusion"
              wordmark stacked on two lines next to the logo. Narrower
              footprint than the inline single-line version so the
              tech-stack text can stay centered in the row. Same typography
              pattern as the slide footer's .brand class: identical font/
              weight for both words, "fusion" differentiated by opacity. */}
          <image href="/logo.svg" x={104} y={178} width={34} height={34} preserveAspectRatio="xMidYMid meet" />
          <text x={146} y={195} fontFamily="Manrope, sans-serif" fontSize={18} fontWeight={500} letterSpacing={-0.18} fill="#F4F6FB">
            clearstone
          </text>
          <text x={146} y={210} fontFamily="Manrope, sans-serif" fontSize={14} fontWeight={500} letterSpacing={-0.14} fill="#F4F6FB" opacity={0.55}>
            fusion
          </text>
          {/* Centered in the available space after the banner:
              (banner_end + rect_right) / 2 = (238 + 820) / 2 = 529.
              Centering at the rect's true center (450) would overlap
              the banner; this gives equal margins on both sides. */}
          <text x={529} y={204} textAnchor="middle"
                fill="#F4F6FB" fontFamily="Geist, sans-serif" fontWeight={500} fontSize={18}>
            SDK · Programs · Trading Terminals · Console
          </text>

          <line x1={450} y1={230} x2={450} y2={300}
                stroke="#A6B3C5" strokeWidth={2.2} strokeLinecap="round"
                strokeDasharray="3 6" opacity={0.55} />

          {/* Infrastructure row - three real brand logos. Same rationale
              as the platform row: no decorative top strip. */}
          <rect x={140} y={300} width={620} height={70} rx={16}
                fill="url(#diag-under)" stroke="#3D4C5A" strokeOpacity={0.55} strokeWidth={1.4}
                filter="url(#boxShadow)" />

          {/* Three real brand assets - Solana (square mark, PNG from
              cryptologos), Kamino (white wordmark), Jito (white wordmark
              fetched from web.archive.org since the live host is
              CF-gated). All bundled in /public/logos so they ship with
              the build and embed in PDF export. */}
          <image href="/logos/solana.png" x={269} y={317} width={36} height={36} preserveAspectRatio="xMidYMid meet" />
          <image href="/logos/kamino.svg" x={365} y={320} width={130} height={30} preserveAspectRatio="xMidYMid meet" />
          <image href="/logos/jito.svg"   x={555} y={320} width={75}  height={30} preserveAspectRatio="xMidYMid meet" />

          {/* Governance spine - Clearstone's stack adds KYC / policy /
              timelocks ON TOP OF the permissionless rails. The vertical
              track shows governance touching all three layers; the
              bright platform tick marks its origin; the bottom tick
              points LEFT into the infrastructure row, indicating
              governance imposed on the otherwise permissionless rails. */}
          <g opacity={0.9}>
            {/* Vertical track - endpoints align exactly with the top
                and bottom ticks so there's no stray stub above or
                below. Solid line (the cross-row connectors between
                products / platform / infrastructure stay dashed; only
                the governance spine is solid so it reads as a unified
                policy rail rather than another data flow). */}
            <line x1={862} y1={55} x2={862} y2={335}
                  stroke="#C5CFDC" strokeOpacity={0.6} strokeWidth={1.4} />
            {/* Three ticks in identical style; the bottom one adds the
                arrow head to mark "governance imposed on the otherwise
                permissionless infrastructure row." */}
            <line x1={820} y1={55}  x2={862} y2={55}
                  stroke="#C5CFDC" strokeOpacity={0.65} strokeWidth={1.4} />
            <line x1={820} y1={195} x2={862} y2={195}
                  stroke="#C5CFDC" strokeOpacity={0.65} strokeWidth={1.4} />
            <line x1={862} y1={335} x2={770} y2={335}
                  stroke="#C5CFDC" strokeOpacity={0.65} strokeWidth={1.4}
                  markerEnd="url(#gov-cap)" />
            {/* Vertical pill on the spine - sibling to the KYC/KYB
                pills on the product connectors. Opaque dark fill so the
                spine line reads as "passing through" the gate. Text
                rotates -90 to read bottom-up. */}
            <rect x={849} y={140} width={26} height={110} rx={13}
                  fill="#070D1F"
                  stroke="#C5CFDC" strokeOpacity={0.9} strokeWidth={1.3} />
            <text x={862} y={199}
                  transform="rotate(-90, 862, 195)"
                  fill="#C5CFDC"
                  fontFamily="Geist Mono, ui-monospace, monospace"
                  fontSize={12}
                  letterSpacing={1.5}
                  fontWeight={600}
                  textAnchor="middle">
              GOVERNANCE
            </text>
          </g>
        </svg>
      </div>
    </Slide>
  );
}


/* ---- Commercial thesis -------------------------------------- */
function ThesisSlide() {
  // Same emphasis tones as the dark slides: white-bold for load-bearing
  // facts, teal for the differentiator/outlook claims, amber for alarm
  // numbers (used on the buy-vs-build card to underline the cost of
  // attempting to build in-house).
  const Key = ({ children }: { children: ReactNode }) => (
    <span style={{ color: "#F4F6FB", fontWeight: 600 }}>{children}</span>
  );
  const Highlight = ({ children }: { children: ReactNode }) => (
    <span style={{ color: "#6BB0BA", fontWeight: 600 }}>{children}</span>
  );
  const Alert = ({ children }: { children: ReactNode }) => (
    <span style={{ color: "#C9A766", fontWeight: 600 }}>{children}</span>
  );

  // Three load-bearing claims, each with a single killer stat sized big
  // enough to land from across the room, plus three short bullets that
  // a reader can skim in a glance. Source links collapse to a small mono
  // cite at the bottom of each card so the slide doesn't collapse into a
  // wall of citations.
  const pillars: {
    num: string;
    tag: string;
    headline: ReactNode;
    stat: ReactNode;
    /** Optional font-size override for the killer stat. Defaults to 84;
     *  used to fit longer text-based stats (e.g. "Top project") on a
     *  single line without overflowing the card width. */
    statSize?: number;
    statLabel: string;
    bullets: ReactNode[];
    cite: string;
    href: string;
    accent: string;
  }[] = [
    {
      num: "01",
      tag: "WHY VENDORS WIN",
      headline: <>Banks <Key>buy</Key>. They don&apos;t build.</>,
      stat: <>80<span style={{ fontSize: "0.55em", verticalAlign: "0.18em" }}>+</span></>,
      statLabel: "banks on Fireblocks · BNY, BNP, HSBC",
      bullets: [
        <>Build graveyard: <Key>NAB AUDN shut</Key>, Wells Fargo shelved, Diem sold for parts</>,
        <>DeFi lost <Alert>$3.1B</Alert> to exploits in H1 2025</>,
        <>Vendor playbook dominant: <Highlight>custody, compliance, tokenization</Highlight></>,
      ],
      cite: "fireblocks · halborn · pymnts",
      href: "https://www.halborn.com/reports/top-100-defi-hacks-2025",
      accent: "#C9A766",
    },
    {
      num: "02",
      tag: "RETAIL TAM · EU FIRST",
      headline: <>The retail TAM is the <Highlight>already-KYC&apos;d saver</Highlight>.</>,
      stat: <>30</>,
      statLabel: "EU/EEA markets · single MiCA passport",
      bullets: [
        <>~<Key>95%</Key> banked · <Key>~€2T</Key> in EU MMFs chasing yield · KYC in <Key>22s</Key></>,
        <><Alert>EU crypto illegal without MiCAR after Jul 2026</Alert> - banks need the stack now</>,
        <>Next €1T migrates via <Highlight>MiCA-compliant savings products</Highlight>, not seed phrases</>,
      ],
      cite: "esma · efama · sumsub",
      href: "https://www.esma.europa.eu/policy-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica",
      accent: "#8C7FBE",
    },
  ];

  return (
    <Slide theme="fade">
      <Eyebrow>Commercial thesis</Eyebrow>
      <h1 style={{ maxWidth: 1500, marginBottom: 18, fontSize: 84, lineHeight: 1.06 }}>
        Built for buyers<br />who already write cheques.
      </h1>
      <p style={{ maxWidth: 1500, marginBottom: 36, fontSize: 30, color: "#A6B3C5", lineHeight: 1.35, fontWeight: 300 }}>
        Why <span style={{ color: "#F4F6FB", fontWeight: 500 }}>now</span>, why{" "}
        <span style={{ color: "#6BB0BA", fontWeight: 500 }}>this stack</span>,
        and who actually <span style={{ color: "#F4F6FB", fontWeight: 500 }}>moves first</span>.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28, flex: 1, alignContent: "stretch" }}>
        {pillars.map((p) => (
          <div
            key={p.num}
            className="deck-card"
            style={{
              display: "flex",
              flexDirection: "column",
              padding: "32px 32px 26px",
              borderColor: `${p.accent}55`,
              position: "relative",
              overflow: "hidden",
            }}
          >
            {/* Numbered + tagged header strip - same monospace tracking
                as the architecture slide's row labels so the slides feel
                like part of the same vocabulary. */}
            <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 22 }}>
              <span style={{
                fontFamily: "var(--font-mono, 'Geist Mono', monospace)",
                fontSize: 16,
                fontWeight: 600,
                color: p.accent,
                letterSpacing: "0.06em",
              }}>
                {p.num}
              </span>
              <span style={{
                fontFamily: "var(--font-mono, 'Geist Mono', monospace)",
                fontSize: 13,
                color: "#7C8BA3",
                letterSpacing: "0.22em",
                fontWeight: 600,
              }}>
                {p.tag}
              </span>
            </div>

            {/* Headline - short, declarative, with inline emphasis on
                the load-bearing word so the claim reads at a glance.
                minHeight pins this block to two lines of body text so
                the killer stat below it lands at the same y across all
                three cards regardless of headline length. */}
            <div style={{
              fontFamily: "var(--font-display, Manrope)",
              fontSize: 30,
              fontWeight: 600,
              color: "#F4F6FB",
              lineHeight: 1.18,
              minHeight: "2.36em",
              marginBottom: 22,
              letterSpacing: "-0.012em",
            }}>
              {p.headline}
            </div>

            {/* Killer stat - sized to be the visual anchor of the card.
                Tabular nums so numeric stats align cleanly across columns.
                The stat container has a fixed 84px height so cards using
                a smaller statSize (text-based stats like "Top project")
                still bottom-align with the others, keeping statLabel
                and body paragraphs on the same baseline. */}
            <div style={{ marginBottom: 14 }}>
              <div style={{
                fontFamily: "var(--font-display, Manrope)",
                fontSize: p.statSize ?? 84,
                fontWeight: 600,
                color: p.accent,
                letterSpacing: "-0.02em",
                lineHeight: 1,
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
                height: 84,
                display: "flex",
                alignItems: "flex-end",
              }}>
                {p.stat}
              </div>
              <div style={{
                fontFamily: "var(--font-mono, 'Geist Mono', monospace)",
                fontSize: 13,
                color: "#A6B3C5",
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                marginTop: 10,
              }}>
                {p.statLabel}
              </div>
            </div>

            {/* Bulleted body. Each bullet gets a small accent-colored
                dot positioned absolutely so the dot's vertical centre
                lines up with the bullet's first line of text regardless
                of bullet length. flex:1 lets the list absorb leftover
                vertical space so the cite link stays anchored to the
                bottom of every card, even when bullet counts vary. */}
            <ul style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              marginTop: 6,
              marginBottom: 18,
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}>
              {p.bullets.map((b, i) => (
                <li key={i} style={{
                  fontSize: 18,
                  color: "#A6B3C5",
                  lineHeight: 1.4,
                  paddingLeft: 18,
                  position: "relative",
                }}>
                  <span aria-hidden="true" style={{
                    position: "absolute",
                    left: 0,
                    top: "0.6em",
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: p.accent,
                    opacity: 0.7,
                  }} />
                  {b}
                </li>
              ))}
            </ul>

            <a
              href={p.href}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontFamily: "var(--font-mono, 'Geist Mono', monospace)",
                fontSize: 14,
                color: "#7C8BA3",
                letterSpacing: "0.14em",
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                alignSelf: "flex-start",
              }}
            >
              <span style={{ borderBottom: "1px solid rgba(124,139,163,0.45)", paddingBottom: 2 }}>
                {p.cite}
              </span>
              <span>↗</span>
            </a>
          </div>
        ))}
      </div>
    </Slide>
  );
}

/* ---- Monetization ------------------------------------------- */
function MonetizationSlide() {
  const Highlight = ({ children }: { children: ReactNode }) => (
    <span style={{ color: "#6BB0BA", fontWeight: 600 }}>{children}</span>
  );

  // Investor-facing commercials slide. Three cards = three revenue
  // mechanics. Hero text per card is the mechanic in plain English so
  // an investor reads "this is how they make money" in one second.
  // Each card ends with a "Like X" line — anchors the mechanic to a
  // known B2B-infra precedent.
  const lines: {
    tag: string;
    hero: ReactNode;
    cadence: string;
    bullets: ReactNode[];
    comparable: string;
    accent: string;
    featured?: boolean;
  }[] = [
    {
      tag: "RECURRING",
      hero: "Annual fees",
      cadence: "Multi-year service contracts.",
      bullets: [
        <>Signed with regulated counterparties.</>,
        <>SDK + program lock-in.</>,
        <>Predictable P&L base.</>,
      ],
      comparable: "Like Plaid",
      accent: "#A6B3C5",
    },
    {
      tag: "VOLUME & SPREAD",
      hero: "1 bp + NIM share",
      cadence: "1 bp on trading. 10–30% of NIM on lending.",
      bullets: [
        <>Taken at the <span style={{ color: "#F4F6FB", fontWeight: 600 }}>contract layer</span>.</>,
        <>Scales with <Highlight>notional</Highlight> + NIM.</>,
        <>Compounds with each client.</>,
      ],
      comparable: "Like Aave reserve factor + Stripe Connect",
      accent: "#6BB0BA",
      featured: true,
    },
    {
      tag: "ENTERPRISE",
      hero: "Negotiable deals",
      cadence: "Custom mix per enterprise customer.",
      bullets: [
        <>Higher tier → <Highlight>waived fees</Highlight>.</>,
        <>Bundles integration, data, audit.</>,
        <>Multi-year, custom SLA.</>,
      ],
      comparable: "Like enterprise SaaS",
      accent: "#C9A766",
    },
  ];

  return (
    <Slide theme="fade">
      <Eyebrow>Business model</Eyebrow>
      <h1 style={{ maxWidth: 1500, marginBottom: 56, fontSize: 84, lineHeight: 1.06 }}>
        Three revenue streams.<br />Well-established in the industry.
      </h1>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 24 }}>
        {lines.map((l) => (
          <div
            key={l.tag}
            className="deck-card"
            style={{
              display: "flex",
              flexDirection: "column",
              padding: "32px 30px 26px",
              borderColor: `${l.accent}33`,
              borderWidth: 1,
              position: "relative",
              background: l.featured
                ? `linear-gradient(180deg, ${l.accent}14 0%, transparent 70%)`
                : undefined,
            }}
          >
            <div style={{
              fontFamily: "var(--font-mono, 'Geist Mono', monospace)",
              fontSize: 13,
              color: l.accent,
              letterSpacing: "0.24em",
              fontWeight: 600,
              marginBottom: 18,
            }}>
              {l.tag}
            </div>

            <div style={{
              fontFamily: "var(--font-display, Manrope)",
              fontSize: 52,
              fontWeight: 600,
              color: "#F4F6FB",
              letterSpacing: "-0.02em",
              lineHeight: 1.05,
              marginBottom: 14,
            }}>
              {l.hero}
            </div>
            <div style={{
              fontSize: 18,
              color: "#A6B3C5",
              marginBottom: 22,
              minHeight: 50,
              lineHeight: 1.4,
              fontWeight: 400,
            }}>
              {l.cadence}
            </div>

            <div style={{
              height: 1,
              background: "rgba(197,207,220,0.14)",
              marginBottom: 18,
            }} />

            <ul style={{ display: "flex", flexDirection: "column", gap: 14, padding: 0, margin: 0, listStyle: "none", flex: 1, marginBottom: 22 }}>
              {l.bullets.map((b, i) => (
                <li key={i} style={{ fontSize: 19, color: "#A6B3C5", lineHeight: 1.4, paddingLeft: 22, position: "relative" }}>
                  <span style={{ position: "absolute", left: 0, top: 0, color: l.accent, fontWeight: 600 }}>›</span>
                  {b}
                </li>
              ))}
            </ul>

            {/* Comparable chip — anchors each revenue line to a public
                B2B-infra precedent the investor already understands. */}
            <div style={{
              fontFamily: "var(--font-mono, 'Geist Mono', monospace)",
              fontSize: 11,
              color: l.accent,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              fontWeight: 600,
              opacity: 0.85,
            }}>
              {l.comparable}
            </div>
          </div>
        ))}
      </div>
    </Slide>
  );
}

/* ---- Compliance --------------------------------------------- */
function ComplianceSlide() {
  // Verdict chip color tokens - teal-tinted "go", amber for caveat, warm
  // red for blocker. All three sit on the deck's existing rise/dark bg.
  const verdictColors: Record<"GREEN" | "YELLOW" | "RED", { bg: string; fg: string; border: string }> = {
    GREEN:  { bg: "rgba(107,176,186,0.16)", fg: "#8FCBD3", border: "rgba(107,176,186,0.45)" },
    YELLOW: { bg: "rgba(201,167,102,0.18)", fg: "#D9BC81", border: "rgba(201,167,102,0.50)" },
    RED:    { bg: "rgba(216,92,78,0.18)",   fg: "#E68479", border: "rgba(216,92,78,0.50)" },
  };
  const verdictStyle = (k: keyof typeof verdictColors): React.CSSProperties => {
    const c = verdictColors[k];
    return {
      display: "inline-block",
      padding: "5px 16px",
      paddingLeft: "calc(16px + 0.22em)", // compensate trailing letter-spacing so text reads centered
      borderRadius: 999,
      fontFamily: "var(--font-mono, 'Geist Mono', ui-monospace, monospace)",
      fontSize: 14,
      letterSpacing: "0.22em",
      textTransform: "uppercase",
      fontWeight: 600,
      background: c.bg,
      color: c.fg,
      border: `1px solid ${c.border}`,
    };
  };

  const rows: { name: string; sub: string; verdict: "GREEN"|"YELLOW"|"RED"; license: string; timing: string; caveat: string }[] = [
    { name: "EU",              sub: "MiCA · DORA · AMLR",      verdict: "GREEN",  license: "Bank or e-money licence",            timing: "MiCA mandatory from Jul 2026",          caveat: "Each EU country has its own deadline" },
    { name: "Switzerland",     sub: "FINMA · DLT Act",          verdict: "GREEN",  license: "Banking, securities, or DLT licence", timing: "DLT Act live · FINMA guidance live",   caveat: "Bank-custodied staking needs a banking licence" },
    { name: "UAE",             sub: "VARA · ADGM · DFSA",       verdict: "GREEN",  license: "Local crypto licence (VARA / FSRA / DFSA)", timing: "Federal crypto law · live by Sep 2026", caveat: "Use ADGM (Abu Dhabi) for fastest institutional path" },
    { name: "Liechtenstein",   sub: "local law → EU MiCA",     verdict: "GREEN",  license: "Crypto licence (upgrades to EU MiCA)", timing: "Fast-track upgrade by Jul 2026",       caveat: "Easiest path from Switzerland into the EU" },
    { name: "SG · UK · US · HK",sub: "rules being updated",    verdict: "YELLOW", license: "Existing local licence",              timing: "New rules landing 2026-27",            caveat: "Sellable today through a local bank's licence" },
    { name: "Direct-to-retail",sub: "no licensed partner",      verdict: "RED",    license: "-",                                   timing: "-",                                    caveat: "Not viable - needs a licensed partner" },
  ];

  const th: React.CSSProperties = {
    fontFamily: "var(--font-mono, 'Geist Mono', monospace)",
    fontSize: 14,
    letterSpacing: "0.22em",
    textTransform: "uppercase",
    color: "#7C8BA3",
    fontWeight: 600,
    textAlign: "left",
    paddingTop: 0,
    paddingBottom: 13,
    borderBottom: "1px solid rgba(124,139,163,0.28)",
  };
  const td: React.CSSProperties = {
    fontSize: 20,
    color: "#A6B3C5",
    paddingTop: 8,
    paddingBottom: 8,
    paddingRight: 14,
    borderBottom: "1px solid rgba(124,139,163,0.10)",
    verticalAlign: "middle",
    lineHeight: 1.28,
  };

  return (
    <Slide theme="rise" grid>
      <Eyebrow>Compliance · jurisdictions</Eyebrow>
      <h1 style={{ maxWidth: 1500, marginBottom: 16, fontSize: 80, lineHeight: 1.06 }}>
        Sellable today, where licensed institutions exist.
      </h1>
      <p style={{ maxWidth: 1500, marginBottom: 18, fontSize: 28, color: "#A6B3C5", lineHeight: 1.4, fontWeight: 300 }}>
        Four markets -{" "}
        <span style={{ color: "#F4F6FB", fontWeight: 500 }}>EU, UK, Switzerland, UAE</span>{" "}
        - under{" "}
        <span style={{ color: "#F4F6FB", fontWeight: 500 }}>MiCA, FCA, FINMA, VARA</span>.{" "}
        With MiCA's CASP framework now live,{" "}
        <span style={{ color: "#C9A766", fontWeight: 500 }}>most DeFi front-ends will need a licence to serve EU retail</span>{" "}
        - or shut down. Licensed institutions hold that licence; we run the rails.
      </p>

      {/* Legend - quick key for the verdict chips below. */}
      <div style={{ display: "flex", gap: 28, marginBottom: 22, alignItems: "center", flexWrap: "wrap" }}>
        {([
          { v: "GREEN",  label: "sellable today" },
          { v: "YELLOW", label: "sellable today, rules updating" },
          { v: "RED",    label: "blocked - needs a licensed partner" },
        ] as const).map((l) => (
          <span key={l.v} style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <span style={verdictStyle(l.v)}>{l.v.toLowerCase()}</span>
            <span style={{ fontSize: 15, color: "#7C8BA3" }}>{l.label}</span>
          </span>
        ))}
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
        <colgroup>
          <col style={{ width: "20%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "20%" }} />
          <col style={{ width: "20%" }} />
          <col style={{ width: "28%" }} />
        </colgroup>
        <thead>
          <tr>
            <th style={th}>Jurisdiction</th>
            <th style={th}>Verdict</th>
            <th style={th}>Customer licence</th>
            <th style={th}>Timing</th>
            <th style={th}>Key caveat</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td style={td}>
                <div style={{ color: "#F4F6FB", fontWeight: 500, fontSize: 21 }}>{r.name}</div>
                <div style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12, color: "#7C8BA3", letterSpacing: "0.18em", textTransform: "uppercase", marginTop: 2 }}>
                  {r.sub}
                </div>
              </td>
              <td style={td}>
                <span style={verdictStyle(r.verdict)}>{r.verdict.toLowerCase()}</span>
              </td>
              <td style={td}>{r.license}</td>
              <td style={td}>{r.timing}</td>
              <td style={td}>{r.caveat}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Slide>
  );
}

/* ---- Numbers / KPIs ------------------------------------------ */
function NumbersSlide() {
  // KPIs use a default 88px display font; vSize lets text-based values
  // (e.g. "Battle tested") drop to a size that fits the card width on
  // one line without forcing the numeric KPIs smaller. The footnote
  // marker on the battle-tested card points to the audit reports
  // surfaced below the grid.
  const kpis: { v: ReactNode; k: string; vSize?: number }[] = [
    { v: "100%",  k: "On-chain settlement" },
    { v: "0",     k: "Off-chain custody points" },
    {
      v: (
        <>
          Battle&nbsp;tested
          <sup style={{ fontSize: "0.42em", marginLeft: 4, fontWeight: 500, verticalAlign: "0.7em" }}>1</sup>
        </>
      ),
      k: "Solana · klend · Jito",
      vSize: 50,
    },
    { v: "Solana", k: "Network of choice" },
  ];
  return (
    <Slide theme="fade">
      <Eyebrow>By the numbers</Eyebrow>
      <h1 style={{ maxWidth: 1500, marginBottom: 96 }}>
        Boring is a feature.
      </h1>
      {/* flex:1 wrapper centers the KPI grid + footnote together
          vertically, leaving the grid centered in the slide and the
          audit footnote anchored a fixed gap below. */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 36 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 24 }}>
          {kpis.map((x) => (
            <div key={x.k} className="deck-card" style={{ textAlign: "center", padding: "56px 32px" }}>
              <div style={{
                fontFamily: "var(--font-display, Manrope)",
                fontSize: x.vSize ?? 88,
                fontWeight: 600,
                color: "#E2E7EF",
                letterSpacing: "-0.02em",
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
                // Pin the value's visual height so a smaller-font card
                // (Battle tested at 50px) still bottom-aligns with the
                // 88px numeric cards - the label below stays on the
                // same baseline across all four cards.
                height: 88,
                display: "flex",
                alignItems: "flex-end",
                justifyContent: "center",
              }}>
                {x.v}
              </div>
              <div style={{ marginTop: 20, fontSize: 18, color: "#A6B3C5", textTransform: "uppercase", letterSpacing: "0.22em" }}>
                {x.k}
              </div>
            </div>
          ))}
        </div>

        {/* Footnote area - sits centered below the KPI grid. Two
            stacked lines: (1) uptime tagline substantiating the
            "Battle tested" KPI with concrete years-in-production for
            each layer, (2) audit-report links. The thin top border
            and muted mono type keep both visually subordinate to the
            KPIs while still readable / clickable. */}
        <div style={{
          paddingTop: 18,
          borderTop: "1px solid rgba(124,139,163,0.18)",
          fontFamily: "var(--font-mono, 'Geist Mono', ui-monospace, monospace)",
          fontSize: 13,
          color: "#7C8BA3",
          letterSpacing: "0.08em",
          textAlign: "center",
          maxWidth: 1100,
          marginLeft: "auto",
          marginRight: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}>
          <div>
            In production:{" "}
            <span style={{ color: "#A6B3C5" }}>Solana mainnet 6+ yrs</span>
            {" · "}
            <span style={{ color: "#A6B3C5" }}>klend 2+ yrs</span>
            {" · "}
            <span style={{ color: "#A6B3C5" }}>Jito 3+ yrs</span>
          </div>
          <div>
            <sup style={{ fontSize: "0.9em", marginRight: 6 }}>1</sup>
            Public audit reports -{" "}
            <a
              href="https://github.com/Kamino-Finance/audits"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#A6B3C5", textDecoration: "underline", textDecorationColor: "rgba(166,179,197,0.35)" }}
            >
              Kamino-Finance/audits
            </a>
            {" · "}
            <a
              href="https://github.com/jito-foundation/restaking/tree/master/security_audits"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#A6B3C5", textDecoration: "underline", textDecorationColor: "rgba(166,179,197,0.35)" }}
            >
              jito-foundation/restaking/security_audits
            </a>
          </div>
        </div>
      </div>
    </Slide>
  );
}

/* ---- Founders ------------------------------------------------- */
function FoundersSlide() {
  // Light-bg variant of the deck's emphasis tone — dark navy bold for
  // load-bearing facts, against the white card background.
  const Key = ({ children }: { children: ReactNode }) => (
    <span style={{ color: "#1F2D48", fontWeight: 600 }}>{children}</span>
  );
  const paraStyle: React.CSSProperties = { fontSize: 17, color: "#4F607C", lineHeight: 1.5, margin: 0 };

  const founders: { name: string; role: string; img: string; bio: ReactNode }[] = [
    {
      name: "Achim Huebl",
      role: "TradFi quant · on-chain credit builder",
      img:  "/images/achim.png",
      bio: (
        <>
          <p style={paraStyle}>
            <Key>Quant finance and regulation</Key> background. M.Sc. in{" "}
            <Key>Math and Finance</Key>, with hands-on experience implementing{" "}
            <Key>new regulatory interest rate models (IRMs)</Key> at the bank level.
          </p>
          <p style={paraStyle}>
            Career spans <Key>quantitative trading</Key>, <Key>risk management</Key>,{" "}
            <Key>management consulting</Key>, and <Key>investment banking</Key>.
          </p>
          <p style={paraStyle}>
            Bridges that rigour with on-chain credit: author of the{" "}
            <Key>1delta white paper</Key>, inventor of the <Key>1delta protocol</Key>,
            and 1st-prize winner at 8 hackathons.
          </p>
        </>
      ),
    },
    {
      name: "Kevin Schellinger",
      role: "Web3 operator · 10+ years",
      img:  "/images/kevin.png",
      bio: (
        <>
          <p style={paraStyle}>
            <Key>Swiss serial entrepreneur</Key> with over a decade of experience in
            Web3. B.Sc. in <Key>Computer Science and IT systems engineering</Key>.
          </p>
          <p style={paraStyle}>
            Co-founded <Key>SwissCEX</Key>, Switzerland's first crypto exchange (2014);
            led business development at <Key>ChainSecurity</Key> until its acquisition
            by <Key>PwC</Key> in 2019; advisor to numerous startups as investor and
            program mentor.
          </p>
          <p style={paraStyle}>
            <Key>Forbes 30 Under 30 (2019)</Key> for pioneering contributions to the
            Swiss crypto ecosystem.
          </p>
        </>
      ),
    },
  ];
  return (
    <Slide theme="rise">
      <Eyebrow>Co-founders</Eyebrow>
      <h2 style={{ marginBottom: 36 }}>Decades of building.<br />Across TradFi and Web3.</h2>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32 }}>
        {founders.map((f) => (
          <div key={f.name} style={{
            display: "flex",
            flexDirection: "column",
            borderRadius: 22,
            overflow: "hidden",
            background: "#FFFFFF",
            boxShadow: "0 18px 50px -22px rgba(7,13,31,0.55)",
            border: "1px solid rgba(166,179,197,0.18)",
          }}>
            {/* Dark header — photo "lives in" this band. The photo's
                white background was knocked out earlier so the silhouette
                sits cleanly on the gradient. Slightly different navy than
                the slide bg so the card pops. */}
            <div style={{
              background: "linear-gradient(135deg, #1F3344 0%, #0E1C2A 100%)",
              height: 280,
              position: "relative",
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "center",
            }}>
              <img src={f.img} alt={f.name}
                   style={{
                     height: 280,
                     width: "auto",
                     display: "block",
                     filter: "grayscale(100%)",
                     objectFit: "contain",
                     objectPosition: "center bottom",
                   }} />
            </div>
            {/* White body — name, role tag, bio paragraphs. */}
            <div style={{ padding: "26px 36px 32px", flex: 1 }}>
              <h3 style={{
                fontFamily: "var(--font-display, Manrope)",
                fontSize: 30,
                fontWeight: 600,
                color: "#1F2D48",
                margin: 0,
                marginBottom: 4,
                textAlign: "center",
              }}>
                {f.name}
              </h3>
              <div style={{
                fontFamily: "var(--font-mono, 'Geist Mono', monospace)",
                fontSize: 13,
                color: "#2B6F7B",
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                textAlign: "center",
                marginBottom: 22,
              }}>
                {f.role}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {f.bio}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Slide>
  );
}

/* ---- Closing -------------------------------------------------- */
function ClosingSlide() {
  // Light theme: the brand mark's gradient lives in the same navy family
  // as the dark slide bgs (#060D1F .. #5E6E89), so it disappears on a
  // dark slide. Putting the closing on light bg also bookends the deck
  // symmetrically with the title slide.
  return (
    <Slide theme="light">
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center" }}>
        <img src={logo} alt="" style={{ height: 220, marginBottom: 56 }} />
        <h1 style={{ maxWidth: 1600, marginBottom: 32, color: "#1F2D48" }}>
          Ship your institutional DeFi product.
          <span style={{ display: "block", color: "#7C8BA3", fontWeight: 300 }}>We do the rails.</span>
        </h1>
        <p className="lead" style={{ maxWidth: 1200, color: "#4F607C", marginTop: 24, display: "flex", justifyContent: "center", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
          <a href="mailto:achim@clearstone.ai"
             style={{ color: "#2B6F7B", textDecoration: "none" }}>
            achim@clearstone.ai
          </a>
          <span style={{ color: "#7C8BA3" }}>·</span>
          <a href="https://clearstone.ai" target="_blank" rel="noopener noreferrer"
             style={{ color: "#2B6F7B", textDecoration: "none" }}>
            clearstone.ai
          </a>
        </p>
      </div>
    </Slide>
  );
}

/* ---- Registry ------------------------------------------------ */
export type DeckTheme = "deep" | "rise" | "fade" | "light" | "soft";

export type SlideEntry = {
  id: string;
  title: string;
  /** The Slide component's `theme` prop. Surfaced here so the deck shell
   *  can match its letterbox/page bg to the active slide - otherwise the
   *  static dark navy bars look jarring on light slides. */
  theme: DeckTheme;
  render: (props: { number: number; total: number }) => ReactNode;
};

export const SLIDES: SlideEntry[] = [
  { id: "title",        title: "Clearstone Fusion",  theme: "light", render: () => <TitleSlide /> },
  { id: "problem",      title: "The problem",        theme: "rise",  render: ({ number, total }) => withChrome(<ProblemSlide />, number, total) },
  { id: "architecture", title: "Architecture",       theme: "fade",  render: ({ number, total }) => withChrome(<ArchitectureSlide />, number, total) },
  { id: "compliance",   title: "Compliance",         theme: "rise",  render: ({ number, total }) => withChrome(<ComplianceSlide />, number, total) },
  { id: "thesis",       title: "Commercial thesis",  theme: "fade",  render: ({ number, total }) => withChrome(<ThesisSlide />, number, total) },
  { id: "surfaces",     title: "Three surfaces",     theme: "soft",  render: ({ number, total }) => withChrome(<SurfacesSlide />, number, total) },
  { id: "monetization", title: "Business model",     theme: "fade",  render: ({ number, total }) => withChrome(<MonetizationSlide />, number, total) },
  { id: "numbers",      title: "By the numbers",     theme: "fade",  render: ({ number, total }) => withChrome(<NumbersSlide />, number, total) },
  { id: "founders",     title: "Founders",           theme: "rise",  render: ({ number, total }) => withChrome(<FoundersSlide />, number, total) },
  { id: "closing",      title: "Closing",            theme: "light", render: () => <ClosingSlide /> },
];

/** Re-clone the rendered slide so we can attach page numbers without
 *  every slide component having to thread `number`/`total` props. */
function withChrome(node: ReactNode, number: number, total: number): ReactNode {
  if (!node || typeof node !== "object" || !("props" in (node as object))) return node;
  const el = node as React.ReactElement<{ number?: number; total?: number }>;
  return { ...el, props: { ...el.props, number, total } } as React.ReactElement;
}
