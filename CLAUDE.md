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

## Engine Transport Seam

`SheetEngine` is assigned to `panel.morphEngine`, using dialog-panel's established duck-typed transport:

```text
show({ from, to, display })
hide()
state
on(name, listener)
off(name, listener)
```

`animatesDialog` is a dynamic getter, not a declaration about the engine as a whole. SheetEngine is normally a **direct** engine that flies the real dialog, but an armed trigger morph temporarily makes it a **proxy** engine whose inner MorphEngine flies a stand-in blob while the real dialog stays invisible. That one bit tells dialog-panel which top-layer choreography is safe for the run it is about to start.

| initiator | transport selected by `animatesDialog` |
| --- | --- |
| `sheet.show(trigger)` with `morph-trigger`, a usable trigger, and a non-zero `--sheet-morph-duration` | proxy blob (`false`) |
| `panel.show()` called directly, or any show with no armed morph | direct spring (`true`) |
| close button, Escape, backdrop, or programmatic `hide()` while a usable trigger morph is live | proxy reverse (`false`) |
| swipe dismissal after `armGestureExit()` | direct spring exit (`true`) |
| deliberate close after the trigger has detached or left the viewport | direct spring exit (`true`) |

`--sheet-morph-duration` does double duty in that first row: it is the *profile*-morph
duration, and it is also the trigger morph's on/off switch. `prefers-reduced-motion` zeroes
it, which is the whole reduced-motion policy — both morphs go, and the ordinary spring
entrance and exit stay. Read once in `SheetPanel.show()`, alongside the other arm gates, so
reduced motion needs no second switch in JS.

dialog-panel reads `direct` at the **top** of `show()` and `hide()`, before it emits `beforeShow` or `beforeHide`. That ordering is load-bearing: the initiator must arm the transport before delegating to the panel, and nothing inside either lifecycle handler may try to change the mode. Doing it there is already too late — dialog-panel has chosen when to promote or demote the native dialog — and leaves the engine and panel following different ownership rules for the same run. `SheetPanel.show()` is therefore the one trigger-morph classification point, and the gesture release arms its direct exit before it calls `panel.hide()`.

- **Promotion happens at show-start.** `panel.show()` calls `engine.show()`, which synchronously paints the hidden `p = 0` frame, then `showModal()` in the same task — so the promotion repaint lands while nothing is visible. Promoting at settle instead repaints the fully visible panel (a one-frame color/compositing shift); that was the original bug, in both engines' transports.
- **Demotion happens after the hidden settle.** The panel does not close the dialog at hide-start; the exit runs fully modal and `dialog.close()` fires from dialog-panel's finalize when the engine emits `hidden`, with the panel invisible again. Two knock-ons are deliberate, matching the CSS path and bottom-sheet: taps during the exit land on `::backdrop` and are dead, and focus (including `autofocus`) enters the sheet at entrance-start, not settle.
- Dialog-panel also listens for engine `stop` (finalize without exit animation) and, for proxy runs only, `reveal` (their mid-flight promotion point). A direct SheetEngine run needs no `reveal`; a trigger morph forwards the inner engine's one because its safe moment is inside the blob flight.

Because the engine declares itself, the panel selects the engine transport with or without a trigger; `SheetPanel.show(trigger)` passes the trigger straight through, purely for focus return. The old `panel.show(trigger || this)` hack is gone — do not reintroduce it.

**`stop()` is the only place terminal state is reset by hand, and it has to be.** It is dialog-panel's force-close repair path — a `<form method="dialog">` submit, or an app-level `dialog.close()` — so it can land mid-flight, it emits no `beforeHide`, and it **never paints a frame**. Anything only `#applyFrame` would have cleared is therefore stranded unless `stop()` clears it explicitly, and two flags qualify. A stale `#morphing` leaves `#applyFrame` inert forever: the next `show()` paints no `p = 0` frame at all and `showModal()` promotes a dialog sitting at CSS rest — the full-size flash this entire transport design exists to prevent. A stale `#flightPhase` of `'showing'` makes `#flightEnvelope` mistake the *next* entrance for the same flight and hold the old opacity through its `Math.max`, so a reopened sheet pops straight to the scrim it was stopped under.

In `#settle()`'s hidden branch, inline styles are restored **before** `hidden` is emitted (matching `stop()`): the emit runs dialog-panel's finalize synchronously, and a `hidden` listener may re-enter `show()` — restoring afterwards would wipe that new run's freshly painted `p = 0` frame, now a visible full-size flash since the dialog is in the top layer from frame 0.

Assigning `morphEngine` adds `[morph]` to dialog-panel, whose CSS forces the dialog's transform and transition to neutral values. SheetEngine writes motion inline, which wins. The more subtle rule is display:

```css
dialog-panel:has(sheet-panel) > dialog[open] {
	display: flex;
}
```

Never put `display:flex` on the closed base dialog. A closed dialog must retain the UA's `display:none`, or `[morph]` makes it paint at rest. SheetEngine still sets inline `display:flex` in `#prepareDialog` and restores it at the shown settle — under promotion-at-start both are computed no-ops (`dialog[open]` supplies `flex`), kept as the safety net that returns a force-closed dialog to the UA's `display:none`.

## Trigger Morph

