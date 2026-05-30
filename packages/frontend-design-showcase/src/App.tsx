import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardFooter,
  CardHeader,
  Eyebrow,
  FieldGroupHeading,
  FormLabel,
  Input,
  KeyValue,
  PageHeader,
  SectionHeader,
  Snackbar,
  Stat,
  StatLabel,
  Tabs,
  TokenAmountInput,
  TokenIcon,
  tokenBrandColor,
} from "@clearstone/design-system";

/**
 * Showcase — every primitive in @clearstone/design-system rendered with
 * representative variants. Sections are anchored from the side nav so a
 * designer can deep-link to a component (e.g. /#input).
 *
 * Kept deliberately presentational: no data fetching, no router. The
 * point is to be a single-page reference for the visual contract.
 */

const SECTIONS: { id: string; label: string }[] = [
  { id: "headings", label: "Headings" },
  { id: "buttons", label: "Buttons" },
  { id: "inputs", label: "Inputs" },
  { id: "money", label: "Money" },
  { id: "stats", label: "Stats" },
  { id: "cards", label: "Cards" },
  { id: "badges", label: "Badges" },
  { id: "labels", label: "Labels" },
  { id: "tabs", label: "Tabs" },
  { id: "snackbars", label: "Snackbars" },
  { id: "tokens", label: "Tokens" },
];

export function App() {
  return (
    <div className="min-h-screen flex">
      <SideNav />
      <main className="flex-1 min-w-0 px-12 py-14 max-w-[1280px] mx-auto">
        <PageHeader
          eyebrow="Clearstone — Design System"
          title="Component Showcase"
          subtitle="A live reference of every primitive exposed from @clearstone/design-system. Use this page to verify visual contracts before shipping changes."
          actions={<Badge tone="primary" variant="soft">v0.1</Badge>}
        />

        <HeadingsSection />
        <ButtonsSection />
        <InputsSection />
        <MoneySection />
        <StatsSection />
        <CardsSection />
        <BadgesSection />
        <LabelsSection />
        <TabsSection />
        <SnackbarsSection />
        <TokensSection />

        <footer className="mt-16 pt-8 border-t border-base-300/70 text-xs text-base-content/45">
          Built with React 18 + Tailwind v4 + DaisyUI 5.
        </footer>
      </main>
    </div>
  );
}

function SideNav() {
  return (
    <aside className="hidden lg:block w-56 shrink-0 sticky top-0 h-screen border-r border-base-300/70 bg-base-200/40 px-6 py-8">
      <div className="brand-wordmark text-xl mb-1">clearstone</div>
      <div className="brand-wordmark-thin text-[11px] text-base-content/55">design system</div>
      <nav className="mt-8 flex flex-col gap-1">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="px-3 py-1.5 rounded-md text-sm text-base-content/70 hover:text-base-content hover:bg-base-content/[0.06] transition-colors"
          >
            {s.label}
          </a>
        ))}
      </nav>
    </aside>
  );
}

function Section({
  id,
  eyebrow,
  title,
  subtitle,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-8 mt-16 first:mt-10">
      <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} divider />
      <div className="mt-6 space-y-6">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_1fr] items-start gap-8 py-5 border-b border-base-300/50 last:border-0">
      <div className="pt-2"><StatLabel>{label}</StatLabel></div>
      <div className="flex flex-wrap items-center gap-4">{children}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Headings                                                                    */
/* -------------------------------------------------------------------------- */

