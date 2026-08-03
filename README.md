# @magic-spells/sheet

**~22 kB** gzipped (`dist/sheet.min.js`, with dialog-panel and all three engines bundled) plus **~1.7 kB** for `dist/sheet.min.css`. The build measures both from the real artifacts into `demo/dist/sizes.json`, so the demo shows the exact figure.

Gesture-driven edge sheets and floating cards built on a real native `<dialog>` through `@magic-spells/dialog-panel`. This package adds spring motion, bottom-sheet snap points, drag/flick policy, and responsive presentation profiles.

🔍 **[Live Demo](https://magic-spells.github.io/sheet/demo/)** - See it in action!

## Features

- Bottom, left, and right edge sheets, plus a centered dialog profile
- Inset card mode with independently configurable desktop presentation
- Mobile-bottom-only CSS snap points, live dragging, nearest-snap release, and velocity flicks
- Spring motion powered by `@magic-spells/physics-engine` and `@magic-spells/frame-engine`
- Header, footer, handle strip, and scroll-aware content drag surfaces
- Native dialog focus trapping, focus return, Escape handling, and modal semantics
- Safe-area-aware optional footer
- Optional trigger morph via `@magic-spells/morph-engine`: `morph-trigger` grows the panel out of the element passed to `show()` and reverses back into it on a deliberate close

## Installation

```bash
npm install @magic-spells/sheet
```

```js
import '@magic-spells/sheet'; // registers the sheet elements AND <dialog-panel>

import '@magic-spells/dialog-panel/css';
import '@magic-spells/sheet/css';
```

One install, one JS import: this package side-effect imports `@magic-spells/dialog-panel`, so importing it registers `<dialog-panel>` and `<dialog-backdrop>` alongside the four sheet elements. You still write `<dialog-panel>` in your own markup and import its stylesheet.

dialog-panel is a **peer dependency** because it must stay a singleton — it registers a custom element, and a tag name can only be claimed once per document. npm 7+ and pnpm install peers automatically; Yarn 1 only warns, which leaves `<dialog-panel>` undefined at runtime — there, install it explicitly: `yarn add @magic-spells/sheet @magic-spells/dialog-panel`. Every registration is guarded with `customElements.get()`, so a duplicate no-ops instead of throwing.

Physics Engine and Frame Engine are **hard runtime dependencies** — installed automatically, never imported by you. They stay external in the ESM build (your bundler resolves them) and are bundled into the UMD.

The package ships two entry points and no CommonJS build: `dist/sheet.esm.js` for anything with a module graph, and `dist/sheet.min.js` — a UMD carrying every JavaScript dependency — for a plain `<script>` tag. Loading the ESM file in a browser with no bundler needs an import map covering dialog-panel and the engines (the [demo](./demo/index.html) does exactly that), or just use the UMD.

### Without a bundler

`dist/sheet.min.js` bundles the JavaScript but **no CSS**. Link both stylesheets, or you get a full-bleed unstyled native `<dialog>` with nothing on the console to say why:

```html
<link rel="stylesheet" href="https://unpkg.com/@magic-spells/dialog-panel/dist/dialog-panel.min.css" />
<link rel="stylesheet" href="https://unpkg.com/@magic-spells/sheet/dist/sheet.min.css" />

<script defer src="https://unpkg.com/@magic-spells/sheet/dist/sheet.min.js"></script>
```

**`defer` is load-bearing, and leaving it off fails quietly.** Without it the elements upgrade before their children exist, so no drag surface binds: the sheet still opens, closes, and returns focus, but **every gesture is dead** and nothing is logged. `defer`, `type="module"`, or a `<script>` at the end of `<body>` all work.

## Usage

Keep the canonical nesting intact. `dialog-panel` owns the native dialog; `sheet-panel` owns presentation and gestures.

```html
<button id="open-sheet">Open sheet</button>

<dialog-panel id="account-panel">
	<dialog aria-labelledby="account-title">
		<sheet-panel
			snap-points="20vh 55vh 90vh"
			initial-snap="1"
			position="bottom"
			mode="edge"
			effect="slide"
			breakpoint="768"
			desktop-position="right"
			desktop-mode="card"
			desktop-exit-effect="fade-scale">
			<sheet-header>
				<h2 id="account-title">Account</h2>
				<button data-action-hide-dialog aria-label="Close">&times;</button>
			</sheet-header>

			<sheet-content>
				<p>Scrollable content goes here.</p>
			</sheet-content>

			<sheet-footer>
				<button>Save changes</button>
			</sheet-footer>
		</sheet-panel>
	</dialog>
</dialog-panel>

<script type="module">
	const trigger = document.querySelector('#open-sheet');
	const sheet = document.querySelector('sheet-panel');
	trigger.addEventListener('click', () => sheet.show(trigger));
</script>
```

Always open through `sheet.show(trigger)`. The trigger is optional and used for focus return (and, with `morph-trigger`, as the box the panel grows out of) — a sheet opened from a timer or route change can call `sheet.show()` bare. Elements with `data-action-hide-dialog` use dialog-panel's built-in delegation.

**Opt the document into the safe area.** Edge sheets and `<sheet-footer>` pad themselves with `env(safe-area-inset-*)`, which resolves to `0px` on iOS unless the viewport meta asks for the full display — without it the footer's buttons sit under the home indicator:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
```

### Growing out of the trigger

Add `morph-trigger` and the panel grows from the trigger's own box instead of sliding in from its edge, then shrinks back into it on close. The destination is whatever the active profile resolves to:

```html
<sheet-panel morph-trigger snap-points="48vh 92vh" desktop-position="right" desktop-mode="card">
```

It is **opt-in on purpose** — every sheet receives a trigger for focus return, so morphing on mere presence would rewrite every entrance on the page. Swipe, snap points, and rubber-band all behave normally once the panel lands.

**Only deliberate closes reverse into the trigger** — close button, Escape, backdrop tap. A swipe dismissal takes the ordinary spring exit instead: a fling owns a direction, and curving it back into the trigger reads as two competing animations. The morph is also skipped (spring runs instead) whenever it can't be done honestly: no trigger passed, trigger detached or scrolled out of view, trigger hidden by the page (the blob renders a clone with visibility forced back on, so it would flash hidden content), or `prefers-reduced-motion`.

**Reduced motion turns the morphs off, not the entrance.** It zeroes `--sheet-morph-duration`, so the panel arrives and leaves on the ordinary spring, and a profile morph collapses to an instant swap.

### Coming back when it does not morph back

A swipe dismissal — or a close after the trigger vanished — has no reverse flight to crossfade the button back in. Rather than snapping it to full opacity under a still-lit scrim, the sheet holds the trigger hidden for the length of the exit and pops it in once the panel and scrim are gone.

Tune it with `--sheet-trigger-return-duration` and `--sheet-trigger-return-easing`; `0` (which `prefers-reduced-motion` sets) restores the button instantly. Override the movement by redefining the keyframes:

```css
@keyframes sheet-trigger-return {
	from {
		opacity: 0;
		transform: translateY(4px);
	}
	to {
		opacity: 1;
		transform: translateY(0);
	}
}
```

While it runs, the trigger carries a `sheet-return` attribute — useful for driving the return from your own CSS entirely.

## Sizing

**`snap-points` is a mobile-profile attribute.** Below `breakpoint`, a bottom sheet can declare multiple snap points; each value is a resting height, and dragging between snaps interpolates height. Below the lowest snap the painted height pins there and the panel follows the finger with `translateY` — at logical size zero it is exactly off-screen, contents unsquished.

At or above `breakpoint` the snap list is **ignored entirely**, whatever the profile. A desktop bottom panel measures its own content height, anchored to the bottom edge, capped by `calc(100dvh - 2 * var(--sheet-card-margin))` and scrolling inside itself past that. It is dismiss-only, like every desktop profile.

Left and right sheets ignore `snap-points` and always have one fixed width from `--sheet-active-size` (default `min(26rem, 90vw)`). Override the token in CSS:

```css
#account-panel > dialog {
	--sheet-active-size: 24rem;
}
```

Side drags move the fixed-width panel with `translateX` and resolve only to open or dismissed.

## Gestures and Snap Rules

The header and optional footer are unconditional drag surfaces, as is the panel's own handle strip — the padding a side sheet draws its pill into. The content hands a touch gesture to the sheet only once the scrollables under the pointer have no room left in that direction:

- A bottom sheet claims downward motion at the content's top and upward motion at its bottom.
- Left and right sheets use the corresponding horizontal scroll edge.
- Nested scrollers count too: a horizontal carousel inside the content scrolls on its own until it reaches its edge, then the gesture passes to the sheet.
- Once claimed, a non-passive `touchmove` veto keeps native scrolling from fighting the sheet.
- Motion past zero or beyond the largest bottom snap gets rubber-band resistance.

**The scrim is not a drag surface.** `showModal()` makes everything outside the dialog inert and the native `::backdrop` wins every hit test in the dim region, so `<dialog-backdrop>` is a paint surface (scrim fill, blur, opacity) and never an event target. Pressing the dim area and pulling moves nothing.

Clicking it does dismiss, subject to `dismiss`, and the rule is geometric rather than timed: the `pointerdown` must have landed on the scrim, and the click must fall outside the dialog's rect. A long slow drag that began on the scrim still closes the sheet; a text selection that began on content and released on the scrim does not. Where the gesture began answers both; how far it travelled answers neither.

For a mobile bottom sheet on release:

- A flick faster than `0.5 px/ms` moves one snap in its direction, measured from the live panel size at release — not the snap where the drag began.
- A dismiss-direction flick from the lowest snap closes the panel.
- A slower release selects the nearest snap; the closed edge participates as a target below the lowest snap.
- Cancelled gestures return to the active snap.

Side sheets, centred dialogs, and a desktop bottom panel all release like a snapless bottom sheet: dismiss or return to their one resting size, with no nearest-snap search.

## Effects

| Effect | Behavior |
| --- | --- |
| `slide` | Travels clear off the configured edge and springs to rest. Carries no blur |
| `fade-scale` | Fades from `0` while scaling from `0.95`, through an `8px` blur; the default for a desktop `center` profile |
| `slide-fade` | Fades with a `24px` edge-directed slide, through a `4px` blur |

Only the two fading effects blur, at different peaks because they have different amounts of other motion to hide behind; a `slide` arrives at full clarity. The blur resolves to `0` on the same frame opacity reaches full — a settled panel can never soften again — and an exit walks it backward. It is **not tunable from CSS**; deliberately no token.

Every profile inherits `effect` unless told otherwise, with one exception: `desktop-effect` defaults to `fade-scale` when `desktop-position` is `center`, because a centered dialog rests against no edge and inheriting `slide` would fly it a viewport height into mid-screen. A mobile `position="center"` still inherits `effect` (default `slide`), so set `effect="fade-scale"` explicitly for a fading centered dialog below the breakpoint.

### Leaving

By default a dismissal walks the same effect's keyframes backward. `exit-effect` and `desktop-exit-effect` break that symmetry: a panel welded to a phone's bottom edge wants to slide back down it, while the same panel floating as a desktop card often reads better shrinking away.

```html
<!-- slides up on a phone, shrinks away as a desktop drawer -->
<sheet-panel
	snap-points="48vh 92vh"
	desktop-position="right"
	desktop-mode="card"
	desktop-exit-effect="fade-scale">…</sheet-panel>
