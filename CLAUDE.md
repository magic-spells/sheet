# @magic-spells/sheet Development Guide

## Commands

- `npm run build` — production Vite builds for ESM and minified UMD; there is deliberately no CommonJS build
- `npm run dev` or `npm run serve` — watch ESM into `demo/dist`, then serve `demo/` on port 3066
- `npm test` — run the DOM-free `node:test` suite
- `npm run lint` — lint source, build scripts, and tests
- `npm run format` — format the repository with Prettier
- `npm run prepublishOnly` — rebuild before publishing

## Code Style

- Tabs, enforced by Prettier
- ES modules and named exports
- `const _ = this;` for methods that repeatedly access one instance
- `#` private class fields
- JSDoc on public APIs
- Kebab-case custom elements and `--sheet-*` CSS tokens
- Every component-owned listener and timer must be removed during teardown

## Component Architecture

The public element family is:

- `<sheet-panel>` — breakpoint/profile policy, snap resolution, gesture ownership, profile morphing, and dialog-panel delegation
- `<sheet-header>` — rigid, unconditional drag surface
- `<sheet-content>` — elastic scroll region and conditional drag surface
- `<sheet-footer>` — optional rigid drag surface and safe-area owner

Required nesting:

```html
<dialog-panel>
	<dialog>
		<sheet-panel>
			<sheet-header>…</sheet-header>
			<sheet-content>…</sheet-content>
			<sheet-footer>…</sheet-footer>
		</sheet-panel>
	</dialog>
</dialog-panel>
```

There is deliberately no morph-engine integration in v1.

## Engine Transport Seam

`SheetEngine` is assigned to `panel.morphEngine`, using dialog-panel's established duck-typed transport:

```text
show({ from, to, display })
hide()
state
on(name, listener)
off(name, listener)
```

SheetEngine declares `animatesDialog: true`, marking it a **direct** engine: it flies the real dialog, visible for the whole flight. That one bit is what tells dialog-panel the safe top-layer moments — the opposite of a proxy engine like MorphEngine, which flies a stand-in blob while the real dialog stays invisible.

- **Promotion happens at show-start.** `panel.show()` calls `engine.show()`, which synchronously paints the hidden `p = 0` frame, then `showModal()` in the same task — so the promotion repaint lands while nothing is visible. Promoting at settle instead repaints the fully visible panel (a one-frame color/compositing shift); that was the original bug, in both engines' transports.
- **Demotion happens after the hidden settle.** The panel does not close the dialog at hide-start; the exit runs fully modal and `dialog.close()` fires from dialog-panel's finalize when the engine emits `hidden`, with the panel invisible again. Two knock-ons are deliberate, matching the CSS path and bottom-sheet: taps during the exit land on `::backdrop` and are dead, and focus (including `autofocus`) enters the sheet at entrance-start, not settle.
- Dialog-panel also listens for engine `stop` (finalize without exit animation) and, for proxy engines only, `reveal` (their mid-flight promotion point). SheetEngine never needs `reveal` — its safe moment is the run boundary.

Because the engine declares itself, the panel selects the engine transport with or without a trigger; `SheetPanel.show(trigger)` passes the trigger straight through, purely for focus return. The old `panel.show(trigger || this)` hack is gone — do not reintroduce it.

In `#settle()`'s hidden branch, inline styles are restored **before** `hidden` is emitted (matching `stop()`): the emit runs dialog-panel's finalize synchronously, and a `hidden` listener may re-enter `show()` — restoring afterwards would wipe that new run's freshly painted `p = 0` frame, now a visible full-size flash since the dialog is in the top layer from frame 0.

Assigning `morphEngine` adds `[morph]` to dialog-panel, whose CSS forces the dialog's transform and transition to neutral values. SheetEngine writes motion inline, which wins. The more subtle rule is display:

```css
dialog-panel:has(sheet-panel) > dialog[open] {
	display: flex;
}
```

Never put `display:flex` on the closed base dialog. A closed dialog must retain the UA's `display:none`, or `[morph]` makes it paint at rest. SheetEngine still sets inline `display:flex` in `#prepareDialog` and restores it at the shown settle — under promotion-at-start both are computed no-ops (`dialog[open]` supplies `flex`), kept as the safety net that returns a force-closed dialog to the UA's `display:none`.

## Motion Architecture

`src/sheet-engine.js` owns one PhysicsEngine spring and builds FrameEngine keyframes from the active position, mode, effect, and geometry.

- Spring travel is always `TRAVEL = 100`.
- Visual choreography uses `p = position / TRAVEL`; never PhysicsEngine's per-run `progress`.
- Show/hide reversals interpolate on a two-frame track from the painted pose to rest without carrying velocity.
- Early settle requires both `|position - target| < 0.3` and `|position - lastPosition| < 0.15` for two consecutive frames.
- Extrapolation below the hidden frame is always clamped at `p = 0` (a fast dismissal otherwise drives scale negative). Above `p = 1` the clamp is **profile-specific**: a bottom sheet's overshoot is the intended settling breath, but every other profile is refused it — see below.
- Size-like values in `CLAMP_POSITIVE` are floored at `0px`.
- `p = 1` is rebased to the active snap after every settle.
- Snap transitions interpolate current and destination resting geometry, then emit `{ from, to }`.

#### Velocity has no default denominator

The spring always runs `0 → TRAVEL`, so a release velocity is only meaningful as a *share of the
pixel distance that particular run covers* — and that distance differs per phase. `velocityToSpring(velocityPxMs, spanPx)`
therefore takes the span explicitly, and every call site states its own:

| run | span |
| --- | --- |
| `show` / `hide` (mid-entrance reversal) | resting size — the run covers off-screen → flush |
| `returnToRest` (side or center) | resting size — same |
| `settleTo` (snap) | **signed segment `targetSize - startSize`** |
| `dismiss` | **`exitTravel()`** — the runway this run has left |

