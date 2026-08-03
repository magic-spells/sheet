import "@magic-spells/dialog-panel";
import PhysicsEngine from "@magic-spells/physics-engine";
import FrameEngine from "@magic-spells/frame-engine";
import { MorphEngine } from "@magic-spells/morph-engine";
//#region src/drag-gesture.js
/**
* Rolling velocity sampler measured in pixels per millisecond.
*/
var VelocityTracker = class {
	#samples = [];
	#windowMs;
	/**
	* @param {number} [windowMs=100] - Rolling sample window.
	*/
	constructor(windowMs = 100) {
		this.#windowMs = windowMs;
	}
	/**
	* Adds one position sample.
	* @param {number} value - Axis position.
	* @param {number} t - Event timestamp.
	*/
	add(value, t) {
		const _ = this;
		_.#samples.push({
			value,
			t
		});
		const cutoff = t - _.#windowMs;
		while (_.#samples.length > 2 && _.#samples[0].t < cutoff) _.#samples.shift();
	}
	/** @returns {number} Current pixels-per-millisecond velocity. */
	get velocity() {
		const samples = this.#samples;
		if (samples.length < 2) return 0;
		const last = samples[samples.length - 1];
		let direction = 0;
		let start = samples.length - 1;
		while (start > 0) {
			const step = Math.sign(samples[start].value - samples[start - 1].value);
			if (step !== 0) {
				if (direction === 0) direction = step;
				else if (step !== direction) break;
			}
			start--;
		}
		const first = samples[start];
		const deltaTime = last.t - first.t;
		return deltaTime === 0 ? 0 : (last.value - first.value) / deltaTime;
	}
	/** Clears all samples. */
	reset() {
		this.#samples = [];
	}
};
var SLOP = 5;
function directionFromDelta(deltaX, deltaY) {
	if (Math.abs(deltaX) > Math.abs(deltaY)) return deltaX < 0 ? "left" : "right";
	return deltaY < 0 ? "up" : "down";
}
/**
* Dependency-free two-axis Pointer Events gesture adapter.
*/
var DragGesture = class {
	#active = false;
	#captured = false;
	#el;
	#handlers;
	#onStart;
	#onMove;
	#onEnd;
	#pointerId = null;
	#startX = 0;
	#startY = 0;
	#startTime = 0;
	#trackerX = new VelocityTracker();
	#trackerY = new VelocityTracker();
	/**
	* @param {HTMLElement} el - Pointer event surface.
	* @param {Object} [callbacks] - Gesture lifecycle callbacks.
	* @param {Function} [callbacks.onStart] - Pointer start callback. Returning
	*   exactly `false` refuses the gesture: no capture, no further callbacks.
	* @param {Function} [callbacks.onMove] - Pointer move callback.
	* @param {Function} [callbacks.onEnd] - Pointer end/cancel callback.
	*/
	constructor(el, { onStart, onMove, onEnd } = {}) {
		const _ = this;
		_.#el = el;
		_.#onStart = onStart;
		_.#onMove = onMove;
		_.#onEnd = onEnd;
		_.#handlers = {
			pointerdown: _.#handlePointerDown.bind(_),
			pointermove: _.#handlePointerMove.bind(_),
			pointerup: (event) => _.#handlePointerEnd(event, false),
			pointercancel: (event) => _.#handlePointerEnd(event, true),
			pointerleave: (event) => {
				if (!_.#captured) _.#handlePointerEnd(event, true);
			}
		};
		for (const [type, handler] of Object.entries(_.#handlers)) el.addEventListener(type, handler);
	}
	#handlePointerDown(event) {
		const _ = this;
		if (!event.isPrimary || _.#active && _.#captured) return;
		_.#active = true;
		_.#captured = false;
		_.#pointerId = event.pointerId;
		_.#startX = event.clientX;
		_.#startY = event.clientY;
		_.#startTime = event.timeStamp;
		_.#trackerX.reset();
		_.#trackerY.reset();
		_.#trackerX.add(event.clientX, event.timeStamp);
		_.#trackerY.add(event.clientY, event.timeStamp);
		if (_.#onStart?.({
			event,
			x: event.clientX,
			y: event.clientY
		}) === false) {
			_.#active = false;
			_.#pointerId = null;
		}
	}
	#handlePointerMove(event) {
		const _ = this;
		if (!_.#active || event.pointerId !== _.#pointerId) return;
		const deltaX = event.clientX - _.#startX;
		const deltaY = event.clientY - _.#startY;
		if (!_.#captured && Math.hypot(deltaX, deltaY) > SLOP) {
			_.#captured = true;
			_.#el.setPointerCapture?.(event.pointerId);
		}
		_.#trackerX.add(event.clientX, event.timeStamp);
		_.#trackerY.add(event.clientY, event.timeStamp);
		_.#onMove?.({
			event,
			deltaX,
			deltaY,
			direction: directionFromDelta(deltaX, deltaY),
			velocityX: _.#trackerX.velocity,
			velocityY: _.#trackerY.velocity
		});
	}
	#handlePointerEnd(event, cancelled) {
		const _ = this;
		if (!_.#active || event.pointerId !== _.#pointerId) return;
		const deltaX = event.clientX - _.#startX;
		const deltaY = event.clientY - _.#startY;
		_.#active = false;
		_.#captured = false;
		_.#trackerX.add(event.clientX, event.timeStamp);
		_.#trackerY.add(event.clientY, event.timeStamp);
		_.#onEnd?.({
			event,
			deltaX,
			deltaY,
			direction: directionFromDelta(deltaX, deltaY),
			velocityX: cancelled ? 0 : _.#trackerX.velocity,
			velocityY: cancelled ? 0 : _.#trackerY.velocity,
			duration: event.timeStamp - _.#startTime,
			cancelled
		});
		_.#pointerId = null;
	}
	/** Removes every pointer listener and resets tracking state. */
	destroy() {
		const _ = this;
		for (const [type, handler] of Object.entries(_.#handlers)) _.#el.removeEventListener(type, handler);
		_.#active = false;
		_.#captured = false;
		_.#pointerId = null;
		_.#trackerX.reset();
		_.#trackerY.reset();
	}
};
//#endregion
//#region src/event-emitter.js
var EventEmitter = class {
	#events;
	constructor() {
		this.#events = /* @__PURE__ */ new Map();
	}
	/**
	* Binds a listener to an event.
	* @param {string} event - The event to bind the listener to.
	* @param {Function} listener - The listener function to bind.
	* @returns {EventEmitter} The current instance for chaining.
	*/
	on(event, listener) {
		if (typeof listener !== "function") throw new TypeError("Listener must be a function");
		const listeners = this.#events.get(event) || [];
		if (!listeners.includes(listener)) listeners.push(listener);
		this.#events.set(event, listeners);
		return this;
	}
	/**
	* Unbinds a listener from an event.
	* @param {string} event - The event to unbind.
	* @param {Function} listener - The listener function to unbind.
	* @returns {EventEmitter} The current instance for chaining.
	*/
	off(event, listener) {
		const listeners = this.#events.get(event);
		if (!listeners) return this;
		const index = listeners.indexOf(listener);
		if (index !== -1) {
			listeners.splice(index, 1);
			if (listeners.length === 0) this.#events.delete(event);
			else this.#events.set(event, listeners);
		}
		return this;
	}
	/**
	* Emits an event.
	* @param {string} event - Event name.
	* @param {...*} args - Listener arguments.
	* @returns {boolean} Whether the event had listeners.
	*/
	emit(event, ...args) {
		const listeners = this.#events.get(event);
		if (!listeners || listeners.length === 0) return false;
		for (const listener of listeners.slice()) try {
			listener.apply(this, args);
		} catch (error) {
			console.error(`Error in listener for event '${event}':`, error);
		}
		return true;
	}
	/**
	* Removes listeners for one event or all events.
	* @param {string} [event] - Optional event name.
	* @returns {EventEmitter} The current instance for chaining.
	*/
	removeAllListeners(event) {
		if (event) this.#events.delete(event);
		else this.#events.clear();
		return this;
	}
};
//#endregion
//#region src/sheet-engine.js
var FRAME_MS = 16.66;
var VELOCITY_BOOST = 1.1;
var SETTLE_POSITION_EPSILON = .3;
var SETTLE_DELTA_EPSILON = .15;
var CLAMP_POSITIVE = [
	"width",
	"height",
	"borderTopLeftRadius",
	"borderTopRightRadius",
	"borderBottomRightRadius",
	"borderBottomLeftRadius",
	"borderTopWidth",
	"borderRightWidth",
	"borderBottomWidth",
	"borderLeftWidth"
];
var MANAGED_PROPERTIES = [
	"display",
	"opacity",
	"transform",
	"transformOrigin",
	"willChange",
	"width",
	"height",
	"filter"
];
/**
* Peak blur, in pixels, an effect's hidden frame carries.
*
* Only the fading effects take one — a `slide` arrives at full clarity from off
* screen, and blurring it would read as motion blur it never earned. The values
* differ because the two effects have different amounts of other motion to hide
* behind: `fade-scale` changes almost nothing geometrically (a 5% scale), so it
* needs the blur to carry the arrival, while `slide-fade` already translates and
* a matching blur would read as a smear.
*
* Blur resolves to 0 on the same reveal frame opacity does, which is what keeps
* it out of the overshoot extrapolation — see DEFAULT_REVEAL_PERCENT. Zero
* disables it.
*/
var EFFECT_BLUR = {
	"fade-scale": 8,
	"slide-fade": 4
};
/**
* Spring tuning per motion phase.
*
* Both dials move together: attraction sets travel speed, friction sets damping.
* Raising friction alone only makes motion sluggish, so each preset pairs a
* pull with enough damping to land calmly.
*
* Springs front-load their travel, so settle time alone does not describe how
* fast a motion FEELS — the 90%-of-travel mark does. Tuning by settle time
* alone is how an earlier pass landed a 350ms entrance that reached 90% in
* 100ms and read as a snap rather than a movement. Both numbers are tracked:
*
*              settle   t90    max progress
*   entrance    483ms   267ms   1.000
*   exit        267ms   133ms   1.000  — leaving is brisker than arriving
*   snap        566ms   200ms   1.024  — the only phase allowed to breathe
*   rest        333ms   167ms   1.000
*
* `morph` and `morphBack` tune the trigger BLOB rather than this engine's own
* spring — a `morph-trigger` panel is flown by MorphEngine, so neither is ever
* handed to `#spring`:
*
*              settle   t90    max progress
*   morph       583ms   133ms   1.118  — growing out of the trigger, deliberately loose
*   morphBack   317ms   150ms   1.000  — returning to it, no bounce at all
*
* Both used to be one inherited number. Saying nothing in MorphEngine's
* constructor took its default of 0.1 / 0.32, which put an 5.9% overshoot on BOTH
* directions — more breath than any preset above, applied by accident rather than
* chosen, and applied just as much to the return as to the arrival.
*
* They are split because the two directions want opposite things. Growing out of
* a trigger is the one motion in this package with somewhere to put a bounce: the
* panel is arriving, nothing is waiting on it, and the overshoot reads as the
* thing springing open. Going back is a dismissal — the user is done, and a
* wobble on the way out reads as the UI dawdling. So `morph` roughly doubles the
* breath it had (5.9% -> 11.8%, and a second crossing, so it reads as a bounce
* rather than a single settle) while `morphBack` removes it entirely and lands
* brisker than it arrives, which is the same rule `exit` follows against
* `entrance` above.
*
* The t90s are near-identical (133 / 150ms), so this is a change of character,
* not of pace: the return is not sluggish, it just does not overshoot.
*
* Settle figures come from the suite's integrator simulation, which models THIS
* engine's early-settle detector; MorphEngine's own settle test may differ by a
* frame or two. Overshoot and t90 are properties of the shared integrator and
* transfer exactly.
*
* `snap` is deliberately the loose one, matching bottom-sheet. A flick has to
* have somewhere to GO: with a tightly damped snap the release velocity is
* absorbed within a frame and every settle looks the same however hard it was
* thrown. The 2.4% overshoot is the room that makes a flick legible.
*
* `rest` exists only because a side sheet cannot borrow that room. Its drag
* track ends flush against the screen edge with no keyframe beyond it, so
* overshoot would translate the panel PAST flush and reveal a sliver of
* backdrop down the side. Bottom snaps carry explicit frames past their
* destination (see REST_OVERSHOOT_PERCENT); a side return has nowhere to put
* one, so it keeps the tight tuning instead.
*/
var SPRING_PRESETS = {
	entrance: {
		attraction: .055,
		friction: .32
	},
	exit: {
		attraction: .3,
		friction: .56
	},
	snap: {
		attraction: .065,
		friction: .3
	},
	rest: {
		attraction: .15,
		friction: .455
	},
	morph: {
		attraction: .07,
		friction: .28
	},
	morphBack: {
		attraction: .08,
		friction: .34
	}
};
/**
* The fastest seed a release may hand a spring: the velocity that spring could
* build for itself under a constant attraction over `distance`, held until
* friction balanced it. In the seed's pre-damping units that terminal velocity
* is the attraction impulse divided by the friction removing it.
*
* Stated once because both cappers below need exactly this quantity and got it
* from the same argument. Writing it out twice already went wrong once — the
* return cap was authored as the bare attraction impulse, dropping the `/
* friction` term, which made it 0.455x too small: it swallowed every flick whole
* so a gentle throw and a hard one returned in the same 200ms, which is the
* "every settle looks identical however hard it was thrown" failure the snap
* preset's own tuning notes exist to prevent.
* @param {{attraction: number, friction: number}} preset - Spring tuning.
* @param {number} distance - Spring-space distance the run has left to cover.
* @returns {number} Largest seed that stays within the spring's own means.
*/
function terminalSeed(preset, distance) {
	return distance * preset.attraction / preset.friction;
}
var SNAP_VELOCITY_LIMIT = terminalSeed(SPRING_PRESETS.snap, 100);
var EXIT_VELOCITY_LIMIT = terminalSeed(SPRING_PRESETS.exit, 100);
/** Bounds PhysicsEngine accepts for both dials, exclusive. */
var MIN_SPRING = .001;
var MAX_SPRING = .999;
/**
* True when a value is usable spring tuning. PhysicsEngine throws outside
* (0, 1) exclusive, so anything else is treated as absent.
* @param {*} value - Candidate dial value.
* @returns {boolean} True when usable.
*/
function isSpringDial(value) {
	return Number.isFinite(value) && value > 0 && value < 1;
}
/**
* Parses a `spring="attraction friction"` attribute.
* @param {string|null} value - Two floats, each exclusive of 0 and 1.
* @returns {{attraction: number, friction: number}|null} Parsed tuning, or null
*   when absent or malformed — in which case the presets stand.
*/
function parseSpring(value) {
	if (typeof value !== "string") return null;
	const parts = value.trim().split(/[\s,]+/).filter(Boolean);
	if (parts.length !== 2) return null;
	const [attraction, friction] = parts.map(Number);
	if (!isSpringDial(attraction) || !isSpringDial(friction)) return null;
	return {
		attraction,
		friction
	};
}
/**
* The three implicit routes out of an open sheet. Every one of them dismisses
* without the user having chosen anything in particular, which is exactly why a
* confirm that genuinely requires an answer has to be able to refuse them.
* Buttons and programmatic `hide()` are not routes here — they are the answer.
*/
var DISMISS_ROUTES = [
	"swipe",
	"backdrop",
	"escape"
];
/**
* Parses a `dismiss="swipe backdrop escape"` token list.
*
* Absent means every route is open, which is the behaviour a sheet has always
* had. `none` (or an empty attribute) closes all three: the confirm-action case,
* where the sheet may only be answered, not waved away. Naming a subset opens
* exactly that subset — `dismiss="backdrop escape"` is a drawer that a stray
* swipe cannot close but a click outside still can.
*
* Unknown tokens are ignored rather than throwing, matching parseSpring: a
* typo degrades to a stricter sheet, never to a broken one.
* @param {string|null} value - Space- or comma-separated route tokens.
* @returns {{swipe: boolean, backdrop: boolean, escape: boolean}} Allowed routes.
*/
function parseDismiss(value) {
	const all = (allowed) => Object.fromEntries(DISMISS_ROUTES.map((route) => [route, allowed]));
	if (value === null || value === void 0) return all(true);
	const tokens = String(value).trim().toLowerCase().split(/[\s,]+/).filter(Boolean);
	if (!tokens.length || tokens.includes("none")) return all(false);
	if (tokens.includes("all")) return all(true);
	return Object.fromEntries(DISMISS_ROUTES.map((route) => [route, tokens.includes(route)]));
}
/**
* Resolves the cushion a profile's exit clears its edge by.
* @param {Object} profile - Resolved visual profile.
* @param {number} [profile.exitCushion] - Override in pixels.
* @returns {number} Cushion in pixels.
*/
function exitCushion(profile) {
	const value = profile.exitCushion;
	return Number.isFinite(value) && value >= 0 ? value : 28;
}
/**
* Percent of the geometry timeline at which fading effects reach full opacity.
* Finishing the fade before the end keeps spring overshoot
* past p=1 from flickering a settled panel back toward transparent, and —
* because opacity is flat from the reveal frame to the end — keeps opacity out
* of the overshoot extrapolation entirely. Walking these frames backwards puts
* the fade-out in the closing tail, which is where an exit wants it.
*
* The number is a percent of TRAVEL, not of time, and springs front-load: at
* the entrance preset, p=0.55 arrives 133ms into a 483ms run. So the old 55
* finished the fade at 28% of the wall clock and left 350ms in which the only
* remaining motion was a 0.95 -> 1 scale — about 9px on a 420px dialog. Opacity
* is the channel the eye actually tracks on a fade effect, and its rate went
* from steep to exactly zero in a single keyframe, so the entrance read as
* arriving and then stopping dead well short of rest.
*
* 80 keeps the whole point of the frame — the entrance preset peaks at p=0.9996
* and even a loose `spring=` override stays flat through an overshoot to 1.25 —
* while giving the fade the back half of the run it was visually missing.
*/
var DEFAULT_REVEAL_PERCENT = 80;
/**
* Converts a gesture velocity into spring units.
*
* The spring always runs `0 -> TRAVEL`, so its units are a share of whatever
* pixel distance that particular run represents — and that distance differs per
* phase. Naming it is this function's entire job:
*
* - Opening, closing, dismissing, and a side sheet's return normalise over the
*   **resting size**: their run covers off-screen to flush.
* - A snap settle normalises over the **signed segment** `targetSize -
*   startSize`, because its keyframes are rebuilt per run to span exactly that
*   hop — and on every downward snap that segment is negative.
*
* The integrator is linear, so dividing by the signed segment traces the same
* path as running the spring in pixel space from `startSize` to `targetSize`
* with the raw per-frame velocity. There is deliberately no default span:
* handing a snap settle the resting size was the original bug, and it arrived
* with the wrong sign on every downward flick.
* @param {number} velocityPxMs - Velocity in pixels per millisecond, signed
*   along the same axis as the run.
* @param {number} spanPx - Signed pixel distance this run covers.
* @returns {number} Spring-space velocity, or 0 when the run has no room.
*/
function velocityToSpring(velocityPxMs, spanPx) {
	if (!Number.isFinite(velocityPxMs) || !Number.isFinite(spanPx)) return 0;
	if (Math.abs(spanPx) < 1) return 0;
	return velocityPxMs * FRAME_MS * VELOCITY_BOOST * 100 / spanPx;
}
function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}
/**
* Maps a visible extent onto backdrop opacity.
*
* The overlay tracks the DISMISSAL ZONE, never raw progress. One rule covers
* every case: any position at or above rest saturates at exactly 1, and only
* travel below rest maps [rest -> off-screen] onto [1 -> 0].
*
* Rest is the lowest snap. For a snapped sheet that means all snap-to-snap
* travel leaves the overlay untouched — only the dismiss gesture past the
* lowest snap fades it. For a snapless sheet the lowest snap *is* the resting
* size, so the overlay tracks the whole downward travel; same formula, no
* special case. Saturation is what keeps upward rubber-band overscroll, spring
* overshoot, and entrance overshoot from ever lightening the overlay.
* @param {number} visibleExtent - On-screen extent along the dismiss axis, in pixels.
* @param {number} restExtent - Resting extent in pixels (the lowest snap).
* @returns {number} Backdrop progress in [0, 1].
*/
function dismissalZoneProgress(visibleExtent, restExtent) {
	if (!Number.isFinite(restExtent) || restExtent <= 0) return 0;
	return clamp(visibleExtent / restExtent, 0, 1);
}
/**
* The single statement of what a position is allowed to be — painted onto the
* panel by `#applyFrame`, published as `--sheet-progress` by the component. Both
* writers go through here so they can never disagree about a frame.
*
* Springs undershoot past the target on a fast entrance or dismissal, so the
* lower end floors during those FLIGHT phases: extrapolating an effect's hidden
* frame is meaningless and can drive scale negative. Landed tracks are a
* different shape. Drag, snap, and return frames are linear in size with scale
* pinned at 1, so allowing their progress below 0 is the 1:1 continuation a
* finger needs to carry an inset or centred panel all the way off screen.
*
* The upper end remains profile-specific. A bottom sheet's overshoot is the
* intended settling breath — a height stretch, or a translate below the floor,
* both of which the snap track carries explicit frames for — so it flows
* through. A side sheet has no equivalent: it is fixed width and sits against
* its edge, so every position past flush translates it inward and opens a
* sliver of backdrop down the side. There is nothing to tune away there — a
* synthetic frame past 100 would be collinear with the track and change nothing
* — so the only fix is to refuse it.
* @param {'bottom'|'left'|'right'|'center'} position - Sheet edge.
* @param {number} p - Raw frame progress.
* @param {string} [phase] - Motion phase; landed phases may extrapolate below 0.
* @returns {number} Progress that may be painted and published.
*/
function paintedProgress(position, p, phase) {
	const lower = phase === "dragging" || phase === "snapping" || phase === "returning" || phase === "shown" ? p : Math.max(0, p);
	return position === "bottom" ? lower : Math.min(1, lower);
}
/**
* Axis a position is dismissed along.
*
* This is one of TWO orthogonal questions a position answers, and they are
* deliberately kept apart:
*
*   - which axis does this profile move on?  -> dismissAxis()
*   - does it resize, or only translate?     -> resizesWithSnaps()
*
* For bottom/left/right the two line up, which is why they were once tangled
* together. `center` is the case that separates them: it travels on y like a
* bottom sheet, but it is intrinsically sized and translates only, like a side
* sheet. Every axis decision routes through here so that stays true.
* @param {'bottom'|'left'|'right'|'center'} position - Sheet edge.
* @returns {'x'|'y'} Gesture axis.
*/
function dismissAxis(position) {
	return position === "bottom" || position === "center" ? "y" : "x";
}
/**
* Where a profile's single resting size comes from: its own laid-out content.
*
* Two profiles answer yes, and they answer it for the same reason — neither has
* a length to read. A centred dialog rests against no edge at all, and a bottom
* panel PAST THE BREAKPOINT is a desktop dialog that happens to sit on the
* bottom edge: `snap-points` is a mobile-profile attribute and has no say up
* there, so the only honest height is the one the content produces. The host
* measures the laid-out box for both, and both need the content-resize
* observer, because content is the one thing that changes a size nothing else
* re-measures.
*
* A side sheet is neither: it is intrinsically sized too, but by a CSS token
* (`--sheet-active-size`) rather than by its content, so it is probed instead
* of measured.
* @param {Object} profile - Resolved visual profile.
* @returns {boolean} True when the resting size is the content's own.
*/
function contentSized(profile) {
	if (profile.position === "center") return true;
	return profile.position === "bottom" && !!profile.desktop;
}
/**
* Does this profile RESIZE as it travels, or only translate?
*
* The second of the two orthogonal questions above, and the reason it is a
* predicate rather than `position === 'bottom'`: only a *mobile* bottom profile
* resizes. It is the one profile with a snap list, and painting a height is how
* snap-to-snap travel is expressed.
*
* A desktop bottom profile is sized by its content, exactly like `center`, so it
* must not emit a height at all. Emitting one is not merely redundant — it pins
* the box in pixels, which makes the next measurement read back the number the
* last frame wrote instead of the content's own height, and freezes the
* ResizeObserver that watches for content changes. And an overshoot or an
* upward rubber-band would stretch a content-sized panel past its content.
* @param {Object} profile - Resolved visual profile.
* @returns {boolean} True when travel is painted as a size change.
*/
function resizesWithSnaps(profile) {
	return profile.position === "bottom" && !contentSized(profile);
}
/**
* Projects a *finger-motion* delta onto the dismiss direction.
*
* Positive results move the panel toward its off-screen edge: fingers down
* dismisses a bottom sheet or a centered dialog, fingers left a left sheet,
* fingers right a right sheet. Touch deltas are already finger motion, so
* drags pass straight through.
* @param {'bottom'|'left'|'right'|'center'} position - Sheet edge.
* @param {number} deltaX - Horizontal finger delta or velocity.
* @param {number} deltaY - Vertical finger delta or velocity.
* @returns {number} Signed offset toward dismissal.
*/
function awayOffset(position, deltaX, deltaY) {
	if (dismissAxis(position) === "y") return deltaY;
	if (position === "left") return -deltaX;
	return deltaX;
}
/**
* The inverse of {@link awayOffset}: places an away-signed distance onto the two
* translate axes. `awayOffset(position, ...awayVector(position, d))` is `d`.
*
* Every frame that moves the panel toward or away from its edge goes through
* here, so the axis choice and the left-hand sign flip are stated once.
* @param {'bottom'|'left'|'right'|'center'} position - Sheet edge.
* @param {number} distance - Away-signed distance in pixels.
* @returns {{x: number, y: number}} Translate components.
*/
function awayVector(position, distance) {
	if (dismissAxis(position) === "y") return {
		x: 0,
		y: distance
	};
	return {
		x: (position === "left" ? -1 : 1) * distance,
		y: 0
	};
}
/**
* Reads the away-signed translation from one of this engine's own style frames.
* Cancelled entrances rebase from the exact FrameEngine pose already painted;
* recomputing it from raw spring progress would lose the active effect's
* geometry and put the backdrop's edge crossing on a different frame than the
* panel's.
* @param {'bottom'|'left'|'right'|'center'} position - Sheet edge.
* @param {Object} styles - A style frame built by {@link styleFromValues}.
* @returns {number} Translate magnitude toward the dismiss edge, in pixels.
*/
function frameAwayTranslation(position, styles) {
	const match = styles?.transform?.match(/translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px,\s*-?[\d.]+px\)/);
	if (!match) return 0;
	return awayOffset(position, Number(match[1]), Number(match[2]));
}
/**
* The extent the panel actually paints along the dismiss axis at a live size.
*
* Only a snapped bottom sheet's changes with the gesture, and only above its
* floor: below the lowest snap the height holds and the travel becomes
* translation. Every other profile is intrinsically sized, so its painted extent
* is its resting one no matter where the drag has taken it.
* @param {Object} profile - Resolved visual profile.
* @param {number} size - Logical size in pixels along the dismiss axis.
* @param {number} restSize - CSS resting size in pixels.
* @param {number} [lowestSize=0] - Lowest bottom snap in pixels.
* @returns {number} Painted extent in pixels.
*/
function paintedExtent(profile, size, restSize, lowestSize = 0) {
	return resizesWithSnaps(profile) ? Math.max(size, lowestSize) : restSize;
}
/**
* Away-signed translate magnitude of the resting-pose frame at a live size —
* how far a live drag has already carried the panel toward its edge.
*
* This is the same piecewise split {@link restStyles} paints by, read back out
* as a single number: a snapped bottom sheet only translates below its floor,
* while every other profile expresses its whole size change as translation.
* @param {Object} profile - Resolved visual profile.
* @param {number} size - Logical size in pixels along the dismiss axis.
* @param {number} restSize - CSS resting size in pixels.
* @param {number} [lowestSize=0] - Lowest bottom snap in pixels.
* @returns {number} Translate magnitude toward the dismiss edge, in pixels.
*/
function awayTranslation(profile, size, restSize, lowestSize = 0) {
	if (resizesWithSnaps(profile)) return Math.max(0, lowestSize - size);
	return restSize - size;
}
/**
* Resolves the transform origin for a profile. Cards scale from the edge they
* sit against so the growth reads as the panel rising into place. A centered
* dialog sits against no edge, so it scales about its own middle.
* @param {Object} profile - Resolved visual profile.
* @returns {string} CSS transform-origin.
*/
function transformOrigin(profile) {
	if (profile.position === "left") return "left center";
	if (profile.position === "right") return "right center";
	if (profile.position === "center") return "center center";
	return "center bottom";
}
/**
* Resting styles for a live size.
*
* Snapped bottom sheets resize only at and above their lowest snap. Logical
* travel below it holds the painted height at that floor and becomes translateY.
*
* Every other profile is intrinsically sized — a side sheet by its CSS width, a
* centered dialog and a DESKTOP bottom panel by their content — so a size change
* is expressed purely as translation and NO size property is ever emitted. Which
* axis that translation lands on is dismissAxis's call, not this one's: center
* and bottom travel on y, sides on x. `test/sheet-engine.test.js` pins the
* no-size-property invariant.
* @param {Object} profile - Resolved visual profile.
* @param {number} size - Logical size in pixels along the dismiss axis.
* @param {number} restSize - CSS resting size in pixels along the dismiss axis.
* @param {number} [lowestSize=0] - Lowest bottom snap in pixels.
* @returns {Object} Keyframe styles.
*/
function restStyles(profile, size, restSize, lowestSize = 0) {
	const base = {
		opacity: "1",
		transformOrigin: transformOrigin(profile),
		filter: "blur(0px)"
	};
	if (resizesWithSnaps(profile)) {
		const paintedSize = Math.max(size, lowestSize);
		const shift = Math.max(0, lowestSize - size);
		return {
			...base,
			height: `${paintedSize}px`,
			transform: `translate3d(0px, ${shift}px, 0px) scale(1)`
		};
	}
	const shift = restSize - size;
	if (dismissAxis(profile.position) === "y") return {
		...base,
		transform: `translate3d(0px, ${shift}px, 0px) scale(1)`
	};
	return {
		...base,
		transform: `translate3d(${(profile.position === "left" ? -1 : 1) * shift}px, 0px, 0px) scale(1)`
	};
}
/**
* The gap a slide has to clear before the panel's own extent even starts.
*
* Edge-mounted profiles are handed this by the component as `edgeInset`, because
* a card's gap is a probed `--sheet-card-margin` and probing is the component's
* job. A centred panel is the exception: it rests mid-screen rather than against
* an edge, so its gap is half the space its own size leaves over — arithmetic
* that needs `size`, which only exists per run, and no DOM at all. Deriving it
* here is therefore both the only place it CAN be exact and still DOM-free.
*
* Exactness is the point rather than pedantry. A safe over-estimate was tried
* (half the viewport, which always clears) and it put a 373px dialog on an 860px
* viewport 33% past off-screen — clearing the edge at `p ≈ 0.75` while the
* backdrop kept fading, which is precisely the empty-screen-under-a-live-overlay
* problem the runway rule exists to prevent.
* @param {Object} profile - Resolved visual profile.
* @param {number} size - Live size in pixels along the dismiss axis.
* @returns {number} Gap in pixels between the panel's near edge and the screen's.
*/
function slideInset(profile, size) {
	if (profile.position === "center") return Math.max(0, ((profile.viewportHeight || 0) - size) / 2);
	return profile.edgeInset ?? 0;
}
/**
* Numeric motion values for the hidden or shown end of an open/close run.
* @param {Object} profile - Resolved visual profile.
* @param {number} [profile.edgeInset=0] - Pixels the panel rests from its screen
*   edge; a slide clears it on top of the panel's own size.
* @param {Object} options - Frame options.
* @param {number} options.size - Live size in pixels along the dismiss axis.
* @param {boolean} options.hidden - True for the off-screen end of the run.
* @param {number} [options.floorDistance] - Minimum away-distance the hidden end
*   must reach. Only buildExitKeyframes supplies it; see the floor rule there.
* @returns {{x: number, y: number, scale: number, opacity: number}} Motion values.
*/
function effectValues(profile, { size, hidden, floorDistance = 0 }) {
	const { effect, position } = profile;
	let distance = 0;
	let scale = 1;
	let opacity = 1;
	if (hidden && effect === "slide") distance = Math.max(size + slideInset(profile, size) + exitCushion(profile), 1);
	if (hidden && effect === "slide-fade") {
		distance = 24;
		opacity = 0;
	}
	if (hidden && effect === "fade-scale") {
		scale = .95;
		opacity = 0;
	}
	if (hidden) distance = Math.max(distance, floorDistance);
	const blur = hidden ? EFFECT_BLUR[effect] ?? 0 : 0;
	return {
		...awayVector(position, distance),
		scale,
		opacity,
		blur
	};
}
/**
* Renders motion values as keyframe styles.
* @param {Object} profile - Resolved visual profile.
* @param {Object} values - Motion values from effectValues.
* @returns {Object} Keyframe styles.
*/
function styleFromValues(profile, values) {
	return {
		opacity: String(values.opacity),
		transform: `translate3d(${values.x}px, ${values.y}px, 0px) scale(${values.scale})`,
		transformOrigin: transformOrigin(profile),
		filter: `blur(${values.blur ?? 0}px)`
	};
}
/**
* Assembles a track from two sets of motion values, plus the reveal frame a
* fading track needs. Shared by the entrance and the exit so the two cannot
* drift apart on the details below.
*
* Fading effects get a third keyframe where opacity has already reached its
* shown value while the geometry is only partway. FrameEngine back-fills
* composite properties it does not find on a keyframe, so this frame carries
* the fully interpolated transform too — collinear with the outer frames, which
* leaves the geometry (and its extrapolation past either end) untouched.
* @param {Object} profile - Resolved visual profile.
* @param {Object} restFrame - Resting styles every frame inherits: the pinned
*   size property, if the profile has one, and the shared transform-origin.
* @param {Object} from - Motion values for the 0% frame.
* @param {Object} to - Motion values for the 100% frame.
* @returns {Object} Percent-keyed keyframes.
*/
function assembleKeyframes(profile, restFrame, from, to) {
	const frame = (values) => ({
		...restFrame,
		...styleFromValues(profile, values)
	});
	const at = (percent, overrides) => {
		const factor = percent / 100;
		const lerp = (a, b) => a + (b - a) * factor;
		return frame({
			x: lerp(from.x, to.x),
			y: lerp(from.y, to.y),
			scale: lerp(from.scale, to.scale),
			opacity: lerp(from.opacity, to.opacity),
			blur: lerp(from.blur ?? 0, to.blur ?? 0),
			...overrides
		});
	};
	const keyframes = {
		0: frame(from),
		100: frame(to)
	};
	const fades = from.opacity !== to.opacity;
	const softens = (from.blur ?? 0) !== (to.blur ?? 0);
	if (fades || softens) {
		const reveal = DEFAULT_REVEAL_PERCENT;
		keyframes[reveal] = at(reveal, {
			opacity: to.opacity,
			blur: to.blur ?? 0
		});
	}
	return keyframes;
}
/**
* Builds the entrance keyframes for a profile: off-screen at 0%, at rest at 100%.
*
* Entrance only. Dismissals build {@link buildExitKeyframes} instead, because an
* exit has to start from wherever the panel currently is rather than from rest.
* @param {Object} profile - Resolved visual profile.
* @param {number} size - Live size in pixels along the dismiss axis.
* @param {number} restSize - CSS resting size in pixels.
* @param {number} [lowestSize=0] - Lowest bottom snap in pixels.
* @returns {Object} Percent-keyed keyframes.
*/
function buildOpenKeyframes(profile, size, restSize, lowestSize = 0) {
	const from = effectValues(profile, {
		size,
		hidden: true
	});
	const to = {
		...awayVector(profile.position, awayTranslation(profile, size, restSize, lowestSize)),
		scale: 1,
		opacity: 1
	};
	return assembleKeyframes(profile, restStyles(profile, size, restSize, lowestSize), from, to);
}
/**
* The two ends of an exit run, as motion values.
*
* Shared by {@link buildExitKeyframes} and {@link exitTravel} so the keyframes a
* run paints and the span its release velocity is normalised over can never
* describe different geometry.
* @param {Object} profile - Resolved visual profile.
* @param {number} size - Live logical size in pixels along the dismiss axis.
* @param {number} restSize - CSS resting size in pixels.
* @param {number} [lowestSize=0] - Lowest bottom snap in pixels.
* @param {string} [effect] - Exit effect; defaults to the profile's.
* @returns {Object} `{live, hidden, away, hiddenAway}`.
*/
function exitValues(profile, size, restSize, lowestSize = 0, effect = profile.effect) {
	const logicalProgress = size / restSize;
	const painted = paintedProgress(profile.position, logicalProgress, "dragging");
	const away = awayTranslation(profile, painted === logicalProgress ? size : painted * restSize, restSize, lowestSize);
	const hidden = effectValues({
		...profile,
		effect
	}, {
		size: paintedExtent(profile, size, restSize, lowestSize),
		hidden: true,
		floorDistance: away > 0 ? away + exitCushion(profile) : 0
	});
	return {
		away,
		hidden,
		hiddenAway: awayOffset(profile.position, hidden.x, hidden.y),
		live: {
			...awayVector(profile.position, away),
			scale: 1,
			opacity: 1
		}
	};
}
/**
* Builds the keyframes for a dismissal, from wherever the panel currently is.
*
* ONE track covers every dismissal — from rest, or continuing a live drag —
* because the difference between those two used to be the bug. A drag-continuing
* exit reused the DRAG keyframes and sprang to their 0% frame, which is exactly
* flush: no inset, no cushion. Every card-mode swipe-close therefore stopped with
* `--sheet-card-margin` of panel still on screen, every edge-mode one left its
* whole box-shadow, and a centred dialog — which translates by its own height
* from mid-screen — stopped with `(viewportHeight - height) / 2` still showing,
* 244px on an 860px viewport.
*
* `100%` is the live resting pose, identical to what is painted at the moment of
* release, so nothing jumps. `0%` is the effect's hidden pose, floored so the
* panel always ends at least a cushion past where the finger left it.
* @param {Object} profile - Resolved visual profile.
* @param {number} size - Live logical size in pixels along the dismiss axis.
* @param {number} restSize - CSS resting size in pixels.
* @param {number} [lowestSize=0] - Lowest bottom snap in pixels.
* @param {Object} [options] - Build options.
* @param {string} [options.effect] - Exit effect; defaults to the profile's.
* @returns {Object} Percent-keyed keyframes.
*/
function buildExitKeyframes(profile, size, restSize, lowestSize = 0, { effect } = {}) {
	const { live, hidden } = exitValues(profile, size, restSize, lowestSize, effect || profile.effect);
	return assembleKeyframes(profile, restStyles(profile, size, restSize, lowestSize), hidden, live);
}
/**
* Pixel distance an exit run covers, for velocity normalisation.
*
* A translating exit covers the runway it has left. One that does not translate —
* `fade-scale` — still crosses the panel's own visible extent by making it
* vanish, and that extent is also the floor for a translating exit whose runway
* the drag has already eaten: normalising a hard flick over the cushion alone
* would hand the spring ~100 units of seed on a 100-unit run and cross it in a
* single frame.
*
* Handing this the resting size instead was the shipped bug. A 500px-snap sheet
* dragged to 150px and flicked only travels the runway that is left, so
* normalising over 500 understated the release velocity by ~2.8x — which is why
* a hard flick-to-close felt identical to a lazy one. Same class of mistake as
* the one `velocityToSpring` refuses to have a default span because of.
* @param {Object} profile - Resolved visual profile.
* @param {number} size - Live logical size in pixels along the dismiss axis.
* @param {number} restSize - CSS resting size in pixels.
* @param {number} [lowestSize=0] - Lowest bottom snap in pixels.
* @param {string} [effect] - Exit effect; defaults to the profile's.
* @returns {number} Positive pixel span of the run.
*/
function exitTravel(profile, size, restSize, lowestSize = 0, effect = profile.effect) {
	const { away, hiddenAway } = exitValues(profile, size, restSize, lowestSize, effect);
	return Math.max(hiddenAway - away, Math.max(size, 0));
}
/**
* Spring progress at which a sliding panel's box has cleared the viewport.
*
* A slide keeps travelling past that point to clear its shadow. The backdrop
* should not follow that invisible cushion, so its exit is remapped to reach
* zero here. Non-sliding effects remain tied to the full effect timeline.
* @param {Object} profile - Resolved visual profile.
* @param {number} size - Live logical size in pixels along the dismiss axis.
* @param {number} restSize - CSS resting size in pixels.
* @param {number} [lowestSize=0] - Lowest bottom snap in pixels.
* @param {string} [effect] - Exit effect; defaults to the profile's.
* @param {number} [liveAway] - Painted start translation. Supplying it rebases
*   the edge crossing for a cancelled entrance whose start is not at rest.
* @returns {number} Exit progress in [0, 1], or 0 for a non-sliding effect.
*/
function exitClearProgress(profile, size, restSize, lowestSize = 0, effect = profile.effect, liveAway) {
	if (effect !== "slide") return 0;
	const extent = paintedExtent(profile, size, restSize, lowestSize);
	const { away, hiddenAway } = exitValues(profile, size, restSize, lowestSize, effect);
	const travel = hiddenAway - (liveAway ?? away);
	if (travel <= 0) return 0;
	return clamp((hiddenAway - (extent + slideInset(profile, extent))) / travel, 0, 1);
}
/**
* Builds the live-drag keyframes for a profile.
* @param {Object} profile - Resolved visual profile.
* @param {number} activeSize - Size of the active snap in pixels.
* @param {number} maxSize - Largest reachable size in pixels.
* @param {number} restSize - CSS resting size in pixels.
* @param {number} [lowestSize=0] - Lowest bottom snap in pixels.
* @returns {Object} Percent-keyed keyframes.
*/
function buildDragKeyframes(profile, activeSize, maxSize, restSize, lowestSize = 0) {
	const keyframes = {
		0: restStyles(profile, 0, restSize, lowestSize),
		100: restStyles(profile, activeSize, restSize, lowestSize)
	};
	if (profile.position === "bottom" && lowestSize > 0 && lowestSize < activeSize) keyframes[lowestSize / activeSize * 100] = restStyles(profile, lowestSize, restSize, lowestSize);
	if (maxSize > activeSize && activeSize > 0) keyframes[maxSize / activeSize * 100] = restStyles(profile, maxSize, restSize, lowestSize);
	else if (profile.position === "bottom" && activeSize > 0 && lowestSize >= activeSize) keyframes[150] = restStyles(profile, activeSize * 1.5, restSize, lowestSize);
	return keyframes;
}
/**
* Builds the snap keyframes between two sizes.
* @param {Object} profile - Resolved visual profile.
* @param {number} fromSize - Starting size in pixels.
* @param {number} toSize - Destination size in pixels.
* @param {number} restSize - CSS resting size in pixels.
* @param {number} [lowestSize=0] - Lowest bottom snap in pixels.
* @returns {Object} Percent-keyed keyframes.
*/
function buildRestKeyframes(profile, fromSize, toSize, restSize, lowestSize = 0) {
	if (profile.position !== "bottom") return {};
	const keyframes = {
		0: restStyles(profile, fromSize, restSize, lowestSize),
		100: restStyles(profile, toSize, restSize, lowestSize)
	};
	const span = toSize - fromSize;
	if (span === 0) return keyframes;
	const floorPercent = (lowestSize - fromSize) / span * 100;
	if (floorPercent > 0 && floorPercent !== 100) keyframes[floorPercent] = restStyles(profile, lowestSize, restSize, lowestSize);
	const endPercent = floorPercent > 100 ? floorPercent + 150 - 100 : 150;
	keyframes[endPercent] = restStyles(profile, fromSize + span * (endPercent / 100), restSize, lowestSize);
	return keyframes;
}
function normalizeSnaps(snaps) {
	return [...new Set(snaps.map(Number).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b))];
}
/**
* Spring transport for dialog-panel and the motion engine behind sheet-panel.
*
* It implements dialog-panel's duck-typed `{show, hide, state, on, off}` seam,
* plus snap and live-drag controls used by the host component.
*/
var SheetEngine = class extends EventEmitter {
	#spring;
	#frames = null;
	#dialog = null;
	#state = "hidden";
	#phase = "hidden";
	#p = 0;
	#profile = {
		position: "bottom",
		mode: "edge",
		effect: "slide",
		edgeInset: 0,
		viewportWidth: 0,
		viewportHeight: 0
	};
	#snaps = [1];
	#activeSnap = 0;
	#currentSize = 1;
	#display = "flex";
	#springTarget = 0;
	#lastPosition = 0;
	#settleCount = 0;
	#settleAction = null;
	#pendingDismissVelocity = 0;
	#savedInline = null;
	#backdropProgress = 0;
	#flightPhase = null;
	#reversalTrack = false;
	#flightBackdrop = 0;
	#springOverride = null;
	#morphing = false;
	#blobEngine = null;
	#morphTrigger = null;
	#blobTo = null;
	#gestureExit = false;
	#heldTrigger = null;
	#triggerProbe;
	/**
	* @param {Object} [options] - Spring tuning. Each run retunes the spring
	*   from SPRING_PRESETS, so these only seed the initial values.
	* @param {number} [options.attraction=0.07] - Spring attraction.
	* @param {number} [options.friction=0.52] - Spring friction.
	* @param {Function} [options.triggerProbe] - Returns whether an armed trigger
	*   is still a usable reverse destination. The component supplies the DOM
	*   geometry policy; the engine remains usable in DOM-free tests.
	*/
	constructor({ attraction = SPRING_PRESETS.entrance.attraction, friction = SPRING_PRESETS.entrance.friction, triggerProbe = (trigger) => !!trigger } = {}) {
		super();
		const _ = this;
		_.#triggerProbe = triggerProbe;
		_.#spring = new PhysicsEngine({
			attraction,
			friction
		});
		_.#spring.on("change", ({ position }) => _.#handleSpringChange(position));
		_.#spring.on("complete", () => _.#settle());
	}
	/**
	* Declares which transport owns the next run.
	*
	* dialog-panel reads this at the top of show()/hide(), before beforeShow or
	* beforeHide can change anything. An armed, still-usable trigger therefore
	* selects the proxy blob; a swipe or a vanished trigger selects the direct
	* spring while there is still time for dialog-panel to choose the matching
	* promotion/demotion choreography. Reading this getter never mutates the run.
	* @returns {boolean} True when the sheet spring animates the real dialog.
	*/
	get animatesDialog() {
		const _ = this;
		if (_.#gestureExit) return true;
		if (!_.#morphTrigger) return true;
		return !_.#triggerProbe(_.#morphTrigger);
	}
	/** @returns {'hidden'|'showing'|'shown'|'hiding'} Current transport state. */
	get state() {
		return this.#state;
	}
	/** @returns {number} Current frame progress. Spring overshoot is preserved. */
	get progress() {
		return this.#p;
	}
	/** @returns {number} Active snap index. */
	get activeSnap() {
		return this.#activeSnap;
	}
	/** @returns {number} Current visible size in pixels. */
	get currentSize() {
		return this.#currentSize;
	}
	/**
	* @returns {number} Backdrop opacity in [0, 1], driven by the dismissal
	*   zone rather than raw progress. Recomputed with every applied frame, so
	*   it can never disagree with the panel styles.
	*/
	get backdropProgress() {
		return this.#backdropProgress;
	}
	/** @returns {number[]} Copy of the current sorted snap list. */
	get snaps() {
		return this.#snaps.slice();
	}
	/**
	* Sets the resolved visual profile used for the next keyframe build.
	* @param {Object} profile - Position, mode, effect, and viewport geometry.
	* @param {number} [profile.edgeInset] - Pixels the panel rests from its
	*   screen edge, which a slide has to clear on top of its own size. Optional:
	*   an absent value means edge-mounted.
	*/
	setProfile(profile) {
		const _ = this;
		_.#landPendingSettle();
		const previous = _.#profile;
		_.#profile = {
			..._.#profile,
			...profile
		};
		if (_.#profile.position !== previous.position || resizesWithSnaps(_.#profile) !== resizesWithSnaps(previous)) _.#clearManagedSize();
		_.#rebuildOpenTrack();
	}
	/**
	* Drops the size properties a previous profile's track wrote.
	*
	* Only a snap-resized bottom sheet emits `height`, and `#applyFrame`'s
	* `Object.assign` cannot clear a property the new track never mentions — so a
	* pixel height would survive onto a side drawer and pin it to the geometry it
	* just left (`inset: 0 auto 0 0` over-constrains, `bottom` is dropped, and the
	* drawer renders at the old snap height). A desktop bottom panel is the same
	* hazard wearing the same position: it is content-sized, and a surviving pixel
	* height would both defeat `height: fit-content` and freeze the content-resize
	* observer. Clearing hands the box back to the new track and the stylesheet.
	* Never during a morph: the host owns every inline box property while one runs.
	*/
	#clearManagedSize() {
		const _ = this;
		if (!_.#dialog || _.#parked()) return;
		_.#dialog.style.width = "";
		_.#dialog.style.height = "";
	}
	/**
	* Repaints the open track after a profile or snap change.
	*
	* `'showing'` is included deliberately. A profile change arriving mid-entrance
	* cannot morph — `beginMorph` refuses any state but `'shown'` — so without a
	* rebuild the still-running spring keeps painting the OLD profile's track (and
	* keeps re-writing its size properties) all the way to the end of the run,
	* then snaps into the new geometry at settle. Rebuilding retargets the run in
	* flight instead, which is what the host asked for.
	*/
	#rebuildOpenTrack() {
		const _ = this;
		if (!_.#dialog || _.#parked()) return;
		if (_.#state !== "shown" && _.#state !== "showing") return;
		if (_.#state === "shown") _.#p = 1;
		const open = _.#makeOpenFrames(_.#currentSize);
		if (_.#reversalTrack && _.#frames) {
			_.#frames = new FrameEngine({
				0: _.#frames.getFrame(0),
				100: open.getFrame(1)
			});
			_.#applyFrame(_.#p);
			return;
		}
		_.#frames = open;
		_.#applyFrame(_.#p);
	}
	/** @returns {boolean} True while a host-driven profile morph owns the dialog. */
	get morphing() {
		return this.#morphing;
	}
	/** @returns {boolean} True while the inner blob is actively flying. */
	get blobFlight() {
		const state = this.#blobEngine?.state;
		return state === "showing" || state === "hiding";
	}
	/**
	* Arms a trigger morph for the next hidden-to-showing run.
	*
	* The hidden-state guard is the classification boundary: a show that rescues
	* a live spring exit cannot accidentally acquire a trigger halfway through
	* and later reverse into a source it never came from. Clearing the gesture
	* flag even on refusal is what lets that rescued spring show classify itself
	* as direct when dialog-panel reads animatesDialog immediately afterwards.
	* @param {HTMLElement} trigger - Trigger to morph from and back into.
	* @param {Object} [options] - Blob presentation options.
	* @param {number} [options.zIndex=1002] - Blob stacking level.
	* @returns {boolean} True when the morph was armed.
	*/
	armMorph(trigger, { zIndex = 1002 } = {}) {
		const _ = this;
		_.#gestureExit = false;
		if (_.#state !== "hidden") return false;
		_.#morphTrigger = trigger;
		_.#ensureBlobEngine(zIndex);
		return true;
	}
	/**
	* Clears an armed trigger morph that was never consumed — a vetoed
	* beforeShow leaves the arm set with the engine still hidden, which would
	* misclassify every later run as proxy. Refuses outside 'hidden' so a live
	* reversal's trigger is never stripped mid-flight.
	*/
	disarmMorph() {
		if (this.#state !== "hidden") return;
		this.#morphTrigger = null;
	}
	/** Selects the direct spring exit for the next gesture-driven hide. */
	armGestureExit() {
		this.#gestureExit = true;
	}
	/** Cancels a gesture exit classification after beforeHide is vetoed. */
	cancelGestureExit() {
		this.#gestureExit = false;
	}
	/**
	* Parks the engine so the host can morph the dialog between two profile
	* geometries.
	*
	* The two resting geometries share almost no CSS properties — `inset: auto 0 0`
	* with a pixel height versus `inset: 0` with `margin: auto` and an intrinsic
	* one — and `auto` is not interpolable, so the morph cannot be expressed as
	* keyframes here. The host measures both boxes and transitions explicit pixel
	* values instead. This method's whole job is to get the engine out of the way
	* of those writes: the spring stops, `#applyFrame` goes inert, and the gesture
	* entry points refuse.
	*
	* The panel is landed at rest in the CURRENT profile first. A resize that
	* arrives mid-drag would otherwise bake a half-finished transform into the
	* `from` box the host is about to measure, and that offset would snap away at
	* endMorph.
	* @returns {boolean} True when the engine parked; false when it was not in a
	*   state that can morph.
	*/
	beginMorph() {
		const _ = this;
		if (_.#state !== "shown" || _.#parked() || !_.#dialog) return false;
		_.#landPendingSettle();
		if (_.#spring.isAnimating) _.#spring.stop();
		_.#currentSize = _.#restSize();
		_.#p = 1;
		_.#frames = _.#makeOpenFrames(_.#currentSize);
		_.#applyFrame(1);
		_.#morphing = true;
		_.#phase = "morphing";
		_.#settleAction = null;
		_.#backdropProgress = 1;
		_.#emitChange();
		return true;
	}
	/**
	* Resumes engine control once the host has landed the new geometry.
	*
	* Rebuilds the open frames against the new profile and repaints at rest, so
	* the next drag starts from a track that matches what is on screen.
	*/
	endMorph() {
		const _ = this;
		if (!_.#morphing) return;
		_.#morphing = false;
		_.#phase = _.#state === "shown" ? "shown" : _.#phase;
		_.#currentSize = _.#restSize();
		_.#p = 1;
		if (_.#dialog && _.#state === "shown" && !_.blobFlight) {
			_.#frames = _.#makeOpenFrames(_.#currentSize);
			_.#applyFrame(1);
		}
	}
	/**
	* Configures bottom snap heights, or the single resting size of a profile
	* that has none — a side sheet's CSS width, a centered dialog's intrinsic
	* height.
	* @param {number[]} pixelSizes - Resolved sizes in pixels.
	* @param {number} activeIndex - Active snap index.
	*/
	setSnaps(pixelSizes, activeIndex = pixelSizes.length - 1) {
		const _ = this;
		let snaps = normalizeSnaps(pixelSizes);
		if (!snaps.length) return;
		if (_.#profile.position !== "bottom") snaps = [snaps[snaps.length - 1]];
		_.#landPendingSettle();
		_.#snaps = snaps;
		_.#activeSnap = clamp(Number.isFinite(activeIndex) ? Math.trunc(activeIndex) : snaps.length - 1, 0, snaps.length - 1);
		if (_.#state !== "hiding") _.#currentSize = snaps[_.#activeSnap];
		_.#rebuildOpenTrack();
	}
	/**
	* Opens the dialog through the dialog-panel engine transport.
	* @param {Object} options - Transport values supplied by dialog-panel.
	* @param {HTMLElement} options.to - Dialog element to animate.
	* @param {string} [options.display='flex'] - Display value during closed-dialog flight.
	* @returns {Promise<boolean>} Resolves when the run settles or is superseded.
	*/
	show({ to, display = "flex" } = {}) {
		const _ = this;
		if (!to) throw new Error("SheetEngine: show() requires a target dialog.");
		if (_.#state === "shown") return Promise.resolve(false);
		_.#dialog = to;
		_.#display = display || "flex";
		_.#saveInline();
		if (_.#morphTrigger && _.#blobEngine) {
			if (_.#state === "hiding") {
				_.emit("reveal", {
					from: _.#morphTrigger,
					to: _.#dialog
				});
				_.#state = "showing";
				_.#phase = "showing";
				_.#tuneBlob("morph");
				return _.#blobEngine.show({
					from: _.#morphTrigger,
					to,
					display: _.#display
				});
			}
			if (_.#state === "hidden") {
				_.#state = "showing";
				_.#phase = "showing";
				_.#p = 0;
				_.#backdropProgress = 0;
				_.#blobTo = "dialog";
				_.#tuneBlob("morph");
				_.#blobEngine.cloneContents = true;
				return _.#blobEngine.show({
					from: _.#morphTrigger,
					to: _.#dialog,
					display: _.#display
				});
			}
		}
		_.#prepareDialog();
		if (_.#state === "hiding") {
			const floorP = paintedProgress(_.#profile.position, _.#p, _.#phase);
			const floorExtent = _.#backdropProgress * _.#backdropRestExtent();
			const painted = _.#frames?.getFrame(floorP);
			_.#state = "showing";
			_.#phase = "showing";
			_.#currentSize = _.#snaps[_.#activeSnap];
			const open = _.#makeOpenFrames(_.#currentSize);
			_.#frames = painted ? new FrameEngine({
				0: painted,
				100: open.getFrame(1)
			}) : open;
			_.#reversalTrack = !!painted;
			_.#p = 0;
			_.#settleAction = {
				type: "shown",
				backdropFloorExtent: floorExtent,
				progressFloor: floorP
			};
			_.#applyFrame(0);
			_.#tuneSpring("entrance");
			return _.#animate(0, 100, 0);
		}
		if (_.#state === "showing") return Promise.resolve(false);
		_.#tuneSpring("entrance");
		_.#state = "showing";
		_.#phase = "showing";
		_.#currentSize = _.#snaps[_.#activeSnap];
		_.#frames = _.#makeOpenFrames(_.#currentSize);
		_.#p = 0;
		_.#applyFrame(0);
		_.#settleAction = { type: "shown" };
		return _.#animate(0, 100, 0);
	}
	/**
	* Hides the dialog. Called during show, this reverses the current spring.
	* @returns {Promise<boolean>} Resolves when hidden or superseded.
	*/
	hide() {
		const _ = this;
		if (_.#state === "hidden" || _.#state === "hiding") return Promise.resolve(false);
		const velocity = _.#pendingDismissVelocity;
		_.#pendingDismissVelocity = 0;
		if (_.#morphTrigger && _.#blobEngine && !_.#gestureExit && _.#triggerProbe(_.#morphTrigger)) {
			if (_.#state === "shown") {
				_.#blobTo = "trigger";
				_.#blobEngine.cloneContents = false;
			}
			_.#state = "hiding";
			_.#phase = "hiding";
			_.#settleAction = null;
			if (_.#spring.isAnimating) _.#spring.stop();
			_.#tuneBlob("morphBack");
			return _.#blobEngine.hide();
		}
		if (_.#blobTo !== null || _.#morphTrigger) _.#releaseBlob();
		_.#gestureExit = false;
		if (_.#state === "showing") {
			const paintedP = paintedProgress(_.#profile.position, _.#p, _.#phase);
			const painted = _.#frames?.getFrame(paintedP);
			const paintedBackdrop = _.#backdropProgress;
			const exit = _.#makeExitFrames(_.#currentSize);
			_.#state = "hiding";
			_.#phase = "hiding";
			_.#frames = painted ? new FrameEngine({
				0: exit.getFrame(0),
				100: painted
			}) : exit;
			const start = paintedP === 0 ? 0 : 100;
			_.#p = start / 100;
			_.#settleAction = {
				type: "hidden",
				backdropCeilingExtent: paintedBackdrop * _.#backdropRestExtent(),
				backdropClearProgress: _.#exitClearProgress(_.#currentSize, frameAwayTranslation(_.#profile.position, painted))
			};
			_.#applyFrame(_.#p);
			_.#tuneSpring("exit");
			return _.#animate(start, 0, velocityToSpring(-Math.abs(velocity), _.#exitTravel(_.#currentSize)));
		}
		return _.dismiss(velocity);
	}
	/**
	* Stores velocity for the next dialog-panel-driven hide.
	* @param {number} velocityPxMs - Velocity toward the dismiss edge.
	*/
	setDismissVelocity(velocityPxMs) {
		this.#pendingDismissVelocity = Number.isFinite(velocityPxMs) ? velocityPxMs : 0;
	}
	/**
	* Applies a live gesture offset. Positive values move toward dismissal.
	* @param {number} offsetPx - Offset from the active snap in pixels.
	*/
	dragBy(offsetPx) {
		const _ = this;
		if (!_.#dialog || _.#state !== "shown" || _.#parked()) return;
		if (_.#spring.isAnimating) {
			_.#spring.stop();
			_.#settleAction = null;
		}
		const activeSize = _.#snaps[_.#activeSnap];
		_.#currentSize = activeSize - offsetPx;
		_.#frames = _.#makeDragFrames(activeSize);
		_.#p = activeSize === 0 ? 1 : _.#currentSize / activeSize;
		_.#phase = "dragging";
		_.#applyFrame(_.#p);
		_.#emitChange();
	}
	/**
	* Springs from the live size to a snap point.
	* @param {number} snapIndex - Destination snap index.
	* @param {number} [velocityPxMs=0] - Velocity toward larger snap sizes.
	* @returns {Promise<boolean>} Resolves when the snap settles.
	*/
	settleTo(snapIndex, velocityPxMs = 0) {
		const _ = this;
		if (_.#profile.position !== "bottom" || !_.#dialog || _.#state !== "shown") return Promise.resolve(false);
		if (_.#parked()) return Promise.resolve(false);
		const to = clamp(Math.trunc(snapIndex), 0, _.#snaps.length - 1);
		const from = _.#activeSnap;
		const targetSize = _.#snaps[to];
		const startSize = _.#currentSize;
		_.#frames = _.#makeRestFrames(startSize, targetSize);
		_.#p = 0;
		_.#phase = "snapping";
		_.#settleAction = {
			type: "snap",
			from,
			to,
			targetSize,
			startSize
		};
		_.#tuneSpring("snap");
		const velocity = clamp(velocityToSpring(velocityPxMs, targetSize - startSize), -SNAP_VELOCITY_LIMIT, SNAP_VELOCITY_LIMIT);
		return _.#animate(0, 100, velocity);
	}
	/**
	* Returns a snapless profile from its live drag position back to rest.
	*
	* Side sheets and centered dialogs both land here: neither has snap points,
	* so a release that does not dismiss is always a return to the one resting
	* geometry. Bottom sheets go through settleTo instead.
	* @param {number} [velocityPxMs=0] - Velocity toward the resting edge.
	* @returns {Promise<boolean>} Resolves when the sheet returns to rest.
	*/
	returnToRest(velocityPxMs = 0) {
		const _ = this;
		if (_.#profile.position === "bottom" || !_.#dialog || _.#state !== "shown") return Promise.resolve(false);
		if (_.#parked()) return Promise.resolve(false);
		const targetSize = _.#restSize();
		const start = Math.min(_.#currentSize / targetSize, 1) * 100;
		_.#frames = _.#makeDragFrames(targetSize);
		_.#p = start / 100;
		_.#phase = "returning";
		_.#settleAction = {
			type: "rest",
			targetSize
		};
		_.#tuneSpring("rest");
		const velocity = velocityToSpring(velocityPxMs, targetSize);
		const velocityCeiling = terminalSeed(SPRING_PRESETS.rest, 100 - start);
		return _.#animate(start, 100, Math.min(velocity, velocityCeiling));
	}
	/**
	* Springs to the configured exit keyframe and emits `hidden`.
	* @param {number} [velocityPxMs=0] - Velocity toward the dismiss edge.
	* @returns {Promise<boolean>} Resolves when hidden.
	*/
	dismiss(velocityPxMs = 0) {
		const _ = this;
		if (!_.#dialog || _.#state === "hidden") return Promise.resolve(false);
		_.#prepareDialog();
		_.#state = "hiding";
		_.#phase = "hiding";
		_.#frames = _.#makeExitFrames(_.#currentSize);
		_.#p = 1;
		_.#settleAction = {
			type: "hidden",
			backdropClearProgress: _.#exitClearProgress(_.#currentSize)
		};
		_.#applyFrame(1);
		_.#tuneSpring("exit");
		const seed = velocityToSpring(-Math.abs(velocityPxMs), _.#exitTravel(_.#currentSize));
		return _.#animate(100, 0, Math.max(seed, -EXIT_VELOCITY_LIMIT));
	}
	/**
	* Stops motion, restores inline styles, and notifies dialog-panel.
	*/
	stop() {
		const _ = this;
		if (_.#blobEngine && _.#blobEngine.state !== "idle") _.#blobEngine.stop();
		_.#returnTrigger(false);
		_.#blobTo = null;
		_.#morphTrigger = null;
		_.#gestureExit = false;
		_.#morphing = false;
		_.#flightPhase = null;
		_.#pendingDismissVelocity = 0;
		_.#reversalTrack = false;
		if (_.#state === "hidden") return;
		if (_.#spring.isAnimating) _.#spring.stop();
		_.#state = "hidden";
		_.#phase = "hidden";
		_.#p = 0;
		_.#settleAction = null;
		_.#restoreInline();
		_.emit("stop", { progress: 0 });
	}
	/**
	* Releases spring and event listeners.
	*/
	destroy() {
		const _ = this;
		_.stop();
		_.#blobEngine?.destroy();
		_.#blobEngine = null;
		_.#spring.removeAllListeners();
		_.removeAllListeners();
	}
	#handleSpringChange(position) {
		const _ = this;
		if (!_.#settleAction) return;
		const p = position / 100;
		_.#p = p;
		const action = _.#settleAction;
		if (action.type === "snap") {
			const t = clamp(p, 0, 1);
			_.#currentSize = action.targetSize * t + action.startSize * (1 - t);
		}
		if (action.type === "rest") _.#currentSize = action.targetSize * clamp(p, 0, 1);
		_.#applyFrame(p);
		const progress = action.progressFloor === void 0 ? p : action.progressFloor + (1 - action.progressFloor) * clamp(p, 0, 1);
		_.emit("change", {
			progress,
			backdropProgress: _.#backdropProgress,
			phase: _.#phase
		});
		if (Math.abs(position - _.#springTarget) < SETTLE_POSITION_EPSILON && Math.abs(position - _.#lastPosition) < SETTLE_DELTA_EPSILON) {
			if (++_.#settleCount >= 2) {
				_.#p = _.#springTarget / 100;
				_.#applyFrame(_.#p);
				_.#spring.stop();
				_.#settle();
				return;
			}
		} else _.#settleCount = 0;
		_.#lastPosition = position;
	}
	#animate(start, target, velocity) {
		const _ = this;
		_.#springTarget = target;
		_.#lastPosition = start;
		_.#settleCount = 0;
		if (start === target && velocity === 0) {
			if (_.#spring.isAnimating) _.#spring.stop();
			const action = _.#settleAction;
			_.#p = target / 100;
			_.#applyFrame(_.#p);
			return Promise.resolve().then(() => {
				if (_.#settleAction === action) _.#settle();
				return true;
			});
		}
		return _.#spring.animateTo(start, target, velocity).then(() => true);
	}
	#landPendingSettle() {
		const _ = this;
		const action = _.#settleAction;
		if (!_.#spring.isAnimating || !action || action.type !== "snap" && action.type !== "rest") return;
		_.#spring.stop();
		_.#settle();
	}
	#settle() {
		const _ = this;
		const action = _.#settleAction;
		if (!action) return;
		_.#settleAction = null;
		_.#reversalTrack = false;
		if (action.type === "shown") {
			_.#state = "shown";
			_.#phase = "shown";
			_.#p = 1;
			_.#currentSize = _.#snaps[_.#activeSnap];
			_.#frames = _.#makeOpenFrames(_.#currentSize);
			_.#applyFrame(1);
			_.#emitChange();
			_.emit("shown");
			_.#dialog.style.display = _.#savedInline?.display || "";
			return;
		}
		if (action.type === "snap") {
			_.#activeSnap = action.to;
			_.#currentSize = action.targetSize;
			_.#phase = "shown";
			_.#p = 1;
			_.#frames = _.#makeOpenFrames(_.#currentSize);
			_.#applyFrame(1);
			_.#emitChange();
			if (action.from !== action.to) _.emit("snapchange", {
				from: action.from,
				to: action.to
			});
			return;
		}
		if (action.type === "rest") {
			_.#currentSize = action.targetSize;
			_.#phase = "shown";
			_.#p = 1;
			_.#frames = _.#makeOpenFrames(_.#currentSize);
			_.#applyFrame(1);
			_.#emitChange();
			return;
		}
		_.#state = "hidden";
		_.#phase = "hidden";
		_.#p = 0;
		_.#returnTrigger(true);
		_.#restoreInline();
		_.emit("hidden");
	}
	/**
	* Resting size along the dismiss axis.
	*
	* Bottom sheets rest at the active snap height. Everything else carries a
	* single size the host measured — a side sheet's CSS `--sheet-active-size`
	* width, a centered dialog's intrinsic height.
	* @returns {number} Resting size in pixels.
	*/
	#restSize() {
		const _ = this;
		if (_.#profile.position === "bottom") return _.#snaps[_.#activeSnap];
		return _.#snaps[0];
	}
	#makeOpenFrames(size) {
		const _ = this;
		return new FrameEngine(buildOpenKeyframes(_.#profile, size, _.#restSize(), _.#snaps[0]));
	}
	#makeDragFrames(activeSize) {
		const _ = this;
		const maximum = Math.max(activeSize, ..._.#snaps);
		return new FrameEngine(buildDragKeyframes(_.#profile, activeSize, maximum, _.#restSize(), _.#snaps[0]));
	}
	#makeExitFrames(size) {
		const _ = this;
		return new FrameEngine(buildExitKeyframes(_.#profile, size, _.#restSize(), _.#snaps[0], { effect: _.#profile.exitEffect }));
	}
	#exitTravel(size) {
		const _ = this;
		return exitTravel(_.#profile, size, _.#restSize(), _.#snaps[0], _.#profile.exitEffect || _.#profile.effect);
	}
	#exitClearProgress(size, liveAway) {
		const _ = this;
		return exitClearProgress(_.#profile, size, _.#restSize(), _.#snaps[0], _.#profile.exitEffect || _.#profile.effect, liveAway);
	}
	/**
	* Distance from the resting pose to fully outside the viewport, excluding
	* the shadow cushion. Adding the inset to both the live and resting extents
	* preserves a snapped bottom sheet's saturation at its lowest snap while a
	* card or centred panel keeps fading until its trailing edge really clears.
	* @returns {number} Dismissal-zone extent at the lowest resting snap.
	*/
	#backdropRestExtent() {
		const _ = this;
		return _.#snaps[0] + slideInset(_.#profile, _.#restSize());
	}
	#makeRestFrames(fromSize, toSize) {
		const _ = this;
		return new FrameEngine(buildRestKeyframes(_.#profile, fromSize, toSize, _.#restSize(), _.#snaps[0]));
	}
	/**
	* Overrides the built-in spring tuning for this instance.
	*
	* Governs how the sheet arrives. Exits and snaps keep their presets, so
	* leaving stays brisk whatever the entrance is set to. Pass null to return
	* to the presets.
	* @param {{attraction: number, friction: number}|null} override - Spring tuning.
	*/
	setSpring(override) {
		const _ = this;
		if (!override) {
			_.#springOverride = null;
			return;
		}
		const { attraction, friction } = override;
		if (!isSpringDial(attraction) || !isSpringDial(friction)) return;
		_.#springOverride = {
			attraction,
			friction
		};
	}
	/** @returns {{attraction: number, friction: number}|null} Active override. */
	get spring() {
		return this.#springOverride ? { ...this.#springOverride } : null;
	}
	/**
	* Resolves the tuning for a phase, honouring any instance override.
	*
	* The override governs how the sheet ARRIVES — by whichever engine is flying
	* that arrival. `entrance` is this engine's own spring; `morph` is the trigger
	* blob that REPLACES it when `morph-trigger` is set. Answering only for
	* `entrance` was the gap: a `morph-trigger` panel is never flown by `#spring`
	* at all, so `spring=` resolved correctly and then tuned a spring that painted
	* no frame of the entrance the user could see.
	*
	* Exits and snaps keep their presets, and `morphBack` is an exit — it returns
	* the panel to the trigger, so it is pinned for the same reason `exit` is.
	*
	* Scaling those phases proportionally was tried and abandoned: the exit
	* preset's attraction is ~5.5x the entrance's, so any brisk override pushed
	* it past the dial's ceiling, and the clamped result was a badly overdamped
	* spring — `spring="0.3 0.55"` measured a 2933ms exit. The dials are bounded,
	* so no proportional rule can survive a fast entrance. Pinning exits to
	* their presets keeps leaving brisk for every override instead.
	* @param {'entrance'|'exit'|'snap'|'rest'|'morph'|'morphBack'} kind - Motion phase.
	* @returns {{attraction: number, friction: number}} Spring tuning.
	*/
	#springFor(kind) {
		const _ = this;
		const preset = SPRING_PRESETS[kind] || SPRING_PRESETS.entrance;
		const override = _.#springOverride;
		if (!override) return preset;
		if (kind !== "entrance" && kind !== "morph") return preset;
		return {
			attraction: clamp(override.attraction, MIN_SPRING, MAX_SPRING),
			friction: clamp(override.friction, MIN_SPRING, MAX_SPRING)
		};
	}
	/**
	* Retunes the spring for the next run.
	* @param {'entrance'|'exit'|'snap'|'rest'} kind - Motion phase.
	*/
	#tuneSpring(kind) {
		const _ = this;
		const preset = _.#springFor(kind);
		_.#spring.setAttraction(preset.attraction);
		_.#spring.setFriction(preset.friction);
	}
	/**
	* Retunes the trigger blob for its next run.
	*
	* The blob outlives a single flight — one MorphEngine is reused for every
	* open and close of this panel — so its tuning has to be written at each run
	* boundary rather than only at construction. That is also what lets the
	* outbound run differ from the inbound one at all: MorphEngine takes both
	* dials live, so the two directions are one retune apart.
	* @param {'morph'|'morphBack'} kind - Blob run direction.
	*/
	#tuneBlob(kind) {
		const _ = this;
		if (!_.#blobEngine) return;
		const preset = _.#springFor(kind);
		_.#blobEngine.setAttraction(preset.attraction);
		_.#blobEngine.setFriction(preset.friction);
	}
	/**
	* Recomputes backdrop opacity from the panel's live position.
	*
	* During the opening and closing flight the panel is at full size but only
	* partly on screen, so the flight progress is what scales the visible
	* extent. Once it has landed (shown, dragging, snapping) the live size is
	* the visible extent directly — which is why a snap-to-snap drag or settle
	* leaves the overlay alone, and why upward overscroll saturates instead of
	* lightening it.
	*
	* A slide's hidden frame includes a cushion past the point where its box clears
	* the viewport. Following p all the way to 0 leaves a dim overlay hanging over
	* an empty screen, so the exit action carries that edge-crossing progress and
	* remaps [1 -> crossing] onto [release opacity -> 0]. The p=1 endpoint is still
	* the live drag pose, so the release remains continuous. Other effects remain
	* tied to their full timeline because they disappear by fading or scaling
	* rather than by crossing an edge.
	* @param {number} p - Frame progress.
	*/
	#syncBackdropProgress(p) {
		const _ = this;
		const flying = _.#phase === "showing" || _.#phase === "hiding";
		const flight = flying ? clamp(p, 0, 1) : 1;
		const inset = slideInset(_.#profile, _.#restSize());
		const restExtent = _.#backdropRestExtent();
		const liveExtent = _.#currentSize + inset;
		const ceiling = _.#settleAction?.backdropCeilingExtent;
		const flightExtent = ceiling === void 0 ? liveExtent : ceiling;
		const clear = _.#settleAction?.backdropClearProgress;
		if (clear > 0 && clear < 1) {
			const visibleFlight = clamp((flight - clear) / (1 - clear), 0, 1);
			_.#backdropProgress = _.#flightEnvelope(flying, dismissalZoneProgress(flightExtent * visibleFlight, restExtent));
			return;
		}
		const floor = _.#settleAction?.backdropFloorExtent;
		const extent = floor === void 0 ? flightExtent * flight : floor + (liveExtent - floor) * flight;
		_.#backdropProgress = _.#flightEnvelope(flying, dismissalZoneProgress(extent, restExtent));
	}
	/**
	* Holds a flight's overlay monotonic: an entrance may only darken it, an exit
	* may only lighten it.
	*
	* dismissalZoneProgress saturates the top, which is what stops overshoot and
	* rubber-band overscroll from lightening the overlay. That covers every
	* preset, because none of them oscillate. A public `spring` override can be
	* set loose enough to oscillate, and a return swing comes back DOWN through
	* rest, into the band below saturation where the clamp has nothing to say —
	* so the scrim pulsed 1 -> 0.85 -> 1 -> 0.95 in time with the panel, decaying
	* with it. The panel is meant to bounce. The scrim is a fade.
	*
	* The mark is seeded, not reset, on every phase change, so a reversal starts
	* from the opacity already painted rather than snapping. Every entry into a
	* flight crosses a phase boundary — `show()` refuses a second showing run and
	* `dismiss()` arrives from `shown`/`dragging` — so no explicit reset is
	* needed at the four call sites that begin one. Landed phases (`dragging`,
	* `snapping`, `returning`, `shown`) are deliberately outside the envelope:
	* there the overlay follows the finger, in both directions.
	* @param {boolean} flying - True during a `showing` or `hiding` run.
	* @param {number} value - The dismissal-zone opacity this frame computed.
	* @returns {number} The value, held to the flight's direction.
	*/
	#flightEnvelope(flying, value) {
		const _ = this;
		if (!flying) {
			_.#flightPhase = null;
			return value;
		}
		if (_.#flightPhase !== _.#phase) {
			_.#flightPhase = _.#phase;
			_.#flightBackdrop = value;
			return value;
		}
		_.#flightBackdrop = _.#phase === "showing" ? Math.max(_.#flightBackdrop, value) : Math.min(_.#flightBackdrop, value);
		return _.#flightBackdrop;
	}
	#emitChange() {
		const _ = this;
		_.emit("change", {
			progress: _.#p,
			backdropProgress: _.#backdropProgress,
			phase: _.#phase
		});
	}
	#applyFrame(p) {
		const _ = this;
		if (_.#parked()) return;
		_.#syncBackdropProgress(p);
		if (!_.#frames || !_.#dialog) return;
		const styles = _.#frames.getFrame(paintedProgress(_.#profile.position, p, _.#phase));
		for (const property of CLAMP_POSITIVE) if (property in styles && parseFloat(styles[property]) < 0) styles[property] = "0px";
		Object.assign(_.#dialog.style, styles);
	}
	#saveInline() {
		const _ = this;
		if (_.#savedInline || !_.#dialog) return;
		_.#savedInline = {};
		for (const property of MANAGED_PROPERTIES) _.#savedInline[property] = _.#dialog.style[property];
	}
	#prepareDialog() {
		const _ = this;
		if (!_.#dialog) return;
		_.#dialog.style.display = _.#display;
		_.#prepareDialogMotion();
	}
	#prepareDialogMotion() {
		const _ = this;
		if (!_.#dialog) return;
		const hints = ["transform", "opacity"];
		if (resizesWithSnaps(_.#profile)) hints.push("height");
		const blurs = (effect) => (EFFECT_BLUR[effect] ?? 0) > 0;
		if (blurs(_.#profile.effect) || blurs(_.#profile.exitEffect || _.#profile.effect)) hints.push("filter");
		_.#dialog.style.willChange = hints.join(", ");
	}
	#parked() {
		return this.#morphing || this.#blobTo !== null;
	}
	#ensureBlobEngine(zIndex) {
		const _ = this;
		if (_.#blobEngine) {
			_.#blobEngine.zIndex = zIndex;
			return;
		}
		_.#blobEngine = new MorphEngine({
			..._.#springFor("morph"),
			zIndex,
			lockScroll: false
		});
		_.#blobEngine.on("change", ({ progress }) => {
			const openness = _.#blobTo === "dialog" ? progress : 1 - progress;
			_.#p = openness;
			_.#backdropProgress = clamp(openness, 0, 1);
			_.emit("change", {
				progress: openness,
				backdropProgress: _.#backdropProgress,
				phase: _.#phase
			});
		});
		_.#blobEngine.on("reveal", (detail) => _.emit("reveal", detail));
		_.#blobEngine.on("shown", () => _.#finishBlobShown());
		_.#blobEngine.on("hidden", () => _.#finishBlobHidden());
	}
	#releaseBlob() {
		const _ = this;
		if (_.#morphTrigger) _.#heldTrigger = _.#morphTrigger;
		if (_.#blobEngine && _.#blobEngine.state !== "idle") _.#blobEngine.stop({ restoreSource: false });
		_.#blobTo = null;
		_.#morphTrigger = null;
		_.#applyFrame(_.#p);
	}
	/**
	* Hands a held trigger back to the page at the end of a direct exit.
	*
	* The emit precedes the restore deliberately: a listener decorates the button
	* while it still cannot paint, so no frame exists in which it is visible and
	* undecorated. Stating that order here makes it structural, rather than a
	* consequence of which listener happened to be registered first.
	* @param {boolean} announce - Emit `triggerreturn` first. False on a force
	*   close, which paints no frame and so has no entrance to introduce.
	*/
	#returnTrigger(announce) {
		const _ = this;
		const trigger = _.#heldTrigger;
		if (!trigger) return;
		_.#heldTrigger = null;
		if (announce) _.emit("triggerreturn", { trigger });
		_.#blobEngine?.restoreSource();
	}
	#finishBlobShown() {
		const _ = this;
		if (_.#state !== "showing") return;
		_.#state = "shown";
		_.#phase = "shown";
		_.#p = 1;
		_.#backdropProgress = 1;
		_.#currentSize = _.#restSize();
		_.#frames = _.#makeOpenFrames(_.#currentSize);
		_.#blobTo = null;
		_.#prepareDialogMotion();
		_.#applyFrame(1);
		_.#emitChange();
		_.emit("shown");
		_.#dialog.style.display = _.#savedInline?.display || "";
	}
	#finishBlobHidden() {
		const _ = this;
		_.#state = "hidden";
		_.#phase = "hidden";
		_.#p = 0;
		_.#backdropProgress = 0;
		_.#flightPhase = null;
		_.#blobTo = null;
		_.#morphTrigger = null;
		_.#gestureExit = false;
		_.#emitChange();
		_.#restoreInline();
		_.emit("hidden");
	}
	#restoreInline() {
		const _ = this;
		if (!_.#dialog || !_.#savedInline) return;
		for (const property of MANAGED_PROPERTIES) _.#dialog.style[property] = _.#savedInline[property];
		_.#savedInline = null;
	}
};
/**
* Recovers finger motion from an away-signed drag direction.
*
* The inverse of sheet-engine's awayOffset on the dismiss axis, and the only
* place the two spaces meet on the touch path. A left sheet is the one profile
* dismissed toward SMALLER coordinates, so its away sign is the finger's
* inverted; bottom and right already agree with their axis. Getting exactly
* this backwards for one profile is the bug the shared policy exists to end, so
* it is a named, tested function rather than a ternary at the call site.
* @param {'bottom'|'left'|'right'} position - Sheet edge.
* @param {number} awayDirection - Signed motion toward dismissal.
* @returns {number} The same motion in finger space on the dismiss axis.
*/
function fingerFromAway(position, awayDirection) {
	return position === "left" ? -awayDirection : awayDirection;
}
/**
* Normalizes a horizontal scroll offset into the monotonic 0..max range
* canScrollFurther assumes. Modern RTL scrollers report 0 at their start
* (right) edge and negative values leftward; shifting by the scrollable
* extent restores [0, max] while preserving the physical relationship —
* scrolling content left still grows the value.
* @param {number} scrollLeft - Raw scrollLeft as the browser reported it.
* @param {number} scrollWidth - Total scrollable width.
* @param {number} clientWidth - Visible width.
* @param {boolean} rtl - True when the scroller's computed direction is rtl.
* @returns {number} Offset in [0, scrollWidth - clientWidth].
*/
function normalizeScrollLeft(scrollLeft, scrollWidth, clientWidth, rtl) {
	if (!rtl) return scrollLeft;
	return scrollLeft + Math.max(0, scrollWidth - clientWidth);
}
/**
* Whether one scrollable still has somewhere to go in a scroll direction.
* @param {Object} metrics - Snapshot of one element's scroll geometry.
* @param {number} metrics.scrollTop - Current vertical scroll offset.
* @param {number} metrics.scrollLeft - Current horizontal scroll offset.
* @param {number} metrics.scrollHeight - Total scrollable height.
* @param {number} metrics.scrollWidth - Total scrollable width.
* @param {number} metrics.clientHeight - Visible height.
* @param {number} metrics.clientWidth - Visible width.
* @param {'x'|'y'} axis - Dismiss axis to test.
* @param {number} scrollSign - Positive asks whether the scroll position can
*   still increase, negative whether it can still decrease.
* @returns {boolean} True while that direction has room left.
*/
function canScrollFurther(metrics, axis, scrollSign) {
	if (!metrics || !scrollSign) return false;
	const horizontal = axis === "x";
	const position = (horizontal ? metrics.scrollLeft : metrics.scrollTop) || 0;
	if (scrollSign < 0) return position > 0;
	const visible = (horizontal ? metrics.clientWidth : metrics.clientHeight) || 0;
	const extent = (horizontal ? metrics.scrollWidth : metrics.scrollHeight) || 0;
	return position + visible < extent - 1;
}
/**
* Whether the scrollable chain under the pointer should keep a gesture instead
* of handing it to the sheet.
*
* Any single member with room left answers for the whole chain, so a nested
* horizontal carousel inside the content scrolls on its own until it reaches
* its edge.
* @param {Object[]} chain - Scroll metrics, innermost first, ending with the
*   sheet content itself.
* @param {'x'|'y'} axis - Dismiss axis to test.
* @param {number} fingerDelta - Finger motion on that axis; negative is up or
*   left. Zero never consumes.
* @returns {boolean} True while the content still has scroll to give.
*/
function scrollChainConsumes(chain, axis, fingerDelta) {
	if (!fingerDelta || !chain) return false;
	const scrollSign = fingerDelta < 0 ? 1 : -1;
	for (const metrics of chain) if (canScrollFurther(metrics, axis, scrollSign)) return true;
	return false;
}
/**
* Resolves whether an unclaimed content gesture may claim on this move.
*
* Stateless per move, so it is always the LIVE offset that answers — a gesture
* that reverses while unclaimed asks the new direction's question, never a
* latched first sample's.
* @param {Object[]} chain - Scroll metrics, innermost first.
* @param {'x'|'y'} axis - Dismiss axis.
* @param {'bottom'|'left'|'right'|'center'} position - Sheet edge.
* @param {number} awayOffset - Live away-signed offset on the dismiss axis.
* @param {number} [slop=CLAIM_SLOP] - Minimum offset magnitude to claim.
* @returns {number} Away-signed claim direction, or 0 to keep waiting.
*/
function contentClaimDirection(chain, axis, position, awayOffset, slop = 5) {
	if (Math.abs(awayOffset) <= slop) return 0;
	const direction = Math.sign(awayOffset);
	return scrollChainConsumes(chain, axis, fingerFromAway(position, direction)) ? 0 : direction;
}
//#endregion
//#region src/snap-points.js
var SIMPLE_LENGTH = /^(-?\d*\.?\d+)(px|vh|dvh|svh|lvh|vw|rem|%)?$/i;
function splitSnapPoints(value) {
	const tokens = [];
	let token = "";
	let depth = 0;
	for (const char of String(value || "").trim()) {
		if (/\s/.test(char) && depth === 0) {
			if (token) tokens.push(token);
			token = "";
			continue;
		}
		if (char === "(") depth++;
		else if (char === ")") depth = Math.max(0, depth - 1);
		token += char;
	}
	if (token) tokens.push(token);
	return tokens;
}
/**
* Resolves a space-separated snap-point list into ascending pixel values.
* A custom measure callback lets the component delegate arbitrary CSS lengths
* such as calc() to the browser while tests can stay DOM-free.
*
* @param {string} value - Space-separated CSS lengths.
* @param {Object} metrics - Viewport and font metrics.
* @param {number} metrics.viewportHeight - Viewport height in pixels.
* @param {number} [metrics.viewportWidth] - Viewport width in pixels.
* @param {number} [metrics.rootFontSize=16] - Root font size in pixels.
* @param {number} [metrics.percentageBase] - Base used for percentages.
* @param {Function} [metrics.measure] - Browser measurement callback.
* @returns {number[]} Sorted unique positive pixel values.
*/
function resolveSnapPoints(value, { viewportHeight, viewportWidth = viewportHeight, rootFontSize = 16, percentageBase = viewportHeight, measure }) {
	const pixels = splitSnapPoints(value).map((token) => {
		if (measure) return measure(token);
		const match = token.match(SIMPLE_LENGTH);
		if (!match) return NaN;
		const number = Number(match[1]);
		const unit = (match[2] || "px").toLowerCase();
		if (unit === "px") return number;
		if (unit === "vw") return number / 100 * viewportWidth;
		if (unit === "rem") return number * rootFontSize;
		if (unit === "%") return number / 100 * percentageBase;
		return number / 100 * viewportHeight;
	}).filter((number) => Number.isFinite(number) && number > 0).map((number) => Math.round(number * 100) / 100).sort((a, b) => a - b);
	return [...new Set(pixels)];
}
/**
* Resolves an initial snap index, defaulting to the largest snap.
* @param {string|number|null} value - Requested index.
* @param {number[]} snaps - Resolved snap points.
* @returns {number} A valid index, or -1 for an empty list.
*/
function resolveInitialSnap(value, snaps) {
	if (!snaps.length) return -1;
	if (value === null || value === void 0 || value === "") return snaps.length - 1;
	const index = Number.parseInt(value, 10);
	if (!Number.isFinite(index)) return snaps.length - 1;
	return Math.min(snaps.length - 1, Math.max(0, index));
}
/**
* Chooses the snap index a released gesture should land on. A flick steps
* exactly one snap in its own direction; anything slower lands on the nearest
* snap, with the closed edge participating as a dismissal target.
* @param {Object} options - Release geometry.
* @param {number} options.currentSize - Visible panel size at release, in pixels.
* @param {number} options.velocityAway - Release velocity in px/ms, positive toward dismissal.
* @param {number[]} options.snaps - Ascending snap sizes in pixels.
* @param {number} options.flickVelocity - Speed that counts as a flick.
* @returns {number|null} Target snap index, or null to dismiss.
*/
function resolveSnapTarget({ currentSize, velocityAway, snaps, flickVelocity }) {
	if (!snaps.length) return null;
	currentSize = Math.min(currentSize, snaps[snaps.length - 1]);
	if (velocityAway > flickVelocity) {
		let below = null;
		for (let index = 0; index < snaps.length; index++) {
			if (snaps[index] >= currentSize - 1) break;
			below = index;
		}
		return below;
	}
	if (velocityAway < -flickVelocity) {
		const above = snaps.findIndex((size) => size > currentSize + 1);
		return above === -1 ? snaps.length - 1 : above;
	}
	let nearest = null;
	let nearestDistance = Math.abs(currentSize);
	for (let index = 0; index < snaps.length; index++) {
		const distance = Math.abs(snaps[index] - currentSize);
		if (distance < nearestDistance) {
			nearest = index;
			nearestDistance = distance;
		}
	}
	return nearest;
}
//#endregion
//#region src/sheet.js
var POSITIONS = /* @__PURE__ */ new Set([
	"bottom",
	"left",
	"right",
	"center"
]);
var MODES = /* @__PURE__ */ new Set(["edge", "card"]);
var EFFECTS = /* @__PURE__ */ new Set([
	"slide",
	"fade-scale",
	"slide-fade"
]);
var PROFILE_ATTRIBUTES = /* @__PURE__ */ new Set([
	"position",
	"mode",
	"breakpoint",
	"desktop-position",
	"desktop-mode"
]);
var EFFECT_ATTRIBUTES = /* @__PURE__ */ new Set([
	"effect",
	"desktop-effect",
	"exit-effect",
	"desktop-exit-effect"
]);
var RESIZE_THROTTLE_MS = 100;
var FLICK_VELOCITY = .5;
var OVERSCROLL_RESISTANCE = .2;
var SCROLLABLE_OVERFLOW = /* @__PURE__ */ new Set(["auto", "scroll"]);
/**
* Where a scrim gesture began, and the reason it is three states rather than a
* boolean. `'none'` is not "did not begin on the scrim" — it is "no pointer
* sequence happened at all", which is a real case and must be allowed through.
*
* iOS Safari delivers a tap on a modal dialog's ::backdrop as a bare `click`
* (target `<dialog>`, `detail: 1`, `pointerType: 'mouse'`) with NO preceding
* `pointerdown` — measured on an iPhone with nothing registered on `document`,
* because any document-level pointer or touch listener makes WebKit emit the
* full sequence and hides this entirely. As a boolean, that tap was
* indistinguishable from a press inside the panel, so the guard refused it and
* backdrop dismissal was dead on iPhone and iPad while swipe-to-dismiss — which
* never touches the scrim — kept working and masked it.
*/
var SCRIM_PRESS_NONE = "none";
var SCRIM_PRESS_SCRIM = "scrim";
var SCRIM_PRESS_INSIDE = "inside";
/**
* Snapshots the scroll geometry the claim policy reads. Cached at gesture start
* rather than read per frame: native scrolling that outruns the snapshot fires
* pointercancel, which abandons the drag anyway. Horizontal offsets are
* normalized here so downstream policy sees the same monotonic range in LTR and
* RTL content.
* @param {Element} element - Scrollable element.
* @returns {Object} Plain metrics for scroll-policy.
*/
function scrollMetrics(element) {
	const rtl = getComputedStyle(element).direction === "rtl";
	return {
		scrollTop: element.scrollTop,
		scrollLeft: normalizeScrollLeft(element.scrollLeft, element.scrollWidth, element.clientWidth, rtl),
		scrollHeight: element.scrollHeight,
		scrollWidth: element.scrollWidth,
		clientHeight: element.clientHeight,
		clientWidth: element.clientWidth
	};
}
/**
* Decides chain membership: only a node whose computed overflow on the dismiss
* axis actually scrolls can answer for the chain. Geometry alone cannot say —
* a clipped element still reports scroll extent past its client box.
* @param {Element} element - Candidate chain member.
* @param {'x'|'y'} axis - Dismiss axis.
* @returns {boolean} True when the element scrolls on that axis.
*/
function scrollsOnAxis(element, axis) {
	const style = getComputedStyle(element);
	return SCROLLABLE_OVERFLOW.has(axis === "x" ? style.overflowX : style.overflowY);
}
/**
* Whether an element is visible enough to be morphed out of.
*
* MorphEngine's blob clones the trigger's subtree and forces visibility,
* display and opacity back on to render it, so a trigger the page deliberately
* hid would have its content flashed across the flight. Refusing the box here
* is what routes such a trigger back to the ordinary spring entrance.
*
* `display: none` is checked even though a display:none box already measures
* zero: MorphEngine flips the element on for one synchronous read, so the
* intent is worth stating rather than leaning on the measurement.
* @param {Element} element - Candidate trigger.
* @returns {boolean} True when the page is actually showing it.
*/
function triggerIsVisible(element) {
	const style = getComputedStyle(element);
	if (style.visibility === "hidden" || style.display === "none") return false;
	const opacity = Number.parseFloat(style.opacity);
	return !(Number.isFinite(opacity) && opacity === 0);
}
/**
* Inline properties the profile morph owns while it runs.
*
* Every one is written in explicit pixels so the transition has something
* interpolable to work with, and every one is stripped on completion so the new
* profile's stylesheet geometry takes back over. Kept as a list because the
* teardown has to be exhaustive: a single survivor — a stale `height`, say —
* would pin the panel to the geometry it just left.
*/
var MORPH_PROPERTIES = [
	"top",
	"left",
	"right",
	"bottom",
	"width",
	"height",
	"maxWidth",
	"maxHeight",
	"margin",
	"borderRadius",
	"transition"
];
/**
* The subset that actually animates, in CSS spelling.
*
* The rest of MORPH_PROPERTIES are neutralisers — `right: auto`, `margin: 0` —
* held constant so they cannot fight the four box values being interpolated.
* Doubles as the transitionend filter: content inside the dialog runs
* transitions of its own, and only these mean the morph itself has landed.
*/
var MORPH_TRANSITION_PROPERTIES = [
	"top",
	"left",
	"width",
	"height",
	"border-radius"
];
/**
* Safety margin on the morph's transitionend wait.
*
* transitionend does not fire if the transition is interrupted, if a property
* happens to start and end at the same value, or if the element is hidden
* mid-flight. The timeout is what guarantees the pins are always stripped, so
* the panel can never be stranded in morph geometry.
*/
var MORPH_TIMEOUT_PADDING_MS = 120;
function throttle(func, limit) {
	let timer = null;
	const throttled = (...args) => {
		if (timer !== null) return;
		timer = setTimeout(() => {
			timer = null;
			func(...args);
		}, limit);
	};
	throttled.cancel = () => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	};
	return throttled;
}
function reflectString(element, name, value) {
	if (value === null || value === void 0 || value === "") element.removeAttribute(name);
	else element.setAttribute(name, String(value));
}
/**
* Gesture-driven sheet policy layered on dialog-panel's native dialog lifecycle.
*/
var SheetPanel = class SheetPanel extends HTMLElement {
	#engine = null;
	#panelRef = null;
	#dialogRef = null;
	#gestures = [];
	#scrollVeto = null;
	#scrimPress = SCRIM_PRESS_NONE;
	#scrimPressTimer = null;
	#pointerlessClick = null;
	#pointerlessArmed = false;
	#pointerlessTimer = null;
	#connected = false;
	#profile = null;
	#snaps = [];
	#drag = { active: false };
	#morph = null;
	#morphInline = null;
	#proxyRevealed = false;
	#pendingProfile = null;
	#contentObserver = null;
	#contentRemeasureTimer = null;
	#triggerReturn = null;
	#handlers;
	static get observedAttributes() {
		return [
			"snap-points",
			"initial-snap",
			"position",
			"mode",
			"breakpoint",
			"desktop-position",
			"desktop-mode",
			"desktop-effect",
			"desktop-exit-effect",
			"effect",
			"exit-effect",
			"max-display-width",
			"spring"
		];
	}
	/**
	* Parses a `spring="attraction friction"` attribute.
	* @param {string|null} value - Two floats, both exclusive of 0 and 1.
	* @returns {{attraction: number, friction: number}|null} Parsed tuning, or
	*   null when absent or malformed — in which case the presets stand.
	*/
	static parseSpring(value) {
		return parseSpring(value);
	}
	constructor() {
		super();
		const _ = this;
		_.#handlers = {
			beforeShow: (event) => {
				if (event.target !== _.#panelRef) return;
				if (window.innerWidth > _.maxDisplayWidth) {
					event.preventDefault();
					return;
				}
				_.#proxyRevealed = false;
				if (_.#engine?.state !== "hiding") _.#setProgress(0);
				_.#prepareOpen();
			},
			beforeHide: (event) => {
				if (event.target !== _.#panelRef) return;
				const source = _.#pointerlessArmed ? _.#pointerlessClick : null;
				if (source && _.#dialogRef?.contains(source) && !source.closest?.("[data-action-hide-dialog]")) {
					event.preventDefault();
					return;
				}
				const interrupted = _.#drag.active ? _.#drag : null;
				_.#drag = { active: false };
				if (interrupted) queueMicrotask(() => {
					if (!_.#connected || _.#engine?.state !== "shown") return;
					if (_.#drag.active) return;
					_.#drag = interrupted;
				});
				_.#finishMorph();
			},
			shown: (event) => {
				if (event.target !== _.#panelRef) return;
				_.#setProgress(1);
				_.#flushPendingProfile();
				_.#syncContentObserver();
			},
			triggerReturn: ({ trigger }) => {
				if (!trigger?.isConnected) return;
				const duration = _.#durationToken(trigger, "--sheet-trigger-return-duration", 280);
				if (duration <= 0) return;
				_.#clearTriggerReturn();
				const finish = () => _.#clearTriggerReturn();
				_.#triggerReturn = {
					trigger,
					onEnd: (event) => {
						if (event.target === trigger) finish();
					},
					timer: setTimeout(finish, duration + MORPH_TIMEOUT_PADDING_MS)
				};
				trigger.addEventListener("animationend", _.#triggerReturn.onEnd);
				trigger.setAttribute("sheet-return", "");
			},
			hidden: (event) => {
				if (event.target !== _.#panelRef) return;
				_.#drag = { active: false };
				_.#clearScrimPressTimer();
				_.#scrimPress = SCRIM_PRESS_NONE;
				_.#proxyRevealed = false;
				_.#finishMorph();
				_.#setProgress(0);
				_.#syncContentObserver();
			},
			escapeGuard: (event) => {
				if (event.target !== _.#dialogRef || _.dismissPolicy.escape) return;
				event.preventDefault();
				event.stopPropagation();
			},
			scrimPress: (event) => {
				_.#clearScrimPressTimer();
				_.#scrimPress = event.target === _.#dialogRef ? SCRIM_PRESS_SCRIM : SCRIM_PRESS_INSIDE;
			},
			scrimRelease: () => {
				_.#clearScrimPressTimer();
				_.#scrimPressTimer = setTimeout(() => {
					_.#scrimPressTimer = null;
					_.#scrimPress = SCRIM_PRESS_NONE;
				}, 0);
			},
			scrimCancel: () => {
				_.#clearScrimPressTimer();
				_.#scrimPress = SCRIM_PRESS_NONE;
			},
			pointerlessArm: (event) => {
				if (event.target === _.#pointerlessClick) _.#pointerlessArmed = true;
			},
			outsideGuard: (event) => {
				try {
					if (!_.#dialogRef) return;
					if (event.detail === 0) {
						_.#pointerlessClick = event.target;
						_.#pointerlessArmed = false;
						clearTimeout(_.#pointerlessTimer);
						_.#pointerlessTimer = setTimeout(() => {
							_.#pointerlessTimer = null;
							_.#pointerlessClick = null;
							_.#pointerlessArmed = false;
						}, 0);
						return;
					}
					const rect = _.#dialogRef.getBoundingClientRect();
					if (!(event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) return;
					if (!_.dismissPolicy.backdrop || _.#scrimPress === SCRIM_PRESS_INSIDE) event.stopPropagation();
				} finally {
					_.#clearScrimPressTimer();
					_.#scrimPress = SCRIM_PRESS_NONE;
				}
			},
			close: () => {
				const dialog = _.#dialogRef;
				const engine = _.#engine;
				if (dialog && !dialog.open && _.#proxyRevealed && engine?.state === "showing" && engine.blobFlight) engine.stop();
			},
			reveal: () => {
				_.#proxyRevealed = true;
			},
			resize: throttle(() => _.#handleResize(), RESIZE_THROTTLE_MS),
			change: ({ progress, backdropProgress, phase }) => _.#setProgress(progress, backdropProgress, phase),
			snapchange: (detail) => {
				_.#syncActiveSize(detail.to);
				_.dispatchEvent(new CustomEvent("snapchange", {
					bubbles: true,
					composed: true,
					detail
				}));
			}
		};
	}
	attributeChangedCallback(name, oldValue, newValue) {
		const _ = this;
		if (oldValue === newValue || !_.#connected) return;
		if (name === "max-display-width") {
			if (window.innerWidth > _.maxDisplayWidth && _.panel?.isOpen) _.hide();
			return;
		}
		if (name === "spring") {
			_.#syncSpring();
			return;
		}
		if (EFFECT_ATTRIBUTES.has(name)) {
			if (_.panel?.isOpen) _.#applyProfile(_.#resolveProfile());
			return;
		}
		if (PROFILE_ATTRIBUTES.has(name) && _.panel?.isOpen) {
			if (_.#engine?.blobFlight) {
				_.#pendingProfile = true;
				return;
			}
			_.#morphToProfile();
			return;
		}
		if (name === "snap-points" || name === "initial-snap") {
			if (_.#engine?.blobFlight) {
				_.#pendingProfile = true;
				return;
			}
			if (!_.#drag.active) _.#prepareOpen();
		}
	}
	connectedCallback() {
		const _ = this;
		if (_.#connected) return;
		_.#connected = true;
		_.#panelRef = _.panel;
		_.#dialogRef = _.dialog;
		_.#engine = new SheetEngine({ triggerProbe: (trigger) => !!_.#usableTriggerBox(trigger) });
		_.#engine.on("snapchange", _.#handlers.snapchange);
		_.#engine.on("change", _.#handlers.change);
		_.#engine.on("reveal", _.#handlers.reveal);
		_.#engine.on("triggerreturn", _.#handlers.triggerReturn);
		_.#syncSpring();
		_.setAttribute("engine", "");
		if (_.#panelRef) {
			_.#panelRef.morphEngine = _.#engine;
			if (!_.#panelRef.hasAttribute("morph-display")) _.#panelRef.setAttribute("morph-display", "flex");
			_.#panelRef.addEventListener("beforeShow", _.#handlers.beforeShow);
			_.#panelRef.addEventListener("beforeHide", _.#handlers.beforeHide);
			_.#panelRef.addEventListener("shown", _.#handlers.shown);
			_.#panelRef.addEventListener("hidden", _.#handlers.hidden);
			_.#panelRef.addEventListener("pointerdown", _.#handlers.scrimPress, true);
			_.#panelRef.addEventListener("pointerup", _.#handlers.scrimRelease, true);
			_.#panelRef.addEventListener("pointercancel", _.#handlers.scrimCancel, true);
			_.#panelRef.addEventListener("click", _.#handlers.outsideGuard, true);
		}
		_.addEventListener("click", _.#handlers.pointerlessArm);
		_.#dialogRef?.addEventListener("close", _.#handlers.close);
		document.addEventListener("cancel", _.#handlers.escapeGuard, true);
		window.addEventListener("resize", _.#handlers.resize);
		_.#bindSurface(_.header, "header");
		_.#bindSurface(_.footer, "footer");
		_.#bindSurface(_.content, "content");
		_.#bindSurface(_, "panel");
		if (_.content) {
			_.#scrollVeto = (event) => {
				if (_.#drag.active && _.#drag.claimed && event.cancelable) event.preventDefault();
			};
			_.content.addEventListener("touchmove", _.#scrollVeto, { passive: false });
		}
		_.#applyProfile(_.#resolveProfile());
	}
	disconnectedCallback() {
		const _ = this;
		if (!_.#connected) return;
		_.#connected = false;
		window.removeEventListener("resize", _.#handlers.resize);
		document.removeEventListener("cancel", _.#handlers.escapeGuard, true);
		_.#handlers.resize.cancel();
		_.#clearMorphTimers();
		_.#clearTriggerReturn();
		_.#clearScrimPressTimer();
		_.#contentObserver?.disconnect();
		_.#contentObserver = null;
		clearTimeout(_.#contentRemeasureTimer);
		_.#contentRemeasureTimer = null;
		clearTimeout(_.#pointerlessTimer);
		_.#pointerlessTimer = null;
		_.#pointerlessClick = null;
		_.#pointerlessArmed = false;
		_.#releaseMorphPins();
		_.removeEventListener("click", _.#handlers.pointerlessArm);
		_.#dialogRef?.removeEventListener("close", _.#handlers.close);
		for (const gesture of _.#gestures) gesture.destroy();
		_.#gestures = [];
		if (_.content && _.#scrollVeto) _.content.removeEventListener("touchmove", _.#scrollVeto);
		_.#scrollVeto = null;
		_.style.removeProperty("--sheet-active-size");
		_.#dialogRef?.style.removeProperty("--sheet-active-size");
		if (_.#panelRef) {
			_.#panelRef.removeEventListener("beforeShow", _.#handlers.beforeShow);
			_.#panelRef.removeEventListener("beforeHide", _.#handlers.beforeHide);
			_.#panelRef.removeEventListener("shown", _.#handlers.shown);
			_.#panelRef.removeEventListener("hidden", _.#handlers.hidden);
			_.#panelRef.removeEventListener("pointerdown", _.#handlers.scrimPress, true);
			_.#panelRef.removeEventListener("pointerup", _.#handlers.scrimRelease, true);
			_.#panelRef.removeEventListener("pointercancel", _.#handlers.scrimCancel, true);
			_.#panelRef.removeEventListener("click", _.#handlers.outsideGuard, true);
			_.#panelRef.style.removeProperty("--sheet-progress");
			_.#panelRef.style.removeProperty("--sheet-backdrop-progress");
		}
		_.#engine?.off("change", _.#handlers.change);
		_.#engine?.off("snapchange", _.#handlers.snapchange);
		_.#engine?.off("reveal", _.#handlers.reveal);
		_.#engine?.off("triggerreturn", _.#handlers.triggerReturn);
		_.#engine?.destroy();
		if (_.#panelRef?.morphEngine === _.#engine) _.#panelRef.morphEngine = null;
		_.#engine = null;
		_.#panelRef = null;
		_.#dialogRef = null;
		_.#profile = null;
		_.#drag = { active: false };
		_.#pendingProfile = null;
		_.removeAttribute("engine");
	}
	/**
	* Opens through dialog-panel. The engine declares `animatesDialog`, so the
	* panel selects its engine transport with or without a trigger.
	*
	* The trigger is used for focus return and — only when `morph-trigger` is
	* set — as the box the panel grows out of. Without that attribute the
	* entrance is the ordinary spring, exactly as it is for a bare `show()`.
	* @param {HTMLElement} [triggerEl] - Trigger for focus return, and the morph
	*   source when `morph-trigger` is set.
	* @returns {boolean|undefined} dialog-panel's show result.
	*/
	show(triggerEl) {
		const _ = this;
		if (window.innerWidth > _.maxDisplayWidth) return false;
		if (_.#triggerReturn?.trigger === triggerEl) _.#clearTriggerReturn();
		_.#prepareOpen();
		const dialog = _.#dialogRef;
		const morph = _.morphsFromTrigger && !!triggerEl && !!dialog && _.#morphDuration(dialog) > 0 && !!_.#usableTriggerBox(triggerEl);
		if (morph) _.#engine?.armMorph(triggerEl, { zIndex: _.#blobZIndex() });
		const result = _.panel?.show(triggerEl);
		if (morph && !result) _.#engine?.disarmMorph();
		return result;
	}
	/**
	* Hides through dialog-panel.
	* @returns {boolean|undefined} dialog-panel's hide result.
	*/
	hide() {
		return this.panel?.hide();
	}
	/**
	* Springs to a mobile snap point. Desktop profiles have one inert snap.
	* @param {number} index - Destination snap index.
	* @returns {Promise<boolean>|undefined} Settle result.
	*/
	snapTo(index) {
		const _ = this;
		if (!_.#engine || !_.#snaps.length) return;
		const requestedIndex = Number(index);
		if (!Number.isFinite(requestedIndex)) return Promise.resolve(false);
		return _.#engine.settleTo(requestedIndex, 0);
	}
	/** @returns {number} Active snap index. */
	get activeSnap() {
		return this.#engine?.activeSnap ?? -1;
	}
	/** @returns {HTMLElement|null} Parent dialog-panel. */
	get panel() {
		return this.closest("dialog-panel");
	}
	/** @returns {HTMLDialogElement|null} Parent native dialog. */
	get dialog() {
		return this.closest("dialog");
	}
	/** @returns {SheetHeader|null} Header drag surface. */
	get header() {
		return this.querySelector("sheet-header");
	}
	/** @returns {SheetContent|null} Scrollable content region. */
	get content() {
		return this.querySelector("sheet-content");
	}
	/** @returns {SheetFooter|null} Optional footer drag surface. */
	get footer() {
		return this.querySelector("sheet-footer");
	}
	/** @returns {HTMLElement|null} Generated dialog-panel backdrop. */
	get backdrop() {
		return this.panel?.querySelector("dialog-backdrop");
	}
	/** @returns {string} Space-separated CSS snap lengths. */
	get snapPoints() {
		return this.getAttribute("snap-points") || "85vh";
	}
	/** @param {string} value - Space-separated CSS snap lengths. */
	set snapPoints(value) {
		reflectString(this, "snap-points", value);
	}
	/** @returns {number|null} Requested initial snap, or null for the largest. */
	get initialSnap() {
		return this.hasAttribute("initial-snap") ? Number.parseInt(this.getAttribute("initial-snap"), 10) : null;
	}
	/** @param {number|null} value - Zero-based initial snap index. */
	set initialSnap(value) {
		reflectString(this, "initial-snap", value);
	}
	/** @returns {'bottom'|'left'|'right'|'center'} Mobile sheet edge. */
	get position() {
		const value = this.getAttribute("position");
		return POSITIONS.has(value) ? value : "bottom";
	}
	/** @param {'bottom'|'left'|'right'|'center'} value - Mobile sheet edge. */
	set position(value) {
		reflectString(this, "position", value);
	}
	/** @returns {'edge'|'card'} Mobile presentation mode. */
	get mode() {
		const value = this.getAttribute("mode");
		return MODES.has(value) ? value : "edge";
	}
	/** @param {'edge'|'card'} value - Mobile presentation mode. */
	set mode(value) {
		reflectString(this, "mode", value);
	}
	/** @returns {number} Desktop profile breakpoint in pixels. */
	get breakpoint() {
		const value = Number.parseFloat(this.getAttribute("breakpoint"));
		return Number.isFinite(value) ? value : 768;
	}
	/** @param {number} value - Desktop profile breakpoint in pixels. */
	set breakpoint(value) {
		reflectString(this, "breakpoint", value);
	}
	/**
	* Desktop placement, falling back to the mobile `position` — except a mobile
	* `bottom`, which falls out to `center`.
	*
	* A bottom panel takes its height from a snap point (85vh by default), so on a
	* wide display a sheet holding one paragraph stands as a full-width slab of
	* mostly empty surface. `center` is the only profile that sizes to its own
	* content height, which is what a desktop dialog wants. Every other position
	* rests against an edge on any viewport and inherits itself unchanged.
	*
	* Pass `desktop-position="bottom"` to opt back in.
	* @returns {'bottom'|'left'|'right'|'center'} Desktop sheet edge.
	*/
	get desktopPosition() {
		const value = this.getAttribute("desktop-position");
		if (POSITIONS.has(value)) return value;
		return this.position === "bottom" ? "center" : this.position;
	}
	/** @param {'bottom'|'left'|'right'|'center'} value - Desktop sheet edge. */
	set desktopPosition(value) {
		reflectString(this, "desktop-position", value);
	}
	/** @returns {'edge'|'card'} Desktop presentation mode. */
	get desktopMode() {
		const value = this.getAttribute("desktop-mode");
		return MODES.has(value) ? value : "card";
	}
	/** @param {'edge'|'card'} value - Desktop presentation mode. */
	set desktopMode(value) {
		reflectString(this, "desktop-mode", value);
	}
	/** @returns {'slide'|'fade-scale'|'slide-fade'} Mobile motion effect. */
	get effect() {
		const value = this.getAttribute("effect");
		return EFFECTS.has(value) ? value : "slide";
	}
	/** @param {'slide'|'fade-scale'|'slide-fade'} value - Mobile motion effect. */
	set effect(value) {
		reflectString(this, "effect", value);
	}
	/** @returns {'slide'|'fade-scale'|'slide-fade'} Desktop motion effect. */
	get desktopEffect() {
		const value = this.getAttribute("desktop-effect");
		if (EFFECTS.has(value)) return value;
		if (this.desktopPosition === "center") return "fade-scale";
		return this.effect;
	}
	/** @param {'slide'|'fade-scale'|'slide-fade'} value - Desktop motion effect. */
	set desktopEffect(value) {
		reflectString(this, "desktop-effect", value);
	}
	/**
	* Mobile exit effect, defaulting to whatever the sheet arrives with.
	*
	* Separate from `effect` because leaving is not always the entrance reversed. A
	* panel that slides up from the bottom edge on a phone often reads better
	* shrinking and fading away on a desktop, where it is a floating card rather
	* than something welded to an edge — and a dismissal that continues a live drag
	* carries on outward past the release pose while it does, rather than sliding
	* the whole way off a screen it is only occupying part of.
	* @returns {'slide'|'fade-scale'|'slide-fade'} Mobile exit effect.
	*/
	get exitEffect() {
		const value = this.getAttribute("exit-effect");
		return EFFECTS.has(value) ? value : this.effect;
	}
	/** @param {'slide'|'fade-scale'|'slide-fade'} value - Mobile exit effect. */
	set exitEffect(value) {
		reflectString(this, "exit-effect", value);
	}
	/**
	* Desktop exit effect. Falls back to `exit-effect` when that is set explicitly,
	* and otherwise to the desktop entrance — so a profile that only names its
	* desktop entrance still leaves the way it arrived.
	* @returns {'slide'|'fade-scale'|'slide-fade'} Desktop exit effect.
	*/
	get desktopExitEffect() {
		const value = this.getAttribute("desktop-exit-effect");
		if (EFFECTS.has(value)) return value;
		const mobile = this.getAttribute("exit-effect");
		if (EFFECTS.has(mobile)) return mobile;
		return this.desktopEffect;
	}
	/** @param {'slide'|'fade-scale'|'slide-fade'} value - Desktop exit effect. */
	set desktopExitEffect(value) {
		reflectString(this, "desktop-exit-effect", value);
	}
	/**
	* Spring tuning override for this instance, or null while the built-in
	* per-phase presets are in force.
	* @returns {{attraction: number, friction: number}|null} Active tuning.
	*/
	get spring() {
		return SheetPanel.parseSpring(this.getAttribute("spring"));
	}
	/**
	* Overrides spring tuning. Both dials are exclusive of 0 and 1; anything
	* else is ignored and the presets stand. Setting null restores them.
	*
	* The pair replaces the entrance tuning — how the sheet arrives — but exits
	* and snaps keep their own presets.
	* @param {{attraction: number, friction: number}|string|null} value - Tuning.
	*/
	set spring(value) {
		if (value === null || value === void 0) {
			this.removeAttribute("spring");
			return;
		}
		if (typeof value === "string") {
			reflectString(this, "spring", value);
			return;
		}
		const { attraction, friction } = value;
		reflectString(this, "spring", `${attraction} ${friction}`);
	}
	/**
	* Which implicit routes out of the sheet are open.
	*
	* `dismiss="none"` closes all three, leaving a button or a programmatic
	* `hide()` as the only way out — a confirm that really does require an answer.
	* See parseDismiss in sheet-engine.js for the token grammar.
	* @returns {{swipe: boolean, backdrop: boolean, escape: boolean}} Allowed routes.
	*/
	get dismissPolicy() {
		return parseDismiss(this.getAttribute("dismiss"));
	}
	/** @param {string|null} value - Route tokens, `none`, or `''` for locked. */
	set dismiss(value) {
		if (value === null || value === void 0) this.removeAttribute("dismiss");
		else this.setAttribute("dismiss", String(value));
	}
	/** @returns {string|null} The raw `dismiss` attribute. */
	get dismiss() {
		return this.getAttribute("dismiss");
	}
	/**
	* Whether `show(trigger)` grows the trigger's box into the panel rather than
	* running the spring entrance. Opt-in, because a trigger is passed to every
	* sheet for focus return and most of them should still slide from their edge.
	* @returns {boolean} True when the `morph-trigger` attribute is present.
	*/
	get morphsFromTrigger() {
		return this.hasAttribute("morph-trigger");
	}
	/**
	* Opts the sheet into growing out of the trigger passed to `show()`.
	* @param {boolean} value - True to set `morph-trigger`, false to remove it.
	*/
	set morphsFromTrigger(value) {
		if (value) this.setAttribute("morph-trigger", "");
		else this.removeAttribute("morph-trigger");
	}
	/** @returns {number} Largest viewport width where opening is allowed. */
	get maxDisplayWidth() {
		const value = this.getAttribute("max-display-width");
		if (value === null || value === "none") return Infinity;
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : Infinity;
	}
	/** @param {number} value - Largest opening width, or Infinity for no limit. */
	set maxDisplayWidth(value) {
		if (value === Infinity || value === null || value === void 0) this.removeAttribute("max-display-width");
		else reflectString(this, "max-display-width", value);
	}
	#bindSurface(element, surface) {
		if (!element) return;
		this.#gestures.push(new DragGesture(element, this.#surfaceCallbacks(surface)));
	}
	#surfaceCallbacks(surface) {
		const _ = this;
		return {
			onStart: (info) => _.#dragStart(surface, info?.event),
			onMove: (info) => _.#dragMove(surface, info),
			onEnd: (info) => _.#dragEnd(info)
		};
	}
	#dragStart(surface, event) {
		const _ = this;
		if (surface === "panel" && event?.target !== _) return false;
		if (_.#engine?.state !== "shown" || _.#engine.morphing || _.#engine.blobFlight) {
			_.#drag = { active: false };
			return false;
		}
		_.#drag = {
			active: true,
			claimed: false,
			direction: 0,
			scrollChain: _.#scrollChain(event?.target)
		};
	}
	/**
	* Collects every scrollable from the gesture's target up to and including the
	* content region, innermost first.
	*
	* Consulting only the content element is what made a nested scroller — an
	* upsell carousel, say — invisible: the sheet claimed the drag immediately
	* and the touchmove veto then killed the carousel's own scrolling.
	* @param {EventTarget} [target] - Element the gesture started on.
	* @returns {Object[]} Scroll metrics; empty when nothing on the axis scrolls.
	*/
	#scrollChain(target) {
		const _ = this;
		const content = _.content;
		if (!content) return [];
		const axis = dismissAxis(_.#profile.position);
		const chain = [];
		let node = target instanceof Element ? target : null;
		while (node && node !== content && content.contains(node)) {
			if (scrollsOnAxis(node, axis)) chain.push(scrollMetrics(node));
			node = node.parentElement;
		}
		if (scrollsOnAxis(content, axis)) chain.push(scrollMetrics(content));
		return chain;
	}
	#dragMove(surface, info) {
		const _ = this;
		const drag = _.#drag;
		if (!drag.active) return;
		const offset = _.#awayOffset(info.deltaX, info.deltaY);
		if (!drag.claimed) {
			if (surface === "content") {
				if (!_.#matchesActiveAxis(info.direction)) return;
				const position = _.#profile.position;
				const direction = contentClaimDirection(drag.scrollChain, dismissAxis(position), position, offset);
				if (!direction) return;
				drag.direction = direction;
			} else {
				if (!offset) return;
				drag.direction = Math.sign(offset);
			}
			drag.claimed = true;
		}
		_.#applyLiveOffset(offset);
	}
	#settleBack() {
		const _ = this;
		if (_.#profile.position === "bottom") _.#engine.settleTo(_.#engine.activeSnap, 0);
		else _.#engine.returnToRest(0);
	}
	#dragEnd(info) {
		const _ = this;
		const drag = _.#drag;
		if (!drag.active) return;
		_.#drag = { active: false };
		if (!drag.claimed) return;
		if (info.cancelled) {
			_.#settleBack();
			return;
		}
		const velocityAway = _.#awayOffset(info.velocityX, info.velocityY);
		const resolved = resolveSnapTarget({
			currentSize: _.#engine.currentSize,
			velocityAway,
			snaps: _.#snaps,
			flickVelocity: FLICK_VELOCITY
		});
		let prevented = resolved === null && !_.dismissPolicy.swipe;
		let target = prevented ? _.#engine.activeSnap : resolved;
		if (target === null) {
			if (_.#dismiss(Math.max(velocityAway, 0)) === false) {
				target = _.#engine.activeSnap;
				prevented = true;
			}
			_.#emitSnapRelease(velocityAway, target, prevented);
			return;
		}
		_.#emitSnapRelease(velocityAway, target, prevented);
		if (_.#profile.position === "bottom") _.#engine.settleTo(target, -velocityAway);
		else _.#engine.returnToRest(-velocityAway);
	}
	/**
	* Announces a touch release decision.
	* @param {number} velocity - Away-signed release velocity in px/ms.
	* @param {number|null} target - Snap index actually taken, or null for a
	*   dismissal. Reports what happened, never what was merely resolved.
	* @param {boolean} [prevented] - True when the gesture resolved to a dismissal
	*   that `dismiss` refused, so a consumer can shake the panel or flag the
	*   field that still needs an answer.
	*/
	#emitSnapRelease(velocity, target, prevented = false) {
		const _ = this;
		_.dispatchEvent(new CustomEvent("snaprelease", {
			bubbles: true,
			composed: true,
			detail: {
				velocity,
				flick: Math.abs(velocity) > FLICK_VELOCITY,
				direction: velocity > 0 ? "away" : velocity < 0 ? "toward" : "none",
				size: _.#engine.currentSize,
				target,
				prevented
			}
		}));
	}
	#awayOffset(x, y) {
		return awayOffset(this.#profile.position, x, y);
	}
	#matchesActiveAxis(direction) {
		if (dismissAxis(this.#profile.position) === "y") return direction === "up" || direction === "down";
		return direction === "left" || direction === "right";
	}
	#applyLiveOffset(offset) {
		const _ = this;
		const activeSize = _.#snaps[_.#engine.activeSnap];
		const drag = _.#drag;
		if (drag.base === void 0) drag.base = _.#engine.currentSize;
		const maximum = _.#snaps[_.#snaps.length - 1];
		let size = drag.base - offset;
		if (size > maximum) size = maximum + Math.sqrt(size - maximum) * 10 * OVERSCROLL_RESISTANCE;
		if (size < 0) size = -Math.sqrt(-size) * 10 * OVERSCROLL_RESISTANCE;
		_.#engine.dragBy(activeSize - size);
	}
	/**
	* @param {number} velocityAway - Release velocity toward the dismiss edge.
	* @returns {boolean} False when a consumer vetoed `beforeHide`, so the caller
	*   can report the snap the panel actually landed on.
	*/
	#dismiss(velocityAway) {
		const _ = this;
		_.#engine.setDismissVelocity(Math.max(0, velocityAway));
		_.#engine.armGestureExit();
		if (_.panel?.hide() === false) {
			_.#engine.cancelGestureExit();
			_.#engine.setDismissVelocity(0);
			_.#settleBack();
			return false;
		}
		return true;
	}
	/**
	* Builds the profile the engine animates against.
	*
	* Called once per profile rebuild — open, resize, profile-affecting attribute
	* change — and never per frame, which is what makes it safe to measure CSS
	* here alongside the snap probe.
	* @returns {Object} Resolved profile.
	*/
	#resolveProfile() {
		const _ = this;
		const desktop = window.innerWidth >= _.breakpoint;
		const mode = desktop ? _.desktopMode : _.mode;
		return {
			desktop,
			position: desktop ? _.desktopPosition : _.position,
			mode,
			effect: desktop ? _.desktopEffect : _.effect,
			exitEffect: desktop ? _.desktopExitEffect : _.exitEffect,
			edgeInset: mode === "card" ? _.#probeLength("--sheet-card-margin", "12px") : 0,
			exitCushion: _.#probeLength("--sheet-exit-cushion", `28px`, 28),
			viewportWidth: window.innerWidth,
			viewportHeight: window.innerHeight
		};
	}
	#profileKey(profile) {
		return `${profile.desktop}:${profile.position}:${profile.mode}`;
	}
	#prepareOpen() {
		const _ = this;
		if (!_.#engine) return;
		const previous = _.#profile;
		const profile = _.#resolveProfile();
		_.#applyProfile(profile);
		if (!resizesWithSnaps(profile)) _.#syncActiveSize(0);
		const snaps = _.#measureSnaps(profile);
		const requestedIndex = resolveInitialSnap(_.getAttribute("initial-snap"), snaps);
		if (profile.desktop) {
			_.#snaps = [snaps[snaps.length - 1]];
			_.#engine.setSnaps(_.#snaps, 0);
		} else {
			_.#snaps = snaps;
			const activeIndex = _.panel?.isOpen && !!previous && resizesWithSnaps(previous) ? _.#engine.activeSnap : requestedIndex;
			_.#engine.setSnaps(_.#snaps, Math.min(activeIndex, _.#snaps.length - 1));
		}
		_.#syncActiveSize(_.#engine.activeSnap);
		_.#syncContentObserver();
	}
	#flushPendingProfile() {
		const _ = this;
		if (!_.#pendingProfile) return;
		_.#pendingProfile = null;
		const next = _.#resolveProfile();
		if (_.#profile && _.#profileKey(next) !== _.#profileKey(_.#profile)) {
			_.#morphToProfile();
			return;
		}
		_.#applyProfile(next);
		_.#prepareOpen();
	}
	/**
	* Keeps a ResizeObserver on the dialog only while an open CONTENT-SIZED
	* profile is active — a centered dialog, or a bottom panel past the
	* breakpoint. Their resting height is their content's, so a content reflow
	* changes the extent every drag threshold and exit runway is computed from,
	* and nothing else re-measures while the panel simply sits open.
	*
	* This only works because neither profile lets the engine pin a pixel height:
	* `restStyles` emits a size property for a snap-resized bottom sheet alone, so
	* the dialog's own box genuinely tracks `height: fit-content` and the observer
	* has something to see. See resizesWithSnaps() in sheet-engine.js.
	*/
	#syncContentObserver() {
		const _ = this;
		const want = !!_.#profile && contentSized(_.#profile) && !!_.panel?.isOpen && typeof ResizeObserver === "function";
		if (want && !_.#contentObserver && _.#dialogRef) {
			_.#contentObserver = new ResizeObserver(() => _.#scheduleContentRemeasure());
			_.#contentObserver.observe(_.#dialogRef);
		} else if (!want && _.#contentObserver) {
			_.#contentObserver.disconnect();
			_.#contentObserver = null;
			clearTimeout(_.#contentRemeasureTimer);
			_.#contentRemeasureTimer = null;
		}
	}
	/**
	* Debounced content re-measure. Never reconfigures under a live finger, a
	* morph, or a running entrance/exit — it re-arms instead and lands once the
	* engine is parked at rest. The 1px tolerance is what stops an
	* observer/remeasure loop on fractional layouts, and it also swallows the
	* observer's initial fire on observe().
	*/
	#scheduleContentRemeasure() {
		const _ = this;
		clearTimeout(_.#contentRemeasureTimer);
		_.#contentRemeasureTimer = setTimeout(() => {
			_.#contentRemeasureTimer = null;
			if (!_.#profile || !contentSized(_.#profile) || !_.panel?.isOpen) return;
			if (_.#drag.active || _.#morph !== null || _.#engine?.state !== "shown") {
				_.#scheduleContentRemeasure();
				return;
			}
			const height = _.#measureBox(_.#profile).height;
			if (Math.abs(height - (_.#snaps[0] ?? 0)) <= 1) return;
			_.#prepareOpen();
		}, RESIZE_THROTTLE_MS);
	}
	/**
	* Publishes the CSS resting size.
	*
	* A snap-resized bottom sheet tracks the active snap height. Every other
	* profile leaves the token entirely to CSS: a side sheet's fallback supplies
	* its one fixed width, and a centered dialog — or a bottom panel past the
	* breakpoint — is sized by its own content through `height: fit-content`.
	* Publishing a measured number for those would put a value in a slot nothing
	* reads, and for a side profile it would feed a height into a width slot.
	* @param {number} activeIndex - Active snap index.
	*/
	#syncActiveSize(activeIndex) {
		const _ = this;
		const size = resizesWithSnaps(_.#profile) ? _.#snaps[activeIndex] : null;
		if (!size) {
			_.style.removeProperty("--sheet-active-size");
			_.#dialogRef?.style.removeProperty("--sheet-active-size");
			return;
		}
		_.style.setProperty("--sheet-active-size", `${size}px`);
		_.#dialogRef?.style.setProperty("--sheet-active-size", `${size}px`);
	}
	/**
	* Mirrors motion onto the panel as CSS custom properties.
	*
	* `--sheet-progress` reports exactly what the engine painted, because it goes
	* through the same `paintedProgress()` the engine's `#applyFrame` paints by:
	* flight phases floor at 0, landed linear tracks may continue below it, and
	* only a non-bottom profile is capped at 1 because its track is refused any
	* paint past flush. A bottom sheet's overshoot past 1 is the intended settling
	* breath and flows through. `--sheet-backdrop-progress`
	* drives the overlay and follows the dismissal zone instead, so
	* snap-to-snap travel and rubber-band overscroll leave it untouched and it
	* always stays in [0, 1]. Both are written in the same call the engine
	* applied panel styles in, so the overlay can never desync from the panel.
	* @param {number} progress - Raw frame progress; overshoots past 1 for a
	*   bottom profile, matching what was painted.
	* @param {number} [backdropProgress] - Dismissal-zone progress in [0, 1].
	* @param {string} [phase] - Motion phase governing lower extrapolation.
	*/
	#setProgress(progress, backdropProgress = progress, phase) {
		const _ = this;
		if (!_.#panelRef) return;
		const clamp01 = (value) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
		const value = Number.isFinite(progress) ? progress : 0;
		const position = _.#profile?.position;
		const painted = position ? paintedProgress(position, value, phase) : clamp01(value);
		_.#panelRef.style.setProperty("--sheet-progress", painted.toFixed(3));
		_.#panelRef.style.setProperty("--sheet-backdrop-progress", clamp01(backdropProgress).toFixed(3));
	}
	#applyProfile(profile) {
		const _ = this;
		_.#profile = profile;
		_.dataset.position = profile.position;
		_.dataset.mode = profile.mode;
		_.dataset.desktop = String(profile.desktop);
		_.dataset.effect = profile.effect;
		_.#engine?.setProfile(profile);
	}
	#measureSnaps(profile) {
		const _ = this;
		if (contentSized(profile)) return [_.#measureBox(profile).height || window.innerHeight * .5];
		if (profile.position !== "bottom") {
			const cssFallback = "min(26rem, 90vw)";
			const pixelFallback = Math.min(416, window.innerWidth * .9);
			const active = () => _.#probeLength("--sheet-active-size", cssFallback, pixelFallback);
			if (!(profile.desktop && profile.mode === "card")) return [active()];
			const cap = _.#probeLength("--sheet-desktop-panel-width", cssFallback, pixelFallback);
			return [_.#tokenIsSet("--sheet-active-size") ? Math.min(active(), cap) : cap];
		}
		const dimension = "height";
		const viewportSize = window.innerHeight;
		const probe = document.createElement("div");
		Object.assign(probe.style, {
			position: "fixed",
			visibility: "hidden",
			pointerEvents: "none",
			inset: "0 auto auto 0",
			boxSizing: "border-box"
		});
		document.body.append(probe);
		const measure = (token) => {
			probe.style[dimension] = "";
			probe.style[dimension] = token;
			return probe.getBoundingClientRect()[dimension];
		};
		const snaps = resolveSnapPoints(_.snapPoints, {
			viewportHeight: window.innerHeight,
			viewportWidth: window.innerWidth,
			rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
			percentageBase: viewportSize,
			measure
		});
		probe.remove();
		return snaps.length ? snaps : [viewportSize * .85];
	}
	/**
	* Measures the dialog's real laid-out box under an arbitrary profile.
	*
	* Both consumers need a number CSS alone will not hand over: a centered
	* dialog's dismiss extent is its intrinsic height, and the profile morph
	* needs the destination rect before it can transition toward it. Reading it
	* off the live element is the only honest way to get either, because both
	* depend on content.
	*
	* The profile's `data-*` attributes are applied, the box is read, and the
	* previous attributes are restored — all synchronously. Style changes are not
	* painted until the next frame boundary, so no flicker is possible even
	* though the element genuinely carries the other profile's geometry for the
	* duration of the call.
	*
	* A closed dialog needs a temporary `display`/`visibility` pair to be
	* measurable at all. That mirrors what SheetEngine already does during the
	* closed-dialog flight, and the stylesheet gives the dialog `position: fixed`
	* under a `[state]` selector that is always present — so the box it reports
	* is the real one, not an in-flow approximation. Transform is neutralised for
	* every measurement because getBoundingClientRect includes it: otherwise a
	* resize during a fade-scale entrance would publish the 0.95-scaled height as
	* the profile's intrinsic resting size.
	* @param {Object} profile - Profile to measure under.
	* @returns {{top: number, left: number, width: number, height: number,
	*   borderRadius: string}} The laid-out box.
	*/
	#measureBox(profile) {
		const _ = this;
		const dialog = _.dialog;
		if (!dialog) return {
			top: 0,
			left: 0,
			width: 0,
			height: 0,
			borderRadius: "0px"
		};
		const previous = {
			position: _.dataset.position,
			mode: _.dataset.mode,
			desktop: _.dataset.desktop
		};
		const closed = !dialog.open;
		const savedDisplay = dialog.style.display;
		const savedVisibility = dialog.style.visibility;
		const savedTransform = dialog.style.transform;
		_.dataset.position = profile.position;
		_.dataset.mode = profile.mode;
		_.dataset.desktop = String(profile.desktop);
		if (closed) {
			dialog.style.display = "flex";
			dialog.style.visibility = "hidden";
		}
		dialog.style.transform = "none";
		const box = _.#readBox(dialog);
		dialog.style.transform = savedTransform;
		if (closed) {
			dialog.style.display = savedDisplay;
			dialog.style.visibility = savedVisibility;
		}
		for (const [key, value] of Object.entries(previous)) if (value === void 0) delete _.dataset[key];
		else _.dataset[key] = value;
		return box;
	}
	/**
	* Resolves a CSS length token to pixels with a hidden fixed-position probe.
	*
	* Every token that reaches here is consumer-overridable and may be any CSS
	* length — a calc(), a rem, a viewport unit — so they are probed rather than
	* parsed. Called once per profile rebuild (open, resize, profile-affecting
	* attribute change) and never per frame, which is what makes touching layout
	* here acceptable.
	*
	* Read off the dialog rather than the sheet-panel, because the dialog is the
	* element the stylesheet's geometry rules apply to and therefore where a
	* consumer overriding one of these will have put it. The desktop card width
	* used to read `this` instead, which quietly missed an override set on the
	* dialog; all four now agree.
	* @param {string} name - Custom property name.
	* @param {string} cssFallback - Length to use when the token is unset.
	* @param {number} [pixelFallback=0] - Value to use when the probe measures nothing.
	* @returns {number} Length in pixels.
	*/
	/**
	* Whether a custom property actually carries a value here.
	*
	* `#probeLength` cannot answer this — it folds an absent token into its
	* fallback, which is exactly the right behaviour for a single-term width and
	* exactly the wrong one for a `min()` whose two terms have different
	* fallbacks. Read off the dialog for the same reason `#probeLength` is: that
	* is the element the geometry rules apply to, so it is where a consumer
	* overriding one will have put it.
	* @param {string} name - Custom property name.
	* @returns {boolean} True when the property resolves to a non-empty value.
	*/
	#tokenIsSet(name) {
		const _ = this;
		return getComputedStyle(_.dialog || _).getPropertyValue(name).trim() !== "";
	}
	#probeLength(name, cssFallback, pixelFallback = 0) {
		const _ = this;
		const token = getComputedStyle(_.dialog || _).getPropertyValue(name).trim() || cssFallback;
		const probe = document.createElement("div");
		Object.assign(probe.style, {
			position: "fixed",
			visibility: "hidden",
			pointerEvents: "none"
		});
		probe.style.width = token;
		if (probe.style.width === "") return pixelFallback;
		document.body.append(probe);
		const pixels = probe.getBoundingClientRect().width;
		probe.remove();
		return pixels;
	}
	/** Pushes any `spring` attribute override down to the engine. */
	#syncSpring() {
		this.#engine?.setSpring(SheetPanel.parseSpring(this.getAttribute("spring")));
	}
	#handleResize() {
		const _ = this;
		if (window.innerWidth > _.maxDisplayWidth && _.panel?.isOpen) {
			_.hide();
			return;
		}
		const next = _.#resolveProfile();
		if (_.#engine?.blobFlight) {
			_.#pendingProfile = true;
			return;
		}
		if (_.#engine?.state === "hiding") return;
		if (_.#profile && _.#profileKey(next) !== _.#profileKey(_.#profile) && _.panel?.isOpen) {
			_.#morphToProfile();
			return;
		}
		if (_.#drag.active) return;
		if (_.#engine?.morphing) {
			_.#morphToProfile();
			return;
		}
		_.#applyProfile(next);
		_.#prepareOpen();
	}
	#usableTriggerBox(trigger) {
		const _ = this;
		if (!(trigger instanceof Element) || !trigger.isConnected) return null;
		if ((_.#engine?.state ?? "hidden") === "hidden" && !triggerIsVisible(trigger)) return null;
		const box = _.#readBox(trigger);
		if (box.width <= 0 || box.height <= 0) return null;
		if (box.left >= window.innerWidth || box.top >= window.innerHeight || box.left + box.width <= 0 || box.top + box.height <= 0) return null;
		return box;
	}
	#blobZIndex() {
		const raw = getComputedStyle(this.#dialogRef || this).getPropertyValue("--sheet-blob-z-index").trim();
		const value = Number.parseFloat(raw);
		return Number.isFinite(value) ? value : 1002;
	}
	#waitForMorph(dialog, duration) {
		const _ = this;
		const settle = () => _.#finishMorph();
		_.#morph = {
			dialog,
			onEnd: (event) => {
				if (event.target === dialog && MORPH_TRANSITION_PROPERTIES.includes(event.propertyName)) settle();
			},
			timer: setTimeout(settle, duration + MORPH_TIMEOUT_PADDING_MS)
		};
		dialog.addEventListener("transitionend", _.#morph.onEnd);
	}
	/**
	* Morphs an open panel between two profile geometries.
	*
	* The two resting geometries share almost no CSS: `inset: auto 0 0` with a
	* pixel height, versus `inset: 12px 12px 12px auto` with an intrinsic one,
	* versus `inset: 0` with `margin: auto`. CSS cannot interpolate `auto` for
	* `top`, `height` or `margin`, so transitioning those declarations directly
	* snaps rather than morphs. (`interpolate-size: allow-keywords` would fix the
	* height case, but it is Chromium-only.)
	*
	* So this is a FLIP measure: read the live box, apply the new profile, read
	* the destination box, pin back to the first set of numbers, then transition
	* between two sets of plain pixels. `transform` and `opacity` stay at their
	* rest values throughout so they never fight the pinned box — the engine is
	* parked for the duration and repaints only once the pins are gone.
	*
	* The panel never closes: no `beforeHide`, no `hidden`, no focus return, and
	* the dialog stays in the top layer the whole way across.
	*
	* The destination is whatever #prepareOpen resolves, so callers only have to
	* decide THAT a morph is warranted, never what to morph to.
	*/
	#morphToProfile() {
		const _ = this;
		const dialog = _.#dialogRef;
		if (_.#engine?.state === "hiding") return;
		if (!dialog || !_.#engine) {
			_.#prepareOpen();
			return;
		}
		const wasMorphing = _.#morph !== null;
		if (wasMorphing) _.#clearMorphTimers();
		_.#drag = { active: false };
		if (!wasMorphing && !_.#engine.beginMorph()) {
			_.#prepareOpen();
			return;
		}
		if (_.#morphInline === null) {
			const engineOwnsHeight = _.#profile ? resizesWithSnaps(_.#profile) : false;
			_.#morphInline = {};
			for (const property of MORPH_PROPERTIES) {
				const owned = engineOwnsHeight && property === "height";
				_.#morphInline[property] = owned ? "" : dialog.style[property] ?? "";
			}
		}
		const from = _.#readBox(dialog);
		_.#stripMorphPins(dialog);
		_.#prepareOpen();
		const to = _.#readBox(dialog);
		const duration = _.#morphDuration(dialog);
		if (duration <= 0) {
			_.#finishMorph();
			return;
		}
		_.#pinBox(dialog, from);
		dialog.offsetWidth;
		dialog.style.transition = MORPH_TRANSITION_PROPERTIES.map((property) => `${property} ${duration}ms var(--sheet-morph-easing, ease-out)`).join(", ");
		_.#pinBox(dialog, to);
		_.#waitForMorph(dialog, duration);
	}
	/**
	* Strips the morph scaffolding and hands the panel back to the engine.
	*
	* Safe to call at any point: the timeout and transition listener are always
	* removed before the engine resumes painting.
	*/
	#finishMorph() {
		const _ = this;
		_.#clearMorphTimers();
		_.#releaseMorphPins();
		if (!_.#engine?.morphing) return;
		_.#engine?.endMorph();
		_.#setProgress(1, 1);
	}
	#clearMorphTimers() {
		const _ = this;
		if (!_.#morph) return;
		clearTimeout(_.#morph.timer);
		_.#morph.dialog.removeEventListener("transitionend", _.#morph.onEnd);
		_.#morph = null;
	}
	#clearScrimPressTimer() {
		const _ = this;
		if (_.#scrimPressTimer === null) return;
		clearTimeout(_.#scrimPressTimer);
		_.#scrimPressTimer = null;
	}
	#readBox(element) {
		const rect = element.getBoundingClientRect();
		return {
			top: rect.top,
			left: rect.left,
			width: rect.width,
			height: rect.height,
			borderRadius: getComputedStyle(element).borderRadius
		};
	}
	/**
	* Pins the dialog to an explicit pixel box.
	*
	* `right`/`bottom`/`margin` are neutralised rather than left alone: the
	* stylesheet sets them per position, and a surviving `bottom: 0` would fight
	* the `top` being animated.
	* @param {HTMLElement} dialog - Dialog to pin.
	* @param {Object} box - Box from #readBox.
	*/
	#pinBox(dialog, box) {
		Object.assign(dialog.style, {
			top: `${box.top}px`,
			left: `${box.left}px`,
			right: "auto",
			bottom: "auto",
			width: `${box.width}px`,
			height: `${box.height}px`,
			maxWidth: "none",
			maxHeight: "none",
			margin: "0",
			borderRadius: box.borderRadius
		});
	}
	/**
	* Unpins the dialog back to whatever inline geometry the consumer had.
	*
	* Restores rather than blanks: the pins are written onto the same inline
	* properties a consumer may already have set, so blanking them silently
	* deleted the consumer's styles at the end of every profile morph. With no
	* snapshot taken — teardown before any morph ran — blanking is still the
	* right answer, since only a pin could have put a value there.
	*
	* Deliberately does NOT clear the snapshot: #morphToProfile strips mid-FLIP
	* to measure the destination box against the consumer's real geometry, and
	* the same snapshot has to survive to the strip that ends the run.
	* @param {HTMLElement} dialog - Dialog to unpin.
	*/
	#stripMorphPins(dialog) {
		const saved = this.#morphInline;
		for (const property of MORPH_PROPERTIES) dialog.style[property] = saved?.[property] ?? "";
	}
	/**
	* Unpins and releases the snapshot — every path that ends a FLIP.
	*
	* A null snapshot means no FLIP ever pinned: #pinBox and the inline
	* transition are both downstream of the snapshot block, so there is nothing
	* to strip and the write would only blank inline styles the consumer owns.
	* #finishMorph runs on every beforeHide and hidden, morph or not, which is
	* exactly how often that blank used to land.
	*/
	#releaseMorphPins() {
		const _ = this;
		if (_.#morphInline === null) return;
		if (_.#dialogRef) _.#stripMorphPins(_.#dialogRef);
		_.#morphInline = null;
	}
	/**
	* Resolves a CSS duration token to milliseconds.
	*
	* The reduced-motion CSS declaration can lose the cascade to a later or more
	* specific consumer token. Reading the preference here too prevents that
	* override from restoring motion the user asked not to see — which is why
	* every duration token in this component routes through one parser rather
	* than a second copy of this parse.
	* @param {HTMLElement} element - Element carrying the token.
	* @param {string} name - Custom property name.
	* @param {number} fallback - Milliseconds used when the token will not parse.
	* @returns {number} Duration in milliseconds.
	*/
	#durationToken(element, name, fallback) {
		if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return 0;
		const raw = getComputedStyle(element).getPropertyValue(name).trim();
		const zero = raw.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i);
		if (zero && Number(zero[1]) === 0) return 0;
		const match = raw.match(/^([+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?)(ms|s)$/i);
		if (!match) return fallback;
		const value = Number(match[1]);
		if (!Number.isFinite(value)) return fallback;
		return match[2].toLowerCase() === "ms" ? value : value * 1e3;
	}
	/**
	* Resolves the morph duration in milliseconds from the CSS token. Governs both
	* the profile FLIP and the trigger blob's arm gate.
	* @param {HTMLElement} dialog - Dialog carrying the token.
	* @returns {number} Duration in milliseconds.
	*/
	#morphDuration(dialog) {
		return this.#durationToken(dialog, "--sheet-morph-duration", 600);
	}
	/**
	* Drops the trigger's return attribute and everything holding it up. The one
	* teardown site — reached by animationend, the safety timeout, a second
	* return, and disconnectedCallback.
	*/
	#clearTriggerReturn() {
		const _ = this;
		const state = _.#triggerReturn;
		if (!state) return;
		_.#triggerReturn = null;
		clearTimeout(state.timer);
		state.trigger.removeEventListener("animationend", state.onEnd);
		state.trigger.removeAttribute("sheet-return");
	}
};
var SheetHeader = class extends HTMLElement {};
var SheetContent = class extends HTMLElement {};
var SheetFooter = class extends HTMLElement {};
if (!customElements.get("sheet-panel")) customElements.define("sheet-panel", SheetPanel);
if (!customElements.get("sheet-header")) customElements.define("sheet-header", SheetHeader);
if (!customElements.get("sheet-content")) customElements.define("sheet-content", SheetContent);
if (!customElements.get("sheet-footer")) customElements.define("sheet-footer", SheetFooter);
//#endregion
export { SheetContent, SheetFooter, SheetHeader, SheetPanel, resolveInitialSnap, resolveSnapPoints, resolveSnapTarget };

//# sourceMappingURL=sheet.esm.js.map