```

A dismissal starts wherever your finger let go, and its track ends **off screen by the panel's own extent, plus whatever gap it already floats by, plus a cushion**. The cushion clears the panel's *shadow*, not just its box — raise `--sheet-exit-cushion` if a soft shadow leaves a halo on the way out. A `fade-scale` exit continuing a live drag carries on outward past the release pose while it shrinks, continuing the gesture rather than contradicting it.

### Refusing to be dismissed

`dismiss` names which of the three implicit routes out stay open. Buttons and a programmatic `hide()` are never affected — they are the answer, not a way out of answering.

```html
<!-- a confirm that really does require an answer -->
<sheet-panel dismiss="none">…</sheet-panel>

<!-- a drawer a stray swipe cannot close, but a click outside still can -->
<sheet-panel dismiss="backdrop escape">…</sheet-panel>
```

| Value | Effect |
| --- | --- |
| absent | All three routes open — swipe, backdrop, Escape |
| `all` | All three open, stated explicitly |
| `none` or `""` | All three refused |
| any subset of `swipe backdrop escape` | Exactly those routes open |

`none` is tested first, so `"all none"` resolves to locked, and an unrecognized token opens nothing — a sheet that refuses a gesture is recoverable; one that closes a confirmation it should have held is not.

A refused sheet still tracks your finger and springs back, so it reads as refusing rather than broken, and `snaprelease` fires with `prevented: true` so you can say why.

## Responsive Profiles

Below `breakpoint`, the mobile `position`, `mode`, and `effect` apply, and a mobile bottom profile uses the complete snap list. At or above it, the desktop attributes apply and **`snap-points` no longer applies at all**: a desktop bottom profile measures its own content height, a desktop side profile uses its single CSS width, and every desktop profile is dismiss-only.

Each desktop attribute falls back to its mobile twin, with two exceptions:

- **A mobile `bottom` position falls out to `center` on the desktop** — a floating card mid-screen reads as a desktop dialog. Say `desktop-position="bottom"` to stay on the bottom edge (still content-sized there, not 85vh).
- **`desktop-mode` does not inherit `mode` — it is always `card` unless you say otherwise.** A sheet welded flush to a phone edge is chrome floating over a page once there is room around it. Say `desktop-mode="edge"` to weld it back.

This is what lets one element be two components:

```html
<sheet-panel snap-points="48vh 92vh" desktop-position="right" desktop-mode="card">…</sheet-panel>

