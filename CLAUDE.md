# @magic-spells/sheet Development Guide

## Commands

- `npm run build` — production Vite builds for ESM and minified UMD; deliberately no CommonJS build
- `npm run dev` or `npm run serve` — watch ESM into `demo/dist`, serve `demo/` on port 3066
- `npm test` — DOM-free `node:test` suite
- `npm run lint` / `npm run format` — ESLint / Prettier
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

- `<sheet-panel>` — breakpoint/profile policy, snap resolution, gesture ownership, profile morphing, dialog-panel delegation
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

## Engine Transport Seam

`SheetEngine` is assigned to `panel.morphEngine`, using dialog-panel's duck-typed transport: `show({ from, to, display })`, `hide()`, `state`, `on(name, listener)`, `off(name, listener)`.

`animatesDialog` is a dynamic getter. SheetEngine is normally a **direct** engine flying the real dialog; an armed trigger morph temporarily makes it a **proxy** engine whose inner MorphEngine flies a stand-in blob while the real dialog stays invisible.

| initiator | transport selected by `animatesDialog` |
| --- | --- |
| `sheet.show(trigger)` with `morph-trigger`, a usable trigger, and a non-zero `--sheet-morph-duration` | proxy blob (`false`) |
| `panel.show()` called directly, or any show with no armed morph | direct spring (`true`) |
| close button, Escape, backdrop, or programmatic `hide()` while a usable trigger morph is live | proxy reverse (`false`) |
| swipe dismissal after `armGestureExit()` | direct spring exit (`true`) |
| deliberate close after the trigger has detached or left the viewport | direct spring exit (`true`) |

`--sheet-morph-duration` does double duty: profile-morph duration AND the trigger morph's on/off switch. `prefers-reduced-motion` zeroes it — that is the entire reduced-motion policy (both morphs off, spring entrance/exit stay). Read once in `SheetPanel.show()`.

dialog-panel reads `direct` at the **top** of `show()`/`hide()`, before `beforeShow`/`beforeHide` — the initiator must arm the transport before delegating, and nothing inside a lifecycle handler may change the mode. `SheetPanel.show()` is the one trigger-morph classification point; the gesture release arms its direct exit before calling `panel.hide()`.

- **Promotion at show-start.** `engine.show()` synchronously paints the hidden `p = 0` frame, then `showModal()` in the same task, so the promotion repaint lands while nothing is visible. Promoting at settle repaints the fully visible panel — the original bug in both engines' transports.
- **Demotion after the hidden settle.** The exit runs fully modal; `dialog.close()` fires from dialog-panel's finalize on the engine's `hidden`. Deliberate knock-ons: taps during the exit land dead on `::backdrop`, and focus (incl. `autofocus`) enters at entrance-start, not settle.
- Dialog-panel also listens for engine `stop` (finalize without exit animation) and, proxy runs only, `reveal` (mid-flight promotion). A direct run needs no `reveal`.

The engine declares itself, so the panel selects the transport with or without a trigger; `show(trigger)` passes the trigger through purely for focus return. The old `panel.show(trigger || this)` hack is gone — do not reintroduce it.

**`stop()` is the only place terminal state is reset by hand.** It is dialog-panel's force-close repair path (`<form method="dialog">`, app-level `dialog.close()`): it can land mid-flight, emits no `beforeHide`, and never paints a frame — so it must explicitly clear what only `#applyFrame` would have cleared. Two flags qualify: a stale `#morphing` leaves `#applyFrame` inert forever (next `show()` paints no `p = 0` frame → full-size flash), and a stale `#flightPhase` of `'showing'` makes `#flightEnvelope` hold the old opacity into the next entrance.

In `#settle()`'s hidden branch, inline styles are restored **before** `hidden` is emitted (matching `stop()`): the emit runs finalize synchronously and a `hidden` listener may re-enter `show()`; restoring afterwards would wipe that new run's freshly painted `p = 0` frame.

Assigning `morphEngine` adds `[morph]` to dialog-panel, whose CSS neutralizes the dialog's transform/transition; SheetEngine's inline motion wins. Display:

```css
dialog-panel:has(sheet-panel) > dialog[open] {
	display: flex;
}
```

Never put `display:flex` on the closed base dialog — a closed dialog must keep the UA's `display:none`, or `[morph]` makes it paint at rest. SheetEngine's inline `display:flex` in `#prepareDialog` (restored at the shown settle) is a computed no-op kept as the safety net returning a force-closed dialog to `display:none`.

## Trigger Morph

Exactly two geometry owners, never two writers on one element. MorphEngine owns the dialog's inline styles from blob launch through its inner `shown`/`hidden`; SheetEngine parks and paints nothing. The open handoff happens only after the inner `shown`: SheetEngine then builds the resting track and paints `p = 1`. Painting even the hidden `p = 0` frame before launch would enter MorphEngine's snapshot and get restored over the settled panel at handoff.

`#usableTriggerBox` is both the arm gate in `SheetPanel.show()` and the engine's `triggerProbe` on the hide path. It refuses a detached trigger, a zero-size one, one wholly outside the viewport, and — **only while the engine is `hidden`** — one hidden with `visibility`, `display: none`, or `opacity: 0` (the blob clones with those forced back on, so morphing from a hidden trigger would flash content the page meant to hide). The state gate is required, not defensive: MorphEngine itself hides the trigger for the whole flight and shown period, so the hidden style only reflects the page's intent while `hidden`. Geometry checks stay live — a trigger that detaches or scrolls away while open falls back to the direct spring exit.

