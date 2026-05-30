# @clearstone/design-system

Shared brand tokens, theme, fonts, and logo assets for all Clearstone Fusion frontends.

## Wire it into a Vite + Tailwind 4 + DaisyUI app

In the package's `package.json`, add:

```json
"dependencies": { "@clearstone/design-system": "workspace:*" }
```

In the app's entry stylesheet (`src/index.css` or `src/app.css`):

```css
@import "tailwindcss";
@plugin "daisyui" { themes: clearstone --default; }
@import "@clearstone/design-system/fonts.css";
@import "@clearstone/design-system/theme.css";
```

That's it. The `clearstone` DaisyUI theme is now the default, Tailwind v4 picks up the brand color tokens (`bg-stone-3`, `text-fusion`, …), and the typography stack (`font-display` / `font-sans`) is wired.

## What's exported

| Path | Purpose |
|---|---|
| `@clearstone/design-system/theme.css` | Tailwind 4 `@theme` tokens + DaisyUI custom theme + global resets + utility classes (`.panel`, `.brand-wordmark`, `.num`) |
| `@clearstone/design-system/fonts.css`  | Quicksand (display) + Inter (UI) from Google Fonts |
| `@clearstone/design-system/logo.svg`     | Brand logo (use everywhere — header, favicon, marketing) |

## Palette

| Token | Hex | Use |
|---|---|---|
| `stone-0` | `#E2E7EF` | brightest highlight, on-dark text |
| `stone-1` | `#C5CFDC` | light face / hover |
| `stone-2` | `#A6B3C5` | borders, muted UI |
| `stone-3` | `#7C8BA3` | secondary text, accents |
| `stone-4` | `#4F607C` | brand "clearstone" — buttons, links |
| `stone-5` | `#1F2D48` | brand "fusion" — headlines, primary CTA |

## Typography

- **Display / wordmark**: Quicksand. `clearstone` set in 600 (medium-bold), `fusion` set in 300 with `letter-spacing: 0.22em` and `lowercase`.
- **UI body**: Inter, weights 400/500/600/700. Tabular numbers (`.num`) for prices, TVL, rates — use everywhere money is rendered.

## Wordmark example

```tsx
<div className="flex items-baseline gap-3 font-display">
  <span className="brand-wordmark text-3xl text-fusion">clearstone</span>
  <span className="brand-wordmark-thin text-xl text-stone-3">fusion</span>
</div>
```

## Logo usage

```tsx
import logo from "@clearstone/design-system/logo.svg";

<img src={logo} alt="Clearstone Fusion" className="h-10" />
```