<!-- centred on the desktop by default -->
<sheet-panel snap-points="34vh">…</sheet-panel>

<!-- a bottom sheet on every viewport: 34vh on a phone, content-sized on a desktop -->
<sheet-panel snap-points="34vh" desktop-position="bottom">…</sheet-panel>
```

`center` is the fourth placement. It ignores `snap-points` and `mode` on **every** viewport, takes its width from `--sheet-center-width`, and its **height from its own content** — keep that content short if it should read as a modal. It is still swipe-dismissible downward; a non-dismissing release returns it to rest.

| Attribute | Property | Default | Description |
| --- | --- | --- | --- |
| `snap-points` | `snapPoints` | `85vh` | **Mobile bottom only** — space-separated CSS heights, resolved at open and resize. Ignored past `breakpoint`, and by every non-bottom position |
| `initial-snap` | `initialSnap` | last | Zero-based initial mobile bottom snap |
| `morph-trigger` | `morphsFromTrigger` | absent | Grow out of the trigger passed to `show(trigger)` and shrink back into it on close. Opt-in; falls back to the spring entrance when there is no usable trigger |
| `position` | `position` | `bottom` | Mobile placement: `bottom`, `left`, `right`, or `center` |
| `mode` | `mode` | `edge` | Mobile geometry: `edge` or `card`. Ignored by a `center` position on every viewport |
| `effect` | `effect` | `slide` | Mobile motion effect |
| `exit-effect` | `exitEffect` | `effect` | Mobile exit effect |
| `breakpoint` | `breakpoint` | `768` | Desktop-profile threshold in pixels |
| `desktop-position` | `desktopPosition` | `center` for a `bottom` mobile position, else the mobile position | Desktop placement, same four values. `bottom` here is content-sized and bottom-anchored, not snap-sized |
| `desktop-mode` | `desktopMode` | `card` | Desktop `edge` or `card`. Does **not** inherit `mode`. Ignored by a `center` desktop profile |
| `desktop-effect` | `desktopEffect` | `fade-scale` for `center`, else `effect` | Desktop motion effect |
| `desktop-exit-effect` | `desktopExitEffect` | `exit-effect`, else `desktop-effect` | Desktop exit effect |
| `dismiss` | `dismiss` / `dismissPolicy` | all routes | Which of `swipe backdrop escape` may dismiss; `none` for none |
| `max-display-width` | `maxDisplayWidth` | none | Largest viewport width where opening is allowed |
| `spring` | `spring` | presets | Spring override, `"attraction friction"` |

Crossing the breakpoint while open **morphs the panel to its new geometry in place** — the dialog never closes, never leaves the top layer, focus is undisturbed, and no `beforeHide`/`hidden` is emitted. Changing `position`, `mode`, or `effect` on an open sheet takes the same path.

Resizes that stay inside one profile re-measure instead — snap lengths, CSS width, or content box. A content-sized profile also re-measures when its **content** changes, via a `ResizeObserver` on the dialog, so drag thresholds and exit runway follow what it is actually showing.

The morph is the one CSS transition in the package (a box between two resting geometries has no meaningful spring position). Tune it with `--sheet-morph-duration` and `--sheet-morph-easing`; `prefers-reduced-motion` zeroes the duration and the change lands as an instant swap.

## Spring Tuning

Motion ships tuned per phase and needs no configuration. Both dials move together — attraction sets travel speed, friction sets damping — so raising friction alone only makes motion sluggish. Springs front-load their travel, so the 90%-of-travel mark describes feel better than settle time.

| Phase | attraction | friction | settle | 90% of travel |
| --- | --- | --- | --- | --- |
| entrance | `0.055` | `0.32` | ~483ms | ~267ms |
| exit | `0.3` | `0.56` | ~267ms | ~133ms |
| snap | `0.065` | `0.3` | ~566ms | ~200ms |
| rest | `0.15` | `0.455` | ~333ms | ~167ms |

`snap` settles with a small (~2.4%) overshoot so a hard flick visibly carries further than a slow release; `rest` returns a side sheet to its single width, where overshoot would open a gap at the screen edge.

To dial the feel without forking the component:

```html
<sheet-panel spring="0.08 0.36">…</sheet-panel>
```

```js
sheet.spring = { attraction: 0.08, friction: 0.36 };
sheet.spring = null; // back to the presets
```

The pair governs how the sheet **arrives** — exits and snaps keep their presets, so leaving stays brisk whatever you set. Both values are exclusive of `0` and `1`; anything else is ignored. Lower values are slower and looser; higher, faster and tighter.

## CSS Custom Properties

Set tokens on `:root`, a panel, or another ancestor.

| Property | Default | Description |
| --- | --- | --- |
| `--sheet-active-size` | `min(26rem, 90vw)` on sides | Single fixed width for left and right sheets, and the active snap height of a mobile bottom sheet. Never published for a content-sized profile — `center`, or a desktop `bottom` |
| `--sheet-panel-background` | `white` | Panel background |
| `--sheet-panel-border-radius` | `25px` | Edge-sheet exposed corner radius |
| `--sheet-card-margin` | `12px` | Card inset from viewport edges |
| `--sheet-card-border-radius` | `20px` | Card corner radius |
| `--sheet-panel-box-shadow` | layered shadow | Panel elevation |
| `--sheet-handle-color` | `#bbb` | Drag-handle fill. Handles render only on coarse-pointer devices, below the breakpoint |
| `--sheet-handle-width` | `50px` | Bottom-sheet handle width |
| `--sheet-handle-height` | `5px` | Bottom-sheet handle height |
| `--sheet-handle-side-length` | `--sheet-handle-width` | Side-sheet handle length, running down the panel |
| `--sheet-handle-side-thickness` | `4px` | Side-sheet handle thickness — a side sheet takes its pill from this pair, not the width/height above |
| `--sheet-handle-offset` | `8px` | Handle distance from the header edge |
| `--sheet-bleed` | `120px` | Panel background extended past an edge sheet's own edge as a solid offset shadow, so rubber-band overshoot never exposes the backdrop. Edge modes only |
| `--sheet-content-padding` | `20px` | Content inset |
| `--sheet-footer-padding` | content padding | Footer inset; safe-area padding is added |
| `--sheet-footer-background` | `transparent` | Footer background |
| `--sheet-overlay-background` | `rgba(0, 0, 0, 0.5)` | Custom backdrop fill |
| `--sheet-overlay-blur` | `5px` | Custom backdrop blur |
| `--sheet-panel-z-index` | `1001` | Stacking order of the dialog itself, one above dialog-panel's scrim — see the scale below |
| `--sheet-blob-z-index` | `1002` | Stacking order of the trigger-morph blob, which flies above both scrim and panel. Read back in JS, so a CSS override moves the real blob |
| `--sheet-desktop-panel-width` | `min(26rem, 90vw)` | Maximum desktop card width |
| `--sheet-center-width` | `min(28rem, 100vw - 2 * card margin)` | Width of a `center` dialog; its height follows its content |
| `--sheet-exit-cushion` | `28px` | How far past its edge a dismissal carries the panel, on top of its size and inset. Raise to about your shadow's blur if the panel leaves a halo on the way out |
| `--sheet-morph-duration` | `600ms` | Two roles: profile-morph duration, and the trigger-morph gate. `0` — which `prefers-reduced-motion` sets — swaps a profile morph instantly and disables the trigger morph entirely |
| `--sheet-morph-easing` | `cubic-bezier(0.34, 1.32, 0.52, 1)` | Profile-morph easing; overshoots slightly by default |
| `--sheet-trigger-return-duration` | `280ms` | How long the trigger takes to pop back in after a close that never morphed back into it. `0` (set by `prefers-reduced-motion`) restores instantly |
| `--sheet-trigger-return-easing` | `cubic-bezier(0.34, 1.4, 0.64, 1)` | Easing for that pop; overshoots on purpose |
| `--sheet-backdrop-progress` | written per frame | Read-only. Drives the overlay from the dismissal zone; always `0`–`1` |
| `--sheet-progress` | written per frame | Read-only. Exactly what was painted — a bottom sheet publishes its snap breath up to ~`1.024`, no other profile exceeds `1` |