A snap's keyframes are rebuilt per run to span exactly that hop, and on every *downward* snap the
segment is negative. Passing the resting size — always positive — was the original bug: it inverted
the sign on every downward flick and scaled the magnitude by `restSize / |segment|`. The symptom was
not a visible reversal (the attraction term swamps the bad seed) but total insensitivity: every
snap settled in 333–350ms with zero overshoot no matter how hard it was thrown, and the hardest
flick was the *slowest*. There is deliberately no default span, so the mistake cannot recur silently.

Because the integrator is linear, dividing by the signed segment traces the same path as running
the spring in pixel space, which is what `../bottom-sheet` does.

`dismiss` was the same mistake wearing different clothes, and it survived longer because its sign
was never wrong. A dismissal continuing a live drag only travels the runway the drag has *not*
already eaten, so normalising over the resting size understated the release velocity by up to ~2.8×
— a 500px-snap sheet dragged to 150px and thrown measured the same frames to gone as a standing
release. `exitTravel()` states the real span: the runway left, floored at the extent still on
screen, because a `fade-scale` exit does not translate at all and normalising over its cushion alone
would seed ~100 spring units on a 100-unit run and cross it in one frame.

**That floor is why the `exit` preset was left alone.** Loosening it toward `snap` was measured
against the suite's integrator and rejected: the span fix already buys the flick legibility (a hard
throw from a deep drag now goes in ~117ms against ~267ms for a standing release, where both were
267ms before), while every looser tuning bought at most one extra frame of spread at full rest and
added 50–150ms of *invisible* tail — the spring undershooting past the hidden frame, which
`paintedProgress` clamps, so the panel is gone while `hidden` and focus return still wait. Recorded
so the retune is not rediscovered as an obvious win.

#### Nothing but a bottom sheet is painted past flush

`#applyFrame` clamps `p` at 1 for any non-bottom profile. Their tracks end at rest with no frame
beyond it, so anything past flush is extrapolation. This cannot be tuned away: a synthetic keyframe
past 100 is *collinear* with the track and changes nothing, which is why the fix is to refuse to
paint it rather than to bend the geometry. `returnToRest`'s upper clamp on `start` depends on this —
the panel is already at `p = 1`, so the spring starts where the panel actually is.

For a side sheet the symptom is concrete: it is fixed width against its edge, so every position past
flush translates it inward and opens a sliver of backdrop down the side — from an inward
rubber-band, from spring overshoot, or from an aggressive `spring=` entrance override. A centered
dialog has no edge to expose and returns under the non-overshooting `rest` preset anyway, but the
same structural reason applies and it takes the same clamp.

`paintedProgress` keys off **position**, so a desktop bottom panel keeps the uncapped bottom rule
even though it is content-sized. That is deliberate and it still reads right: its track is linear
in size everywhere (translate-only, no floor bend), so everything past flush is collinear
extrapolation that lifts the panel slightly off its edge instead of stretching a content-sized box
past its content — and the edge profile's `--sheet-bleed` skirt covers what the lift exposes, while
a card is already floating over backdrop. It is a genuine improvement on the old behaviour, where
an upward rubber-band grew the panel taller and opened empty surface inside it.

#### A slide's runway is the panel's own reach

A slide's hidden frame sits `size + slideInset(profile, size) + exitCushion(profile)` past rest —
the panel's own extent, whatever gap it already floats by, and a cushion for its shadow. The cushion
defaults to `EXIT_CUSHION` (28px) and is overridable per profile via `exitCushion`, which the
component probes from `--sheet-exit-cushion`. It is a token rather than a constant because it has to
clear the **shadow**, not the box: the demo's own shadow is a 60px blur, so 28px left a visible halo
and it raises the token to 72px.

`slideInset` resolves that gap, and it has two sources for a reason:

- **Edge-mounted profiles** take `profile.edgeInset`, resolved by the *component*: `0` for edge
  mode, the probed `--sheet-card-margin` for any card mode. It lives there because probing CSS is the
  component's job. It is optional, so an engine handed a profile without it reads as edge-mounted.
- **A centred dialog** is derived in the *engine* as `(viewportHeight - size) / 2`, because it is
  the one profile that rests against no edge at all. That needs `size`, which only exists per run —
  and unlike a card margin it needs no DOM, so the engine is both the only place it can be exact
  and still DOM-free. `edgeInset` is ignored for centre even if supplied; its own geometry is the
  authority.

**Exactness here is the point, not pedantry.** A safe over-estimate was tried first — half the
viewport, which always clears — and it put a 373px dialog on an 860px viewport 33% past
off-screen. The edge-crossing backdrop remap now prevents that excess runway from leaving a live
overlay over an empty screen, but the guess would still stretch the entrance and dilute the
release velocity over travel the panel never needed. `test/sheet-engine.test.js` asserts the
runway clears by exactly the shared cushion across a range of sizes, so a guess cannot creep back
in.

The distance is floored at `1` for a **negative** size, not a zero one — at zero the expression
already clears the cushion. A negative size is reachable: `#applyLiveOffset` rubber-bands a
pull past the closed edge to about `-2·√(overpull)` (≈ −68px on a hard overpull), and a profile
rebuild during that drag — `setProfile`, off the throttled resize path — hands that live
`#currentSize` straight to `#makeOpenFrames`. Without the floor the runway would point back toward
rest.

The runway used to be `max(size, viewport)`, which is far more than off-screen. A 320px side panel
on a 1400px viewport had cleared the edge by `p ≈ 0.77` while the backdrop kept tracking down to
0, so the last quarter of every from-rest exit was a strong overlay hanging over an empty screen —
and every entrance started a full viewport away.

#### One exit track, and it starts where the finger let go

`buildExitKeyframes` builds **every** dismissal, from rest or continuing a live drag. `100%` is the
live resting pose — identical to what is painted at the moment of release, so nothing jumps — and
`0%` is the effect's hidden pose. `dismiss()` therefore always starts at `p = 1` and has no branch
left to disagree with itself.