A trigger flight has exactly two geometry owners, never two writers on one element. MorphEngine owns the dialog's inline styles from the instant the blob is launched through its inner `shown` or `hidden`; SheetEngine parks for that whole window and paints nothing. The handoff on open happens only after the inner `shown`, when MorphEngine has finished restoring its target snapshot: SheetEngine then builds the resting track and paints `p = 1`. Painting even SheetEngine's hidden `p = 0` frame before launch would put that frame into MorphEngine's snapshot, and MorphEngine would restore it over the settled panel at the handoff — the blob would arrive correctly and the real dialog would jump back off screen.

### "Usable" is a geometry question, plus one the blob has already answered

`#usableTriggerBox` is both the arm gate in `SheetPanel.show()` and the engine's
`triggerProbe` on the hide path. It refuses a detached trigger, a zero-size one, one wholly
outside the viewport, and — **only while the engine is `hidden`** — one the page has hidden
with `visibility`, `display: none`, or `opacity: 0`. The blob renders a *clone* with those
forced back on, so morphing out of a hidden trigger would flash content the page meant to
hide.

The state gate on that last check is not defensive; it is the difference between working and
refusing every reverse morph. MorphEngine hides the source element for the whole flight and
keeps it `visibility: hidden` for as long as the panel is shown, so from the launch onward
the hidden style *on the trigger is the morph's own* and says nothing about the page's
intent. `hidden` is the only moment the answer is honest, and it is the moment that decides
whether the flight happens at all. Geometry is unaffected — the blob moves nothing — so a
trigger that detaches or scrolls away while the sheet is open still falls back to the direct
spring exit.

The inner engine's `stop` event is deliberately swallowed. `#releaseBlob()` uses `blob.stop()` as a transport handoff for a swipe dismissal, not as a request to close the dialog; forwarding that event would make dialog-panel finalize and demote the dialog in the middle of the swipe release, just before SheetEngine starts the direct exit. Only `SheetEngine.stop()` forwards its own terminal `stop`, because that is the actual force-close path.

Stopping the blob restores the inline snapshot it took before the flight, which also erases the live drag pose SheetEngine painted after the panel landed. `#releaseBlob()` must therefore call `#applyFrame(#p)` in the **same task** as `blob.stop()`. Waiting for the first spring frame leaves one paint opportunity in which the blob is gone and the dialog has snapped back to rest before continuing its exit from the finger's release point. (The trigger no longer reappears in that window — the stop is a handoff now, see below — but the dialog half of the argument is unchanged.)

#### A trigger that is never morphed back has to be handed back

A direct exit — a swipe dismissal, or a close after the trigger detached or scrolled away —
never runs MorphEngine's reverse flight, so its source crossfade never runs either. `stop()`
restoring the source therefore put the button back at **full opacity on frame 0 of the
exit**, where it sat under a still-lit scrim for the whole dismissal. That read as the button
popping into existence at the *end*, which is why the defect looked like a late appearance
rather than an early one.

`#releaseBlob()` calls `blob.stop({ restoreSource: false })` — MorphEngine 0.1.2's transport
handoff — so the trigger stays hidden and keeps its `morphing` mark for the length of the
exit, and `#returnTrigger()` hands it over at the hidden settle. **The emit precedes the
restore**, so a listener decorates a button that cannot yet paint and no frame exists showing
it visible and undecorated. The other order works only while the component's `triggerreturn`
listener happens to be registered ahead of anything else that paints — a timing invariant
nothing enforces. Stating the order inside one method makes it structural.

The alternative — let `stop()` reveal the button and re-hide it from the component — was
rejected for the same reason. It is correct only because the re-hide lands in the same
synchronous task, which is exactly the class of invariant the `#applyFrame(#p)` rule above
already exists to protect. One such invariant in this file is enough.

`stop()` and `destroy()` hand the trigger back with `announce = false`: a force close paints
no frame, so there is no exit to wait out and no entrance to introduce. Every terminal route
releases the hold, because the hold is the only thing that can strand a consumer's button
invisible.

The pop itself is CSS and stays out of MorphEngine. Its `sourceRevealUntil` crossfade looks
like a fit but is derived from the blob's live rect against the source's natural rect, and by
this point the blob is gone. What is left needs a duration, an easing, a keyframe and a
reduced-motion policy — `--sheet-trigger-return-duration` and `--sheet-trigger-return-easing`
driving a `sheet-return` attribute, read off the **trigger** because that is the element the
`[sheet-return]` rule applies to and where an override will have been written. Zero writes no
attribute and schedules nothing, which makes reduced motion and the opt-out one code path.

**Known gap, deliberately not fixed for 0.1.0:** that turn-around is always bound to the trigger the
run was armed with. `armMorph` refuses outside `hidden` and leaves `#morphTrigger` in place, so
`show(B)` landing during a reverse flight armed to A reopens with B's content but morphs back into
A's box and returns focus to A. It is not the ten-line downgrade it looks like — `animatesDialog`
keys off `#morphTrigger` itself, so the panel cannot force the direct transport without clearing it
mid-flight, and `disarmMorph` refuses that *by design* so a live reversal is never stripped. The real
fixes are releasing the blob and re-classifying at the seam, or retargeting the blob in MorphEngine;
both change the one classification point described above and want their own pass.

