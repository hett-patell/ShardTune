# ShardTune Design Theme

> Derived from **ShardPass** (Swiss Vermillion shell) × **ShardPet** (Pixel Arcade overlay).  
> Accent swapped from vermillion → Spotify Green. Built for a Brave/Chrome MV3 extension popup.

---

## Art Direction

```
Concept:    CRT terminal meets Spotify
Tone:       Dark, focused, pixel-edged — functional but with personality
Palette:    Near-black graphite surfaces + single Spotify green accent
Typography: Press Start 2P (labels only) + Inter Tight (UI) + IBM Plex Mono (data)
Density:    Dense — 380×580px popup, every pixel earns its place
Motion:     Subtle — 150–220ms, golden easing, no theatrics in daily UI
```

---

## Color Tokens

### Surfaces (ShardPass graphite stack)

| Token | Hex | Usage |
|---|---|---|
| `--bg` | `#0c0c0d` | Root background |
| `--surface` | `#18181b` | Cards, now-playing section |
| `--elevated` | `#1c1c20` | Buttons, inputs, raised elements |
| `--subtle` | `#131316` | Header, volume row, recessed areas |
| `--border` | `#26262b` | Standard dividers |
| `--border-soft` | `#1d1d21` | Ghost borders, very subtle separation |
| `--border-strong` | `#3a3a40` | Emphasis borders, waveform inactive bars |

### Text

| Token | Hex | Usage |
|---|---|---|
| `--fg` | `#f4f4f5` | Primary text |
| `--fg-muted` | `#a1a1aa` | Secondary text, artist name, ctrl buttons |
| `--fg-faint` | `#52525b` | Tertiary — timestamps, queue numbers, labels |

### Accent — Spotify Green

| Token | Value | Usage |
|---|---|---|
| `--green` | `#1db954` | Primary accent — progress fill, play btn, liked state, active waveform bars |
| `--green-dim` | `#158a3e` | Hover states on green surfaces |
| `--green-glow` | `0 0 10px rgba(29,185,84,0.45)` | box-shadow glow — progress cursor, heart liked, logo |
| `--green-glow-lg` | `0 0 20px rgba(29,185,84,0.3)` | Larger glow — play button hover |

### Semantic

| Token | Hex | Usage |
|---|---|---|
| `--destructive` | `#ef4444` | Error states |
| `--success` | `#4ade80` | Positive indicators |
| `--warning` | `#f59e0b` | Warnings |

---

## Typography

### Font Stack

| Role | Font | Fallback |
|---|---|---|
| **Pixel labels** | `Press Start 2P` | `ui-monospace, "Courier New", monospace` |
| **UI / body** | `Inter Tight` | `ui-sans-serif, system-ui, sans-serif` |
| **Numeric / mono** | `IBM Plex Mono` | `ui-monospace, monospace` |

**Google Fonts import:**
```css
@import url("https://fonts.googleapis.com/css2?family=Press+Start+2P&family=Inter+Tight:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap");
```

### Size Rules

| Context | Font | Size | Notes |
|---|---|---|---|
| Logo | Press Start 2P | 9px | Green, glow text-shadow |
| Section labels | Press Start 2P | 6–7px | Uppercase, 0.14–0.16em tracking, `--fg-faint` |
| Track name | Inter Tight 600 | 13px | Primary fg |
| Artist / sub | Inter Tight 400 | 11px | `--fg-muted` |
| Body / queue | Inter Tight 500 | 12–13px | — |
| Timestamps | IBM Plex Mono | 10px | `tabular-nums`, `--fg-faint` |
| Stat values | IBM Plex Mono 600 | 18px | `tabular-nums` |
| Volume % | IBM Plex Mono | 10px | `--fg-faint` |

> **Rule:** Press Start 2P is used ONLY for logo and section labels — never for readable body text. It exists as a decorative signal, not a reading font.

---

## Geometry

### Border Radius
Zero-radius philosophy inherited from ShardPass. Maximum `2px` on any element — never rounded cards.

```css
--radius: 0px;   /* default — most elements */
--radius-xs: 2px; /* device chip, tooltips only */
```

### Borders
All borders use alpha-blended values — never solid opaque grey.

```css
/* Standard card border */
border: 2px solid rgba(255, 255, 255, 0.08);

/* Divider */
border-bottom: 1px solid var(--border); /* #26262b */

/* Pixel border on interactive cards */
border: var(--px-border); /* 2px solid rgba(255,255,255,0.08) */
```

### Pixel Hard Shadow
ShardPet-style offset shadow — no blur, just displacement.

```css
--px-shadow: 3px 3px 0 rgba(0, 0, 0, 0.6);
```

Used on: album art, play button, stat cards.

### Pixel Corner Accents
CSS `::before` / `::after` corner brackets — top-left or bottom-left.

```css
/* Top-left bracket */
.el::after {
  content: '';
  position: absolute;
  top: 0; left: 0;
  width: 6px; height: 6px;
  border-top: 2px solid var(--green);
  border-left: 2px solid var(--green);
  opacity: 0.7;
}

/* Bottom-left bracket */
.el::before {
  content: '';
  position: absolute;
  bottom: 0; left: 0;
  width: 5px; height: 5px;
  border-bottom: 2px solid var(--green);
  border-left: 2px solid var(--green);
  opacity: 0.5;
}
```