The branch it replaced is the bug this whole section exists to prevent, reintroduced for the
*common* case. A dismissal from rest built a real exit track and cleared correctly; a dismissal
continuing a drag — which is every swipe-to-close — reused the **drag** keyframes and sprang to their
`0%` frame instead. That frame is `restStyles(profile, 0, …)`, which is *exactly flush*: no inset, no
cushion. What each profile left on screen, all of it invisible to the tests of the day because their
bounds were `>=` lower bounds a flush exit also satisfies:

| profile | translate at the end of a swipe-close | left on screen |
| --- | --- | --- |
| edge mode | its own size | 0px of panel — but the entire box-shadow |
| card mode | its own size | `--sheet-card-margin` (12px) + shadow |
| `center` | its own **height**, from mid-screen | `(viewportHeight − height) / 2` |

`desktopMode` defaults to `card`, so *every* desktop swipe-close left the sliver. Centre was the
worst by far: measured against a real laid-out box on a 1570px viewport, a 373px dialog needed 598px
of runway before its own extent and got 0, leaving 598px of dialog sitting on screen.

**The floor rule, stated once:** an exit must never end closer to rest than the pose it started
from; when it starts displaced it ends at least one cushion further out.

```js
const floor = away > 0 ? away + exitCushion(profile) : 0;
```

The `away > 0` guard is load-bearing, not defensive. From rest there is no displacement and so no
floor — without the guard every `fade-scale` and `pop` exit would acquire a cushion of stray drift,
and those effects scale down *in place*. It also subsumes the negative-size floor above: on a hard
overpull `away` exceeds the slide runway on its own, so the floor is what keeps the runway pointing
away from rest.

`exitTravel()` shares `exitValues()` with the builder, so the span a velocity is normalised over and
the keyframes the run paints can never describe different geometry.

`paintedExtent` and `awayTranslation` are `restStyles`' piecewise rule read back out as numbers, and
they are what keep the runway honest per profile: a side sheet is fixed width, so its exit pose is
absolute and a drag cannot move it, while a bottom sheet above its floor has genuinely *resized* and
correctly clears the smaller height it now paints. Below its floor the height is pinned there and the
runway stops shrinking however deep the drag went.

The effects are `slide`, `fade-scale`, `slide-fade`, and `pop`. An exit walks the same effect
vocabulary but is asked separately — see the exit effects below.

#### Arriving and leaving are separate questions

`exit-effect` and `desktop-exit-effect` sit alongside `effect` and `desktop-effect`, and resolve by
falling back rather than by defaulting to a value of their own:

| question | mobile | desktop |
| --- | --- | --- |
| how does it arrive? | `effect` | `desktop-effect` → `effect` |
| how does it leave? | `exit-effect` → `effect` | `desktop-exit-effect` → `exit-effect` → `desktop-effect` |

So saying nothing keeps the old behaviour exactly: leaving mirrors arriving. The pair exists because a
panel welded to the bottom edge of a phone wants to slide back down it, while the same panel floating
as a card on a desktop reads better shrinking away than sliding the full width of a screen it only
partly covers — and with the floor rule above, a `fade-scale` exit continuing a drag carries on
outward past the release pose instead of contradicting the gesture.

Neither is in `#profileKey`, and both are handled ahead of `PROFILE_ATTRIBUTES` in
`attributeChangedCallback`: an exit effect changes no resting geometry, so morphing on it would run a
FLIP measure whose `from` and `to` boxes are identical.

**`desktopEffect` defaults to `effect` for everything except `center`.** It used to return
`fade-scale` for any card mode, which meant a desktop drawer faded in place rather than sliding in
from its edge — not what anyone means by a drawer — and forced every mobile-bottom-to-desktop-side
consumer to write `desktop-effect="slide"` to get the obvious behaviour. Centre keeps its own default
because it rests against no edge, and inheriting a bottom sheet's `slide` would fly it up a whole
viewport height into the middle of the screen. A card slides from its edge like anything else;
`slideInset` already accounts for the margin it floats by.

#### A sheet that may not be waved away

`dismiss` is a token list — `swipe`, `backdrop`, `escape` — parsed by `parseDismiss` in
`sheet-engine.js`, following `parseSpring`'s precedent that parsers live in the engine so they stay
node-testable. Absent means all three are open. `dismiss="none"` (or an empty attribute) closes all
three and leaves a button or a programmatic `hide()` as the only way out. A contradiction like
`"all none"` resolves to locked, and an unrecognised token opens nothing: a sheet that refuses a
gesture it should have taken is recoverable, one that closes a confirm it should have held is not.

**Each route is blocked at its source, never by vetoing `beforeHide`.** That is the whole design
constraint: by the time `beforeHide` fires, an Escape and a `[data-action-hide-dialog]` button are
the same call, so a veto there would break the very buttons the feature exists to require.

- **swipe** — checked where the release resolves. A refused dismissal is *redirected* to the active
  snap rather than blocked later, because `#dismiss()` routes through `panel.hide()`; refusing
  downstream would leave the panel parked at its dragged pose with no settle at all.
- **backdrop** — the sheet's own tap branch, plus a capture-phase `click` on the dialog-panel that
  swallows an outside-the-dialog click before dialog-panel's own bubble-phase handler sees it. A real
  element inside the panel passes through untouched; the native `::backdrop` reports the *dialog* as
  its target, so geometry is the only way to tell, and it uses the same test dialog-panel does.
- **escape** — `document.addEventListener('cancel', …, true)`. Capture on the way *down* is the only
  ordering that gets ahead of dialog-panel's own `cancel` listener, because `cancel` does not bubble
  and that listener sits on the dialog itself.

`snaprelease` carries `prevented: true` when a gesture resolved to a dismissal that was refused, so a
consumer can shake the panel or flag the field still needing an answer. `dismiss` is deliberately
**not** in `observedAttributes`: every guard reads `dismissPolicy` live at event time, so there is no
state to resync.

### Spring presets

`SPRING_PRESETS` tunes the spring per motion phase; `#tuneSpring()` selects one before every run. Both dials move together — attraction sets travel speed, friction sets damping — because raising friction alone only makes motion sluggish.