Calling `show()` while a reverse blob flight is running turns the existing MorphEngine run around; it never builds a second blob or a second set of keyframes. In that direction the dialog is the run's source, and MorphEngine has no source-side `reveal` event, so SheetEngine re-emits `reveal { to: dialog }` synchronously before asking the blob to reverse. Without it dialog-panel would keep the native dialog demoted until `shown`, then promote a fully visible settled surface in one repaint.

Focus timing follows the transport boundary. A direct spring promotes at entrance-start, so focus and `autofocus` enter then. A trigger morph keeps the real dialog out of the top layer while the blob establishes the geometry and moves focus only when the forwarded `reveal` promotes it. Moving focus earlier would target a dialog that is deliberately still invisible; moving it to settle would recreate the visible promotion repaint the reveal seam exists to avoid.

## Motion Architecture

`src/sheet-engine.js` owns one PhysicsEngine spring and builds FrameEngine keyframes from the active position, mode, effect, and geometry.

- Spring travel is always `TRAVEL = 100`.
- Visual choreography uses `p = position / TRAVEL`; never PhysicsEngine's per-run `progress`.
- Show/hide reversals interpolate on a two-frame track between the pose already painted and the *other run's* endpoint: a `show()` landing mid-exit runs to the entrance track's rest frame carrying no velocity, a `hide()` landing mid-entrance runs to the **exit** track's hidden frame carrying the queued dismissal velocity — see below.
- Early settle requires both `|position - target| < 0.3` and `|position - lastPosition| < 0.15` for two consecutive frames.
- Extrapolation below the hidden frame is clamped at `p = 0` for the **flight** phases (`showing`, `hiding`) only; the landed phases continue below it — see below. Above `p = 1` the clamp is **profile-specific**: a bottom sheet's overshoot is the intended settling breath, but every other profile is refused it — see below.
- Size-like values in `CLAMP_POSITIVE` are floored at `0px`.
- `p = 1` is rebased to the active snap after every settle.
- Snap transitions interpolate current and destination resting geometry, then emit `{ from, to }`.

#### The fade finishes late because the spring front-loads

A fading effect reaches full opacity at `DEFAULT_REVEAL_PERCENT` on the geometry timeline and is
flat from there to `100%`. That flatness is the point:
it keeps spring overshoot past `p = 1` from flickering a settled panel back toward transparent, and
keeps opacity out of the overshoot extrapolation entirely. Walking the frames backwards puts the
fade-out in the closing tail, which is where an exit wants it.

**The number is a percent of `TRAVEL`, not of time, and that is the whole trap.** Springs
front-load, so under the `entrance` preset `p = 0.55` arrives **133ms into a 483ms run**. The old
default of `55` therefore finished the fade at 28% of the wall clock and left 350ms in which the
only remaining motion was a `0.95 → 1` scale — about **9px on a 420px dialog**. Opacity is the
channel the eye actually tracks on a fade effect, and its rate went from steep to exactly zero in a
single keyframe, so the entrance read as arriving and then stopping dead well short of rest. The
default is `80`, which keeps the flatness the frame exists for — the entrance preset peaks at
`p = 0.9996`, and even a loose `spring=` override overshooting to 1.25 stays flat — while giving the
fade the back half of the run it was visually missing.

Nothing pinned the value before; a test now asserts the built keyframe percents are exactly
`[0, 80, 100]`, so a change to it is a change someone had to mean.

#### Velocity has no default denominator

The spring always runs `0 → TRAVEL`, so a release velocity is only meaningful as a *share of the
pixel distance that particular run covers* — and that distance differs per phase. `velocityToSpring(velocityPxMs, spanPx)`
therefore takes the span explicitly, and every call site states its own:

| run | span |
| --- | --- |
| `show` (mid-exit reversal) | resting size — the run covers off-screen → flush, and carries no velocity anyway |
| `hide` (mid-entrance reversal) | **`exitTravel()`** — it rebuilds onto the real exit track, so it normalises over the real exit's runway |
| `returnToRest` (side or center) | resting size — capped, see below |
| `settleTo` (snap) | **signed segment `targetSize - startSize`** — capped, see below |
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

#### No seed may outrun the spring that receives it

Normalising over the span is what makes a release velocity mean something; it is also what makes a
*short* run explosive, because the seed scales as `1/span`. All three runs that take a release
velocity cap it, and each takes the cap
from the same quantity: `terminalSeed(preset, distance)` — the velocity that spring could have built
for itself under a constant attraction over `distance`, held until friction balanced it, which in
the seed's pre-damping units is `distance × attraction / friction`.

- **`settleTo`** caps at `SNAP_VELOCITY_LIMIT = terminalSeed(SPRING_PRESETS.snap, TRAVEL)`. A snap
  hop can be about **1px** — the last of a slow drag onto its own snap — and an ordinary flick
  through it launched the sheet **85px past its destination** and wobbled there for the better part
  of a second. Capping rather than declaring short hops velocity-free is deliberate: a normal
  240px / 1.5 px·ms⁻¹ flick is unchanged (7.2px of overshoot, 33 frames), while the 1px hop thrown
  at 3 px·ms⁻¹ now overshoots 0.06px in 32.
- **`returnToRest`** caps at `terminalSeed(SPRING_PRESETS.rest, TRAVEL - start)` — the distance
  *this* run has left, because it starts wherever the finger left the panel. Anything past that
  becomes overshoot past `TRAVEL`, and a snapless profile's paint clamp is obliged to eat it: a
  20px pull flicked at 3 px·ms⁻¹ painted **one** pose and then sat motionless for 317ms while the
  spring finished running.