---

## Scanline Overlay
CRT texture on header/hero surfaces. ShardPet-inspired.

```css
.header::after {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    to bottom,
    transparent 0px,
    transparent 3px,
    rgba(255, 255, 255, 0.015) 3px,
    rgba(255, 255, 255, 0.015) 4px
  );
  pointer-events: none;
}
```

---

## Motion

### Easing (ShardPass)
```css
--ease: cubic-bezier(0.16, 1, 0.3, 1);
```
Golden curve — fast start, soft settle. Used on all transitions.

### Durations

| Action | Duration | Notes |
|---|---|---|
| Hover state | `150ms` | Buttons, controls |
| Fade in | `200ms` | Dialogs, overlays |
| Slide in | `220ms` | Panel transitions |
| Progress bar | `1s linear` | Track seek simulation |
| Waveform bars | `0.4s–0.9s ease-in-out infinite` | Staggered via `--d` CSS var |
| Device dot pulse | `2s ease-in-out infinite` | Opacity 1 → 0.4 |
| Note bob | `1.8s / 0.9s ease-in-out infinite` | Slower when paused, faster when playing |

### Button Active State (ShardPet pixel press)
```css
.play-btn:active {
  transform: scale(0.96) translate(1px, 1px);
  box-shadow: 1px 1px 0 rgba(0, 0, 0, 0.6); /* shadow collapses = pressed in */
}
```

---

## Component Patterns

### Play Button
```css
background: var(--green);
color: #000;
width: 36px; height: 36px;
border-radius: 0; /* sharp — no rounding */
box-shadow: var(--px-shadow), var(--green-glow);
```
On hover: `scale(1.05)` + `var(--green-glow-lg)`. On active: collapse shadow.

### Progress Bar
```css
height: 3px;
background: var(--elevated);
border: 1px solid var(--border);

/* Fill */
background: var(--green);
box-shadow: var(--green-glow);

/* Pixel cursor (::after on fill) */
width: 7px; height: 7px;
background: var(--green);
box-shadow: var(--green-glow-lg);
border-radius: 0; /* square cursor */
```

### Stat Cards
```css
background: var(--surface);
border: 2px solid rgba(255, 255, 255, 0.08);
padding: 10px 12px;
/* + bottom-left pixel corner accent */
```
Highlighted variant: `--stat-val` color → `var(--green)` + `text-shadow: var(--green-glow)`.

### Section Labels (Press Start 2P caps)
```css
font-family: var(--font-px);
font-size: 6px; /* or 7px */
letter-spacing: 0.14em;
text-transform: uppercase;
color: var(--fg-faint);
```

### Device Chip
```css
font-family: var(--font-mono);
font-size: 9px;
font-weight: 500;
letter-spacing: 0.1em;
text-transform: uppercase;
background: var(--surface);
border: 1px solid var(--border);
padding: 3px 7px;
border-radius: 0;
```
Live dot: `5px` circle, `var(--green)`, `box-shadow: var(--green-glow)`, pulse animation.

### Queue Items
```css
padding: 7px 8px;
cursor: pointer;
transition: background 120ms var(--ease);
/* hover → background: var(--surface) */
```
Numbers in `--font-mono` 10px `--fg-faint`. Thumbnails: 28px square, `var(--elevated)`, 1px border.

---

## Waveform Visualizer
Bars generated in JS, heights defined via `--h` CSS custom property.

```css
.bar {
  flex: 1;
  background: var(--border-strong); /* inactive */
  min-height: 3px;
}

.bar.active {
  background: var(--green);
  box-shadow: 0 0 4px rgba(29, 185, 84, 0.5);
}

@keyframes wave {
  0%, 100% { height: var(--h); }
  50%       { height: calc(var(--h) * 0.4); }
}

.bar.playing {
  animation: wave calc(0.4s + var(--d, 0s)) ease-in-out infinite;
  /* --d staggered per bar: i * 0.06s */
}
```

---

## Extension Popup Dimensions
```css
body {
  width: 380px;
  min-height: 580px;
}
```

---

## Inheritance Map

| Design Decision | Source |
|---|---|
| Dark graphite surface stack | ShardPass `globals.css` |
| Inter Tight + IBM Plex Mono | ShardPass `globals.css` |
| `cubic-bezier(0.16,1,0.3,1)` easing | ShardPass `globals.css` |
| Zero border-radius philosophy | ShardPass `globals.css` |
| Alpha-blended borders | ShardPass `globals.css` |
| 200ms fade/slide animations | ShardPass `globals.css` |
| Press Start 2P pixel font | ShardPet `overlay.css` |
| Hard pixel offset shadow | ShardPet `overlay.css` |
| Pixel corner bracket accents | ShardPet (adapted) |
| Scanline CRT overlay | ShardPet (adapted) |
| Square pixel button press animation | ShardPet `overlay.css` |
| Spotify Green `#1db954` accent | ShardTune (new) |
| Green glow `box-shadow` system | ShardTune (new) |
| Animated waveform visualizer | ShardTune (new) |
| Device live-dot pulse | ShardTune (new) |