**Tune on `t90`, not settle time.** Springs front-load their travel, so settle time does not describe perceived speed. An earlier pass tuned purely on settle time and shipped a 350ms entrance that reached 90% of travel in **100ms**; it read as a snap rather than a movement and had to be redone. Budget and report both numbers.

| Preset | attraction | friction | settle | t90 | max `p` |
| --- | --- | --- | --- | --- | --- |
| `entrance` | 0.055 | 0.32 | ~483ms | ~267ms | 1.000 |
| `pop` | 0.055 | 0.325 | ~516ms | ~283ms | 1.000 |
| `exit` | 0.30 | 0.56 | ~267ms | ~133ms | 1.000 |
| `snap` | 0.065 | 0.3 | ~566ms | ~200ms | **1.024** |
| `rest` | 0.15 | 0.455 | ~333ms | ~167ms | 1.000 |

`snap` matches `../bottom-sheet` and is deliberately the loose one. **A flick needs somewhere to
go**: under the previous 0.15/0.455 the release velocity was absorbed within a frame, so every
settle looked identical however hard it was thrown. The 2.4% overshoot is the room that makes a
flick legible, and it is why the snap keyframes carry explicit frames past their destination.

`rest` exists only because a snapless profile cannot borrow that room — a side sheet's track ends
flush against the screen edge, a centred dialog's at its middle — so `returnToRest` keeps the tight
tuning. Splitting the preset was necessary but *not
sufficient* on its own: it made the gap velocity-gated rather than gone (a 20px pull flicked back
at 4 px/ms still measured a 50px gap), which is why the paint clamp above exists.

No phase oscillates; `pop` is the only visible bounce and it lives in its keyframes, not its
spring. The numbers are asserted in `test/sheet-engine.test.js` via a simulation of the integrator
plus the early-settle detector, which matches measured browser runs to within a frame. Overshoot
budgets are asserted **per preset**, so `snap`'s breath cannot be used as cover for another phase
drifting loose.

#### Public override

`spring="attraction friction"` (attribute) or `sheet.spring = { attraction, friction }` (property) overrides the tuning per instance. Parsing lives in `parseSpring()` in `sheet-engine.js` rather than the component, so it stays node-testable; the component's static `SheetPanel.parseSpring` delegates to it. Both dials must be exclusive of 0 and 1 (PhysicsEngine throws otherwise); invalid input is ignored and the presets stand.

The override governs how the sheet **arrives** — the entrance, including pop's. Exits and snaps keep their presets.

Scaling those phases proportionally was tried and abandoned: the exit preset's attraction is ~5.5× the entrance's, so any brisk override pushed it past the dial ceiling and the clamped result was badly overdamped — `spring="0.3 0.55"` measured a **2933ms exit**. The dials are bounded, so no proportional rule survives a fast entrance. A test pins exit frame counts as identical across a wide range of overrides.

### Backdrop opacity

The overlay tracks the **dismissal zone**, never raw progress. One rule: any position at or above rest saturates at exactly 1, and only travel below rest maps `[rest → off-screen]` onto `[1 → 0]`. Rest is the lowest snap, which collapses snapped and snapless sheets into one formula — for a snapless sheet the lowest snap *is* its resting size, so it fades across its whole downward travel with no special case.

Saturation is what stops upward rubber-band overscroll, spring overshoot, and entrance overshoot from lightening the overlay. During the opening/closing flight the panel is full-size but only partly on screen, so flight progress scales the visible extent; that also makes a snapped sheet reach full opacity by the time it passes its lowest snap, so opening to a mid snap never rests under a half-faded overlay.

#### Saturation only holds one end; a flight is monotonic at both

Saturation answers overshoot, and overshoot is all the presets can produce — none of them
oscillate. A public `spring=` override can be set loose enough to, and an oscillation's return
swing comes back **down** through rest, into the band below saturation where the clamp has nothing
to say. The scrim pulsed `1 → 0.85 → 1 → 0.95` in time with the panel and decayed with it; a
`spring="0.2 0.15"` entrance dipped on 17 separate frames. The panel is meant to bounce — that is
what the dial is for. The scrim is a fade.

`#flightEnvelope()` holds a flight to its direction: an entrance may only darken the overlay, an
exit may only lighten it. It applies to `showing` and `hiding` alone. The landed phases —
`dragging`, `snapping`, `returning`, `shown` — are deliberately outside it, because there the
overlay follows the finger and must move both ways.

The mark is **seeded on every phase change, never reset to an endpoint**, so a genuine reversal
starts from the opacity already painted rather than snapping: a `hide()` mid-entrance keeps fading
down from where the entrance got to. That also means no explicit reset is needed at the four sites
that begin a flight — every entry crosses a phase boundary, since `show()` refuses a second
`showing` run and `dismiss()` always arrives from `shown` or `dragging`.

`#currentSize × p` is the visible extent for entrances and non-sliding exits. A slide is the one
exception because its hidden frame carries an extra shadow cushion beyond the point where its box
clears the viewport. `exitClearProgress()` derives that edge-crossing point from the same
`exitValues()` geometry as the keyframes. During a slide exit, `[p = 1 → edge crossing]` maps from
the exact release opacity to `0`; the remaining cushion clears the shadow with no overlay hanging
over the empty screen.

There used to be a `flightSize: restSize` override on the settle action here, and its disappearance
is the tell that the exit *track* was the bug rather than the overlay. The old drag-continuing branch
started `p` at `currentSize / restSize`, which made this `currentSize × p / rest` — p² — so a panel
dragged half off screen sat at 0.5 and popped to 0.25 on the first frame of the dismissal, before it
had moved. Every left/right close continuing a drag flashed. The override existed
solely to paper over a `p` that did not mean what the formula assumed. With one track there is
nothing to paper over: do not reintroduce it.