- **`dismiss`** caps at `EXIT_VELOCITY_LIMIT = terminalSeed(SPRING_PRESETS.exit, TRAVEL)`. It was the
  run that had none, and it is the same short-run explosion reached from the other direction: a
  dismissal normalises over the runway it has **left**, so a deep drag makes the span tiny. A 373px
  centred dialog dragged to a logical 10px has 28px of `fade-scale` runway; a 2 px·ms⁻¹ flick seeded
  ~131 units into a spring whose own terminal velocity is ~54. Measured, that drove `p` to
  **−0.242** and left **17 frames (~283ms)** in which the panel was already gone but `hidden` — and
  with it `dialog.close()`, focus return and scroll unlock — had not fired. Capped it undershoots
  0.005 with a 6-frame tail. A `slide` exit continuing the same drag had the milder version of it.

**The fix is the cap, not a wider `exitTravel` floor, and the difference matters.** The obvious
reading is that the floor should be the panel's *painted* extent rather than its logical `size`,
since a drag translates an intrinsically sized panel instead of shrinking it. It measures well on
`fade-scale` — and it reintroduces the bug `exitTravel`'s own docstring records, because a
**translating** exit's span really is the runway left: flooring a slide at the resting size
understates a flick by ~2.8× and returns every flick-to-close to the same speed however hard it was
thrown. Two pinned tests fail on that change and they are right to. The floor is the extent still
showing; what was unbounded was the seed. From-rest exits never reach the cap at any realistic
velocity, so only the deep-drag case moves, and a flick still reads below the cap
(267 / 217 / 150ms across `v = 0 / 0.5 / 1`) before saturating exactly as the other two runs do.

**The return cap was first written as the bare attraction impulse**, dropping the `/ friction` term
— 0.455× too small — and it swallowed every flick whole: `v = 1` and `v = 3` both returned in an
identical **200ms**. That is exactly the "every settle looks the same however hard it was thrown"
failure the `snap` preset's own tuning notes exist to prevent, reintroduced one function over. Stating
the derivation once, in `terminalSeed`, is why it cannot be got wrong in one place and right in the
other. At the honest terminal velocity a 120px pull spreads **300 / 267 / 233ms across
`v = 0 / 1 / 3`** and still paints every frame; the deepest pull with the hardest flick peaks at
`p = 1.001` for a single frame, below the 1.0001 the preset overshoots by unaided. The suite asserts
the spread *and* its ordering, so a retune that keeps three distinct numbers but inverts them — a
harder flick taking longer because its overshoot is being clamped away — fails rather than reads as
a pass.

#### Nothing but a bottom sheet is painted past flush

`#applyFrame` clamps `p` at 1 for any non-bottom profile. Their tracks end at rest with no frame
beyond it, so anything past flush is extrapolation. This cannot be tuned away: a synthetic keyframe
past 100 is *collinear* with the track and changes nothing, which is why the fix is to refuse to
paint it rather than to bend the geometry. `returnToRest`'s upper clamp on `start` depends on this —
the panel is already at `p = 1`, so the spring starts where the panel actually is.

**That clamp is a cap and never a floor, and the asymmetry is the whole point.** `start` was written
as `clamp(size / targetSize, 0, 1)`, but only the upper bound has the argument above behind it.
Below zero there is no refusal to paint: the landed phases extrapolate under `0` precisely so an
inset or centred panel can be carried off screen 1:1, and `#applyLiveOffset` rubber-bands a pull past
the closed edge to about `-2·√(overpull)`. The floor therefore started the spring somewhere the panel
was not — a right sheet resting at 400px and overpulled to −20px paints `translate3d(420px, …)`, and
a floored start painted `400px` on its very first frame, teleporting the whole overpull away before
the spring had moved. `settleTo` has never clamped its start and has never had the defect. The
regression test asserts it **comparatively** — a flush release and a 20px-overpulled release must not
produce the same frame sequence — because the floor's signature is making two physically different
releases identical, and because a single measured constant would only record whatever the code emits.

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

#### The floor belongs to a flight, not to a landed track

The lower end of `paintedProgress` is **phase-aware**, and it has to be, because the two kinds of
track have different shapes below zero. `showing` and `hiding` paint an effect's keyframes: their
`0%` frame carries a scale, an opacity, a translate off-screen, and extrapolating past it is
meaningless — a fast run drives scale *negative*. Those phases floor at 0, which is what the `exit`
preset's invisible-tail note above depends on. The landed phases — `dragging`, `snapping`,
`returning`, `shown` — paint drag/rest tracks that are linear in size with scale pinned at 1, so
below zero is not extrapolation into nonsense but the 1:1 continuation the finger is asking for.

Flooring them was the bug, and it is a profile-specific one that a bottom sheet cannot see. A bottom
sheet's logical size `0` *is* off-screen: the panel is translated by exactly its own height. Anything
that rests inset from the edge is not. A **200px centred confirm on an 800px viewport** floats 300px
down; at logical size 0 it has translated 200px and sits at `500…700` — fully on screen — and the
floor refused every further frame. It could not be dragged off screen **at all**; it froze, fully
visible, under the finger. The upper cap is unchanged and still position-keyed: a non-bottom profile
is refused paint past flush in every phase.

