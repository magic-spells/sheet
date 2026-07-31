# Sheet Web Component

Gesture-driven edge sheets and floating cards built on a real native `<dialog>` through `@magic-spells/dialog-panel`. `@magic-spells/sheet` adds spring motion, bottom-sheet snap points, drag/flick policy, and responsive presentation profiles.

[**Live Demo**](https://magic-spells.github.io/sheet/demo/)

## Features

- Bottom, left, and right edge sheets, plus a centered dialog profile
- Inset card mode with independently configurable desktop presentation
- Mobile-bottom-only CSS snap points, live dragging, nearest-snap release, and velocity flicks
- Spring motion powered by `@magic-spells/physics-engine` and `@magic-spells/frame-engine`
- Header, footer, backdrop, and scroll-aware content drag surfaces
- Native dialog focus trapping, focus return, Escape handling, and modal semantics
- Safe-area-aware optional footer
- No morph-engine integration; a small sheet engine uses dialog-panel's transport seam directly

## Installation

```bash
npm install @magic-spells/sheet @magic-spells/dialog-panel
```

```js
import '@magic-spells/dialog-panel';
import '@magic-spells/sheet';

import '@magic-spells/dialog-panel/css';
import '@magic-spells/sheet/css';
```

Only `@magic-spells/dialog-panel` is named on that line, and the asymmetry is deliberate. You import
dialog-panel yourself and write `<dialog-panel>` in your own markup, so it belongs in your own
`package.json`. It is declared here as a **peer dependency**, which npm 7+ and pnpm install
automatically — `npm install @magic-spells/sheet` on its own really does produce all four packages.
Yarn 1 is the exception: it installs the rest and reduces the missing peer to a warning, which leaves
`<dialog-panel>` undefined at runtime. Naming it on the install line is what makes the command
correct on every package manager, and what keeps you from importing a package you never declared at a
version this package's peer range chose for you.

Peer is also the right field because dialog-panel has to be a **singleton**. It registers the
`<dialog-panel>` custom element, and a tag name can only be claimed once per document, so several
packages depending on it must converge on one copy rather than each nesting their own. Peer
semantics are what push npm to reconcile them and to warn when ranges genuinely conflict. Both
packages also guard every registration with `customElements.get()`, so a duplicate that slips
through no-ops instead of throwing — and this package never imports dialog-panel at all. It finds
the element with `closest('dialog-panel')` and drives it through the duck-typed transport, so it
holds no reference to dialog-panel's class and cannot be confused about which copy won.

Physics Engine and Frame Engine are **hard runtime dependencies**. They are not optional and not
swappable: every spring and every keyframe in this package runs through them, so a sheet without
them does not move. Being in `dependencies` is the strongest guarantee npm offers — every package
manager installs them, always, with no peer-resolution rules involved. You simply never have to
*name* them, because you never import them yourself. They stay external in the ESM build, where your
bundler resolves them from `node_modules`, and are bundled into the UMD build so a `<script>` tag
needs nothing else.

The three differ in who owns the import, not in how required they are. All three are mandatory.

The one case where those two names become your concern is loading `dist/sheet.esm.js` straight into
a browser with no bundler, since nothing is there to resolve the bare specifiers. Supply an import
map — the [demo](./demo/index.html) does exactly that — or use `dist/sheet.min.js`, which already has
them bundled.

The package ships two entry points and no CommonJS build: `dist/sheet.esm.js` for anything with a
module graph, and `dist/sheet.min.js` — a self-contained UMD — for a plain `<script>` tag. No
`require` condition is declared. Node 22 and newer can still `require()` the ESM build directly, and
older Node throws `ERR_REQUIRE_ESM`; either way nothing here ships a second copy of the engines.

## Usage

Keep the canonical nesting intact. `dialog-panel` owns the native dialog, while `sheet-panel` owns presentation and gestures.

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

Always open through `sheet.show(trigger)`. The method supplies `trigger || sheet` to dialog-panel because its custom engine path requires a truthy trigger. Elements with `data-action-hide-dialog` continue to use dialog-panel's built-in delegation.

## Sizing

**`snap-points` is a mobile-profile attribute.** Below `breakpoint`, a bottom sheet can declare
multiple snap points; each value is a resting height. Dragging between snaps interpolates height.
Once logical travel passes below the lowest snap, the painted height stays at that lowest value and
the panel follows the finger with `translateY` instead. At logical size zero it has translated by
exactly its own height and is fully off-screen, without squishing its contents.

At or above `breakpoint` the snap list is **ignored entirely**, whatever the profile. A desktop
bottom panel measures its own content height and sits anchored to the bottom edge — a desktop
dialog that happens to rest on an edge rather than in the middle of the screen — capped by
`calc(100dvh - 2 * var(--sheet-card-margin))` and scrolling inside itself past that. It is
dismiss-only, like every desktop profile.

Left and right sheets ignore `snap-points` and always have one fixed width from
`--sheet-active-size`, which falls back to `min(26rem, 90vw)`. Override that token in CSS when a side
panel needs a different width:

```css
#account-panel > dialog {
	--sheet-active-size: 24rem;
}
```

No width attribute is needed. Side drags move the fixed-width panel with `translateX` and resolve
only to open or dismissed.

## Gestures and Snap Rules

The header, optional footer, and generated backdrop are unconditional drag surfaces, as is the panel's own handle strip — the padding a side sheet draws its pill into, which no child surface covers. The content hands a touch gesture to the sheet only once the scrollables under the pointer have no room left in that direction:

- A bottom sheet claims downward motion at the content's top and upward motion at its bottom.
- Left and right sheets use the corresponding horizontal scroll edge.
- Nested scrollers count too: a horizontal carousel inside the content scrolls on its own until it reaches its edge, then the gesture passes to the sheet.
- Once claimed, a non-passive `touchmove` veto keeps native scrolling from fighting the sheet.
- Motion past zero or beyond the largest bottom snap gets rubber-band resistance.

For a mobile bottom sheet on release:

- A flick faster than `0.5 px/ms` moves one snap in its direction, measured from the live panel
  size at release—not the snap where the drag began.
- A dismiss-direction flick from the lowest snap closes the panel.
- A slower release selects the nearest snap; the closed edge participates as a target below the lowest snap.
- Cancelled gestures return to the active snap.
- A backdrop gesture under `10px` and `300ms` is a tap and closes.

Side sheets, centred dialogs, and a desktop bottom panel all use the same release shape as a
snapless bottom sheet: dismiss or return to their one resting size, with no nearest-snap search.

## Effects

| Effect | Behavior |
| --- | --- |
| `slide` | Travels clear off the configured edge and springs to rest |
| `fade-scale` | Fades from `0` while scaling from `0.95`; the default for a desktop `center` profile |
| `slide-fade` | Fades with a `24px` edge-directed slide |
| `pop` | Fades in over the first 30% while scaling `0.85` → `1.05` → `1`, then exits monotonically to `0.9` |

Every profile inherits `effect` unless told otherwise, with one exception: `desktop-effect` defaults
to `fade-scale` when `desktop-position` is `center`, because a centered dialog rests against no edge
and inheriting a bottom sheet's `slide` would fly it up a whole viewport height into the middle of
the screen. A plain bottom sheet resolves to a desktop `center` (see
[Responsive Profiles](#responsive-profiles)), so that is what it arrives with above the breakpoint
unless you name a `desktop-effect`.

The exception lives only on the desktop side. A mobile `position="center"` still inherits `effect`,
which defaults to `slide`, so set `effect="fade-scale"` explicitly if you want a centered dialog to
fade in below the breakpoint as well.

### Leaving

By default a dismissal is the entrance run backward — except `pop`, whose bounce frame is dropped so
a dismissal never bounces on the way out. `exit-effect` and `desktop-exit-effect` break that
symmetry when you want it: a panel welded to the bottom edge of a phone wants to slide back down it,
while the same panel floating as a card on a desktop often reads better shrinking away.

```html
<!-- slides up on a phone, shrinks away as a desktop drawer -->
<sheet-panel
	snap-points="48vh 92vh"
	desktop-position="right"
	desktop-mode="card"
	desktop-exit-effect="fade-scale">…</sheet-panel>
```

A dismissal does not start at rest — it starts wherever your finger let go — so its track ends
**off screen by the panel's own extent, plus whatever gap it already floats by, plus a cushion**. All
three terms matter: a card sits `--sheet-card-margin` in from the edge, and a centred dialog rests
mid-screen. The cushion clears the panel's *shadow*, not just its box, so raise
`--sheet-exit-cushion` if a soft shadow leaves a halo behind on the way out.

A non-translating exit (`fade-scale`, `pop`) scales down in place from rest, and when it continues a
live drag it carries on outward past the release pose by one cushion while it shrinks — so the fade
continues the gesture rather than contradicting it.

### Refusing to be dismissed

`dismiss` names which of the three implicit routes out stay open. Buttons and a programmatic `hide()`
are never affected — they are the answer, not a way out of answering.

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

`none` is tested first, so a contradiction like `"all none"` resolves to locked, and an
unrecognized token opens nothing. A sheet that refuses a gesture it should have taken is
recoverable; one that closes a confirmation it should have held is not.

A refused sheet still tracks your finger and still springs back, so it reads as refusing rather than
as broken, and `snaprelease` fires with `prevented: true` so you can say why.

## Responsive Profiles

Below `breakpoint`, the mobile `position`, `mode`, and `effect` apply, and a mobile bottom profile
uses the complete snap list. At or above the breakpoint, the desktop attributes apply and
**`snap-points` no longer applies at all**: a desktop bottom profile measures its own content
height, a desktop side profile uses its single CSS width, and every desktop profile is dismiss-only.

Each desktop attribute falls back to its mobile twin, with one exception: **a mobile `bottom`
position falls out to `center` on the desktop.** Both desktop shapes are content-sized, so this is
a question of placement rather than size — a floating card in the middle of the screen reads as a
desktop dialog, while an edge-anchored panel reads as a sheet. Say `desktop-position="bottom"` when
the sheet should stay on the bottom edge on a wide viewport; it will still size to its content
there, not to 85vh.

This is what lets one element be two components. A quick-shop panel is a bottom sheet with snap
points on a phone and a right-hand drawer on a desktop; an action sheet is a bottom sheet on a
phone and a centred modal on a desktop without being asked:

```html
<sheet-panel snap-points="48vh 92vh" desktop-position="right" desktop-mode="card">…</sheet-panel>

<!-- centred on the desktop by default -->
<sheet-panel snap-points="34vh">…</sheet-panel>

<!-- a bottom sheet on every viewport: 34vh on a phone, content-sized on a desktop -->
<sheet-panel snap-points="34vh" desktop-position="bottom">…</sheet-panel>
```

`center` is the fourth placement. It ignores `snap-points` and `mode` on **every** viewport, takes
its width from `--sheet-center-width`, and takes its **height from its own content** — so keep that
content short if you want it to read as a modal rather than a full-height panel. A desktop bottom
profile is sized the same way, and for the same reason. Center is still swipe-dismissible:
like a bottom sheet it is pulled away downward, and like a side sheet a release that does not
dismiss returns it to rest rather than snapping.

| Attribute | Property | Default | Description |
| --- | --- | --- | --- |
| `snap-points` | `snapPoints` | `85vh` | **Mobile bottom only** — space-separated CSS heights, resolved at open and resize. Ignored past `breakpoint`, and by every non-bottom position |
| `initial-snap` | `initialSnap` | last | Zero-based initial mobile bottom snap |
| `position` | `position` | `bottom` | Mobile placement: `bottom`, `left`, `right`, or `center` |
| `mode` | `mode` | `edge` | Mobile geometry: `edge` or `card` |
| `effect` | `effect` | `slide` | Mobile motion effect |
| `exit-effect` | `exitEffect` | `effect` | Mobile exit effect |
| `breakpoint` | `breakpoint` | `768` | Desktop-profile threshold in pixels |
| `desktop-position` | `desktopPosition` | `center` for a `bottom` mobile position, else the mobile position | Desktop placement, same four values. `bottom` here is content-sized and bottom-anchored, not snap-sized |
| `desktop-mode` | `desktopMode` | `card` | Desktop `edge` or `card` geometry |
| `desktop-effect` | `desktopEffect` | `fade-scale` for `center`, else `effect` | Desktop motion effect |
| `desktop-exit-effect` | `desktopExitEffect` | `exit-effect`, else `desktop-effect` | Desktop exit effect |
| `dismiss` | `dismiss` / `dismissPolicy` | all routes | Which of `swipe backdrop escape` may dismiss; `none` for none |
| `max-display-width` | `maxDisplayWidth` | none | Largest viewport width where opening is allowed |
| `spring` | `spring` | presets | Spring override, `"attraction friction"` |

Crossing the breakpoint while open **morphs the panel to its new geometry in place**. The dialog is never closed and never leaves the top layer, focus is not disturbed, and no `beforeHide` or `hidden` is emitted — a bottom sheet visibly narrows into a drawer, lifts into the middle of the screen, or collapses down onto its content while staying welded to the bottom edge. Changing `position`, `mode` or `effect` on an open sheet takes the same path.

Resizes that stay inside one profile re-measure instead: a mobile bottom profile re-resolves its snap lengths, a side profile its CSS width, and a content-sized profile — `center`, or a desktop `bottom` — its laid-out box. Only a change of profile is worth animating — a window drag fires a resize every 100ms, and morphing on each one would be unwatchable.

A content-sized profile also re-measures when its **content** changes, which nothing else would catch: a `ResizeObserver` on the dialog re-resolves the resting height once the panel is parked at rest, so the drag thresholds and exit runway follow the content it is actually showing.

The morph is the one motion in the package that is a CSS transition rather than a spring, because it interpolates a *box* between two resting geometries that share almost no properties. Tune it with `--sheet-morph-duration` and `--sheet-morph-easing`; `prefers-reduced-motion` zeroes the duration and the change lands as an instant swap.

## Spring Tuning

Motion ships tuned per phase and needs no configuration. Both dials move together — attraction sets travel speed, friction sets damping — so raising friction alone only makes motion sluggish.

Springs front-load their travel, so settle time alone does not describe how a motion *feels*; the 90%-of-travel mark does.

| Phase | attraction | friction | settle | 90% of travel |
| --- | --- | --- | --- | --- |
| entrance | `0.055` | `0.32` | ~483ms | ~267ms |
| pop | `0.055` | `0.325` | ~516ms | ~283ms |
| exit | `0.3` | `0.56` | ~267ms | ~133ms |
| snap | `0.065` | `0.3` | ~566ms | ~200ms |
| rest | `0.15` | `0.455` | ~333ms | ~167ms |

`snap` moves a mobile bottom sheet between snap points and settles with a small (~2.4%) overshoot, so a
hard flick visibly carries further than a slow release. `rest` returns a side sheet to its single
width, where there is no room to overshoot without opening a gap at the screen edge.

To dial the feel without forking the component, set `spring` as an attribute or a property:

```html
<sheet-panel spring="0.08 0.36">…</sheet-panel>
```

```js
sheet.spring = { attraction: 0.08, friction: 0.36 };
sheet.spring = null; // back to the presets
```

The pair governs how the sheet **arrives**. Exits and snaps keep their presets, so leaving stays brisk whatever you set. Both values are exclusive of `0` and `1`; anything else is ignored and the presets stand.

Lower attraction and lower friction give a slower, looser motion; higher values give a faster, tighter one. `pop` keeps its keyframed bounce regardless — that shape lives in its keyframes, not in the spring.

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
| `--sheet-handle-color` | `#bbb` | Drag-handle fill. Handles advertise touch travel, so they render only on coarse-pointer (touch) devices, below the breakpoint |
| `--sheet-handle-width` | `50px` | Bottom-sheet handle width |
| `--sheet-handle-height` | `5px` | Bottom-sheet handle height |
| `--sheet-handle-side-length` | `--sheet-handle-width` | Side-sheet handle length, running down the panel |
| `--sheet-handle-side-thickness` | `4px` | Side-sheet handle thickness. A left or right sheet takes its pill from this pair, not from the bottom-sheet width/height above |
| `--sheet-handle-offset` | `8px` | Handle distance from the header edge |
| `--sheet-bleed` | `120px` | How far the panel background is extended past an edge sheet's own edge, as a solid offset shadow, so a rubber-band overshoot never exposes the backdrop behind it. Edge modes only — a card floats by design and its overshoot should reveal the backdrop |
| `--sheet-content-padding` | `20px` | Content inset |
| `--sheet-footer-padding` | content padding | Footer inset; safe-area padding is added |
| `--sheet-footer-background` | `transparent` | Footer background |
| `--sheet-overlay-background` | `rgba(0, 0, 0, 0.5)` | Custom backdrop fill |
| `--sheet-overlay-blur` | `5px` | Custom backdrop blur |
| `--sheet-desktop-panel-width` | `min(26rem, 90vw)` | Maximum desktop card width |
| `--sheet-center-width` | `min(28rem, 100vw - 2 * card margin)` | Width of a `center` dialog; its height follows its content |
| `--sheet-exit-cushion` | `28px` | How far past its edge a dismissal carries the panel, on top of its size and inset. Raise it to about your shadow's blur if the panel leaves a halo on the way out |
| `--sheet-morph-duration` | `600ms` | Profile-morph duration; `0` swaps instantly |
| `--sheet-morph-easing` | `cubic-bezier(0.34, 1.32, 0.52, 1)` | Profile-morph easing; overshoots slightly by default |
| `--sheet-backdrop-progress` | written per frame | Read-only. Drives the overlay from the dismissal zone; always `0`–`1` |
| `--sheet-progress` | written per frame | Read-only. Exactly what was painted — a bottom sheet publishes its snap breath up to about `1.024`, no other profile exceeds `1` |

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
| `show(triggerEl)` | Resolve the active profile and open through dialog-panel's engine transport |
| `hide()` | Close through dialog-panel |
| `snapTo(index)` | Spring a mobile bottom sheet to a zero-based snap index; inert on every other profile, which has a single snap |

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

The element classes and the snap helpers are also named exports, if you need to subclass or reuse
them: `import { SheetPanel, SheetHeader, SheetContent, SheetFooter, resolveSnapPoints, resolveInitialSnap, resolveSnapTarget } from '@magic-spells/sheet'`.

## Events

All six events bubble and are composed, but they do not all originate on the same element:
`snapchange` and `snaprelease` are dispatched by `<sheet-panel>`, while the four lifecycle events
come from `<dialog-panel>`. Since `<dialog-panel>` is the *ancestor*, a listener bound to
`<sheet-panel>` will never see `shown` or `hidden` — bind the lifecycle events to the
`<dialog-panel>`, or bind everything there to catch the whole cycle in one place.

| Event | Fired on | Cancelable | When it fires |
| --- | --- | --- | --- |
| `beforeShow` | `<dialog-panel>` | Yes | Before the opening spring starts |
| `shown` | `<dialog-panel>` | No | After the sheet settles and the native dialog enters the top layer |
| `beforeHide` | `<dialog-panel>` | Yes | Before the exit spring starts |
| `hidden` | `<dialog-panel>` | No | After exit and native dialog cleanup |
| `snapchange` | `<sheet-panel>` | No | After a different snap settles; detail is `{ from, to }` |
| `snaprelease` | `<sheet-panel>` | No | After any claimed pointer release resolves; detail is `{ velocity, flick, direction, size, target, prevented }`, with a zero-based target or `null` for dismissal. `target` is the snap actually taken, so a dismissal refused by `dismiss` reports the active snap with `prevented: true` |

```js
const sheet = document.querySelector('sheet-panel');
sheet.addEventListener('snapchange', ({ detail }) => {
	console.log(`snap ${detail.from} → ${detail.to}`);
});
```

## Accessibility

The peer dialog component and native `<dialog>` provide modal semantics, focus trapping, focus return, and Escape handling. Give every dialog an accessible name with `aria-labelledby` or `aria-label`, keep a visible close action, label icon-only buttons, and pass the actual opener to `show()` when possible so focus returns to the right place.

Do not rely on drag gestures as the only path to an action. Interactive descendants remain clickable because pointer capture is deferred until movement passes `5px`.

## Browser Support

Modern browsers with custom elements, native `<dialog>`, Pointer Events, `:has()`, CSS custom properties, and `dvh` support.

## License

MIT