`dismissalZoneProgress()` is the release mapping; the slide remap only changes when that value
reaches zero. The `p = 1` endpoint is untouched, so releasing a partially faded drag cannot flash.
`#syncBackdropProgress()` runs inside `#applyFrame()` — the single place panel styles are written —
so the overlay can never disagree with the panel or lag it by a frame. It surfaces as
`--sheet-backdrop-progress`, always in `[0, 1]`.

`--sheet-progress` reports what was **painted**, not a clamped copy of it. The rule lives once, in the
pure `paintedProgress(position, p)` exported from `sheet-engine.js` — floor at 0 always, and cap at 1
only for a non-bottom profile, whose track is refused any paint past flush. `#applyFrame()` paints
through it and the component's `#setProgress()` publishes through it, so the two cannot drift: a
bottom sheet's ~1.024 snap breath flows through uncapped, and a side sheet never publishes a
position its panel was denied. An unresolved profile has no rule to apply and falls back to the full
`[0, 1]` clamp at the component. Anything keyed off the token sees the same number the transform did.
A hide-to-show reversal restarts its two-frame track at `p = 0`, so its settle action carries the
painted progress and visible-extent floors forward; both public tokens continue from the reversal
pose rather than restarting their entrance ramps.

Two traps here, both fixed: reusing `--sheet-progress` for the overlay made snap-to-snap drags lighten it (mid-drag `p = currentSize / activeSize`, so 720px→480px emitted 0.667), and letting spring overshoot into the snap-size interpolation pushed the logical size a hair past the destination snap, which read as a dip under 1 on a settle that never left the snap range. The size interpolation is clamped to its segment; the visual breath belongs to the keyframes.

### Sizing rules

**`snap-points` is a MOBILE-profile attribute.** Snap points belong only to a bottom sheet below
the breakpoint. Between the lowest and highest snaps, their logical size paints directly as
`height`, so snap-to-snap travel still resizes. The painted height is floored at the lowest snap:
logical travel below that floor keeps the height fixed and maps `lowestSize - currentSize` to
`translateY` 1:1. At logical size `0`, the lowest-height panel is translated by exactly its own
height and is fully off-screen. `#currentSize`, velocity, snap resolution, and backdrop progress
all remain logical-size calculations.

Side sheets are **fixed width at all times** and ignore `snap-points`. Their one resting width
comes from the CSS `--sheet-active-size` token, whose component fallback is
`min(26rem, 90vw)`. JavaScript must not publish a snap-derived value into that token for a side
profile; consumers override it in CSS. Side drags are binary dismiss-or-return motion expressed
entirely as `translateX`.

Centered dialogs are the same shape of rule with a different source: they ignore `snap-points`
and `mode`, take their width from `--sheet-center-width`, and take their **height from their own
content**. `--sheet-active-size` must not be published for them either — it is a width slot, and a
centre's size is a height.

**A desktop bottom profile is content-sized too, by exactly the same machinery as centre.** Past
the breakpoint the snap list is ignored outright, `#measureSnaps` returns the measured box height
as the single snap, and the panel stays welded to the bottom edge. `contentSized(profile)` in
`sheet-engine.js` is the one statement of which profiles that covers (centre at any width, bottom
past the breakpoint) and it drives measurement AND the content-resize observer together. The
token is not published for it either.

**No profile except a snap-resized bottom sheet may emit a size property in a keyframe.**
`resizesWithSnaps(profile)` — `position === 'bottom' && !contentSized(profile)` — is that rule, and
`restStyles`, `awayTranslation`, `paintedExtent`, and the `willChange` hint all route through it.
`test/sheet-engine.test.js` asserts the invariant across left, right, center, and desktop bottom,
for the exit track as well as the entrance and drag ones. Centre and desktop bottom are the two
most likely to break it by accident, because both share the bottom sheet's axis — see the
axis/resize split below. A mobile bottom sheet's exit track is the one place a size property is
*pinned* rather than animated: both ends carry the painted height, so the run translates a
constant-height box.

**Emitting a height for a content-sized profile is not merely redundant — it is self-defeating.**
The engine writes keyframes inline, so a pixel `height` pins the dialog's box: the next
`#measureBox` reads back the number the last frame wrote instead of the content's own height, and
the `ResizeObserver` watching for content changes has nothing left to observe because the box can
no longer move. That is why the fix for desktop bottom is at `restStyles`, not only in the
stylesheet.

#### Which axis, versus resize or translate

These are two orthogonal questions, and they are deliberately answered by two different
predicates:

| question | predicate |
| --- | --- |
| which axis does this profile travel on? | `dismissAxis(position)` |
| does it resize, or only translate? | `resizesWithSnaps(profile)` |
| where does its single size come from? | `contentSized(profile)` |

For mobile bottom/left/right the first two answers happen to line up, which is why they were once
tangled together. `center` is the case that separates them: it travels on **y** like a bottom
sheet, but it is intrinsically sized and translates only, like a side sheet. A **desktop bottom**
panel is the case that stops position alone from answering the second at all: same position, same
axis, but content-sized and translate-only. Every axis decision routes through `dismissAxis` — in
the engine (`effectValues`, `awayOffset`) and in the component (`#scrollChain`, `#dragMove`,
`#matchesActiveAxis`); every resize decision routes through `resizesWithSnaps`. Reaching for
`position === 'bottom'` to answer either question is the mistake to watch for.

The *distance* a slide travels is a third question again, and belongs to `slideInset`: a centred
panel rests mid-screen, so its gap to the edge is `(viewportHeight - size) / 2`, derived in the
engine from the `viewportHeight` the component supplies. `edgeInset` is ignored for centre — its
own geometry is the authority — and the derivation is exact rather than a safe over-estimate,
for the reason recorded under the slide runway above.

#### A centred dialog must not use `height: auto`

`inset: 0` pins both `top` and `bottom`, and an absolutely positioned box with both edges pinned
and `height: auto` is solved to **fill** the space; `margin: auto` only centres a height that is
already definite. The symptom was a two-line confirm rendering at `max-height` — full screen —
rather than at its content size. `height: fit-content` makes the height definite from the
content, which is both the size wanted and the precondition the auto margins need.