`--sheet-progress` publishes through the same function with the same phase, so a landed track's
token goes negative exactly when its transform does.

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

For a non-bottom profile that live pose is the **capped** one. `exitValues` once read the raw
logical size instead: a right sheet at `restSize = 400`, overpulled to `size = 420`, was painted
flush but built `100%` at `−20px`, so dismissal jumped **20px inward** before leaving. Applying the
paint cap before deriving its displacement is the mirror of `returnToRest`'s cap-not-floor rule.

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
floor — without the guard every `fade-scale` exit would acquire a cushion of stray drift instead of
scaling down *in place*. It also subsumes the negative-size floor above: on a hard
overpull `away` exceeds the slide runway on its own, so the floor is what keeps the runway pointing
away from rest.

`exitTravel()` shares `exitValues()` with the builder, so the span a velocity is normalised over and
the keyframes the run paints can never describe different geometry.

`paintedExtent` and `awayTranslation` are `restStyles`' piecewise rule read back out as numbers, and
they are what keep the runway honest per profile: a side sheet is fixed width, so its exit pose is
absolute and a drag cannot move it, while a bottom sheet above its floor has genuinely *resized* and
correctly clears the smaller height it now paints. Below its floor the height is pinned there and the
runway stops shrinking however deep the drag went.

The effects are `slide`, `fade-scale`, and `slide-fade`. An exit walks the same effect
vocabulary but is asked separately — see the exit effects below.

#### A cancelled entrance leaves by the exit door

A `hide()` that lands mid-entrance is a third caller of the exit track, and it used to be the one
that did not use it: it simply reversed the spring back down the **entrance** keyframes. Same
symptom family as the drag-continuing branch above — one run quietly parameterised by the wrong
geometry — and it is the *common* case for a fast double-tap, a route change, or an Escape landing
inside the opening run. Three things were wrong at once:

| what the reversed entrance did | what it should do |
| --- | --- |
| ignored `exit-effect` / `desktop-exit-effect` entirely | leave by the configured exit effect |
| followed `slide`'s entrance track to its hidden frame, with no edge-clear remap | drop the scrim as the box crosses the edge |
| walked an entrance-only bounce keyframe **backwards** | use the monotonic exit track |

So `hide()` builds the real exit frames for the live size, then rebases: `0%` is that exit's hidden
pose and `100%` is the exact frame already painted, so the first frame of the reversal is
byte-identical to the last frame of the entrance and the run starts at `p = 1`. It is the mirror of
the hide-to-show reversal, which rebases the entrance's rest frame onto the painted exit pose. A
reversal caught at the entrance's *untouched* `p = 0` frame is the one shortcut: both effects are
already invisible there, so it switches hidden poses at `p = 0` and completes asynchronously rather
than scheduling a spring across zero travel.

The clear progress is derived from `frameAwayTranslation()` — the away-signed translate read back
out of the frame that was actually painted — not from raw spring progress. Recomputing it would
lose the active effect's geometry and put the scrim's edge crossing on a different frame than the
panel's. Its overlay counterpart is `backdropCeilingExtent`, the exact mirror of the show-reversal's
`backdropFloorExtent`: a floor stops a cancelled *exit* from restarting the entrance's opacity ramp
from nothing, a ceiling stops a cancelled *entrance* from restarting the exit's ramp from full. Both
are stated as extents so `dismissalZoneProgress()` inverts them exactly.

The suite pins all of it as exact poses: a `fade-scale` entrance with `exit-effect="slide"` lands on
`translate3d(0px, 528px, 0px) scale(1)` — a 500px snap plus the 28px cushion, i.e. slide geometry,
not the entrance's — with the backdrop already at 0 on every off-screen frame.

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

The one sanctioned exception is dialog-panel misreading a pointerless click's `(0,0)` coordinates
as backdrop: `#outsideGuard` records its target only for that synchronous dispatch, so `beforeHide`
regains exactly the missing bit and vetoes only a non-closing control inside this dialog. Escape,
close buttons, real scrim taps, outside clicks, and programmatic hides therefore remain distinct.

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

No preset is tuned to wobble; `snap` alone carries a small settling breath. The numbers are asserted
in `test/sheet-engine.test.js` via a simulation of the integrator plus the early-settle detector,
which matches measured browser runs to within a frame. Overshoot budgets are asserted **per
preset**, so `snap`'s breath cannot be used as cover for another phase drifting loose.

#### Public override

`spring="attraction friction"` (attribute) or `sheet.spring = { attraction, friction }` (property) overrides the tuning per instance. Parsing lives in `parseSpring()` in `sheet-engine.js` rather than the component, so it stays node-testable; the component's static `SheetPanel.parseSpring` delegates to it. Both dials must be exclusive of 0 and 1 (PhysicsEngine throws otherwise); invalid input is ignored and the presets stand.

The override governs how the sheet **arrives**. Exits and snaps keep their presets.

Scaling those phases proportionally was tried and abandoned: the exit preset's attraction is ~5.5× the entrance's, so any brisk override pushed it past the dial ceiling and the clamped result was badly overdamped — `spring="0.3 0.55"` measured a **2933ms exit**. The dials are bounded, so no proportional rule survives a fast entrance. A test pins exit frame counts as identical across a wide range of overrides.