function HeadingsSection() {
  return (
    <Section
      id="headings"
      eyebrow="Typography"
      title="Headings"
      subtitle="Page header, section header, eyebrow, field-group caption."
    >
      <Card>
        <PageHeader
          eyebrow="Lending"
          title="Positions"
          subtitle="Active obligations, accrued yield, health factors."
          actions={<Button size="sm" variant="secondary">Refresh</Button>}
        />
        <SectionHeader
          eyebrow="Composition"
          title="Collateral mix"
          subtitle="Token weights driving the borrow capacity."
          actions={<Badge tone="success" variant="soft">Healthy</Badge>}
        />
        <div className="mt-6">
          <FieldGroupHeading>Quote inputs</FieldGroupHeading>
          <p className="text-sm text-base-content/65">
            FieldGroupHeading is the lightest tier — used above small clusters of inputs.
          </p>
        </div>
        <div className="mt-6">
          <Eyebrow>Eyebrow</Eyebrow>
          <p className="text-sm text-base-content/65">
            Tracked-out uppercase label, paired with a title.
          </p>
        </div>
      </Card>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Buttons                                                                     */
/* -------------------------------------------------------------------------- */

function ChevronRight() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function Plus() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}

function ButtonsSection() {
  return (
    <Section
      id="buttons"
      eyebrow="Action"
      title="Buttons"
      subtitle="Six variants × four sizes. Borders are 1px across the board so mixed rows align."
    >
      <Card>
        <Row label="Primary">
          <Button size="xs">XS</Button>
          <Button size="sm">Small</Button>
          <Button size="md">Default</Button>
          <Button size="lg">Large</Button>
        </Row>
        <Row label="Secondary">
          <Button variant="secondary" size="xs">XS</Button>
          <Button variant="secondary" size="sm">Small</Button>
          <Button variant="secondary" size="md">Default</Button>
          <Button variant="secondary" size="lg">Large</Button>
        </Row>
        <Row label="Outline">
          <Button variant="outline" size="xs">XS</Button>
          <Button variant="outline" size="sm">Small</Button>
          <Button variant="outline" size="md">Default</Button>
          <Button variant="outline" size="lg">Large</Button>
        </Row>
        <Row label="Ghost">
          <Button variant="ghost" size="xs">XS</Button>
          <Button variant="ghost" size="sm">Small</Button>
          <Button variant="ghost" size="md">Default</Button>
          <Button variant="ghost" size="lg">Large</Button>
        </Row>
        <Row label="Destructive">
          <Button variant="destructive" size="xs">Remove</Button>
          <Button variant="destructive" size="sm">Remove</Button>
          <Button variant="destructive" size="md">Remove</Button>
          <Button variant="destructive" size="lg">Remove</Button>
        </Row>
        <Row label="Link">
          <Button variant="link" size="xs">Read more</Button>
          <Button variant="link" size="sm">Read more</Button>
          <Button variant="link" size="md">Read more</Button>
          <Button variant="link" size="lg">Read more</Button>
        </Row>
        <Row label="With icons">
          <Button iconLeft={<Plus />}>Add asset</Button>
          <Button variant="secondary" iconRight={<ChevronRight />}>Continue</Button>
          <Button variant="outline" iconLeft={<Plus />} iconRight={<ChevronRight />}>
            Both
          </Button>
        </Row>
        <Row label="States">
          <Button loading>Submitting</Button>
          <Button disabled>Disabled</Button>
          <Button variant="secondary" disabled>Disabled</Button>
          <Button variant="outline" loading>Loading</Button>
        </Row>
        <Row label="Full width">
          <div className="w-full max-w-md">
            <Button fullWidth>Confirm transaction</Button>
          </div>
        </Row>
      </Card>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

function SearchIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" strokeLinecap="round" />
    </svg>
  );
}

function Field({ label, children, hint }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <FormLabel hint={hint}>{label}</FormLabel>
      {children}
    </div>
  );
}