`sheet-panel` opts out of its own `height: 100%` for both content-sized profiles (centre, and
desktop bottom), for the same reason: a percentage height against a content-sized dialog resolves
to auto and the flex layout then settles at `max-height`.

#### A bottom panel's height is stated conditionally, never overridden

The two bottom profiles disagree about exactly one declaration — `height` — so the stylesheet
splits it across two **mutually exclusive** selectors
(`[data-position='bottom']:not([data-desktop='true'])` for the snap height,
`[data-desktop='true'][data-position='bottom']` for `fit-content` plus the max-height cap) rather
than declaring one and overriding it. Two rules that both set `height` on the same element leave
source order and specificity to decide, and the desktop one would have to keep winning forever.
Everything the two profiles agree on — `inset`, `width`, `margin`, radius — stays in the shared
rule above them.

FrameEngine back-fills composite properties (`transform`, `filter`) onto any keyframe that omits
them, using zeroed defaults. A partial keyframe therefore bends the transform track. Every bottom
drag keyframe—including the breakpoint at the lowest snap—must carry a full transform; every
track the breakpoint does not intentionally bend must stay collinear with its neighbors. The
mid-timeline opacity reveal frame follows the same rule.

## Gesture Layers

Sensing is separate from policy.

### DragGesture

- Pointer capture is deferred until movement exceeds `5px`.
- X and Y use independent rolling `100ms` velocity trackers.
- Direction comes from the dominant axis of total displacement.
- Cancellation reports zero velocity.

#### Continuous tracking (do not break this)

While a drag is live, its displacement is measured continuously from `pointerdown`, never rebased
mid-gesture. Reversing direction walks the panel back through the same positions; travel past rest
is absorbed by the consumer's existing overscroll resistance.

### Scroll claim policy

`src/scroll-policy.js` is the single answer to "does the content scroll, or does the sheet move?",
on the touch path. It reads plain metric snapshots rather than live elements, so it stays DOM-free
and node-testable.

The rule is stated in **finger space** on the dismiss axis, which is what makes it
position-independent: a finger moving in some direction drags the content the opposite way, so the
content consumes while it can still scroll opposite-of-finger, and the sheet claims the moment that
room runs out. Nothing in the module knows which edge the sheet sits on.
`fingerFromAway(position, away)` is the only seam between away space and finger space on the touch
path, and only a `left` sheet — the one profile dismissed toward *smaller* coordinates — inverts. It
is a named, tested function rather than a ternary at the call site because it is exactly the line
the bug lived on.

Writing the rule per profile instead is how the hand-rolled touch branches ended up mirrored into
each other: a left sheet claimed at `scrollLeft <= 0` for an away drag when it should claim at the
*right* edge, and the right sheet carried the same error reversed. The shared module states the
rule once in finger space.

The unit is a scroll **chain**, not the content element. `#scrollChain()` walks from the gesture's
target up to and including `sheet-content`, keeping every node whose computed overflow on
the dismiss axis is `auto` or `scroll`; any member with room left answers for the whole chain, so a
nested horizontal carousel — cart upsells, say — scrolls natively inside any sheet and hands off at
its own edge. Consulting the content alone made such a scroller invisible: the sheet claimed the
drag immediately and the `touchmove` veto then killed the carousel's scrolling. The touch path
snapshots the chain once at `pointerdown` and does not hand off inside the gesture; native scrolling
that outruns the snapshot fires `pointercancel`, which abandons the drag anyway.

Content is subject to the same overflow filter as every other node. Admitting it unconditionally
made a consumer's `overflow-x: hidden` override undismissable: a wide table still reports
`scrollWidth > clientWidth`, so the chain claimed room forever. An empty chain means the sheet
claims, which is the right answer for a content region that cannot scroll at all.

`SCROLL_EDGE_TOLERANCE` gives the far edge `1px` of slack — a fractional device pixel ratio alone
puts `scrollHeight` a hair above `clientHeight`, and without it the sheet would never claim there.
The near edge is a hard zero and needs none.

`sheet-content` is `touch-action: pan-x pan-y` with `overscroll-behavior: contain` for
**every** position. Arbitration belongs to the claim logic, not to `touch-action`: the single
non-passive `touchmove` veto suppresses native scrolling only once the sheet has claimed. Pinning
one axis per profile forbade panning on the other for every descendant — the side profile's
`pan-x` override blocked vertical touch scrolling inside a tall side panel outright.

### SheetPanel policy constants

- `FLICK_VELOCITY = 0.5 px/ms`
- `OVERSCROLL_RESISTANCE = 0.2`
- Backdrop tap: under `10px` and `300ms`
- Resize throttle: `100ms`

Header, footer, and backdrop always claim. Content defers to its scroll chain and claims only once that chain has no room left in the gesture's direction — see the scroll claim policy above. The content's single non-passive `touchmove` listener vetoes scrolling only after a drag is claimed.

The panel itself is the fifth surface, and it exists for one region: a side sheet's handle strip. The
pill is the panel's own `::before`, sitting in padding no child surface covers, so without this
binding the element that *advertises* the swipe was the one place a swipe was dead. It claims
rigidly, like the header, and takes `touch-action: none` for side positions — safe for nested
scrolling because a scroll container inside the content implements its own pans below the panel. The
trap is bubbling: every child surface's `pointerdown` reaches the panel's DragGesture too, and one
that merely ignored the callbacks would still capture the pointer at slop and starve the surface
that owns it. `#dragStart` therefore *refuses* any hit whose target is not the panel directly, via
DragGesture's return-`false` seam, which puts the refused gesture fully inert — no capture, no
further callbacks.

Dismissal always enters through `panel.hide()` so cancelable `beforeHide`, focus restoration, Escape handling, and native dialog cleanup stay centralized. Gesture velocity is queued on SheetEngine before delegation.