### Backdrop opacity

The overlay tracks the **dismissal zone**, never raw progress. One rule: any position at or above rest saturates at exactly 1, and only travel below rest maps `[rest → off-screen]` onto `[1 → 0]`.

Saturation is what stops upward rubber-band overscroll, spring overshoot, and entrance overshoot from lightening the overlay. During the opening/closing flight the panel is full-size but only partly on screen, so flight progress scales the visible extent; that also makes a snapped sheet reach full opacity by the time it passes its lowest snap, so opening to a mid snap never rests under a half-faded overlay.

#### Off-screen is further away than rest is tall

"Rest" is the lowest snap **plus the gap the panel already floats by**: `#backdropRestExtent()` is
`snaps[0] + slideInset(profile, restSize)`, and the live numerator gains the same inset —
`#currentSize + inset`. The denominator is the distance from the resting pose to genuinely outside
the viewport, and for anything that does not sit welded to its edge that is strictly more than its
own extent.

The lowest snap alone was the bug, and centre showed it worst. A **373px dialog on an 800px
viewport** floats 213px from the top edge, so its real dismissal zone is 586px; dividing by 373
drove the scrim to **0 with 213px of the dialog still on screen** — a fully lit panel over a
completely clear backdrop, for the whole last third of the gesture. A card-mode edge profile had the
same defect scaled down to its `--sheet-card-margin`.

**Adding the inset to both ends is what keeps this from disturbing a snapped bottom sheet.** At the
lowest snap the numerator is `snaps[0] + inset` and the denominator is the same expression, so
saturation still lands at exactly 1 at exactly the lowest snap, whatever the inset — and for an
edge-mode bottom sheet `slideInset` is `0`, so the formula is arithmetically identical to what it
was. Snap-to-snap travel above the lowest snap still leaves the overlay untouched. What changed is
only where the *zero* is, and only for a profile that never rested against the edge in the first
place.

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

`(#currentSize + inset) × p` is the visible extent for entrances and non-sliding exits. A slide is
the one exception because its hidden frame carries an extra shadow cushion beyond the point where
its box clears the viewport. `exitClearProgress()` derives that edge-crossing point from the same
`exitValues()` geometry as the keyframes. During a slide exit, `[p = 1 → edge crossing]` maps from
the exact release opacity to `0`; the remaining cushion clears the shadow with no overlay hanging
over the empty screen.

A reversal's endpoint is seeded from the **opacity actually painted**, inverted back through
`#backdropRestExtent()`, rather than recomputed as `p × size`. Those two disagree precisely because
of the remap above: a slide exit's scrim is already ahead of raw progress, so recomputing it jumped
the overlay back **up** on the first frame of a rescued exit. The jump is bounded by
`cushion / (extent + inset + cushion)` — invisible at the 28px default, but **0.18 on a narrow side
panel under the 72px cushion a soft shadow needs**. Multiplying the painted opacity by the rest
extent inverts `dismissalZoneProgress()` exactly, so `#flightEnvelope` starts from the number the
scrim is wearing. The same inversion supplies the cancelled entrance's `backdropCeilingExtent`.

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
pure `paintedProgress(position, p, phase)` exported from `sheet-engine.js` — a floor at 0 for the
flight phases only, and a cap at 1 only for a non-bottom profile, whose track is refused any paint
past flush. `#applyFrame()` paints through it and the component's `#setProgress()` publishes through
it — the engine hands the phase out on every `change` event so both writers apply the same rule to
the same frame. They therefore cannot drift: a bottom sheet's ~1.024 snap breath flows through
uncapped, a landed drag's negative continuation is published as painted, and a side sheet never
publishes a position its panel was denied. An unresolved profile has no rule to apply and falls back
to the full `[0, 1]` clamp at the component. Anything keyed off the token sees the same number the
transform did. A hide-to-show reversal restarts its two-frame track at `p = 0`, so its settle action
carries the painted progress and visible-extent floors forward; both public tokens continue from the
reversal pose rather than restarting their entrance ramps.

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
- An **uncaptured** pointer that leaves the element ends the gesture as a cancellation.

#### A mouse that wanders off never comes back

`pointerleave` is the fourth way a gesture can end, and it exists for a hole that is **mouse-only**:
a direct pointer — touch, or a pen in contact — gets implicit pointer capture to its own
`pointerdown` target, so it keeps targeting that element wherever it travels and always delivers its
own `pointerup`. Only a mouse can be pressed on a surface, drifted across the boundary inside the
`5px` slop, and released on the far side, where no `pointerup` this listener can see ever fires.

The stray paint is not the damage. Chrome and Firefox give the mouse a **stable `pointerId`**, so
the stranded-active gesture still matches on the next plain **hover**: it resumes calling `onMove`,
crosses slop, and captures a *button-less* pointer — after which the panel follows the bare cursor
around the screen until some unrelated click finally delivers a `pointerup`.

It is guarded on `#captured` because once capture is set the element becomes the effective target of
every event for that pointer and boundary events only re-fire when the capture target itself
changes — so a captured drag cannot fire `pointerleave` and abort itself mid-flight, and the leave
that arrives after the implicit release at `pointerup` lands with the gesture already inactive and
early-returns. It ends as a **cancellation**, not a clean release: the user did not let go here, and
zero velocity plus `cancelled: true` is what routes the consumer to a settle-back. A pointer that
wandered off must never be able to dismiss.

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
- Resize throttle: `100ms`

