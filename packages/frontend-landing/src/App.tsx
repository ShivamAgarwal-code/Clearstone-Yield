import { useEffect, useRef } from "react";

// Logo lives in /public — design-system SVGs are not typed for TS imports.
const logo = "/logo.svg";

/* ---- Reveal-on-scroll hook ---------------------------------- */
function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>(".reveal, .reveal-stagger");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-visible");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.12 }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

/* ---- Section ------------------------------------------------- */
function Section({
  id,
  children,
  className = "",
}: {
  id?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={`relative w-full px-6 md:px-10 py-24 md:py-32 ${className}`}
    >
      <div className="max-w-6xl mx-auto">{children}</div>
    </section>
  );
}

/* ---- Eyebrow ------------------------------------------------- */
function Eyebrow({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) {
  return (
    <span
      className={`inline-block uppercase text-[11px] tracking-[0.28em] mb-5 ${
        dark ? "text-stone-3" : "text-[#6B7E9A]"
      }`}
    >
      {children}
    </span>
  );
}

/* ---- Top Nav ------------------------------------------------- */
// Live demo URLs are pinned here (and re-used in the Surfaces section
// below) so a deploy slug change only edits one place.
const DEMOS = {
  retail:        "https://retail.clearstone.ai",
  institutional: "https://institutional.clearstone.ai",
  console:       "https://console.clearstone.ai",
} as const;

function Nav() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-30 bg-[#F7F8FA]/70 supports-[backdrop-filter]:bg-[#F7F8FA]/55 backdrop-blur-md backdrop-saturate-150 border-b border-[#DCE2EC]/70">
      <div className="max-w-6xl mx-auto px-6 md:px-10 h-16 flex items-center justify-between gap-6">
        <a href="#top" className="flex items-center gap-3">
          <img src={logo} alt="Clearstone Fusion" className="h-7 w-auto" />
          <div className="flex items-baseline gap-1.5 font-display">
            <span className="brand-wordmark text-base text-[#1F2D48]">clearstone</span>
            <span className="brand-wordmark-thin text-xs text-[#7C8BA3]">fusion</span>
          </div>
        </a>
        <div className="hidden md:flex items-center gap-7 text-sm text-[#4F607C]">
          <a href="#solution"   className="hover:text-[#1F2D48] transition-colors">Platform</a>
          <a href="#surfaces"   className="hover:text-[#1F2D48] transition-colors">Products</a>
          <a href="#stack"      className="hover:text-[#1F2D48] transition-colors">Architecture</a>
          <a href="#compliance" className="hover:text-[#1F2D48] transition-colors">Compliance</a>
        </div>
        {/* The three live demos are showcased in the Surfaces tile
            section below — no top-right shortcut here on the landing
            so the primary "Book a demo" CTA stays uncluttered. */}
        <a
          href="#cta"
          className="btn-primary-cs whitespace-nowrap text-xs px-4! py-2! sm:text-sm sm:px-[1.6rem]! sm:py-[0.85rem]!"
        >
          Book a demo
        </a>
      </div>
    </nav>
  );
}