Every claimed touch release emits `snaprelease` with `{ velocity, flick, direction, size, target, prevented }` through `#emitSnapRelease()`. `target` reports the snap actually taken, never merely the one resolved — so a dismissal `dismiss` refused reports the active snap with `prevented: true`. The touch path runs `resolveSnapTarget()` and reports its index.

## Breakpoint and Snap Policy

Below `breakpoint`, mobile profile attributes apply. If that profile is bottom-positioned, its
complete snap list applies. **At or above the breakpoint the snap list is ignored entirely** —
`snap-points` is a mobile-profile attribute and has no say up there, whatever the position. Every
desktop profile is dismiss-only and carries exactly one resting size: the sides take their single
CSS width, and a center *or* a desktop bottom takes its intrinsic content height. Any left, right,
or center profile ignores the snap list on a mobile viewport too.

Each desktop attribute falls back to its mobile twin, **except `desktop-position` when `position`
is `bottom`, which falls out to `center`.** Both desktop shapes are content-sized, so this
fallback is about placement rather than size: a floating card in the middle of the screen reads as
a desktop dialog, while an edge-anchored panel reads as a sheet. Every other position rests
against an edge on any viewport and inherits itself unchanged. `desktop-position="bottom"` opts
back in — and still sizes to content there, not to 85vh. The knock-on is deliberate:
`desktopEffect` already answers `fade-scale` for a desktop `center`, so a plain bottom sheet
arrives on the desktop by fading rather than flying a viewport height up into the middle of the
screen.

### A ceiling above which the sheet simply does not open

`max-display-width` is the second viewport policy, and it is a different kind of rule from
`breakpoint`: the breakpoint *switches* profiles, this one *withdraws* the component. Above it
`show()` returns `false` before `#prepareOpen()` runs, and an already-open panel is hidden when a
resize crosses the line. Absent — or `none` — resolves to `Infinity`, so saying nothing imposes no
ceiling.

It exists for the layout that outgrows a sheet entirely: a filter drawer that becomes a
permanent sidebar on a wide screen wants the sheet to stop existing, not to morph into a card.
It is in `observedAttributes`, unlike `dismiss`, because crossing the ceiling has to close a
panel that is already open.

Flicks resolve from `SheetEngine.currentSize`, the live panel size at release, never from
`activeSnap`. `activeSnap` is only updated after a settle, so during a drag it still names the
snap where the gesture started. Resolving from it was the previous bug: dragging from 20vh to
about 88vh and flicking up targeted 55vh, while flicking down from the same point could dismiss.
A flick steps exactly one snap in its direction measured from the live position; a slow release
chooses the nearest snap with the closed edge as a candidate.

CSS lengths are resolved at open and resize with a hidden fixed-position browser probe — snap heights, a side profile's `--sheet-active-size`, a card profile's `--sheet-card-margin` edge inset, the `--sheet-exit-cushion`, a desktop card's `--sheet-desktop-panel-width`, and a content-sized profile's intrinsic box (centre, or bottom past the breakpoint) are all resolved this way, once per profile rebuild rather than per frame. The pure `resolveSnapPoints()` helper handles deterministic unit conversion for tests.

One `#probeLength(name, cssFallback, pixelFallback)` serves the four single-token lengths — `--sheet-active-size`, `--sheet-card-margin`, `--sheet-exit-cushion`, and `--sheet-desktop-panel-width`; there were three copies of the same twelve-line probe before the cushion would have made a fourth. The other two measurements are not single tokens and keep their own paths: snap heights share one reusable probe inside `#measureSnaps()`, and a content-sized profile's intrinsic box is measured by `#measureBox()`. Every token is read off the **dialog**, because that is the element the stylesheet's geometry rules apply to and therefore where a consumer overriding one will have put it — the desktop card width used to read the `sheet-panel` instead and quietly missed an override set on the dialog.

### Profile morph

Crossing profiles while open **morphs the panel in place**. `#morphToProfile()` owns it; the
dialog is never closed, never leaves the top layer, and no `beforeHide`/`hidden` is emitted.

**It is a FLIP measure, not a transition on the geometry declarations.** The resting geometries
are `inset: auto 0 0` with a pixel height, `inset: 12px 12px 12px auto` with an intrinsic one, and
`inset: 0` with `margin: auto`. CSS cannot interpolate `auto` for `top`, `height` or `margin`, so
transitioning those directly **snaps**. (`interpolate-size: allow-keywords` fixes only the height
case, and only in Chromium.) The order matters and is the whole trick:

1. `engine.beginMorph()` — spring stops, `#applyFrame` goes inert, gestures refuse.
2. Read the live box.
3. `#prepareOpen()` — hand the new profile to CSS and re-measure snaps.
4. Read the destination box. **The pins must be off for this**, or it measures the scaffolding.
5. Pin back to the first box in explicit pixels, force layout.
6. Set the transition, write the second box.
7. On `transitionend` — strip every pin, `engine.endMorph()`.

`transform` and `opacity` stay at their rest values throughout so they never fight the pinned box.
`beginMorph` lands the panel at rest in the *current* profile first: a resize arriving mid-drag
would otherwise bake a half-finished transform into the measured `from` box.

Three things that look optional and are not:

- **The timeout beside `transitionend`.** That event does not fire for an interrupted transition
  or for a property whose start equals its end. Without the timeout a panel can be stranded in
  morph geometry.
- **Backdrop pinned to 1** while morphing. The resting size changes underneath the dismissal-zone
  calculation, which would otherwise blink the overlay mid-morph.
- **`from` is read, never remembered.** Mid-transition `getBoundingClientRect` reports the animated
  value, which is exactly what makes a re-entrant morph (a window edge dragged back and forth)
  retarget seamlessly.

The temporary inline `transition` is the one sanctioned exception to dialog-panel's "no transition
on a morph dialog" rule (its README:100). It is scoped to a window in which the engine is
deliberately parked, and it is stripped on completion. Do not "fix" it.

#### The content-resize observer, and the one moment it can be armed