Header and footer always claim. Content defers to its scroll chain and claims only once that chain has no room left in the gesture's direction — see the scroll claim policy above. The content's single non-passive `touchmove` listener vetoes scrolling only after a drag is claimed.

**The scrim is not a drag surface, and `<dialog-backdrop>` is not an event target.** `showModal()`
makes everything outside the dialog's own subtree inert, and `<dialog-backdrop>` is a *sibling* of
the dialog — so the native `::backdrop` wins every hit test in the scrim region and reports the
**dialog** as its target. Measured, not inferred: `elementFromPoint` returns the dialog at every
scrim point, and `pointer-events: none` on `::backdrop` does not hand events down to the element
either, it drops them on `<html>`. dialog-panel's own `DialogBackdrop` click listener is therefore
dead for every modal consumer. The element is a paint surface — scrim colour, `backdrop-filter`,
opacity — and it must stay an element rather than the pseudo-element so a morph blob can fly above
the scrim and below the dialog.

So every scrim gesture is read off the dialog by geometry. `#outsideGuard` is capture-phase on
`dialog-panel`, ahead of dialog-panel's bubble-phase `dialogClick`, and it refuses an outside click
for two independent reasons: the `dismiss` policy forbids `backdrop`, **or** the gesture did not
begin on the scrim.

That second condition is the one with a bug behind it. `click` is dispatched at the release point
and retargeted — to the dialog for a plain scrim tap, and to whatever held **pointer capture** for a
drag, which is inside the panel. `dialogClick` only tests coordinates, so selecting text in the
sheet and releasing past its edge closed the sheet. `#scrimPress` records whether `pointerdown`
landed on the dialog itself, which separates that release from a genuine tap **without** a distance
gate — a distance gate would refuse the near-miss swipe, where a user aims for the sheet's edge,
lands just above it, and swipes. Starting position answers both; travelled distance answers neither.
The old target-based exemption (`dialogRef.contains(target)`) had to go: it was exactly what waved
the captured release through. Every ordinary click on panel content lands inside the rect and
returns on the geometry test instead.

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

**There are TWO ways a resolved dismissal fails to happen, and both must report the same way.**
`dismiss` refusing a swipe is answered before `panel.hide()`; a consumer vetoing `beforeHide` is only
answerable after it, because the veto result is `panel.hide()`'s return value. The dismissal branch
therefore emits *after* `#dismiss()` rather than alongside the other branch — `#dismiss()` returns
`false` on a veto, and the emit then reports the active snap with `prevented: true`, exactly as the
refused swipe does. Emitting first was the bug: a consumer keying teardown off `target === null`
cleared its draft, released its camera and logged a dismissal while the sheet stayed open and fully
interactive.

**A vetoed hide also has to hand back a live gesture.** `beforeHide` clears `#drag` for every route
out, but it is cancelable, and only `#dismiss()` repairs its own route by reading that `false`. Every
other route — a router guard, an inactivity timeout, a bare `panel.hide()` — left `#dragMove` and
`#dragEnd` early-returning on `!active`, so the release ran no settle and the panel stayed frozen at
its dragged, half-faded pose until the user started a fresh drag. The veto cannot be read from inside
the emit and dialog-panel publishes no post-veto event (it emits only `beforeShow`, `shown`,
`beforeHide`, `hidden`), so the handler snapshots the live drag and re-checks on a **microtask**: if
the engine never left for the exit, the gesture is restored. `#dismiss()`'s own repair still runs
first, which is why the restore only applies while the engine is genuinely still `shown`.

## Breakpoint and Snap Policy

Below `breakpoint`, mobile profile attributes apply. If that profile is bottom-positioned, its
complete snap list applies. **At or above the breakpoint the snap list is ignored entirely** —
`snap-points` is a mobile-profile attribute and has no say up there, whatever the position. Every
desktop profile is dismiss-only and carries exactly one resting size: the sides take their single
CSS width, and a center *or* a desktop bottom takes its intrinsic content height. Any left, right,
or center profile ignores the snap list on a mobile viewport too.

Each desktop attribute falls back to its mobile twin, with **two** exceptions.

**`desktop-position` falls out to `center` when `position` is `bottom`.** Both desktop shapes are
content-sized, so this fallback is about placement rather than size: a floating card in the middle
of the screen reads as a desktop dialog, while an edge-anchored panel reads as a sheet. Every other
position rests against an edge on any viewport and inherits itself unchanged.
`desktop-position="bottom"` opts back in — and still sizes to content there, not to 85vh. The
knock-on is deliberate: `desktopEffect` already answers `fade-scale` for a desktop `center`, so a
plain bottom sheet arrives on the desktop by fading rather than flying a viewport height up into the
middle of the screen.

**`desktopMode` inherits nothing — it hard-defaults to `card`, for every position.** Not a fallback
with an exception in it, like the one above: the getter never reads `mode` at all. On a wide
viewport the sheet is chrome floating over a page rather than the surface itself, so it floats by
`--sheet-card-margin` unless `desktop-mode="edge"` welds it back to the edge. This is why the exit
track section above can say flatly that *every* desktop swipe-close left a `--sheet-card-margin`
sliver — a consumer who never wrote `desktop-mode` still got a card. Do not describe the desktop attributes
as uniformly inheriting: `mode` and `desktop-mode` are independent settings that happen to share a
vocabulary.

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