The inner engine's `stop` event is deliberately swallowed: `#releaseBlob()` uses `blob.stop()` as a transport handoff for a swipe dismissal, and forwarding it would make dialog-panel finalize and demote mid-swipe-release. Only `SheetEngine.stop()` forwards its own terminal `stop` (the real force-close path).

`#releaseBlob()` must call `#applyFrame(#p)` in the **same task** as `blob.stop()` — the stop restores the pre-flight snapshot, erasing the live drag pose; waiting a frame leaves one paint where the dialog snapped back to rest.

A direct exit never runs the reverse flight, so the trigger is *handed back* instead of restored at stop (which put it at full opacity under a still-lit scrim on frame 0): `blob.stop({ restoreSource: false })` keeps it hidden through the exit, and `#returnTrigger()` restores it at the hidden settle. **The `triggerreturn` emit precedes the restore**, so a listener decorates a button that cannot yet paint — the other order only works while listener registration order happens to cooperate. `stop()` and `destroy()` hand back with `announce = false` (no frame painted, nothing to wait out). Every terminal route releases the hold — the hold is the only thing that can strand a consumer's button invisible.

The pop is CSS, not MorphEngine: `--sheet-trigger-return-duration`/`--sheet-trigger-return-easing` drive a `sheet-return` attribute, read off the **trigger** (where the `[sheet-return]` rule applies and overrides live). Zero writes no attribute and schedules nothing — reduced motion and the opt-out are one code path.

**Known gap, deliberately not fixed for 0.1.0:** the reverse flight stays bound to the trigger it was armed with — `show(B)` landing during a reverse flight armed to A reopens with B's content but morphs back into A's box and returns focus to A. Not the ten-line fix it looks like: `animatesDialog` keys off `#morphTrigger` itself, and `disarmMorph` refuses mid-flight *by design*. The real fixes change the classification point and want their own pass.

`show()` during a reverse blob flight turns the existing MorphEngine run around — never a second blob. MorphEngine has no source-side `reveal`, so SheetEngine re-emits `reveal { to: dialog }` synchronously before reversing; without it dialog-panel would promote a fully visible settled surface in one repaint at `shown`.

Focus follows the transport boundary: direct spring → focus at entrance-start; trigger morph → focus at the forwarded `reveal`, neither earlier (dialog still invisible) nor at settle (visible promotion repaint).

## Motion Architecture

`src/sheet-engine.js` owns one PhysicsEngine spring and builds FrameEngine keyframes from the active position, mode, effect, and geometry.

- Spring travel is always `TRAVEL = 100`.
- Visual choreography uses `p = position / TRAVEL`; never PhysicsEngine's per-run `progress`.
- Show/hide reversals interpolate on a two-frame track between the pose already painted and the *other run's* endpoint: a `show()` mid-exit runs to the entrance rest frame with no velocity; a `hide()` mid-entrance runs to the **exit** track's hidden frame with the queued dismissal velocity.
- Early settle requires both `|position - target| < 0.3` and `|position - lastPosition| < 0.15` for two consecutive frames.
- Below the hidden frame, extrapolation is clamped at `p = 0` for the **flight** phases only; landed phases continue below. Above `p = 1` the clamp is profile-specific: only a bottom sheet keeps its overshoot breath.
- Size-like values in `CLAMP_POSITIVE` are floored at `0px`.
- `p = 1` is rebased to the active snap after every settle.
- Snap transitions interpolate current and destination resting geometry, then emit `{ from, to }`.

#### Fade reveal percent

A fading effect reaches full opacity at `DEFAULT_REVEAL_PERCENT = 80` — a percent of `TRAVEL`, **not** of time — and is flat to `100%`. The flatness keeps spring overshoot from flickering a settled panel toward transparent; walked backwards it puts the fade-out in the closing tail. Springs front-load, so a lower value ends the fade far too early in wall-clock terms (the old `55` finished at 28% of the run and the entrance read as stopping dead). A test asserts the keyframe percents are exactly `[0, 80, 100]`.

#### Velocity has no default denominator

The spring always runs `0 → TRAVEL`, so a release velocity only means something as a share of the pixel distance that run covers — which differs per phase. `velocityToSpring(velocityPxMs, spanPx)` takes the span explicitly; every call site states its own:

| run | span |
| --- | --- |
| `show` (mid-exit reversal) | resting size — carries no velocity anyway |
| `hide` (mid-entrance reversal) | `exitTravel()` — rebuilds onto the real exit track |
| `returnToRest` (side or center) | resting size — capped, see below |
| `settleTo` (snap) | **signed segment `targetSize - startSize`** — capped, see below |
| `dismiss` | `exitTravel()` — the runway this run has left |

Traps, each shipped once:

- A snap's segment is **signed** — downward snaps are negative. Passing the always-positive resting size inverted every downward flick and made all snaps settle identically. There is deliberately no default span, so the mistake cannot recur silently.
- `dismiss` normalises over `exitTravel()` — the runway *left*, floored at the extent still on screen (a `fade-scale` exit doesn't translate; normalising over its cushion alone would cross the run in one frame). Normalising over resting size understated deep-drag flicks ~2.8×.
- The `exit` preset was deliberately left alone. Loosening it toward `snap` was measured and rejected: it bought only invisible tail past the hidden frame (panel gone, `hidden`/focus return still waiting). Do not rediscover the retune.

#### No seed may outrun the spring that receives it

The seed scales as `1/span`, so short runs are explosive. All three velocity-taking runs cap at `terminalSeed(preset, distance) = distance × attraction / friction` — the velocity the spring could have built for itself over that distance:

- `settleTo` → `SNAP_VELOCITY_LIMIT = terminalSeed(snap, TRAVEL)`. A snap hop can be ~1px; uncapped, an ordinary flick through it overshot 85px. Capping (rather than declaring short hops velocity-free) leaves normal flicks unchanged.
- `returnToRest` → `terminalSeed(rest, TRAVEL - start)` — the distance *this* run has left. Do not drop the `/ friction` term: written as the bare attraction impulse the cap swallowed every flick and all releases returned in identical time. The suite asserts the spread across velocities **and its ordering**.
- `dismiss` → `EXIT_VELOCITY_LIMIT = terminalSeed(exit, TRAVEL)`. A deep drag makes the exit span tiny; uncapped, `p` shot to −0.24 and `hidden` (with `dialog.close()`, focus return, scroll unlock) trailed the already-invisible panel by ~283ms.

**The fix is the cap, not a wider `exitTravel` floor.** Flooring at painted extent instead measures well on `fade-scale` but reintroduces the recorded bug for translating exits (understates flicks ~2.8×); two pinned tests fail on that change and they are right to.

#### Nothing but a bottom sheet is painted past flush

`#applyFrame` clamps `p` at 1 for any non-bottom profile — their tracks end at rest, and anything past flush is extrapolation. This cannot be tuned away: a synthetic keyframe past 100 is collinear with the track and changes nothing, so refuse to paint rather than bend geometry. A side sheet past flush translates inward and opens a backdrop sliver.

**The clamp is a cap, never a floor.** Landed phases extrapolate below `0` so an inset or centred panel can be carried off screen 1:1, and `#applyLiveOffset` rubber-bands overpull to ~`-2·√(overpull)`. Flooring `returnToRest`'s `start` teleported a 20px overpull away on its first frame; `settleTo` never clamped its start and never had the defect. The regression test asserts **comparatively** — a flush release and an overpulled release must not produce the same frame sequence — because the floor's signature is making two different releases identical.

`paintedProgress` keys off **position**, so a desktop bottom panel keeps the uncapped bottom rule even though content-sized — its track is linear and translate-only, so past-flush extrapolation lifts it slightly off its edge (covered by the `--sheet-bleed` skirt) instead of stretching a content-sized box.

#### The floor belongs to a flight, not to a landed track

`paintedProgress`'s lower end is **phase-aware**. `showing`/`hiding` paint effect keyframes whose `0%` frame carries scale/opacity/off-screen translate — extrapolating past it drives scale negative — so they floor at 0. Landed phases (`dragging`, `snapping`, `returning`, `shown`) paint linear drag/rest tracks; below zero is the 1:1 continuation the finger asks for. Flooring them froze a centred confirm fully visible under the finger, undraggable off screen — a bug a bottom sheet (whose logical 0 *is* off-screen) cannot see. The upper cap stays position-keyed in every phase. `--sheet-progress` publishes through the same function with the same phase.

#### A slide's runway is the panel's own reach

A slide's hidden frame sits `size + slideInset(profile, size) + exitCushion(profile)` past rest. The cushion defaults to `EXIT_CUSHION` (28px), probed from `--sheet-exit-cushion` — a token because it must clear the **shadow**, not the box (the demo's 60px blur needs 72px).