The three transport surfaces stack adjacently and deliberately low: dialog-panel's scrim at `--dialog-backdrop-z-index` (`1000`), the panel at `1001`, the blob at `1002`. If something paints over the sheet, raise the trio together, by as little as clears the offender — extreme values recreate the whole-page compositor re-sort flicker this scale exists to avoid.

```css
:root {
	--sheet-panel-background: #171012;
	--sheet-panel-border-radius: 18px;
	--sheet-card-margin: 16px;
	--sheet-overlay-blur: 8px;
}
```

## JavaScript API

### Methods

| Method | Description |
| --- | --- |
| `show(triggerEl)` | Resolve the active profile and open through dialog-panel's engine transport. `triggerEl` is optional; used for focus return and — only with `morph-trigger` — as the box the panel grows out of |
| `hide()` | Close through dialog-panel |
| `snapTo(index)` | Spring a mobile bottom sheet to a zero-based snap index; inert on every other profile |

### Properties

Every responsive attribute in the table above reflects through its camelCase property. These read-only references are also available:

| Property | Description |
| --- | --- |
| `activeSnap` | Current zero-based snap index |
| `panel` | Parent `<dialog-panel>` |
| `dialog` | Parent native `<dialog>` |
| `header` | Descendant `<sheet-header>` |
| `content` | Descendant `<sheet-content>` |
| `footer` | Optional descendant `<sheet-footer>` |
| `backdrop` | Generated `<dialog-backdrop>` |