**Nothing re-measures under a live finger.** A `snap-points` or `initial-snap` attribute change
refuses `#prepareOpen()` while a drag is active, exactly as the throttled resize path does and for
the same reason: `setSnaps` rewrites `#currentSize` to the active snap and would discard the
gesture's pose. Because `#dragMove` measures displacement continuously from `pointerdown`, a moving
finger repaints the correct pose on its very next move and only a finger held perfectly still stays
jumped — and the release settle or the next open re-measures either way, so there is nothing to gain
by doing it under the finger.

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
2. Snapshot the dialog's inline `MORPH_PROPERTIES` — see the restore rule below.
3. Read the live box.
4. `#prepareOpen()` — hand the new profile to CSS and re-measure snaps.
5. Read the destination box. **The pins must be off for this**, or it measures the scaffolding.
6. Pin back to the first box in explicit pixels, force layout.
7. Set the transition, write the second box.
8. On `transitionend` — restore the snapshot, `engine.endMorph()`.

**Unpinning restores; it does not blank.** The pins are written onto the same inline
properties a consumer may already have set, and once both are inline they are
indistinguishable — so blanking the list on teardown silently deleted styles the component
never owned. `#stripMorphPins` restores the snapshot instead, and step 5 uses that same
restore so the destination is measured against the consumer's real geometry rather than a
blanked box.

Two rules keep the snapshot honest. **A re-entrant morph must not re-snapshot**: it arrives
with the previous FLIP's pins still on the element, and re-reading them would promote the
scaffolding to "what the consumer had" permanently. The snapshot therefore survives every
retarget and is released only by `#finishMorph` — the single strip site, reached by
completion, the safety timeout, a zero duration, and `beforeHide`'s abandon — plus
`disconnectedCallback`, which shares `#releaseMorphPins`. And **`height` is excluded when
the outgoing profile is snap-resized**: it is the one property on the list the *engine* also
writes inline, so that value is a painted snap rather than a consumer style, and restoring
it would pin the incoming profile — which paints no height at all — to the snap it just
left.

`transform` and `opacity` stay at their rest values throughout so they never fight the pinned box.
`beginMorph` lands the panel at rest in the *current* profile first: a resize arriving mid-drag
would otherwise bake a half-finished transform into the measured `from` box.

**Landing means `#landPendingSettle()` first, then the stop** — the same order `setSnaps` and
`setProfile` use, and the order matters because `settleTo` never leaves `'shown'`, so a snap settle
still in flight passes `beginMorph`'s state guard. Stopping the spring without landing it leaves
`#activeSnap` naming the snap the settle *started* from, which is what `#restSize()` reads: the
panel jerked backward to the old snap and the host's FLIP then measured that wrong box as its `from`.
`#landPendingSettle` early-returns unless the spring is still animating, so it has to run before the
stop, not after.

Three things that look optional and are not:

- **The timeout beside `transitionend`.** That event does not fire for an interrupted transition
  or for a property whose start equals its end. Without the timeout a panel can be stranded in
  morph geometry.
- **Backdrop pinned to 1** while morphing, and *published*, not merely held. The resting size
  changes underneath the dismissal-zone calculation, which would otherwise blink the overlay
  mid-morph — but `#applyFrame` is inert from `beginMorph` to `endMorph`, so the pin has to be
  emitted there or nothing ever tells the component about it. Without the emit, a drag into the
  dismissal zone that crossed the breakpoint held the CSS scrim at its faded value for the whole
  morph, with the panel fully on screen, and then popped to 1 when `#finishMorph` wrote `(1, 1)`.
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

`src/sheet.js` side-effect imports `@magic-spells/dialog-panel`, so one install and one import set
up the whole family. It is external in the ESM build like the engines — but as a **peerDependency**,
because it registers the `<dialog-panel>` custom element and must stay a singleton however many
spells import it; bundlers dedupe the bare specifier to the app's one hoisted copy. The UMD bundles
it along with the engines, which the guarded `customElements.get()` defines on both sides make safe
even when a page also loads dialog-panel's own script. npm 7+ and pnpm auto-install the peer, so
`npm install @magic-spells/sheet` alone works there; Yarn 1 needs it named explicitly.

Production output is cleaned before sequential builds, and the production path then gzips
`sheet.min.js` and `sheet.min.css` and writes the byte counts to `demo/dist/sizes.json`, which the
demo hero fetches — the advertised sizes are measured from the artifacts, never hand-maintained.
Development output goes to `demo/dist` and is **ESM only** — the demo loads `sheet.esm.js` and
`sheet.css` and nothing else, so building a UMD on every watch tick was pure cost. The server runs
on port 3066.

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
distinguishes them — the ESM keeps dialog-panel and the engines as bare imports (dialog-panel as a
`from`-less side-effect import, which the singleton rule above requires stay external), the UMD
bundles them all. The UMD runs
through a `node:vm` sandbox shaped like CommonJS on purpose: loaded as ESM it would take its global
branch instead and assert nothing about what a consumer receives. All of it skips cleanly when
`dist/` has not been built.