`slideInset` has two sources: edge-mounted profiles take `profile.edgeInset`, resolved by the *component* (0 for edge mode, probed `--sheet-card-margin` for card — probing CSS is the component's job; the field is optional, absent reads as edge-mounted); a centred dialog is derived in the *engine* as `(viewportHeight - size) / 2` (needs per-run `size`, needs no DOM; `edgeInset` is ignored for centre). Exactness is the point — a safe over-estimate stretched the entrance and diluted release velocity over travel the panel never needed; tests assert the runway clears by exactly the shared cushion. The distance floors at `1` for a **negative** size, which is reachable: rubber-band overpull during a profile rebuild hands the live negative `#currentSize` to `#makeOpenFrames`.

#### One exit track, and it starts where the finger let go

`buildExitKeyframes` builds **every** dismissal, from rest or continuing a live drag: `100%` is the live resting pose — identical to what is painted at release, so nothing jumps — and `0%` is the effect's hidden pose. `dismiss()` always starts at `p = 1` and has no branch left to disagree with itself.

For a non-bottom profile the live pose is the **capped** one — `exitValues` reading the raw logical size made an overpulled dismissal jump inward before leaving. The branch this replaced reused the **drag** keyframes for drag-continuing dismissals, whose `0%` frame is exactly flush: every desktop swipe-close left a `--sheet-card-margin` sliver plus shadow, and centre left `(viewportHeight − height) / 2` of dialog on screen.

**The floor rule, stated once:** an exit must never end closer to rest than the pose it started from; when it starts displaced it ends at least one cushion further out.

```js
const floor = away > 0 ? away + exitCushion(profile) : 0;
```

The `away > 0` guard is load-bearing: from rest there is no floor, or every `fade-scale` exit would acquire a cushion of drift instead of scaling down in place. It also subsumes the negative-size floor above. `exitTravel()` shares `exitValues()` with the builder, so the velocity span and the painted keyframes can never describe different geometry. `paintedExtent`/`awayTranslation` read `restStyles`' piecewise rule back out per profile: a side sheet's exit pose is absolute, a bottom sheet's runway stops shrinking below its height floor.

#### A cancelled entrance leaves by the exit door

A `hide()` mid-entrance builds the real exit frames for the live size, then rebases: `0%` is that exit's hidden pose, `100%` the exact frame already painted — the reversal's first frame is byte-identical to the entrance's last and the run starts at `p = 1`. (Reversing down the entrance keyframes — the old behaviour — ignored `exit-effect`, skipped the edge-clear scrim remap, and walked an entrance-only bounce keyframe backwards.) One shortcut: a reversal caught at the untouched `p = 0` frame switches hidden poses there and completes asynchronously rather than springing across zero travel.

Clear progress derives from `frameAwayTranslation()` — the away-signed translate read out of the frame actually painted — so the scrim's edge crossing shares the panel's frame. `backdropCeilingExtent` mirrors the show-reversal's `backdropFloorExtent`: the floor stops a cancelled exit restarting the entrance opacity ramp from nothing; the ceiling stops a cancelled entrance restarting the exit ramp from full. Both stated as extents so `dismissalZoneProgress()` inverts them exactly. The suite pins the results as exact poses.

#### Arriving and leaving are separate questions

`exit-effect` and `desktop-exit-effect` resolve by falling back, never by defaulting to their own value:

| question | mobile | desktop |
| --- | --- | --- |
| how does it arrive? | `effect` | `desktop-effect` → `effect` |
| how does it leave? | `exit-effect` → `effect` | `desktop-exit-effect` → `exit-effect` → `desktop-effect` |

Saying nothing keeps symmetry: leaving mirrors arriving. Neither is in `#profileKey`, and both are handled ahead of `PROFILE_ATTRIBUTES` in `attributeChangedCallback` — an exit effect changes no resting geometry, so morphing on it would FLIP identical boxes.

**`desktopEffect` defaults to `effect` for everything except `center`** (which gets `fade-scale`). Defaulting all card modes to `fade-scale` made desktop drawers fade in place instead of sliding from their edge; centre keeps its own default because inheriting a bottom sheet's `slide` would fly it a viewport height into mid-screen.

#### A sheet that may not be waved away

`dismiss` is a token list — `swipe`, `backdrop`, `escape` — parsed by `parseDismiss` in `sheet-engine.js` (parsers live in the engine, node-testable). Absent = all three open; `none`/empty = all closed; `"all none"` resolves locked; an unrecognised token opens nothing — fail closed, because a refused gesture is recoverable and a closed confirm is not.

**Each route is blocked at its source, never by vetoing `beforeHide`** — by then an Escape and a `[data-action-hide-dialog]` button are the same call, and a veto would break the very buttons the feature requires. One sanctioned exception: `#outsideGuard` records a pointerless click's target for its synchronous dispatch so `beforeHide` can veto only a non-closing control misread as backdrop from `(0,0)` coordinates.

- **swipe** — checked where the release resolves; a refused dismissal is *redirected* to the active snap (refusing downstream would leave the panel parked at its dragged pose with no settle).
- **backdrop** — the sheet's tap branch plus a capture-phase `click` on dialog-panel that swallows outside clicks before dialog-panel's bubble handler. The native `::backdrop` reports the *dialog* as target, so geometry is the only test, and it uses the same one dialog-panel does.
- **escape** — `document.addEventListener('cancel', …, true)`; capture-down is the only ordering ahead of dialog-panel's own listener, since `cancel` doesn't bubble and that listener sits on the dialog.

`snaprelease` carries `prevented: true` for a refused dismissal. `dismiss` is deliberately **not** in `observedAttributes` — every guard reads `dismissPolicy` live at event time, so there is no state to resync.

### Spring presets

`SPRING_PRESETS` tunes the spring per motion phase; `#tuneSpring()` selects one before every run. Both dials move together — attraction sets travel speed, friction sets damping.

**Tune on `t90`, not settle time.** Springs front-load, so settle time does not describe perceived speed — an earlier pass tuned on settle alone and shipped an entrance that read as a snap. Budget and report both numbers.

| Preset | attraction | friction | settle | t90 | max `p` |
| --- | --- | --- | --- | --- | --- |
| `entrance` | 0.055 | 0.32 | ~483ms | ~267ms | 1.000 |
| `exit` | 0.30 | 0.56 | ~267ms | ~133ms | 1.000 |
| `snap` | 0.065 | 0.3 | ~566ms | ~200ms | **1.024** |
| `rest` | 0.15 | 0.455 | ~333ms | ~167ms | 1.000 |

`snap` matches `../bottom-sheet` and is deliberately loose: the 2.4% overshoot is the room that makes a flick legible (tighter tuning absorbed release velocity within a frame), and it is why the snap keyframes carry explicit frames past their destination. `rest` exists because a snapless profile has no room to overshoot — its track ends flush at an edge — and splitting the preset alone wasn't enough, which is why the paint clamp above exists.

The numbers are asserted in `test/sheet-engine.test.js` via a simulation of the integrator plus the early-settle detector, matching browser runs to within a frame. Overshoot budgets are asserted **per preset**, so `snap`'s breath cannot cover another phase drifting loose.

#### Public override

`spring="attraction friction"` (attribute) or `sheet.spring = { attraction, friction }` (property). Parsing lives in `parseSpring()` in the engine (node-testable); the component's static delegates. Both dials must be exclusive of 0 and 1; invalid input is ignored and the presets stand.

The override governs **arrival only** — exits and snaps keep their presets. Scaling them proportionally was tried and abandoned: the exit's attraction is ~5.5× the entrance's, so any brisk override clamps into badly overdamped motion. A test pins exit frame counts as identical across overrides.

### Backdrop opacity

The overlay tracks the **dismissal zone**, never raw progress: any position at or above rest saturates at exactly 1; only travel below rest maps `[rest → off-screen]` onto `[1 → 0]`. Saturation stops rubber-band overscroll, spring overshoot, and entrance overshoot from lightening the overlay; flight progress scales the visible extent, so opening to a mid snap never rests half-faded.

"Rest" is the lowest snap **plus the inset the panel already floats by**: `#backdropRestExtent()` = `snaps[0] + slideInset(profile, restSize)`, and the numerator gains the same inset (`#currentSize + inset`). Snap-alone drove a centred dialog's scrim to 0 with a third of the dialog still on screen. Adding the inset to both ends keeps saturation at exactly 1 at exactly the lowest snap, and an edge-mode bottom sheet (inset 0) is arithmetically unchanged.

`#flightEnvelope()` holds a flight monotonic — an entrance may only darken, an exit only lighten — for `showing`/`hiding` only; landed phases follow the finger both ways. Needed because a loose public `spring=` override can oscillate, and the return swing dips below saturation where the clamp says nothing (the scrim pulsed in time with the panel). The mark is **seeded on every phase change, never reset to an endpoint**, so a reversal continues from the opacity already painted.

`(#currentSize + inset) × p` is the visible extent for entrances and non-sliding exits. A slide exit is the exception: its hidden frame carries the shadow cushion past the edge, so `exitClearProgress()` — derived from the same `exitValues()` geometry as the keyframes — maps `[p = 1 → edge crossing]` from the release opacity to `0`, and the cushion clears with no overlay over an empty screen.

A reversal's endpoint is seeded from the **painted opacity inverted through `#backdropRestExtent()`**, never recomputed as `p × size` — the slide remap makes those disagree (a jump up to 0.18 under a 72px cushion). There used to be a `flightSize: restSize` override here papering over the old drag-continuing exit branch's p² bug; with one exit track there is nothing to paper over — do not reintroduce it.

`#syncBackdropProgress()` runs inside `#applyFrame()` — the single place panel styles are written — so the overlay can never disagree with the panel or lag a frame. It surfaces as `--sheet-backdrop-progress`, always `[0, 1]`.

`--sheet-progress` reports what was **painted**. The rule lives once, in the pure `paintedProgress(position, p, phase)` export — floor at 0 for flight phases only, cap at 1 only for non-bottom profiles — and both writers (`#applyFrame()` and the component's `#setProgress()`) apply it to the same frame via the phase handed out on every `change` event, so they cannot drift. An unresolved profile falls back to a plain `[0, 1]` clamp. A hide-to-show reversal restarts its two-frame track at `p = 0`, so its settle action carries the painted progress and visible-extent floors forward.

Two fixed traps: reusing `--sheet-progress` for the overlay lightened it on snap-to-snap drags, and spring overshoot leaking into the snap-size interpolation dipped it under 1 on a settle that never left the snap range — the size interpolation is clamped to its segment; the visual breath belongs to the keyframes.

### Sizing rules

**`snap-points` is a MOBILE-bottom attribute.** Between lowest and highest snap the logical size paints directly as `height`. Below the lowest snap the painted height pins there and `lowestSize - currentSize` maps to `translateY` 1:1 — at logical size 0 the panel is exactly off-screen. `#currentSize`, velocity, snap resolution, and backdrop progress all stay logical-size calculations.

Side sheets are **fixed width at all times**, from `--sheet-active-size` (component fallback `min(26rem, 90vw)`); JS must not publish a snap-derived value into that token for a side profile. Side drags are binary dismiss-or-return `translateX`.

Centred dialogs ignore `snap-points` and `mode`, take width from `--sheet-center-width`, and take **height from their own content**; `--sheet-active-size` is not published for them either — it is a width slot and a centre's size is a height. A desktop bottom profile is content-sized by exactly the same machinery: `contentSized(profile)` in `sheet-engine.js` (centre at any width, bottom past the breakpoint) is the one statement of which profiles those are, and it drives measurement AND the content-resize observer.

**No profile except a snap-resized bottom sheet may emit a size property in a keyframe.** `resizesWithSnaps(profile)` — `position === 'bottom' && !contentSized(profile)` — is that rule; `restStyles`, `awayTranslation`, `paintedExtent`, and the `willChange` hint all route through it, and tests assert it across profiles and tracks. Emitting a pixel `height` for a content-sized profile is self-defeating, not just redundant: it pins the box, `#measureBox` reads back its own last frame, and the `ResizeObserver` has nothing left to observe — which is why the fix lives at `restStyles`, not only in the stylesheet. A mobile bottom exit track is the one place a size is *pinned* rather than animated: both ends carry the painted height, so the run translates a constant-height box.

Three orthogonal questions, three predicates — never answer any of them with `position === 'bottom'`:

| question | predicate |
| --- | --- |
| which axis does this profile travel on? | `dismissAxis(position)` |
| does it resize, or only translate? | `resizesWithSnaps(profile)` |
| where does its single size come from? | `contentSized(profile)` |

`center` separates the first two (y-axis but translate-only); desktop bottom stops position answering resize at all. Every axis decision routes through `dismissAxis` (engine: `effectValues`, `awayOffset`; component: `#scrollChain`, `#dragMove`, `#matchesActiveAxis`); every resize decision through `resizesWithSnaps`. Slide *distance* is a third question again, owned by `slideInset`.

**A centred dialog must not use `height: auto`** — `inset: 0` pins both edges, and auto height with both pinned solves to *fill*; `margin: auto` only centres a definite height. `height: fit-content` gives both the size wanted and the precondition the auto margins need. `sheet-panel` opts out of its own `height: 100%` for both content-sized profiles for the same reason.

The two bottom profiles disagree about exactly one declaration — `height` — so the stylesheet states it in two **mutually exclusive** selectors (`[data-position='bottom']:not([data-desktop='true'])` for the snap height, `[data-desktop='true'][data-position='bottom']` for `fit-content` + max-height cap) rather than declaring one and overriding it. Shared declarations stay in the shared rule.

FrameEngine back-fills composite properties (`transform`, `filter`) onto any keyframe that omits them, using zeroed defaults — a partial keyframe bends the transform track. Every bottom drag keyframe, including the breakpoint at the lowest snap, must carry a full transform; every track the breakpoint does not intentionally bend must stay collinear. The mid-timeline opacity reveal frame follows the same rule.

## Gesture Layers

Sensing is separate from policy.

### DragGesture

- Pointer capture is deferred until movement exceeds `5px`.
- X and Y use independent rolling `100ms` velocity trackers.
- Direction comes from the dominant axis of total displacement.
- Cancellation reports zero velocity.
- An **uncaptured** pointer that leaves the element ends the gesture as a cancellation.

That last rule is mouse-only by nature: touch/pen get implicit capture and always deliver `pointerup`, but a mouse can press, drift out inside the 5px slop, and release unseen — after which the stranded gesture re-matches on the next bare hover (stable `pointerId`) and captures a button-less pointer. The `pointerleave` listener is guarded on `#captured` (a captured drag can't fire it; post-release leaves early-return) and ends as a **cancellation**, not a clean release — a pointer that wandered off must never dismiss.

**Continuous tracking (do not break this):** displacement is measured continuously from `pointerdown`, never rebased mid-gesture. Reversing direction walks the panel back through the same positions.

### Scroll claim policy

`src/scroll-policy.js` is the single answer to "does the content scroll, or does the sheet move?" on the touch path — DOM-free, fed plain metric snapshots. The rule is stated in **finger space** on the dismiss axis, which makes it position-independent: content consumes while it can still scroll opposite-of-finger; the sheet claims when that room runs out. `fingerFromAway(position, away)` is the only away↔finger seam, and only `left` — the one profile dismissed toward smaller coordinates — inverts. It is a named, tested function because that line is exactly where the bug lived: per-profile hand-rolled branches mirrored the same edge error into each other.

The unit is a scroll **chain**, not the content element: `#scrollChain()` walks from the gesture's target up to and including `sheet-content`, keeping nodes whose computed overflow on the dismiss axis is `auto`/`scroll`; any member with room answers for the chain, so a nested carousel scrolls natively and hands off at its own edge. The chain is snapshotted once at `pointerdown`; native scrolling that outruns it fires `pointercancel`, which abandons the drag anyway. Content passes the same overflow filter as every other node (admitting it unconditionally made an `overflow-x: hidden` consumer undismissable); an empty chain means the sheet claims.

`SCROLL_EDGE_TOLERANCE` gives the far edge 1px of slack (fractional DPR puts `scrollHeight` a hair above `clientHeight`); the near edge is a hard zero.

`sheet-content` is `touch-action: pan-x pan-y` with `overscroll-behavior: contain` for **every** position. Arbitration belongs to the claim logic and the single non-passive `touchmove` veto, not to `touch-action` — pinning one axis per profile forbade panning on the other for every descendant.

### SheetPanel policy constants

- `FLICK_VELOCITY = 0.5 px/ms`
- `OVERSCROLL_RESISTANCE = 0.2`
- Resize throttle: `100ms`

Header and footer always claim. Content defers to its scroll chain; its single non-passive `touchmove` listener vetoes scrolling only after a drag is claimed.

**The scrim is not a drag surface, and `<dialog-backdrop>` is not an event target.** Under `showModal()` the native `::backdrop` wins every scrim hit test and reports the **dialog** as its target (measured: `elementFromPoint` returns the dialog everywhere; `pointer-events: none` on `::backdrop` drops events on `<html>`, not the element). The element is a paint surface only, and must stay an element rather than the pseudo-element so the morph blob can fly above the scrim and below the dialog.

Scrim gestures are therefore read off the dialog by geometry. `#outsideGuard` (capture-phase on `dialog-panel`, ahead of its bubble-phase `dialogClick`) refuses an outside click when the `dismiss` policy forbids `backdrop` **or** the gesture did not begin on the scrim. `#scrimPress` records whether `pointerdown` landed on the dialog itself — a `click` is retargeted to whatever held pointer capture, so selecting text in the sheet and releasing past its edge used to close it. Starting position answers both cases without a distance gate, which would refuse the near-miss swipe; the old target-based exemption (`dialogRef.contains(target)`) is exactly what waved the captured release through — do not restore it.

The panel itself is the fifth drag surface, existing for one region: a side sheet's handle strip (its own `::before` in padding no child covers). It claims rigidly and takes `touch-action: none` for side positions. The trap is bubbling: child surfaces' `pointerdown` reaches the panel's DragGesture too, and merely ignoring callbacks would still capture at slop and starve the owning surface — `#dragStart` *refuses* any hit whose target is not the panel directly, via DragGesture's return-`false` seam (no capture, no further callbacks).

Dismissal always enters through `panel.hide()` so cancelable `beforeHide`, focus restoration, Escape handling, and native dialog cleanup stay centralized. Gesture velocity is queued on SheetEngine before delegation.

Every claimed touch release emits `snaprelease` with `{ velocity, flick, direction, size, target, prevented }`. `target` reports the snap actually **taken**, never merely resolved. Two ways a resolved dismissal fails — `dismiss` refusing (answerable before `panel.hide()`) and a consumer's `beforeHide` veto (only answerable after, via `#dismiss()` returning `false`) — and both must report the active snap with `prevented: true`. The dismissal branch therefore emits *after* `#dismiss()`; emitting first let consumers key teardown off `target === null` while the sheet stayed open.

**A vetoed hide must hand back the live gesture.** `beforeHide` clears `#drag` for every route out, but only `#dismiss()` repairs its own; any other vetoed route (router guard, timeout, bare `panel.hide()`) froze the panel at its dragged pose. dialog-panel publishes no post-veto event, so the handler snapshots the live drag and re-checks on a **microtask**: if the engine never left `shown`, the gesture is restored (`#dismiss()`'s own repair runs first).

## Breakpoint and Snap Policy

Below `breakpoint`, mobile attributes apply; a mobile bottom profile uses the full snap list. **At or above it the snap list is ignored entirely** — every desktop profile is dismiss-only with one resting size (sides: their CSS width; centre or desktop bottom: intrinsic content height). Left, right, and center ignore the snap list on mobile too.

Each desktop attribute falls back to its mobile twin, with **two** exceptions:

- **`desktop-position` falls out to `center` when `position` is `bottom`.** Placement, not size — a floating card mid-screen reads as a desktop dialog. `desktop-position="bottom"` opts back in, still content-sized. Knock-on: `desktopEffect` answers `fade-scale` for desktop centre, so a plain bottom sheet fades on desktop rather than flying a viewport height.
- **`desktopMode` inherits nothing — it hard-defaults to `card` for every position.** The getter never reads `mode`; `desktop-mode="edge"` welds it back. Do not describe the desktop attributes as uniformly inheriting.

`max-display-width` *withdraws* the component rather than switching profiles: above it `show()` returns `false` before `#prepareOpen()`, and a resize crossing the line hides an open panel — which is why it **is** in `observedAttributes`, unlike `dismiss`. Absent or `none` resolves to `Infinity`. It exists for the layout that outgrows a sheet entirely (a filter drawer that becomes a permanent sidebar).

Flicks resolve from `SheetEngine.currentSize` — the live panel size at release — never from `activeSnap`, which is only updated after a settle and mid-drag still names the gesture's starting snap (resolving from it mis-targeted every long drag). A flick steps exactly one snap in its direction from the live position; a slow release chooses the nearest snap with the closed edge as a candidate.

**Nothing re-measures under a live finger.** A `snap-points`/`initial-snap` change refuses `#prepareOpen()` while a drag is active, exactly like the throttled resize path: `setSnaps` rewrites `#currentSize` and would discard the gesture's pose. A moving finger repaints correctly on its next move, and the release settle or next open re-measures anyway.

CSS lengths are resolved at open and resize with a hidden fixed-position browser probe, once per profile rebuild, never per frame. One `#probeLength(name, cssFallback, pixelFallback)` serves the four single-token lengths (`--sheet-active-size`, `--sheet-card-margin`, `--sheet-exit-cushion`, `--sheet-desktop-panel-width`); snap heights share a probe inside `#measureSnaps()`; a content-sized profile's intrinsic box is measured by `#measureBox()`. Every token is read off the **dialog** — the element the stylesheet's geometry rules apply to and where a consumer override lives (the desktop card width once read `sheet-panel` and quietly missed overrides). The pure `resolveSnapPoints()` helper handles deterministic unit conversion for tests.

### Profile morph

Crossing profiles while open **morphs the panel in place** (`#morphToProfile()`). The dialog is never closed, never leaves the top layer, and no `beforeHide`/`hidden` is emitted.

**It is a FLIP measure, not a transition on the geometry declarations** — CSS cannot interpolate `auto` for `top`, `height`, or `margin`, so transitioning those snaps. The order is the trick:

1. `engine.beginMorph()` — spring stops, `#applyFrame` goes inert, gestures refuse.
2. Snapshot the dialog's inline `MORPH_PROPERTIES`.
3. Read the live box.
4. `#prepareOpen()` — hand the new profile to CSS and re-measure snaps.
5. Read the destination box. **The pins must be off for this**, or it measures the scaffolding.
6. Pin back to the first box in explicit pixels, force layout.
7. Set the transition, write the second box.
8. On `transitionend` — restore the snapshot, `engine.endMorph()`.

**Unpinning restores; it does not blank.** Pins are written onto inline properties a consumer may already own, so blanking deleted consumer styles; `#stripMorphPins` restores the snapshot, and step 5 uses the same restore so the destination measures the consumer's real geometry. Two snapshot rules: a **re-entrant morph must not re-snapshot** (it would promote the previous FLIP's scaffolding to "what the consumer had"; the snapshot survives every retarget and is released only by `#finishMorph` — completion, safety timeout, zero duration, `beforeHide`'s abandon — plus `disconnectedCallback`); and **`height` is excluded when the outgoing profile is snap-resized** (that inline value is the engine's painted snap, and restoring it would pin the incoming profile — which paints no height — to the snap it just left).

`transform` and `opacity` stay at rest throughout. `beginMorph` lands the panel at rest in the *current* profile first — **`#landPendingSettle()` first, then the stop** (same order as `setSnaps`/`setProfile`): `settleTo` never leaves `'shown'`, so an in-flight snap settle passes the state guard, and stopping without landing leaves `#activeSnap` naming the old snap, jerking the panel backward before the `from` measure. `#landPendingSettle` early-returns unless the spring is still animating, so it must run before the stop.

Three things that look optional and are not:

- **The timeout beside `transitionend`** — the event doesn't fire for an interrupted transition or a start==end property; without it a panel strands in morph geometry.
- **Backdrop pinned to 1 and *published*, not merely held** — `#applyFrame` is inert during the morph, so the pin must be emitted or the scrim holds its faded value through the morph and pops at `#finishMorph`.
- **`from` is read, never remembered** — mid-transition `getBoundingClientRect` reports the animated value, which is what makes a re-entrant morph retarget seamlessly.

The temporary inline `transition` is the one sanctioned exception to dialog-panel's "no transition on a morph dialog" rule (its README:100), scoped to a window where the engine is parked and stripped on completion. Do not "fix" it.

A content-sized profile is the only one whose resting size can change with nothing external happening, so `#syncContentObserver()` puts a `ResizeObserver` on the dialog for exactly those profiles while open, and `#scheduleContentRemeasure()` debounces a `#prepareOpen()` off it — re-arming rather than reconfiguring under a live finger, morph, or spring, with a 1px tolerance that stops observe/remeasure loops and swallows the initial fire. It is armed from the **`shown`** handler and nowhere else: dialog-panel is still `'hidden'` at `beforeShow` and `show()`, so the `isOpen` gate refused every earlier install and the feature silently did nothing.

Only a `#profileKey` change morphs; same-profile resizes re-measure instantly (a window drag fires a resize every `RESIZE_THROTTLE_MS`, and morphing per tick would be unwatchable). The morph is the only CSS-driven motion in the package — no meaningful spring position exists between geometries sharing almost no properties. `--sheet-morph-duration`/`--sheet-morph-easing` tune it, and the component reads the duration back so `prefers-reduced-motion` collapses it to an instant swap rather than waiting on a transition that never runs.

Internal `data-position`, `data-mode`, `data-desktop`, and `data-effect` attributes scope active-profile CSS — implementation details, not public configuration.

## Build and Packaging

`scripts/build.mjs` — programmatic Vite with Lightning CSS and Terser:

- `sheet.esm.js` — runtime dependencies external
- `sheet.min.js` — minified UMD with runtime dependencies bundled
- `sheet.css` and `sheet.min.css`

`src/sheet.js` side-effect imports `@magic-spells/dialog-panel`, so one install and one import set up the whole family. It is a **peerDependency** because it registers the `<dialog-panel>` element and must stay a singleton — bundlers dedupe the bare specifier to one hoisted copy, and the guarded `customElements.get()` defines on both sides make the UMD's bundled copy safe. npm 7+ and pnpm auto-install the peer; Yarn 1 needs it named explicitly.

Production cleans output, builds sequentially, then gzips `sheet.min.js`/`sheet.min.css` and writes byte counts to `demo/dist/sizes.json`, which the demo hero fetches — advertised sizes are measured, never hand-maintained. Development output goes to `demo/dist` and is **ESM only** (the demo loads nothing else). The server runs on port 3066.

**There is no CommonJS build, on purpose.** Two entry points only: `sheet.esm.js` for module graphs, `sheet.min.js` for a `<script>` tag. `exports` declares no `require` condition but keeps a catch-all `default`, so `require('@magic-spells/sheet')` still resolves to the ESM file — which works on Node ≥ 22 (`require(esm)`) and throws `ERR_REQUIRE_ESM` earlier. Do not add a CJS build: both engines point their own `exports.require` at `.js` UMD files under `"type": "module"`, which Node parses as ESM and hands back an empty namespace — a CJS build externalizing them throws at the first spring, and one bundling them ships duplicate engines.

## Testing

The suite has no DOM library:

- Listener-map element stubs cover the pointer event adapter.
- `captureFrames()` stubs `requestAnimationFrame` so the real PhysicsEngine runs synchronously.
- Dialog targets are style-object stubs.
- Snap parsing/default tests import the pure helper module.
- `scroll-policy` tests feed metric snapshots and name cases by finger direction. Touch cases drive the **full round trip** — finger delta through `awayOffset()` into DragGesture's away-signed direction and back through `fingerFromAway()` — because asserting in finger space alone left the suite green when the inversion was reverted.

The element-stub harness installs global `HTMLElement`/`window`/`document`/`customElements` stubs and uses `module.registerHooks` to neuter the CSS import so `src/sheet.js` loads under Node. Requires Node ≥ 22.15 or ≥ 23.5; older releases skip the element suite cleanly.

**Assert the exact number, not a bound the bug also satisfies.** The flush-exit bug lived a whole release under `>=` lower bounds a flush exit also passed; those tests now assert `size + EXIT_CUSHION`, and a pure-builder test pins the runway per profile and mode. "It moved far enough" deserves suspicion; "it moved exactly this far" catches an off-by-an-inset.

The DOM-free suite cannot see CSS/engine geometry drift, so occasionally check the chain in a browser: force-measure each profile's resting box and confirm the engine's derived gap matches the CSS. A **backgrounded tab runs no `requestAnimationFrame`**, so no spring motion is observable through automation — check geometry statically and leave motion to the integrator simulation, which matches browser runs to within a frame.

`test/package.json` points the `node --test test/` directory argument at `all.test.js`, which imports every suite.

`dist-smoke.test.js` reads `dist/` and **executes** the artifacts rather than inspecting them: it pins the shipped file list to exactly `sheet.esm.js` and `sheet.min.js`, checks both expose the same seven named exports, and asserts the split — the ESM keeps dialog-panel (as a `from`-less side-effect import, which the singleton rule requires stay external) and the engines as bare imports, the UMD bundles them all. The UMD runs in a CommonJS-shaped `node:vm` sandbox on purpose (as ESM it would take its global branch and assert nothing about what a consumer receives). Skips cleanly when `dist/` has not been built.