The element classes and snap helpers are also named exports: `import { SheetPanel, SheetHeader, SheetContent, SheetFooter, resolveSnapPoints, resolveInitialSnap, resolveSnapTarget } from '@magic-spells/sheet'`.

## Events

All six events bubble and are composed, but `snapchange` and `snaprelease` are dispatched by `<sheet-panel>` while the four lifecycle events come from `<dialog-panel>` — the *ancestor*, so a listener bound to `<sheet-panel>` will never see `shown` or `hidden`. Bind lifecycle events to the `<dialog-panel>`, or bind everything there.

| Event | Fired on | Cancelable | When it fires |
| --- | --- | --- | --- |
| `beforeShow` | `<dialog-panel>` | Yes | Before the opening spring starts |
| `shown` | `<dialog-panel>` | No | After the sheet settles and the native dialog enters the top layer |
| `beforeHide` | `<dialog-panel>` | Yes | Before the exit spring starts |
| `hidden` | `<dialog-panel>` | No | After exit and native dialog cleanup |
| `snapchange` | `<sheet-panel>` | No | After a different snap settles; detail is `{ from, to }` |
| `snaprelease` | `<sheet-panel>` | No | After any claimed pointer release resolves; detail below |

The `snaprelease` detail:

| Field | Type | Value |
| --- | --- | --- |
| `velocity` | number | Release velocity in px/ms, projected onto the dismiss axis and **signed away from rest** — positive is toward the closed edge. A left sheet is the one that inverts |
| `flick` | boolean | `Math.abs(velocity) > 0.5`, the same threshold the release policy uses |
| `direction` | `'away'`, `'toward'`, `'none'` | The sign of `velocity` — **not** `up`/`down`/`left`/`right`, so `detail.direction === 'down'` silently never matches |
| `size` | number | The panel's logical size in px along the dismiss axis at release |
| `target` | number or `null` | Zero-based index of the snap actually taken, or `null` for a dismissal that is going through |
| `prevented` | boolean | True when the release resolved to a dismissal that did not happen |

`target` reports what was *taken*, never what was merely resolved: a dismissal refused by `dismiss`, or vetoed in `beforeHide`, reports the active snap with `prevented: true` — so `target === null` is a reliable signal to tear down a draft or release a camera stream.

```js
const sheet = document.querySelector('sheet-panel');
sheet.addEventListener('snapchange', ({ detail }) => {
	console.log(`snap ${detail.from} → ${detail.to}`);
});
```

## Accessibility

The peer dialog component and native `<dialog>` provide modal semantics, focus trapping, focus return, and Escape handling. Give every dialog an accessible name with `aria-labelledby` or `aria-label`, keep a visible close action, label icon-only buttons, and pass the actual opener to `show()` so focus returns to the right place.

Do not rely on drag gestures as the only path to an action. Interactive descendants remain clickable because pointer capture is deferred until movement passes `5px`.

## Browser Support

Modern browsers with custom elements, native `<dialog>`, Pointer Events, `:has()`, CSS custom properties, and `dvh` support.

## License

MIT

---

<p align="center">
  Made by <a href="https://github.com/coryschulz">Cory Schulz</a>
</p>