/* ---- Hero ---------------------------------------------------- */
function Hero() {
  const heroRef = useRef<HTMLElement>(null);

  // Smooth pointer parallax via lerp loop + CSS variables.
  // No React state — direct DOM updates, frame-paced. Far smoother than
  // setState-on-mousemove + a long CSS transition (which always feels laggy).
  useEffect(() => {
    const el = heroRef.current;
    if (!el) return;

    const target  = { x: 0, y: 0 };
    const current = { x: 0, y: 0 };
    let raf = 0;
    let inView = true;
    let running = false;

    const io = new IntersectionObserver(
      ([e]) => { inView = e.isIntersecting; },
      { threshold: 0 }
    );
    io.observe(el);

    // Critically-damped low-pass: smooths jitter, settles in ~10 frames
    const k = 0.09;

    const tick = () => {
      current.x += (target.x - current.x) * k;
      current.y += (target.y - current.y) * k;
      el.style.setProperty("--px-x", current.x.toFixed(4));
      el.style.setProperty("--px-y", current.y.toFixed(4));

      const settled =
        Math.abs(target.x - current.x) < 0.0008 &&
        Math.abs(target.y - current.y) < 0.0008;
      if (settled) {
        running = false;
        raf = 0;
      } else {
        raf = requestAnimationFrame(tick);
      }
    };

    const onMove = (e: MouseEvent) => {
      if (!inView) return;
      const r = el.getBoundingClientRect();
      target.x = ((e.clientX - r.left) / r.width  - 0.5) * 2;
      target.y = ((e.clientY - r.top)  / r.height - 0.5) * 2;
      if (!running) {
        running = true;
        raf = requestAnimationFrame(tick);
      }
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      io.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const wordmark = "clearstone".split("");

  return (
    <section
      ref={heroRef}
      id="top"
      className="relative min-h-[100svh] pt-28 md:pt-20 flex items-center justify-center overflow-hidden bg-stone-page-light"
    >
      {/* Mesh gradient — light variant for the white hero */}
      <div className="absolute inset-0 hero-mesh-light pointer-events-none" />

      {/* Slow orbital conic sweep — light variant */}
      <div className="absolute hero-conic-light pointer-events-none" />

      {/* Vector grid — stroke + opacity bumped so the underlying mesh
          gradients have a structural lattice to play against instead of
          just floating in beige. */}
      <svg className="absolute inset-0 w-full h-full opacity-[0.11] pointer-events-none mix-blend-multiply" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id="g" width="56" height="56" patternUnits="userSpaceOnUse">
            <path d="M 56 0 L 0 0 0 56" fill="none" stroke="#1F2D48" strokeWidth="0.7" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#g)" />
      </svg>

      {/* Hero content (no whole-block parallax — only the logo tilts) */}
      <div className="relative max-w-4xl mx-auto px-6 text-center">
        {/* Logo with subtle 3D tilt — no shadow, sits clean on the light bg */}
        <div className="hero-logo-wrap relative inline-flex items-center justify-center mb-10">
          <img
            src={logo}
            alt=""
            className="relative z-10 h-44 md:h-56 w-auto hero-float"
          />
        </div>

        {/* Wordmark — letter-by-letter mount-in. whitespace-nowrap on the
            letter span prevents inline-block letters from wrapping mid-word
            on narrow viewports (was breaking as "clearsto / ne" at ~360px). */}
        <div className="font-display flex items-baseline justify-center gap-2 sm:gap-3 md:gap-4 mb-7">
          <span className="brand-wordmark whitespace-nowrap text-[clamp(2.25rem,11vw,4.5rem)] md:text-7xl text-[#1F2D48]">
            {wordmark.map((c, i) => (
              <span
                key={i}
                className="hero-letter inline-block"
                style={{ animationDelay: `${i * 55}ms` }}
              >
                {c}
              </span>
            ))}
          </span>
          <span className="brand-wordmark-thin text-lg sm:text-2xl md:text-3xl text-[#7C8BA3] hero-fusion">
            fusion
          </span>
        </div>

        <p className="hero-tag text-lg md:text-xl text-[#4F607C] max-w-2xl mx-auto leading-relaxed">
          Institutional DeFi infrastructure. Software, programs, and rails that let banks,
          fintechs, and asset managers stand up KYC-gated savings apps and trading desks —
          running on permissionless liquidity underneath.
        </p>

        <div className="hero-cta flex flex-col md:flex-row gap-3 md:gap-4 justify-center mt-10">
          <a href="#cta" className="btn-primary-cs btn-shimmer">Book a demo</a>
          <a href="#solution" className="btn-ghost-cs-light">See the architecture ↓</a>
        </div>
      </div>

      {/* Scroll cue (dark on light bg). Hidden on mobile — the absolute
          positioning collides with the CTA stack on short viewports, and
          touch users don't need a scroll affordance anyway. */}
      <div className="hidden md:flex absolute bottom-10 left-0 right-0 justify-center pointer-events-none">
        <div className="flex flex-col items-center gap-2 text-[#7C8BA3]">
          <span className="text-[10px] tracking-[0.32em] uppercase">scroll</span>
          <span className="hero-scroll-dot block h-7 w-px bg-gradient-to-b from-[#7C8BA3]/80 to-transparent" />
        </div>
      </div>
    </section>
  );
}

/* ---- Solution overview --------------------------------------- */
function Solution() {
  return (
    <Section id="solution" className="bg-stone-rise">
      <div className="reveal text-center max-w-3xl mx-auto">
        <Eyebrow>What we provide</Eyebrow>
        <h2 className="font-display text-4xl md:text-5xl font-semibold text-stone-0 leading-tight tracking-tight">
          Infrastructure, not an app.
        </h2>
        <p className="text-stone-2 text-lg mt-6 leading-relaxed">
          Clearstone Fusion is the institutional layer between regulated counterparties and DeFi.
          We ship the SDK, the on-chain programs, the custody patterns, and the operator console.
          You ship a compliant product to your customers — under your brand.
        </p>
      </div>

      <div className="divider-hair my-16" />

      <div className="grid md:grid-cols-3 gap-6 reveal-stagger">
        {[
          {
            title: "Audited programs",
            body: "Open-source governor and vault contracts your compliance team can read. Timelocked changes, parameter-bounded, no privileged backdoors.",
          },
          {
            title: "Permissioned-on-permissionless",
            body: "KYC/KYB gates wrap permissionless DeFi liquidity. Your users never leave your perimeter. Capital never leaves chain.",
          },
          {
            title: "One ledger of truth",
            body: "TVL, APY, utilization, reserves — read directly from Solana. Audit and reporting work without reconciliation across systems.",
          },
        ].map((c) => (
          <div key={c.title} className="card-stone p-7">
            <div className="text-stone-0 font-display font-semibold text-lg mb-2">{c.title}</div>
            <p className="text-stone-2 text-sm leading-relaxed">{c.body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ---- Three surfaces ------------------------------------------ */
function Surfaces() {
  const items = [
    {
      tag: "White-label · savings",
      title: "Retail savings, your brand",
      body: "Spin up a regulated USDC savings product for your customers in days. KYC-gated wallet flow, branded UI, audit-ready operations — from a single SDK.",
      points: ["KYC-gated deposit & withdraw", "Brandable UI components", "Real-time APY from chain"],
      cta: "Open the live demo",
      href: DEMOS.retail,
      host: "retail.clearstone.ai",
    },
    {
      tag: "B2B · trading",
      title: "Trading desks, white-labeled",
      body: "A permissioned trading and lending surface for treasury teams, family offices, and corporate clients. Curated markets, policy-bounded execution, full audit trail.",
      points: ["KYB gates per counterparty", "Policy-bounded automation", "Position & exposure exports"],
      cta: "Open the live demo",
      href: DEMOS.institutional,
      host: "institutional.clearstone.ai",
    },
    {
      tag: "Internal · ops",
      title: "Operator console",
      body: "The cockpit your ops team runs everything from: reserve config, oracle status, elevation groups, vault deployments, keeper telemetry, audit exports.",
      points: ["Reserve & oracle ops", "Vault management", "Keeper telemetry & alerts"],
      cta: "Open the live demo",
      href: DEMOS.console,
      host: "console.clearstone.ai",
    },
  ];
  return (
    <Section id="surfaces" className="bg-stone-light">
      <div className="reveal text-center max-w-3xl mx-auto">
        <Eyebrow>Live demos · what you ship</Eyebrow>
        <h2 className="font-display text-4xl md:text-5xl font-semibold leading-tight tracking-tight">
          Three deliverables. Your brand.
        </h2>
        <p className="text-[#4F607C] text-lg mt-6 leading-relaxed">
          Pick a surface — or all three. Each card opens the live devnet build for that product.
          Your engineers integrate the SDK; your customers see your UI. We provide the rails, the
          audits, and the on-chain plumbing.
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-6 mt-16 reveal-stagger">
        {items.map((it) => (
          <a
            key={it.tag}
            href={it.href}
            target="_blank"
            rel="noreferrer"
            className="card-stone-light p-8 flex flex-col group transition-shadow hover:shadow-[var(--shadow-stone-md,0_14px_32px_-12px_rgba(31,45,72,0.32))] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1F2D48]/40"
          >
            <span className="uppercase tracking-[0.22em] text-[10px] text-[#7C8BA3] font-semibold mb-4">
              {it.tag}
            </span>
            <h3 className="font-display text-2xl font-semibold leading-tight mb-3 text-[#1F2D48]">
              {it.title}
            </h3>
            <p className="text-[#4F607C] text-sm leading-relaxed mb-6">{it.body}</p>
            <ul className="space-y-2 mb-8 text-sm text-[#1F2D48]">
              {it.points.map((p) => (
                <li key={p} className="flex items-start gap-2">
                  <span className="mt-2 h-1.5 w-1.5 rounded-full bg-[#4F607C] flex-shrink-0" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
            <div className="mt-auto pt-4 border-t border-[#DCE2EC]/70">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-[#1F2D48] group-hover:text-[#4F607C] transition-colors">
                  {it.cta}
                  <span className="inline-block ml-1 transition-transform group-hover:translate-x-0.5">↗</span>
                </span>
              </div>
              <div className="mt-1 text-[10px] tracking-[0.18em] uppercase text-[#9AA8C0] font-mono">
                {it.host}
              </div>
            </div>
          </a>
        ))}
      </div>
    </Section>
  );
}

/* ---- Architecture diagram ------------------------------------ */
function Stack() {
  return (
    <Section id="stack" className="bg-stone-deep">
      <div className="reveal text-center max-w-3xl mx-auto">
        <Eyebrow>Architecture</Eyebrow>
        <h2 className="font-display text-4xl md:text-5xl font-semibold text-stone-0 leading-tight tracking-tight">
          What you ship vs. what we ship.
        </h2>
        <p className="text-stone-2 text-lg mt-6 leading-relaxed">
          You ship the brand and the customer relationship. We ship the SDK, the on-chain programs,
          the keeper, and the operator console — running on audited Solana liquidity.
        </p>
      </div>

      <div className="reveal mt-16 max-w-5xl mx-auto">
        <svg viewBox="0 0 900 360" className="w-full h-auto">
          <defs>
            {/* Box gradients — each row has its own accent at the top,
                all share the same navy floor so the diagram feels
                grouped and on-brand. */}
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
            {/* Infrastructure row — darker and slightly cooler than the
                platform row's stone gradient so the foundation visually
                recedes (and the platform reads as the protagonist). */}
            <linearGradient id="diag-under"  x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%"  stopColor="#2C3845" />
              <stop offset="100%" stopColor="#0E1822" />
            </linearGradient>

            {/* Drop shadow gives boxes depth — sits well on the dark
                section background. */}
            <filter id="boxShadow" x="-20%" y="-50%" width="140%" height="200%">
              <feDropShadow dx="0" dy="6" stdDeviation="9" floodColor="#000814" floodOpacity={0.55} />
            </filter>
            {/* Arrowhead used by the products-row connectors. context-stroke
                makes each arrow inherit its line's accent color. */}
            <marker id="surface-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="4" markerHeight="4" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
            {/* Arrowhead for the governance spine's bottom tick. */}
            <marker id="gov-cap" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#C5CFDC" />
            </marker>
          </defs>

          {/* Row labels — mono number + tracked-out caps, neutral tone.
              Numbers carry the ordering (top-down stack); the categorical
              color story already lives in the boxes themselves. */}
          {[
            { y: 14,  num: "01", label: "PRODUCTS"       },
            { y: 144, num: "02", label: "PLATFORM"       },
            { y: 274, num: "03", label: "INFRASTRUCTURE" },
          ].map((l) => (
            <g key={l.label}>
              <text x={20} y={l.y} fill="#8895AC" fontFamily="Geist Mono, ui-monospace, monospace" fontSize={10} fontWeight={600} letterSpacing={0.5}>
                {l.num}
              </text>
              <text x={45} y={l.y} fill="#D4DDE8" fontFamily="Geist, sans-serif" fontSize={10} letterSpacing={2.5} fontWeight={500}>
                {l.label}
              </text>
            </g>
          ))}

          {/* 3 surfaces (top row) — each with its own categorical accent
              and a line icon at the left so the boxes read as products.
              Surfaces with a compliance gate (savings: KYC, trading: KYB)
              get a pill on their connector + an upward-pointing arrow. */}
          {([
            { x: 80,  label: "Savings app",  grad: "diag-amber",  accent: "#C9A766", pill: "KYC",
              icon: <g fill="none" stroke="#F4F6FB" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <rect x={2} y={3} width={18} height={14} rx={1.5} />
                <circle cx={13} cy={10} r={3} />
                <line x1={13} y1={10} x2={13} y2={7.2} />
                <line x1={4}  y1={17} x2={4}  y2={19.5} />
                <line x1={18} y1={17} x2={18} y2={19.5} />
              </g> },
            { x: 380, label: "Trading desk", grad: "diag-teal",   accent: "#6BB0BA", pill: "KYB",
              icon: <g fill="none" stroke="#F4F6FB" strokeWidth={2} strokeLinecap="round">
                <line x1={5}  y1={18} x2={5}  y2={13} />
                <line x1={11} y1={18} x2={11} y2={9}  />
                <line x1={17} y1={18} x2={17} y2={5}  />
                <line x1={3}  y1={20} x2={19} y2={20} strokeWidth={1} />
              </g> },
            { x: 680, label: "Ops console",  grad: "diag-indigo", accent: "#8C7FBE",
              icon: <g fill="none" stroke="#F4F6FB" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <rect x={2} y={3} width={18} height={13} rx={1.5} />
                <polyline points="6,8 9,11 6,14" />
                <line x1={11} y1={14} x2={15} y2={14} />
                <line x1={8}  y1={19} x2={14} y2={19} />
              </g> },
          ] as { x: number; label: string; grad: string; accent: string; icon: React.ReactNode; pill?: string }[]).map((s) => (
            <g key={s.label}>
              <rect x={s.x} y={20} width={140} height={60} rx={14}
                    fill={`url(#${s.grad})`} stroke={s.accent} strokeOpacity={0.6} strokeWidth={1.3}
                    filter="url(#boxShadow)" />
              {/* Icon horizontally centered above the label, no chrome. */}
              <g transform={`translate(${s.x + 59}, 22)`}>{s.icon}</g>
              <text x={s.x + 70} y={64} textAnchor="middle"
                    fill="#F4F6FB" fontFamily="Quicksand, sans-serif" fontWeight={600} fontSize={14}>
                {s.label}
              </text>
              {/* Connector middle → top, drawn upward so the markerEnd
                  arrow lands on the product (governance flowing UP). */}
              <line x1={s.x + 70} y1={150} x2={s.x + 70} y2={80}
                    stroke={s.accent} strokeWidth={2.2} strokeLinecap="round"
                    strokeDasharray="3 6" opacity={0.75}
                    markerEnd={s.pill ? "url(#surface-arrow)" : undefined} />
              {/* Compliance pill — the gate the connection passes through. */}
              {s.pill && (
                <g>
                  <rect x={s.x + 45} y={104} width={50} height={22} rx={11}
                        fill="#070D1F"
                        stroke={s.accent} strokeOpacity={0.9} strokeWidth={1.3} />
                  <text x={s.x + 70} y={120} textAnchor="middle"
                        fill={s.accent}
                        fontFamily="Geist Mono, ui-monospace, monospace"
                        fontSize={12} letterSpacing={1.5} fontWeight={600}>
                    {s.pill}
                  </text>
                </g>
              )}
            </g>
          ))}

          {/* Platform row — Clearstone mark + "clearstone / fusion"
              wordmark stacked on two lines next to the logo. Same
              typography pattern as the slide footer's .brand class:
              identical font/weight, "fusion" differentiated by opacity.
              Tech-stack text centered in the available space after the
              banner ((banner_end + rect_right) / 2). */}
          <rect x={80} y={150} width={740} height={60} rx={14}
                fill="url(#diag-stone)" stroke="#C5CFDC" strokeOpacity={0.55} strokeWidth={1.5}
                filter="url(#boxShadow)" />
          <image href="/logo.svg" x={104} y={162} width={30} height={30} preserveAspectRatio="xMidYMid meet" />
          <text x={140} y={177} fontFamily="Manrope, sans-serif" fontSize={15} fontWeight={500} letterSpacing={-0.15} fill="#F4F6FB">
            clearstone
          </text>
          <text x={140} y={191} fontFamily="Manrope, sans-serif" fontSize={12} fontWeight={500} letterSpacing={-0.12} fill="#F4F6FB" opacity={0.55}>
            fusion
          </text>
          <text x={530} y={186} textAnchor="middle"
                fill="#F4F6FB" fontFamily="Geist, sans-serif" fontWeight={500} fontSize={15}>
            SDK · Programs · Trading Terminals · Console
          </text>

          {/* connector to infrastructure */}
          <line x1={450} y1={210} x2={450} y2={280}
                stroke="#A6B3C5" strokeWidth={2.2} strokeLinecap="round"
                strokeDasharray="3 6" opacity={0.55} />

          {/* Infrastructure row — darker than Platform so the foundation
              recedes and the platform reads as the protagonist. */}
          <rect x={140} y={280} width={620} height={60} rx={14}
                fill="url(#diag-under)" stroke="#3D4C5A" strokeOpacity={0.55} strokeWidth={1.3}
                filter="url(#boxShadow)" />

          {/* Three real brand assets — same files as the slide deck,
              served from /public/logos so they're bundled with the page. */}
          <image href="/logos/solana.png" x={297} y={295} width={30} height={30} preserveAspectRatio="xMidYMid meet" />
          <image href="/logos/kamino.svg" x={377} y={297} width={110} height={26} preserveAspectRatio="xMidYMid meet" />
          <image href="/logos/jito.svg"   x={537} y={297} width={65}  height={26} preserveAspectRatio="xMidYMid meet" />

          {/* Governance spine — Clearstone's stack adds KYC / policy /
              timelocks ON TOP OF the permissionless rails. Vertical
              track touches all three rows; the bright platform tick
              marks origin; the bottom tick points LEFT into the
              infrastructure row. The pill mirrors the KYC/KYB pills
              on the product connectors. */}
          <g opacity={0.9}>
            <line x1={862} y1={50} x2={862} y2={310}
                  stroke="#C5CFDC" strokeOpacity={0.6} strokeWidth={1.4} />
            <line x1={820} y1={50}  x2={862} y2={50}
                  stroke="#C5CFDC" strokeOpacity={0.65} strokeWidth={1.4} />
            <line x1={820} y1={180} x2={862} y2={180}
                  stroke="#C5CFDC" strokeOpacity={0.65} strokeWidth={1.4} />
            <line x1={862} y1={310} x2={770} y2={310}
                  stroke="#C5CFDC" strokeOpacity={0.65} strokeWidth={1.4}
                  markerEnd="url(#gov-cap)" />
            {/* Vertical pill — sibling to the KYC/KYB pills. */}
            <rect x={849} y={130} width={26} height={100} rx={13}
                  fill="#070D1F"
                  stroke="#C5CFDC" strokeOpacity={0.9} strokeWidth={1.3} />
            <text x={862} y={184}
                  transform="rotate(-90, 862, 180)"
                  fill="#C5CFDC"
                  fontFamily="Geist Mono, ui-monospace, monospace"
                  fontSize={11} letterSpacing={1.5} fontWeight={600}
                  textAnchor="middle">
              GOVERNANCE
            </text>
          </g>
        </svg>
      </div>

      <div className="grid md:grid-cols-4 gap-4 mt-14 reveal-stagger">
        {[
          { k: "Settlement",     v: "Solana mainnet" },
          { k: "Liquidity",      v: "Institutional capital" },
          { k: "Infrastructure", v: "Kamino · Jito" },
          { k: "Programs",       v: "Governor + Vault" },
        ].map((x) => (
          <div key={x.k} className="card-stone p-5">
            <div className="text-stone-3 text-[11px] uppercase tracking-[0.22em] mb-1">{x.k}</div>
            <div className="text-stone-0 font-display font-semibold">{x.v}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ---- Compliance & Ops ---------------------------------------- */
function Compliance() {
  return (
    <Section id="compliance" className="bg-stone-light">
      <div className="grid md:grid-cols-2 gap-12 items-start">
        <div className="reveal">
          <Eyebrow>Compliance, baked in</Eyebrow>
          <h3 className="font-display text-3xl md:text-4xl font-semibold leading-tight mb-5">
            Permissioned access. Permissionless rails.
          </h3>
          <p className="text-[#4F607C] text-base leading-relaxed mb-6">
            The on-chain programs gate every interaction by KYC or KYB attestation. Your compliance
            team defines who clears the gate. We don't replace your KYC vendor — we plug into it.
            Underneath, capital lives in audited DeFi reserves you can verify on-chain.
          </p>
          <ul className="space-y-3 text-sm text-[#1F2D48]">
            {[
              "KYC / KYB gating enforced at the program level",
              "Per-jurisdiction policy controls",
              "Timelocked governance, parameter-bounded automation",
              "Audit-ready exports — no off-chain reconciliation",
            ].map((s) => (
              <li key={s} className="flex gap-3">
                <span className="text-[#4F607C] font-bold">›</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="reveal">
          <Eyebrow>Operations, simplified</Eyebrow>
          <h3 className="font-display text-3xl md:text-4xl font-semibold leading-tight mb-5">
            One console for every reserve, oracle, and vault.
          </h3>
          <p className="text-[#4F607C] text-base leading-relaxed mb-6">
            Real-time reserve health, oracle status, keeper telemetry, and per-policy alerts.
            Your ops team gets out of spreadsheets and into a cockpit built specifically for
            running an institutional DeFi product.
          </p>
          <ul className="space-y-3 text-sm text-[#1F2D48]">
            {[
              "Reserve, oracle, and elevation-group operations",
              "Vault deployment and configuration",
              "Keeper health and alert routing",
              "On-chain audit trail surfaced inline",
            ].map((s) => (
              <li key={s} className="flex gap-3">
                <span className="text-[#4F607C] font-bold">›</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}

/* ---- Numbers / KPIs ------------------------------------------ */
function Numbers() {
  const kpis = [
    { v: "100%",    k: "On-chain settlement" },
    { v: "0",       k: "Off-chain custody points" },
    { v: "Audited", k: "Governor & vault programs" },
    { v: "Solana",  k: "Network of choice" },
  ];
  return (
    <Section id="numbers" className="bg-stone-fade">
      <div className="reveal text-center max-w-3xl mx-auto mb-16">
        <Eyebrow>By the numbers</Eyebrow>
        <h2 className="font-display text-4xl md:text-5xl font-semibold text-stone-0 leading-tight tracking-tight">
          Boring is a feature.
        </h2>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 reveal-stagger">
        {kpis.map((x) => (
          <div key={x.k} className="card-stone p-7 text-center">
            <div className="kpi-num text-stone-0 font-display text-4xl md:text-5xl font-semibold">{x.v}</div>
            <div className="text-stone-3 text-xs uppercase tracking-[0.22em] mt-3">{x.k}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ---- Final CTA ----------------------------------------------- */
function CTA() {
  return (
    <Section id="cta" className="bg-stone-deep">
      <div className="reveal max-w-3xl mx-auto text-center">
        <img src={logo} alt="" className="h-24 mx-auto mb-8 opacity-90" />
        <h2 className="font-display text-4xl md:text-6xl font-semibold text-stone-0 leading-[1.05] tracking-tight">
          Ship your institutional DeFi product.
          <span className="block text-stone-3 font-light">We do the rails.</span>
        </h2>
        <p className="text-stone-2 text-base md:text-lg max-w-xl mx-auto mt-7 leading-relaxed">
          Talk to us. We'll walk through the SDK, the on-chain programs, the compliance flow,
          and the operator console — and show you how partners are deploying.
        </p>
        <div className="flex flex-col md:flex-row gap-3 md:gap-4 justify-center mt-10">
          <a href="mailto:hello@clearstone.ai" className="btn-primary-cs">Book a demo</a>
          <a href="#surfaces" className="btn-ghost-cs">Open the live demos</a>
          <a href="https://github.com" className="btn-ghost-cs">View on GitHub</a>
        </div>
      </div>
    </Section>
  );
}

/* ---- Footer -------------------------------------------------- */
const SOCIALS = [
  {
    label: "X / Twitter",
    href: "https://x.com/ClearstoneAI",
    // X glyph
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden className="h-4 w-4" fill="currentColor">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817-5.967 6.817H1.677l7.73-8.835L1.254 2.25h6.83l4.713 6.231 5.447-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117l11.966 15.644Z" />
      </svg>
    ),
  },
  {
    label: "LinkedIn",
    href: "https://www.linkedin.com/company/116019486",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden className="h-4 w-4" fill="currentColor">
        <path d="M20.45 20.45h-3.555v-5.569c0-1.328-.026-3.037-1.852-3.037-1.853 0-2.136 1.446-2.136 2.94v5.666H9.353V9h3.414v1.561h.048c.476-.9 1.637-1.852 3.37-1.852 3.6 0 4.265 2.37 4.265 5.455v6.286ZM5.337 7.433a2.062 2.062 0 1 1 0-4.124 2.062 2.062 0 0 1 0 4.124ZM7.115 20.45H3.558V9h3.557v11.45ZM22.225 0H1.771C.792 0 0 .773 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .773 23.2 0 22.222 0h.003Z" />
      </svg>
    ),
  },
] as const;

function Footer() {
  return (
    <footer className="border-t border-white/5 bg-[#040814] py-10 px-6">
      <div className="max-w-6xl mx-auto flex flex-col md:flex-row gap-6 md:items-center md:justify-between text-stone-3 text-sm">
        <div className="flex items-center gap-3">
          <img src={logo} alt="" className="h-6" />
          <div className="font-display flex items-baseline gap-1.5">
            <span className="brand-wordmark text-sm text-stone-2">clearstone</span>
            <span className="brand-wordmark-thin text-[11px]">fusion</span>
          </div>
        </div>
        <div className="flex gap-6">
          <a href="#solution" className="hover:text-stone-0 transition-colors">Platform</a>
          <a href="#surfaces" className="hover:text-stone-0 transition-colors">Products</a>
          <a href="#stack" className="hover:text-stone-0 transition-colors">Architecture</a>
          <a href="#compliance" className="hover:text-stone-0 transition-colors">Compliance</a>
        </div>
        <div className="flex items-center gap-3">
          {SOCIALS.map((s) => (
            <a
              key={s.label}
              href={s.href}
              target="_blank"
              rel="noreferrer"
              aria-label={s.label}
              className="inline-flex items-center justify-center h-8 w-8 rounded-full border border-white/10 text-stone-3 hover:text-stone-0 hover:border-white/25 transition-colors"
            >
              {s.icon}
            </a>
          ))}
        </div>
        <div className="text-xs">© {new Date().getFullYear()} Clearstone Fusion · Institutional DeFi infrastructure · Solana</div>
      </div>
    </footer>
  );
}

/* ---- Composition -------------------------------------------- */
export default function App() {
  useReveal();
  return (
    <div className="text-stone-0">
      <Nav />
      <Hero />
      <Solution />
      <Surfaces />
      <Stack />
      <Compliance />
      <Numbers />
      <CTA />
      <Footer />
    </div>
  );
}