function InputsSection() {
  const [amount, setAmount] = useState("12.4500");
  return (
    <Section
      id="inputs"
      eyebrow="Form"
      title="Inputs"
      subtitle="Three sizes, optional adornment / addon, opt-in numeric font. Heights align 1:1 with Button."
    >
      <Card>
        <FieldGroupHeading>Sizes</FieldGroupHeading>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <Field label="Small (h-9)"><Input inputSize="sm" placeholder="Small" /></Field>
          <Field label="Default (h-10)"><Input inputSize="md" placeholder="Default" /></Field>
          <Field label="Large (h-12)"><Input inputSize="lg" placeholder="Large" /></Field>
        </div>
      </Card>

      <Card>
        <FieldGroupHeading>Adornment & addon</FieldGroupHeading>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <Field label="Search">
            <Input adornmentLeft={<SearchIcon />} placeholder="Search markets" />
          </Field>
          <Field label="Amount" hint="balance: 12.34 SOL">
            <Input
              numeric
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              addonRight={
                <>
                  <button className="text-primary text-[11px]">MAX</button>
                  <span>SOL</span>
                </>
              }
            />
          </Field>
          <Field label="Numeric body">
            <Input numeric defaultValue="1234.5678" />
          </Field>
          <Field label="Sans body (default)">
            <Input defaultValue="A regular text field" />
          </Field>
        </div>
      </Card>

      <Card>
        <FieldGroupHeading>States</FieldGroupHeading>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <Field label="With helper">
            <Input
              numeric
              defaultValue="12.34"
              helperText="Available: 12.34 SOL"
              addonRight={<span>SOL</span>}
            />
          </Field>
          <Field label="Invalid">
            <Input
              defaultValue="0xnotanaddress"
              invalid
              helperText="Invalid address checksum."
            />
          </Field>
          <Field label="Disabled">
            <Input defaultValue="Locked while syncing…" disabled />
          </Field>
          <Field label="Aligned with Button">
            <div className="flex gap-2.5">
              <Input numeric placeholder="0.00" addonRight={<span>USDC</span>} />
              <Button>Deposit</Button>
            </div>
          </Field>
        </div>
      </Card>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Money — TokenAmountInput                                                    */
/* -------------------------------------------------------------------------- */

function MoneySection() {
  const [a, setA] = useState("");
  const [b, setB] = useState("12.4500");
  const [c, setC] = useState("9999.99");
  return (
    <Section
      id="money"
      eyebrow="Form / Crypto"
      title="TokenAmountInput"
      subtitle="First-class money input. Built-in label, balance affordance, MAX pill, distinct token chip — replaces the Input + addonRight composition pattern."
    >
      <Card>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <TokenAmountInput
            label="Default"
            symbol="USDC"
            value={a}
            onChange={setA}
            balance={21.10}
            balanceDecimals={2}
            onMax={() => setA("21.10")}
          />
          <TokenAmountInput
            label="With value"
            symbol="SOL"
            value={b}
            onChange={setB}
            balance={12.345678}
            onMax={() => setB("12.3456")}
            helperText="Leaves 0.01 SOL for fees + ATA rent."
          />
          <TokenAmountInput
            label="Invalid (over balance)"
            symbol="USDC"
            value={c}
            onChange={setC}
            balance={21.10}
            balanceDecimals={2}
            onMax={() => setC("21.10")}
            invalid
            errorText="Exceeds wallet balance (21.10 USDC)."
          />
          <TokenAmountInput
            label="Large size"
            inputSize="lg"
            symbol="ceUSX"
            value={b}
            onChange={setB}
            balance={54.22}
            balanceDecimals={2}
            onMax={() => setB("54.22")}
          />
          <TokenAmountInput
            label="No balance / no MAX"
            symbol="ETH"
            value={a}
            onChange={setA}
          />
          <TokenAmountInput
            label="Disabled"
            symbol="USDT"
            value="0.00"
            onChange={() => undefined}
            balance={100}
            balanceDecimals={2}
            disabled
          />
        </div>
      </Card>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Stats                                                                       */
/* -------------------------------------------------------------------------- */

function StatsSection() {
  return (
    <Section
      id="stats"
      eyebrow="Data / KPI"
      title="Stat"
      subtitle="KPI tile — label, big figure, optional unit/caption/accent. Replaces the inline Card + StatLabel + figure pattern."
    >
      <Card>
        <FieldGroupHeading>Hero (icon + token-coloured halo)</FieldGroupHeading>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Stat icon={<TokenIcon symbol="USDC"  size="lg" />} iconHalo={tokenBrandColor("USDC")}  label="USDC balance" value="21.10"  caption="wallet" />
          <Stat icon={<TokenIcon symbol="USDT"  size="lg" />} iconHalo={tokenBrandColor("USDT")}  label="USDT balance" value="100.00" caption="wallet" />
          <Stat icon={<TokenIcon symbol="USX"   size="lg" />} iconHalo={tokenBrandColor("USX")}   label="USX balance"  value="0.00"   caption="wallet" />
          <Stat icon={<TokenIcon symbol="eUSX"  size="lg" />} iconHalo={tokenBrandColor("eUSX")}  label="eUSX balance" value="0.08"   caption="wallet" />
          <Stat icon={<TokenIcon symbol="ceUSX" size="lg" />} iconHalo={tokenBrandColor("ceUSX")} label="ceUSX balance" value="54.22" caption="wallet" />
        </div>
      </Card>
      <Card>
        <FieldGroupHeading>Plain — no icon, optional accent stripe</FieldGroupHeading>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Stat label="Total value locked" value="184.2" unit="M USD" accent="primary" caption="across all institutional vaults" />
          <Stat label="Supply APY" value="4.82" unit="%" accent="info" caption="30-day average" />
          <Stat label="Utilization" value="68" unit="%" accent="accent" caption="all reserves" />
        </div>
      </Card>
      <Card>
        <FieldGroupHeading>Interactive (hover lifts)</FieldGroupHeading>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Stat interactive icon={<TokenIcon symbol="SOL" />}   label="Native SOL" value="12.345" caption="wallet" />
          <Stat interactive icon={<TokenIcon symbol="csSOL" />} label="csSOL"      value="8.211"  caption="wallet" />
          <Stat interactive icon={<TokenIcon symbol="JitoSOL" />} label="JitoSOL"  value="3.107"  caption="wallet" />
        </div>
      </Card>
      <Card>
        <FieldGroupHeading>TokenIcon palette</FieldGroupHeading>
        <div className="flex flex-wrap items-center gap-5">
          {(["USDC","USDT","DAI","USX","eUSX","ceUSX","SOL","wSOL","csSOL","JitoSOL","BTC","ETH"] as const).map((sym) => (
            <div key={sym} className="flex flex-col items-center gap-2">
              <TokenIcon symbol={sym} size="lg" />
              <code className="text-[10px] text-base-content/55">{sym}</code>
            </div>
          ))}
        </div>
        <div className="mt-6 text-xs text-base-content/55">
          The gold ring on <code>ceUSX</code> and <code>csSOL</code> marks them
          as KYC-wrapped variants of <code>eUSX</code> / <code>SOL</code>.
        </div>
      </Card>
      <Card>
        <FieldGroupHeading>Position kind (corner indicator)</FieldGroupHeading>
        <div className="flex flex-wrap items-end gap-8">
          <div className="flex flex-col items-center gap-2">
            <TokenIcon symbol="USDC" size="lg" />
            <code className="text-[10px] text-base-content/55">wallet</code>
          </div>
          <div className="flex flex-col items-center gap-2">
            <TokenIcon symbol="ceUSX" size="lg" kind="claim" />
            <code className="text-[10px] text-base-content/55">claim · supplied</code>
          </div>
          <div className="flex flex-col items-center gap-2">
            <TokenIcon symbol="USDC" size="lg" kind="debt" />
            <code className="text-[10px] text-base-content/55">debt · borrowed</code>
          </div>
          <div className="flex flex-col items-center gap-2">
            <TokenIcon symbol="csSOL" size="lg" kind="claim" />
            <code className="text-[10px] text-base-content/55">wrapped + claim</code>
          </div>
        </div>
      </Card>
      <Card>
        <FieldGroupHeading>Sizes & options</FieldGroupHeading>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Stat
            size="sm"
            label="Native SOL"
            value="12.3456"
            unit="SOL"
            accent="info"
          />
          <Stat
            size="md"
            label="Total value locked"
            value="184.2"
            unit="M USD"
            accent="primary"
            caption="across all institutional vaults"
            trailing={<Badge tone="success" variant="soft" size="xs">+2.4%</Badge>}
          />
          <Stat
            size="lg"
            label="Supply APY"
            value="4.82"
            unit="%"
            accent="accent"
            caption="30-day average"
          />
        </div>
      </Card>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Cards                                                                       */
/* -------------------------------------------------------------------------- */

function CardsSection() {
  return (
    <Section
      id="cards"
      eyebrow="Surface"
      title="Cards"
      subtitle="Three tones × three densities. Use elevated for primary panels, flat on coloured surfaces, muted for secondary blocks."
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <Card tone="elevated" size="md">
          <CardHeader
            eyebrow="Elevated"
            title="Total value locked"
            subtitle="Across all institutional vaults."
          />
          <div className="figure text-3xl">$184.2M</div>
          <CardFooter divider>
            <Button size="sm" variant="secondary">Details</Button>
            <Button size="sm">Deposit</Button>
          </CardFooter>
        </Card>
        <Card tone="flat" size="md">
          <CardHeader eyebrow="Flat" title="Reserve health" />
          <KeyValue label="LTV" value="64.2%" />
          <KeyValue label="Liquidation" value="78.0%" />
          <KeyValue label="Health factor" value="1.42" />
        </Card>
        <Card tone="muted" size="md">
          <CardHeader eyebrow="Muted" title="Notes" />
          <p className="text-sm text-base-content/70">
            Use a muted tone for secondary panels — it sits one elevation
            below an elevated card and is comfortable on coloured backgrounds.
          </p>
        </Card>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <Card size="sm">
          <Eyebrow>Small</Eyebrow>
          <p className="mt-1 text-sm">Dense info row, used inside a parent panel.</p>
        </Card>
        <Card size="md">
          <Eyebrow>Default</Eyebrow>
          <p className="mt-1 text-sm">Standalone primary panel.</p>
        </Card>
        <Card size="lg">
          <Eyebrow>Large</Eyebrow>
          <p className="mt-1 text-sm">Page-level hero panels — generous breathing room.</p>
        </Card>
      </div>
      <Card>
        <FieldGroupHeading>Interactive (hover me)</FieldGroupHeading>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <Card interactive size="md">
            <Eyebrow>Selectable</Eyebrow>
            <div className="font-display text-base font-medium mt-1">Conservative</div>
            <p className="mt-1.5 text-xs text-base-content/55">Lower yield, lower risk.</p>
          </Card>
          <Card interactive size="md">
            <Eyebrow>Selectable</Eyebrow>
            <div className="font-display text-base font-medium mt-1">Moderate</div>
            <p className="mt-1.5 text-xs text-base-content/55">Balanced exposure.</p>
          </Card>
          <Card interactive size="md">
            <Eyebrow>Selectable</Eyebrow>
            <div className="font-display text-base font-medium mt-1">Aggressive</div>
            <p className="mt-1.5 text-xs text-base-content/55">Higher yield, higher risk.</p>
          </Card>
        </div>
      </Card>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Badges                                                                      */
/* -------------------------------------------------------------------------- */

function BadgesSection() {
  const tones = ["neutral", "primary", "info", "success", "warning", "error"] as const;
  return (
    <Section
      id="badges"
      eyebrow="Status"
      title="Badges"
      subtitle="Soft is the default — readable on light surfaces. Solid for emphasis, outline for low-density rows."
    >
      <Card>
        <Row label="Soft (default)">
          {tones.map((t) => (
            <Badge key={t} tone={t}>{t}</Badge>
          ))}
        </Row>
        <Row label="Solid">
          {tones.map((t) => (
            <Badge key={t} tone={t} variant="solid">{t}</Badge>
          ))}
        </Row>
        <Row label="Outline">
          {tones.map((t) => (
            <Badge key={t} tone={t} variant="outline">{t}</Badge>
          ))}
        </Row>
        <Row label="Sizes">
          <Badge size="xs" tone="primary">XS</Badge>
          <Badge size="sm" tone="primary">SM</Badge>
          <Badge size="md" tone="primary">MD</Badge>
        </Row>
      </Card>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                      */
/* -------------------------------------------------------------------------- */

function LabelsSection() {
  return (
    <Section
      id="labels"
      eyebrow="Form / Data"
      title="Labels"
      subtitle="FormLabel above inputs, StatLabel above KPIs, KeyValue inside summary panels."
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Card>
          <FieldGroupHeading>Form labels</FieldGroupHeading>
          <FormLabel htmlFor="x" required>Required field</FormLabel>
          <Input id="x" placeholder="Required" />
          <div className="mt-4">
            <FormLabel htmlFor="y" hint="balance: 102.3 USDC">Amount</FormLabel>
            <Input id="y" numeric defaultValue="100.00" addonRight={<span>USDC</span>} />
          </div>
        </Card>
        <Card>
          <FieldGroupHeading>Stat labels</FieldGroupHeading>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <StatLabel>Supply APY</StatLabel>
              <div className="figure text-2xl mt-1">4.82%</div>
            </div>
            <div>
              <StatLabel>Borrow APY</StatLabel>
              <div className="figure text-2xl mt-1">7.14%</div>
            </div>
            <div>
              <StatLabel>Utilization</StatLabel>
              <div className="figure text-2xl mt-1">68%</div>
            </div>
          </div>
          <div className="mt-6">
            <FieldGroupHeading>KeyValue rows</FieldGroupHeading>
            <KeyValue label="Network fee" value="≈ 0.000045 SOL" />
            <KeyValue label="Slippage" value="0.30%" />
            <KeyValue label="Min received" value="12.18 SOL" withLeader />
            <KeyValue compact label="Compact row" value="42.0" />
          </div>
        </Card>
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Tabs                                                                        */
/* -------------------------------------------------------------------------- */

function TabsSection() {
  const [u, setU] = useState("positions");
  const [p, setP] = useState("long");
  const [s, setS] = useState("conservative");
  const [sec, setSec] = useState("supply");
  return (
    <Section
      id="tabs"
      eyebrow="Navigation"
      title="Tabs"
      subtitle="Underline (page), pill (sub-section), segmented (binary), section (card-style)."
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Card>
          <FieldGroupHeading>Underline</FieldGroupHeading>
          <Tabs.Root value={u} onValueChange={setU} variant="underline">
            <Tabs.List withRail>
              <Tabs.Trigger value="positions">Positions</Tabs.Trigger>
              <Tabs.Trigger value="collateral">Collateral</Tabs.Trigger>
              <Tabs.Trigger value="trade" badge={<Badge size="xs" tone="success">3</Badge>}>Trade</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="positions" className="pt-4 text-sm text-base-content/70">
              Positions panel content.
            </Tabs.Content>
            <Tabs.Content value="collateral" className="pt-4 text-sm text-base-content/70">
              Collateral panel content.
            </Tabs.Content>
            <Tabs.Content value="trade" className="pt-4 text-sm text-base-content/70">
              Trade panel content.
            </Tabs.Content>
          </Tabs.Root>
        </Card>

        <Card>
          <FieldGroupHeading>Pill</FieldGroupHeading>
          <Tabs.Root value={p} onValueChange={setP} variant="pill">
            <Tabs.List>
              <Tabs.Trigger value="long">Long</Tabs.Trigger>
              <Tabs.Trigger value="short">Short</Tabs.Trigger>
            </Tabs.List>
          </Tabs.Root>
        </Card>

        <Card>
          <FieldGroupHeading>Segmented</FieldGroupHeading>
          <Tabs.Root value={s} onValueChange={setS} variant="segmented">
            <Tabs.List>
              <Tabs.Trigger value="conservative">Conservative</Tabs.Trigger>
              <Tabs.Trigger value="moderate">Moderate</Tabs.Trigger>
              <Tabs.Trigger value="aggressive">Aggressive</Tabs.Trigger>
            </Tabs.List>
          </Tabs.Root>
        </Card>

        <Card>
          <FieldGroupHeading>Section (card-style)</FieldGroupHeading>
          <Tabs.Root value={sec} onValueChange={setSec} variant="section">
            <Tabs.List>
              <Tabs.Trigger value="supply">
                <Eyebrow>Action</Eyebrow>
                <div className="font-display text-sm font-medium mt-0.5">Supply</div>
              </Tabs.Trigger>
              <Tabs.Trigger value="borrow">
                <Eyebrow>Action</Eyebrow>
                <div className="font-display text-sm font-medium mt-0.5">Borrow</div>
              </Tabs.Trigger>
              <Tabs.Trigger value="repay">
                <Eyebrow>Action</Eyebrow>
                <div className="font-display text-sm font-medium mt-0.5">Repay</div>
              </Tabs.Trigger>
            </Tabs.List>
          </Tabs.Root>
        </Card>

        <Card className="md:col-span-2">
          <FieldGroupHeading>Section with icons (pipeline switcher)</FieldGroupHeading>
          <Tabs.Root value={sec} onValueChange={setSec} variant="section">
            <Tabs.List>
              <Tabs.Trigger
                value="supply"
                icon={<TokenIcon symbol="ceUSX" size="md" />}
                badge={<Badge tone="primary" variant="soft" size="xs">EG-1</Badge>}
              >
                <Eyebrow>Stablecoin pipeline</Eyebrow>
                <div className="font-display text-base font-medium tracking-[-0.01em] mt-1.5">
                  USDC / USDT → ceUSX
                </div>
                <p className="text-xs text-base-content/55 leading-relaxed mt-1 pr-2">
                  Mint USX, lock for eUSX yield, wrap into KYC-gated collateral.
                </p>
              </Tabs.Trigger>
              <Tabs.Trigger
                value="borrow"
                icon={<TokenIcon symbol="csSOL" size="md" />}
                badge={<Badge tone="primary" variant="soft" size="xs">EG-2</Badge>}
              >
                <Eyebrow>LST pipeline</Eyebrow>
                <div className="font-display text-base font-medium tracking-[-0.01em] mt-1.5">
                  SOL → csSOL
                </div>
                <p className="text-xs text-base-content/55 leading-relaxed mt-1 pr-2">
                  Single-signature Jito-vault stake, minted as KYC-gated csSOL.
                </p>
              </Tabs.Trigger>
            </Tabs.List>
          </Tabs.Root>
        </Card>
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Snackbars                                                                   */
/* -------------------------------------------------------------------------- */

function SnackbarsSection() {
  const [toast, setToast] = useState<null | "info" | "success" | "warning" | "error">(null);
  return (
    <Section
      id="snackbars"
      eyebrow="Feedback"
      title="Snackbars"
      subtitle="Inline status surface and fixed-position toast. Severity stripe + icon for colour-blind safety."
    >
      <Card>
        <FieldGroupHeading>Inline</FieldGroupHeading>
        <div className="space-y-3">
          <Snackbar type="info" message="The reserve will rebalance at the next epoch." />
          <Snackbar
            type="success"
            message="Deposit confirmed."
            detail="3yPyEzkMz5jzCq…cWk6eMCS4Y"
          />
          <Snackbar
            type="warning"
            message="Health factor approaching liquidation threshold."
            action={<Button size="sm" variant="secondary">Review</Button>}
          />
          <Snackbar
            type="error"
            message="Transaction reverted: insufficient collateral."
            detail="TransactionExpiredBlockheightExceededError"
            onDismiss={() => undefined}
          />
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setToast("success")}>Trigger success toast</Button>
          <Button size="sm" variant="secondary" onClick={() => setToast("info")}>Trigger info toast</Button>
          <Button size="sm" variant="destructive" onClick={() => setToast("error")}>Trigger error toast</Button>
        </div>
      </Card>
      {toast && (
        <Snackbar
          type={toast}
          variant="toast"
          message={
            toast === "success" ? "Saved." :
            toast === "error" ? "Something went wrong." :
            "Heads up — sync running in the background."
          }
          dismissAfterMs={3000}
          onDismiss={() => setToast(null)}
        />
      )}
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Tokens                                                                      */
/* -------------------------------------------------------------------------- */

const STONE = ["stone-0", "stone-1", "stone-2", "stone-3", "stone-4", "stone-5"];
const SEMANTIC = [
  "primary", "secondary", "accent",
  "info", "success", "warning", "error",
  "base-100", "base-200", "base-300",
];
const RADII = ["xs", "sm", "md", "lg", "xl"];
const SHADOWS = [
  { name: "stone", token: "var(--shadow-stone)" },
  { name: "stone-md", token: "var(--shadow-stone-md)" },
  { name: "stone-lg", token: "var(--shadow-stone-lg)" },
  { name: "well", token: "var(--shadow-well)" },
];

function Swatch({ name, varName }: { name: string; varName: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div
        className="h-16 rounded-lg border border-base-300/70"
        style={{ background: `var(--color-${varName})` }}
      />
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold">{name}</span>
        <code className="text-[10px] text-base-content/55">--color-{varName}</code>
      </div>
    </div>
  );
}

function TokensSection() {
  return (
    <Section
      id="tokens"
      eyebrow="Foundations"
      title="Tokens"
      subtitle="Brand palette, semantic colours, radii, and elevation."
    >
      <Card>
        <FieldGroupHeading>Stone palette</FieldGroupHeading>
        <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
          {STONE.map((s) => (
            <Swatch key={s} name={s} varName={s} />
          ))}
        </div>
      </Card>
      <Card>
        <FieldGroupHeading>Semantic</FieldGroupHeading>
        <div className="grid grid-cols-3 md:grid-cols-5 gap-3">
          {SEMANTIC.map((s) => (
            <Swatch key={s} name={s} varName={s} />
          ))}
        </div>
      </Card>
      <Card>
        <FieldGroupHeading>Radii</FieldGroupHeading>
        <div className="flex flex-wrap gap-5">
          {RADII.map((r) => (
            <div key={r} className="flex flex-col items-center gap-2">
              <div
                className="h-16 w-16 bg-base-300 border border-base-300"
                style={{ borderRadius: `var(--radius-${r})` }}
              />
              <code className="text-[10px] text-base-content/55">--radius-{r}</code>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <FieldGroupHeading>Elevation</FieldGroupHeading>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
          {SHADOWS.map((s) => (
            <div key={s.name} className="flex flex-col items-center gap-3">
              <div
                className="h-20 w-full rounded-lg bg-base-100 border border-base-300"
                style={{ boxShadow: s.token }}
              />
              <code className="text-[10px] text-base-content/55">--shadow-{s.name}</code>
            </div>
          ))}
        </div>
      </Card>
    </Section>
  );
}