A content-sized profile is the only one whose resting size can change with **nothing external
happening**: no resize, no attribute, no profile crossing. `#syncContentObserver()` puts a
`ResizeObserver` on the dialog for exactly those profiles while they are open, and
`#scheduleContentRemeasure()` debounces a `#prepareOpen()` off it — re-arming rather than
reconfiguring under a live finger, a morph, or a running spring, with a 1px tolerance that both
stops an observe/remeasure loop on fractional layouts and swallows the observer's initial fire.

It is armed from the **`shown`** handler, and that is not interchangeable with the other call
sites. `#prepareOpen()` runs from `beforeShow` and from `show()`, and dialog-panel is still
`'hidden'` at both — its `isOpen` only turns true at `'showing'` — so the `isOpen` gate refused
every install from there. Before this was noticed, a centre panel picked up an observer only if a
window resize happened to rebuild its profile while it sat open, which is why the feature looked
present and did nothing.

Only a `#profileKey` change morphs. Same-profile resizes re-measure instantly — a window drag
fires a resize every `RESIZE_THROTTLE_MS`, and morphing on each tick would be unwatchable.

This is the only motion in the package that is CSS-driven rather than spring-driven, because
there is no meaningful spring position for a run whose start and end share almost no properties.
`--sheet-morph-duration` / `--sheet-morph-easing` tune it, and the component reads the duration token
back so `prefers-reduced-motion` (which zeroes it) collapses the morph to an instant swap rather
than leaving JS waiting on a transition that will never run.

Internal `data-position`, `data-mode`, `data-desktop`, and `data-effect` attributes scope active-profile CSS. They are implementation details, not public configuration.

## Build and Packaging

`scripts/build.mjs` follows bottom-sheet's programmatic Vite pattern with Lightning CSS and Terser:

- `sheet.esm.js` — runtime dependencies external
- `sheet.min.js` — minified UMD with runtime dependencies bundled
- `sheet.css` and `sheet.min.css`

Production output is cleaned before sequential builds. Development output goes to `demo/dist` and is
**ESM only** — the demo loads `sheet.esm.js` and `sheet.css` and nothing else, so building a UMD on
every watch tick was pure cost. The server runs on port 3066.

#### There is no CommonJS build, on purpose

Two entry points, and only two: `sheet.esm.js` for anything with a module graph, `sheet.min.js` for
a plain `<script>` tag. CommonJS is not a supported target and no CJS artifact is built.

`exports` declares no `require` condition. It does keep a `default`, which is a catch-all every
condition matches, so `require('@magic-spells/sheet')` still *resolves* — to the ESM file. On Node
22 and newer that then works, because `require(esm)` loads a module with no top-level await; on
older Node it throws `ERR_REQUIRE_ESM`. Verified rather than assumed: a `require()` of the built
package on Node 25 gets all the way to `ReferenceError: HTMLElement is not defined`, which is the
DOM missing, not the module format. Dropping `default` would harden that into a resolution error,
at the cost of bundlers that request no conditions — not worth it.

Adding one back is not the small favour it looks like. Both engines declare `"type": "module"` while
pointing their own `exports.require` condition at a `.js` UMD file — and under `"type": "module"`
that extension is ESM, so Node parses the UMD as ESM: its `typeof exports == "object"` branch never
runs, nothing is exported, and `require()` hands back an empty module namespace. A CJS build that
externalized them would therefore define `default` as that empty namespace and throw
`TypeError: ... is not a constructor` the moment a spring is built, while one that bundled them
would ship a private duplicate of both engines to work around someone else's packaging bug.
Neither is worth it for a format on its way out.

## Testing

The suite has no DOM library:

- Listener-map element stubs cover the pointer event adapter.
- `captureFrames()` stubs `requestAnimationFrame` so the real PhysicsEngine can run synchronously.
- Dialog targets are style-object stubs.
- Snap parsing/default tests import the pure helper module.
- `scroll-policy` tests feed the module metric snapshots, and name their cases by finger direction. The touch cases drive the **full round trip** — finger delta through `awayOffset()` into DragGesture's away-signed direction and back through `fingerFromAway()` — because asserting in finger space alone made the left and right rows the same assertion twice, and reverting the inversion left the suite green.

The element-stub harness installs global `HTMLElement`, `window`, `document`, and `customElements`
stubs, then uses `module.registerHooks` to neuter the CSS import so `src/sheet.js` can load under
Node. That hook requires Node ≥ 22.15 or ≥ 23.5; older releases skip the element suite cleanly.

**Assert the exact number, not a bound that the bug also satisfies.** The flush-exit bug lived for a
whole release under two tests that looked like they covered it: `path.at(-1) >= 399` on a 400px
panel, and `>= 199` on a 200px one. A flush exit — no inset, no cushion — passes both. They now
assert `size + EXIT_CUSHION`, and a pure-builder test pins the runway per profile and mode. Any
assertion of the form "it moved far enough" deserves suspicion; "it moved exactly this far" is what
catches an off-by-an-inset.

The DOM-free suite cannot see the defect this rule is about, so the geometry chain is worth checking
in a browser: force-measure each profile's real resting box, and confirm the gap the engine derives
equals the gap the CSS actually produced. Note that a **backgrounded tab runs no `requestAnimationFrame`
at all**, so no spring-driven motion can be observed through automation — check geometry statically
there and leave the motion to the integrator simulation, which matches measured browser runs to
within a frame.

`test/package.json` points the `node --test test/` directory argument at `all.test.js`, which imports every suite.

`dist-smoke.test.js` is the one suite that reads `dist/` instead of `src/`, and it executes the
artifacts rather than inspecting them: a module-format or interop mistake is invisible until
something loads the file. It pins the shipped file list to exactly `sheet.esm.js` and
`sheet.min.js`, checks both expose the same seven named exports, and asserts the split that
distinguishes them — the ESM keeps the engines as bare imports, the UMD bundles them. The UMD runs
through a `node:vm` sandbox shaped like CommonJS on purpose: loaded as ESM it would take its global
branch instead and assert nothing about what a consumer receives. All of it skips cleanly when
`dist/` has not been built.
