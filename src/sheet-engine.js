import PhysicsEngine from '@magic-spells/physics-engine';
import FrameEngine from '@magic-spells/frame-engine';
import EventEmitter from './event-emitter.js';

// PhysicsEngine integrates once per 60fps frame — its `velocity` is units per
// frame, not per millisecond. DragGesture reports px/ms, so every release
// velocity handed to the spring has to cross this scale first. Getting it wrong
// is silent: the spring still runs, it just settles at ~17x the wrong speed.
const FRAME_MS = 16.66;

// The tracker measures the last stretch of a finger that is already slowing
// into its release, so the number it reports reads slightly slower than the
// throw felt. A small boost hands the spring the intent rather than the
// measurement. Kept separate from FRAME_MS: that one is a unit conversion and
// is not a matter of taste, this one is.
const VELOCITY_BOOST = 1.1;

const TRAVEL = 100;
// Settle epsilons are absolute spring units, so their felt effect scales with
// TRAVEL. At 100 travel these sit at 0.3% / 0.15% of travel — a crisper
// end-of-motion trim than the 0.1% / 0.05% the old 1000 travel gave, while the
// snap-to-end stays ~2px on a full-height sheet, below perception at speed.
const SETTLE_POSITION_EPSILON = 0.3;
const SETTLE_DELTA_EPSILON = 0.15;
const CLAMP_POSITIVE = [
	'width',
	'height',
	'borderTopLeftRadius',
	'borderTopRightRadius',
	'borderBottomRightRadius',
	'borderBottomLeftRadius',
	'borderTopWidth',
	'borderRightWidth',
	'borderBottomWidth',
	'borderLeftWidth',
];
const MANAGED_PROPERTIES = [
	'display',
	'opacity',
	'transform',
	'transformOrigin',
	'willChange',
	'width',
	'height',
];

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
 *   pop         516ms   283ms   1.000  — bounce lives in its keyframes
 *   exit        267ms   133ms   1.000  — leaving is brisker than arriving
 *   snap        566ms   200ms   1.024  — the only phase allowed to breathe
 *   rest        333ms   167ms   1.000
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
const SPRING_PRESETS = {
	entrance: { attraction: 0.055, friction: 0.32 },
	pop: { attraction: 0.055, friction: 0.325 },
	exit: { attraction: 0.3, friction: 0.56 },
	snap: { attraction: 0.065, friction: 0.3 },
	rest: { attraction: 0.15, friction: 0.455 },
};

/** Bounds PhysicsEngine accepts for both dials, exclusive. */
const MIN_SPRING = 0.001;
const MAX_SPRING = 0.999;

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
	if (typeof value !== 'string') return null;
	const parts = value
		.trim()
		.split(/[\s,]+/)
		.filter(Boolean);
	if (parts.length !== 2) return null;
	const [attraction, friction] = parts.map(Number);
	if (!isSpringDial(attraction) || !isSpringDial(friction)) return null;
	return { attraction, friction };
}

/**
 * The three implicit routes out of an open sheet. Every one of them dismisses
 * without the user having chosen anything in particular, which is exactly why a
 * confirm that genuinely requires an answer has to be able to refuse them.
 * Buttons and programmatic `hide()` are not routes here — they are the answer.
 */
const DISMISS_ROUTES = ['swipe', 'backdrop', 'escape'];

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
	if (value === null || value === undefined) return all(true);
	const tokens = String(value)
		.trim()
		.toLowerCase()
		.split(/[\s,]+/)
		.filter(Boolean);
	if (!tokens.length || tokens.includes('none')) return all(false);
	if (tokens.includes('all')) return all(true);
	return Object.fromEntries(DISMISS_ROUTES.map((route) => [route, tokens.includes(route)]));
}

/**
 * Cushion, in pixels, that an exit carries past the panel's own size and inset —
 * enough for the panel, and its shadow, to clear the screen edge, and no
 * further. The exact number is a product decision; 28 clears the default
 * `0 1px 20px -4px` shadow with headroom.
 *
 * It is only the DEFAULT. A consumer whose shadow is softer than the default's
 * needs a longer cushion — a 60px blur is entirely ordinary — so a profile may
 * carry its own `exitCushion`, which the component probes from
 * `--sheet-exit-cushion`. Absent means "use the default", the same optionality
 * contract `edgeInset` has.
 *
 * The runway used to be a whole viewport, which is far more than "off-screen":
 * a 320px side panel on a 1400px screen was gone by p ~ 0.77 while the backdrop
 * kept tracking down to 0, so a from-rest exit left a strong overlay hanging
 * over an empty screen — and an entrance started a viewport away.
 */
const EXIT_CUSHION = 28;

/**
 * Resolves the cushion a profile's exit clears its edge by.
 * @param {Object} profile - Resolved visual profile.
 * @param {number} [profile.exitCushion] - Override in pixels.
 * @returns {number} Cushion in pixels.
 */
function exitCushion(profile) {
	const value = profile.exitCushion;
	return Number.isFinite(value) && value >= 0 ? value : EXIT_CUSHION;
}

/**
 * Percent of the geometry timeline at which a fading effect reaches full
 * opacity, per effect. Finishing the fade early keeps spring overshoot past
 * p=1 from flickering a settled panel back toward transparent, and — because
 * opacity is flat from the reveal frame to the end — keeps opacity out of the
 * overshoot extrapolation entirely. Walking these frames backwards puts the
 * fade-out in the closing tail, which is where an exit wants it.
 */
const REVEAL_PERCENT = { pop: 30 };
const DEFAULT_REVEAL_PERCENT = 55;

/**
 * How far past the destination a snap track carries explicit frames, so spring
 * overshoot interpolates along the correct limb of the floor rule instead of
 * extrapolating the segment it came from.
 */
const REST_OVERSHOOT_PERCENT = 150;

/**
 * Shortest run, in pixels, that a release velocity may be normalised over.
 *
 * A settle with almost no distance to cross has no room to express a flick:
 * dividing by the span scales the velocity by 1/span, and because the settle
 * epsilons are absolute in spring units they then demand sub-micron precision —
 * so the run idles for up to a second after the panel has visually landed.
 */
const MIN_SPRING_SPAN = 1;

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
	if (Math.abs(spanPx) < MIN_SPRING_SPAN) return 0;
	return (velocityPxMs * FRAME_MS * VELOCITY_BOOST * TRAVEL) / spanPx;
}

/**
 * pop's bounce is baked into its keyframes instead of borrowed from spring
 * overshoot: the scale track rises past rest once, then settles. A spring can
 * only overshoot by oscillating, which reads as jelly; a keyframed rise gives
 * exactly one confident bounce and a clean exit when walked in reverse.
 */
const POP_OVERSHOOT_PERCENT = 70;
const POP_OVERSHOOT_SCALE = 1.05;
const POP_ENTER_SCALE = 0.85;
const POP_EXIT_SCALE = 0.9;

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
 * Springs undershoot past the target on a fast dismissal, so the lower end
 * always floors: extrapolating below the hidden frame is meaningless and flips
 * scale negative. The upper end is profile-specific. A bottom sheet's overshoot
 * is the intended settling breath — a height stretch, or a translate below the
 * floor, both of which the snap track carries explicit frames for — so it flows
 * through. A side sheet has no equivalent: it is fixed width and sits against
 * its edge, so every position past flush translates it inward and opens a
 * sliver of backdrop down the side. There is nothing to tune away there — a
 * synthetic frame past 100 would be collinear with the track and change nothing
 * — so the only fix is to refuse it.
 * @param {'bottom'|'left'|'right'|'center'} position - Sheet edge.
 * @param {number} p - Raw frame progress.
 * @returns {number} Progress that may be painted and published.
 */
function paintedProgress(position, p) {
	return Math.max(0, position === 'bottom' ? p : Math.min(1, p));
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
	return position === 'bottom' || position === 'center' ? 'y' : 'x';
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
	if (profile.position === 'center') return true;
	return profile.position === 'bottom' && !!profile.desktop;
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
	return profile.position === 'bottom' && !contentSized(profile);
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
	if (dismissAxis(position) === 'y') return deltaY;
	if (position === 'left') return -deltaX;
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
	if (dismissAxis(position) === 'y') return { x: 0, y: distance };
	return { x: (position === 'left' ? -1 : 1) * distance, y: 0 };
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
	if (profile.position === 'left') return 'left center';
	if (profile.position === 'right') return 'right center';
	if (profile.position === 'center') return 'center center';
	return 'center bottom';
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
	const base = { opacity: '1', transformOrigin: transformOrigin(profile) };
	if (resizesWithSnaps(profile)) {
		const paintedSize = Math.max(size, lowestSize);
		const shift = Math.max(0, lowestSize - size);
		return {
			...base,
			height: `${paintedSize}px`,
			transform: `translate3d(0px, ${shift}px, 0px) scale(1)`,
		};
	}
	const shift = restSize - size;
	if (dismissAxis(profile.position) === 'y') {
		return { ...base, transform: `translate3d(0px, ${shift}px, 0px) scale(1)` };
	}
	return {
		...base,
		transform: `translate3d(${(profile.position === 'left' ? -1 : 1) * shift}px, 0px, 0px) scale(1)`,
	};
}

/**
 * Numeric motion values for the hidden or shown end of an open/close run.
 * @param {Object} profile - Resolved visual profile.
 * @param {number} [profile.edgeInset=0] - Pixels the panel rests from its screen
 *   edge; a slide clears it on top of the panel's own size.
 * @param {Object} options - Frame options.
 * @param {number} options.size - Live size in pixels along the dismiss axis.
 * @param {boolean} options.hidden - True for the off-screen end of the run.
 * @param {boolean} [options.exiting] - True when building a closing run.
 * @returns {{x: number, y: number, scale: number, opacity: number}} Motion values.
 */
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
	if (profile.position === 'center') {
		return Math.max(0, ((profile.viewportHeight || 0) - size) / 2);
	}
	return profile.edgeInset ?? 0;
}

function effectValues(profile, { size, hidden, exiting = false, floorDistance = 0 }) {
	const { effect, position } = profile;
	let distance = 0;
	let scale = 1;
	let opacity = 1;

	if (hidden && effect === 'slide') {
		// Off-screen is the panel's own extent plus whatever gap it already sits
		// from the edge, plus a cushion — not a viewport.
		//
		// A zero size already clears the cushion, so the floor of 1 is there for a
		// NEGATIVE one, which is reachable: the component rubber-bands a pull past
		// the closed edge to about -2*sqrt(overpull) — roughly -68px on a hard one
		// — and a profile rebuild during that drag (setProfile, off the resize
		// path) hands that live size straight to #makeOpenFrames. Without the
		// floor the runway would point back toward rest.
		distance = Math.max(size + slideInset(profile, size) + exitCushion(profile), 1);
	}
	if (hidden && effect === 'slide-fade') {
		distance = 24;
		opacity = 0;
	}
	if (hidden && effect === 'fade-scale') {
		scale = 0.95;
		opacity = 0;
	}
	if (hidden && effect === 'pop') {
		scale = exiting ? POP_EXIT_SCALE : POP_ENTER_SCALE;
		opacity = 0;
	}
	// The floor an exit continuing a live drag imposes — see buildExitKeyframes.
	// It is 0 for every other caller, so it cannot reach a track that has not
	// asked for it.
	if (hidden) distance = Math.max(distance, floorDistance);

	// The axis question, asked once, through the shared vector. A centered dialog
	// travels vertically like a bottom sheet — `slide` drops it away downward —
	// while left/right travel horizontally. How FAR it travels is a separate
	// question again: see slideInset.
	return { ...awayVector(position, distance), scale, opacity };
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
	};
}

/**
 * Motion styles for the hidden or shown end of an open/close run.
 * @param {Object} profile - Resolved visual profile.
 * @param {Object} options - Frame options, as accepted by effectValues.
 * @returns {Object} Keyframe styles.
 */
function effectStyles(profile, options) {
	return styleFromValues(profile, effectValues(profile, options));
}

/**
 * Assembles a track from two sets of motion values, plus whatever intermediate
 * frames the effect asks for. Shared by the entrance and the exit so the two
 * cannot drift apart on the details below.
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
 * @param {Object} options - Assembly options.
 * @param {string} options.effect - Effect governing the intermediate frames.
 * @param {boolean} [options.exiting] - True when building a closing run, which
 *   drops pop's bounce frame so the track stays monotonic.
 * @returns {Object} Percent-keyed keyframes.
 */
function assembleKeyframes(profile, restFrame, from, to, { effect, exiting = false }) {
	const frame = (values) => ({ ...restFrame, ...styleFromValues(profile, values) });
	const at = (percent, overrides) => {
		const factor = percent / 100;
		const lerp = (a, b) => a + (b - a) * factor;
		return frame({
			x: lerp(from.x, to.x),
			y: lerp(from.y, to.y),
			scale: lerp(from.scale, to.scale),
			opacity: lerp(from.opacity, to.opacity),
			...overrides,
		});
	};

	const keyframes = { 0: frame(from), 100: frame(to) };

	// Only the entrance carries the bounce; the exit walks a monotonic track.
	if (effect === 'pop' && !exiting) {
		keyframes[POP_OVERSHOOT_PERCENT] = at(POP_OVERSHOOT_PERCENT, {
			scale: POP_OVERSHOOT_SCALE,
			opacity: to.opacity,
		});
	}

	if (from.opacity !== to.opacity) {
		const reveal = REVEAL_PERCENT[effect] ?? DEFAULT_REVEAL_PERCENT;
		keyframes[reveal] = at(reveal, { opacity: to.opacity });
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
	const from = effectValues(profile, { size, hidden: true });
	const to = {
		...awayVector(profile.position, awayTranslation(profile, size, restSize, lowestSize)),
		scale: 1,
		opacity: 1,
	};
	return assembleKeyframes(profile, restStyles(profile, size, restSize, lowestSize), from, to, {
		effect: profile.effect,
	});
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
	const away = awayTranslation(profile, size, restSize, lowestSize);
	const hidden = effectValues(
		{ ...profile, effect },
		{
			size: paintedExtent(profile, size, restSize, lowestSize),
			hidden: true,
			exiting: true,
			// An exit must never end closer to rest than the pose it started from:
			// when it starts displaced it ends at least one cushion further out.
			//
			// The `away > 0` guard is load-bearing. From rest there is no
			// displacement and so no floor — without the guard every fade-scale and
			// pop exit would acquire a cushion of stray drift, and those effects
			// scale down IN PLACE. It also subsumes the old negative-size guard:
			// #applyLiveOffset rubber-bands an overpull to about -68px, and `away`
			// then exceeds the slide runway on its own, so this is what keeps the
			// runway pointing away from rest rather than back toward it.
			floorDistance: away > 0 ? away + exitCushion(profile) : 0,
		}
	);
	return {
		away,
		hidden,
		hiddenAway: awayOffset(profile.position, hidden.x, hidden.y),
		live: { ...awayVector(profile.position, away), scale: 1, opacity: 1 },
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
	const resolved = effect || profile.effect;
	const { live, hidden } = exitValues(profile, size, restSize, lowestSize, resolved);
	// The rest frame pins the painted height for the whole run — a bottom sheet
	// dragged below its floor exits at that floor's height, exactly as the drag
	// track paints it — and supplies the transform-origin every frame shares.
	return assembleKeyframes(profile, restStyles(profile, size, restSize, lowestSize), hidden, live, {
		effect: resolved,
		exiting: true,
	});
}

/**
 * Pixel distance an exit run covers, for velocity normalisation.
 *
 * A translating exit covers the runway it has left. One that does not translate —
 * `fade-scale`, `pop` — still crosses the panel's own visible extent by making it
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
 * @returns {number} Exit progress in [0, 1], or 0 for a non-sliding effect.
 */
function exitClearProgress(profile, size, restSize, lowestSize = 0, effect = profile.effect) {
	if (effect !== 'slide') return 0;
	const extent = paintedExtent(profile, size, restSize, lowestSize);
	const { away, hiddenAway } = exitValues(profile, size, restSize, lowestSize, effect);
	const travel = hiddenAway - away;
	if (travel <= 0) return 0;
	const clearAway = extent + slideInset(profile, extent);
	return clamp((hiddenAway - clearAway) / travel, 0, 1);
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
		100: restStyles(profile, activeSize, restSize, lowestSize),
	};
	if (profile.position === 'bottom' && lowestSize > 0 && lowestSize < activeSize) {
		keyframes[(lowestSize / activeSize) * 100] = restStyles(
			profile,
			lowestSize,
			restSize,
			lowestSize
		);
	}
	if (maxSize > activeSize && activeSize > 0) {
		keyframes[(maxSize / activeSize) * 100] = restStyles(profile, maxSize, restSize, lowestSize);
	} else if (profile.position === 'bottom' && activeSize > 0 && lowestSize >= activeSize) {
		// When the active snap IS the floor, the whole 0→100 track is translation
		// and nothing above 100 carries a height ramp — extrapolated overscroll
		// would lift the sheet off the bottom edge instead of stretching it. A
		// synthetic upper frame restores the ramp at the same slope the height
		// track has everywhere else.
		keyframes[150] = restStyles(profile, activeSize * 1.5, restSize, lowestSize);
	}
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
	if (profile.position !== 'bottom') return {};
	const keyframes = {
		0: restStyles(profile, fromSize, restSize, lowestSize),
		100: restStyles(profile, toSize, restSize, lowestSize),
	};
	const span = toSize - fromSize;
	if (span === 0) return keyframes;

	// `restStyles` is piecewise-linear in size with exactly one bend, at the
	// floor. Locate that bend wherever it lands on this segment's timeline
	// rather than assuming it falls inside it: a settle whose spring breathes
	// past its destination crosses the floor ABOVE 100, and a track with no
	// frame there extrapolates the wrong limb — shrinking the height below the
	// floor on a downward settle, and driving translateY negative (lifting the
	// sheet off the bottom edge) on an upward one.
	//
	// Direction fixes the sign, so the branches are provable rather than
	// empirical: every snap is >= the lowest, so a downward settle always puts
	// the floor at or above 100, and an upward settle from at/above the floor
	// always puts it at or below 0.
	const floorPercent = ((lowestSize - fromSize) / span) * 100;
	if (floorPercent > 0 && floorPercent !== 100) {
		keyframes[floorPercent] = restStyles(profile, lowestSize, restSize, lowestSize);
	}

	// A terminus past the last bend, so overshoot interpolates along the right
	// limb instead of extrapolating. Frames above 100 can never affect the
	// settled track — FrameEngine interpolates between the bracketing pair.
	const endPercent =
		floorPercent > 100 ? floorPercent + REST_OVERSHOOT_PERCENT - 100 : REST_OVERSHOOT_PERCENT;
	keyframes[endPercent] = restStyles(
		profile,
		fromSize + span * (endPercent / 100),
		restSize,
		lowestSize
	);
	return keyframes;
}

function normalizeSnaps(snaps) {
	return [
		...new Set(
			snaps
				.map(Number)
				.filter((value) => Number.isFinite(value) && value > 0)
				.sort((a, b) => a - b)
		),
	];
}

/**
 * Spring transport for dialog-panel and the motion engine behind sheet-panel.
 *
 * It implements dialog-panel's duck-typed `{show, hide, state, on, off}` seam,
 * plus snap and live-drag controls used by the host component.
 */
class SheetEngine extends EventEmitter {
	#spring;
	#frames = null;
	#dialog = null;
	#state = 'hidden';
	#phase = 'hidden';
	#p = 0;
	#profile = {
		position: 'bottom',
		mode: 'edge',
		effect: 'slide',
		edgeInset: 0,
		viewportWidth: 0,
		viewportHeight: 0,
	};
	#snaps = [1];
	#activeSnap = 0;
	#currentSize = 1;
	#display = 'flex';
	#springTarget = 0;
	#lastPosition = 0;
	#settleCount = 0;
	#settleAction = null;
	#pendingDismissVelocity = 0;
	#savedInline = null;
	#backdropProgress = 0;
	#springOverride = null;
	#morphing = false;

	/**
	 * @param {Object} [options] - Spring tuning. Each run retunes the spring
	 *   from SPRING_PRESETS, so these only seed the initial values.
	 * @param {number} [options.attraction=0.07] - Spring attraction.
	 * @param {number} [options.friction=0.52] - Spring friction.
	 */
	constructor({
		attraction = SPRING_PRESETS.entrance.attraction,
		friction = SPRING_PRESETS.entrance.friction,
	} = {}) {
		super();
		const _ = this;
		_.#spring = new PhysicsEngine({ attraction, friction });
		_.#spring.on('change', ({ position }) => _.#handleSpringChange(position));
		_.#spring.on('complete', () => _.#settle());
	}

	/**
	 * Declares this a direct engine: it animates the real dialog, visible for
	 * the whole flight. dialog-panel therefore promotes it into the top layer at
	 * show-start (the p=0 frame is painted hidden) and demotes only after the
	 * hidden settle — never on a frame anything visible could repaint.
	 * @returns {boolean} Always true.
	 */
	get animatesDialog() {
		return true;
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
		_.#profile = { ..._.#profile, ...profile };
		// Two ways to stop emitting a height: change position, or cross the
		// breakpoint on `bottom`, where the same position switches from
		// snap-resized to content-sized.
		if (
			_.#profile.position !== previous.position ||
			resizesWithSnaps(_.#profile) !== resizesWithSnaps(previous)
		) {
			_.#clearManagedSize();
		}
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
		if (!_.#dialog || _.#morphing) return;
		_.#dialog.style.width = '';
		_.#dialog.style.height = '';
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
		if (!_.#dialog || _.#morphing) return;
		if (_.#state !== 'shown' && _.#state !== 'showing') return;
		if (_.#state === 'shown') _.#p = 1;
		_.#frames = _.#makeOpenFrames(_.#currentSize);
		_.#applyFrame(_.#p);
	}

	/** @returns {boolean} True while a host-driven profile morph owns the dialog. */
	get morphing() {
		return this.#morphing;
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
		if (_.#state !== 'shown' || _.#morphing || !_.#dialog) return false;
		if (_.#spring.isAnimating) _.#spring.stop();

		_.#currentSize = _.#restSize();
		_.#p = 1;
		_.#frames = _.#makeOpenFrames(_.#currentSize);
		_.#applyFrame(1);

		_.#morphing = true;
		_.#phase = 'morphing';
		_.#settleAction = null;
		// Held for the duration. The panel is fully on screen the whole way
		// across, so recomputing the dismissal zone against a changing rest size
		// would blink the overlay mid-morph.
		_.#backdropProgress = 1;
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
		_.#phase = _.#state === 'shown' ? 'shown' : _.#phase;
		_.#currentSize = _.#restSize();
		_.#p = 1;
		if (_.#dialog && _.#state === 'shown') {
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
		if (_.#profile.position !== 'bottom') snaps = [snaps[snaps.length - 1]];

		_.#landPendingSettle();
		_.#snaps = snaps;
		const requestedIndex = Number.isFinite(activeIndex)
			? Math.trunc(activeIndex)
			: snaps.length - 1;
		_.#activeSnap = clamp(requestedIndex, 0, snaps.length - 1);
		// Every state but `'hiding'` takes the new resting size. A dismissal is the
		// one run whose live size is not the active snap — it is wherever the finger
		// let go — and `beforeShow` fires `#prepareOpen()` through here while the
		// exit is still in flight, so writing it there would clobber the pose the
		// reversal has to start from.
		if (_.#state !== 'hiding') _.#currentSize = snaps[_.#activeSnap];

		_.#rebuildOpenTrack();
	}

	/**
	 * Opens the dialog through the dialog-panel engine transport.
	 * @param {Object} options - Transport values supplied by dialog-panel.
	 * @param {HTMLElement} options.to - Dialog element to animate.
	 * @param {string} [options.display='flex'] - Display value during closed-dialog flight.
	 * @returns {Promise<boolean>} Resolves when the run settles or is superseded.
	 */
	show({ to, display = 'flex' } = {}) {
		const _ = this;
		if (!to) throw new Error('SheetEngine: show() requires a target dialog.');
		if (_.#state === 'shown') return Promise.resolve(false);

		_.#dialog = to;
		_.#display = display || 'flex';
		_.#saveInline();
		_.#prepareDialog();

		if (_.#state === 'hiding') {
			const floorP = paintedProgress(_.#profile.position, _.#p);
			const floorExtent = _.#currentSize * floorP;
			const painted = _.#frames?.getFrame(floorP);
			_.#state = 'showing';
			_.#phase = 'showing';
			_.#currentSize = _.#snaps[_.#activeSnap];
			const open = _.#makeOpenFrames(_.#currentSize);
			// A reversal interpolates from the pose on screen to rest; it cannot borrow
			// the entrance parameterisation: pop's exit drops the bounce, and an exit
			// effect need not translate at all.
			_.#frames = painted ? new FrameEngine({ 0: painted, 100: open.getFrame(1) }) : open;
			_.#p = 0;
			_.#settleAction = {
				type: 'shown',
				backdropFloorExtent: floorExtent,
				progressFloor: floorP,
			};
			_.#applyFrame(0);
			_.#tuneSpring('entrance');
			return _.#animate(0, TRAVEL, 0);
		}
		if (_.#state === 'showing') return Promise.resolve(false);

		_.#tuneSpring('entrance');
		_.#state = 'showing';
		_.#phase = 'showing';
		_.#currentSize = _.#snaps[_.#activeSnap];
		_.#frames = _.#makeOpenFrames(_.#currentSize);
		_.#p = 0;
		_.#applyFrame(0);
		_.#settleAction = { type: 'shown' };
		return _.#animate(0, TRAVEL, 0);
	}

	/**
	 * Hides the dialog. Called during show, this reverses the current spring.
	 * @returns {Promise<boolean>} Resolves when hidden or superseded.
	 */
	hide() {
		const _ = this;
		if (_.#state === 'hidden' || _.#state === 'hiding') return Promise.resolve(false);
		const velocity = _.#pendingDismissVelocity;
		_.#pendingDismissVelocity = 0;

		if (_.#state === 'showing') {
			_.#state = 'hiding';
			_.#phase = 'hiding';
			_.#settleAction = { type: 'hidden' };
			_.#tuneSpring('exit');
			return _.#animate(_.#p * TRAVEL, 0, velocityToSpring(-Math.abs(velocity), _.#restSize()));
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
		if (!_.#dialog || _.#state !== 'shown' || _.#morphing) return;
		if (_.#spring.isAnimating) _.#spring.stop();

		const activeSize = _.#snaps[_.#activeSnap];
		_.#currentSize = activeSize - offsetPx;
		_.#frames = _.#makeDragFrames(activeSize);
		_.#p = activeSize === 0 ? 1 : _.#currentSize / activeSize;
		_.#phase = 'dragging';
		_.#applyFrame(_.#p);
		_.emit('change', {
			progress: _.#p,
			backdropProgress: _.#backdropProgress,
			phase: _.#phase,
		});
	}

	/**
	 * Springs from the live size to a snap point.
	 * @param {number} snapIndex - Destination snap index.
	 * @param {number} [velocityPxMs=0] - Velocity toward larger snap sizes.
	 * @returns {Promise<boolean>} Resolves when the snap settles.
	 */
	settleTo(snapIndex, velocityPxMs = 0) {
		const _ = this;
		if (_.#profile.position !== 'bottom' || !_.#dialog || _.#state !== 'shown') {
			return Promise.resolve(false);
		}
		if (_.#morphing) return Promise.resolve(false);
		const to = clamp(Math.trunc(snapIndex), 0, _.#snaps.length - 1);
		const from = _.#activeSnap;
		const targetSize = _.#snaps[to];
		const startSize = _.#currentSize;

		_.#frames = _.#makeRestFrames(startSize, targetSize);
		_.#p = 0;
		_.#phase = 'snapping';
		_.#settleAction = { type: 'snap', from, to, targetSize, startSize };
		_.#tuneSpring('snap');
		// The segment, not the resting size: this run's keyframes span exactly
		// startSize -> targetSize, and that span is negative on a downward snap.
		return _.#animate(0, TRAVEL, velocityToSpring(velocityPxMs, targetSize - startSize));
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
		if (_.#profile.position === 'bottom' || !_.#dialog || _.#state !== 'shown') {
			return Promise.resolve(false);
		}
		if (_.#morphing) return Promise.resolve(false);

		const targetSize = _.#restSize();
		// The upper clamp discards logical inward overscroll, which is correct
		// ONLY because #applyFrame refuses to paint these profiles past flush: the
		// panel is already sitting at p=1, so starting there matches what is on
		// screen. Without that clamp this would start the spring somewhere the
		// panel is not, and the first frame would teleport it.
		const start = clamp(_.#currentSize / targetSize, 0, 1) * TRAVEL;
		_.#frames = _.#makeDragFrames(targetSize);
		_.#p = start / TRAVEL;
		_.#phase = 'returning';
		_.#settleAction = { type: 'rest', targetSize };
		// Not 'snap': these tracks carry no frame beyond rest, so a breathing
		// spring would translate the panel past flush — opening a gap down the
		// side of a side sheet, and drifting a centered dialog off its middle.
		_.#tuneSpring('rest');
		return _.#animate(start, TRAVEL, velocityToSpring(velocityPxMs, targetSize));
	}

	/**
	 * Springs to the configured exit keyframe and emits `hidden`.
	 * @param {number} [velocityPxMs=0] - Velocity toward the dismiss edge.
	 * @returns {Promise<boolean>} Resolves when hidden.
	 */
	dismiss(velocityPxMs = 0) {
		const _ = this;
		if (!_.#dialog || _.#state === 'hidden') return Promise.resolve(false);
		_.#prepareDialog();
		_.#state = 'hiding';
		_.#phase = 'hiding';

		// One track, whether this continues a live drag or leaves from rest: its
		// 100% frame IS the current pose, so p always starts at 1 and there is no
		// branch left to disagree with itself. See buildExitKeyframes.
		_.#frames = _.#makeExitFrames(_.#currentSize);
		_.#p = 1;
		_.#settleAction = {
			type: 'hidden',
			backdropClearProgress: _.#exitClearProgress(_.#currentSize),
		};
		_.#applyFrame(1);
		_.#tuneSpring('exit');
		// The span is what this run actually covers — never the resting size, which
		// is the distance only a from-rest exit happens to travel.
		return _.#animate(
			TRAVEL,
			0,
			velocityToSpring(-Math.abs(velocityPxMs), _.#exitTravel(_.#currentSize))
		);
	}

	/**
	 * Stops motion, restores inline styles, and notifies dialog-panel.
	 */
	stop() {
		const _ = this;
		if (_.#state === 'hidden') return;
		if (_.#spring.isAnimating) _.#spring.stop();
		_.#state = 'hidden';
		_.#phase = 'hidden';
		_.#p = 0;
		_.#settleAction = null;
		_.#restoreInline();
		_.emit('stop', { progress: 0 });
	}

	/**
	 * Releases spring and event listeners.
	 */
	destroy() {
		const _ = this;
		_.stop();
		_.#spring.removeAllListeners();
		_.removeAllListeners();
	}

	#handleSpringChange(position) {
		const _ = this;
		if (!_.#settleAction) return;
		const p = position / TRAVEL;
		_.#p = p;

		// Size first: the applied frame derives backdrop opacity from it, and a
		// stale size would lag the overlay one frame behind the panel.
		const action = _.#settleAction;
		if (action.type === 'snap') {
			// Clamped to the segment: the spring's breath past p=1 belongs to the
			// keyframes, not to the logical size. Letting it through here pushed
			// the size a fraction below the destination snap, which read as the
			// backdrop dipping under 1 on a settle that never left the snap range.
			const t = clamp(p, 0, 1);
			_.#currentSize = action.targetSize * t + action.startSize * (1 - t);
		}
		if (action.type === 'rest') {
			_.#currentSize = action.targetSize * clamp(p, 0, 1);
		}
		_.#applyFrame(p);
		const progress =
			action.progressFloor === undefined
				? p
				: action.progressFloor + (1 - action.progressFloor) * clamp(p, 0, 1);
		_.emit('change', {
			progress,
			backdropProgress: _.#backdropProgress,
			phase: _.#phase,
		});

		if (
			Math.abs(position - _.#springTarget) < SETTLE_POSITION_EPSILON &&
			Math.abs(position - _.#lastPosition) < SETTLE_DELTA_EPSILON
		) {
			if (++_.#settleCount >= 2) {
				_.#p = _.#springTarget / TRAVEL;
				_.#applyFrame(_.#p);
				_.#spring.stop();
				_.#settle();
				return;
			}
		} else {
			_.#settleCount = 0;
		}
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
			_.#p = target / TRAVEL;
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
		if (!_.#spring.isAnimating || !action || (action.type !== 'snap' && action.type !== 'rest')) {
			return;
		}
		_.#spring.stop();
		_.#settle();
	}

	#settle() {
		const _ = this;
		const action = _.#settleAction;
		if (!action) return;
		_.#settleAction = null;

		if (action.type === 'shown') {
			_.#state = 'shown';
			_.#phase = 'shown';
			_.#p = 1;
			_.#currentSize = _.#snaps[_.#activeSnap];
			_.#frames = _.#makeOpenFrames(_.#currentSize);
			_.#applyFrame(1);
			_.#emitChange();
			_.emit('shown');
			_.#dialog.style.display = _.#savedInline?.display || '';
			return;
		}

		if (action.type === 'snap') {
			_.#activeSnap = action.to;
			_.#currentSize = action.targetSize;
			_.#phase = 'shown';
			_.#p = 1;
			_.#frames = _.#makeOpenFrames(_.#currentSize);
			_.#applyFrame(1);
			_.#emitChange();
			if (action.from !== action.to) {
				_.emit('snapchange', { from: action.from, to: action.to });
			}
			return;
		}

		if (action.type === 'rest') {
			_.#currentSize = action.targetSize;
			_.#phase = 'shown';
			_.#p = 1;
			_.#frames = _.#makeOpenFrames(_.#currentSize);
			_.#applyFrame(1);
			_.#emitChange();
			return;
		}

		_.#state = 'hidden';
		_.#phase = 'hidden';
		_.#p = 0;
		// Restore BEFORE emitting, matching stop(): the hidden emit runs
		// dialog-panel's finalize synchronously, and a listener there may call
		// show() again — restoring afterwards would wipe that new run's freshly
		// painted p=0 frame (and null the inline snapshot it just saved).
		_.#restoreInline();
		_.emit('hidden');
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
		if (_.#profile.position === 'bottom') return _.#snaps[_.#activeSnap];
		return _.#snaps[0];
	}

	#makeOpenFrames(size) {
		const _ = this;
		return new FrameEngine(buildOpenKeyframes(_.#profile, size, _.#restSize(), _.#snaps[0]));
	}

	#makeDragFrames(activeSize) {
		const _ = this;
		const maximum = Math.max(activeSize, ..._.#snaps);
		return new FrameEngine(
			buildDragKeyframes(_.#profile, activeSize, maximum, _.#restSize(), _.#snaps[0])
		);
	}

	#makeExitFrames(size) {
		const _ = this;
		return new FrameEngine(
			buildExitKeyframes(_.#profile, size, _.#restSize(), _.#snaps[0], {
				effect: _.#profile.exitEffect,
			})
		);
	}

	#exitTravel(size) {
		const _ = this;
		return exitTravel(
			_.#profile,
			size,
			_.#restSize(),
			_.#snaps[0],
			_.#profile.exitEffect || _.#profile.effect
		);
	}

	#exitClearProgress(size) {
		const _ = this;
		return exitClearProgress(
			_.#profile,
			size,
			_.#restSize(),
			_.#snaps[0],
			_.#profile.exitEffect || _.#profile.effect
		);
	}

	#makeRestFrames(fromSize, toSize) {
		const _ = this;
		return new FrameEngine(
			buildRestKeyframes(_.#profile, fromSize, toSize, _.#restSize(), _.#snaps[0])
		);
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
		_.#springOverride = { attraction, friction };
	}

	/** @returns {{attraction: number, friction: number}|null} Active override. */
	get spring() {
		return this.#springOverride ? { ...this.#springOverride } : null;
	}

	/**
	 * Resolves the tuning for a phase, honouring any instance override.
	 *
	 * The override governs how the sheet ARRIVES — the entrance, including
	 * pop's. Exits and snaps keep their presets.
	 *
	 * Scaling those phases proportionally was tried and abandoned: the exit
	 * preset's attraction is ~5.5x the entrance's, so any brisk override pushed
	 * it past the dial's ceiling, and the clamped result was a badly overdamped
	 * spring — `spring="0.3 0.55"` measured a 2933ms exit. The dials are bounded,
	 * so no proportional rule can survive a fast entrance. Pinning exits to
	 * their presets keeps leaving brisk for every override instead.
	 * @param {'entrance'|'exit'|'snap'|'pop'} kind - Motion phase.
	 * @returns {{attraction: number, friction: number}} Spring tuning.
	 */
	#springFor(kind) {
		const _ = this;
		const preset = SPRING_PRESETS[kind] || SPRING_PRESETS.entrance;
		const override = _.#springOverride;
		if (!override) return preset;
		if (kind !== 'entrance' && kind !== 'pop') return preset;
		return {
			attraction: clamp(override.attraction, MIN_SPRING, MAX_SPRING),
			friction: clamp(override.friction, MIN_SPRING, MAX_SPRING),
		};
	}

	/**
	 * Retunes the spring for the next run.
	 * @param {'entrance'|'exit'|'snap'} kind - Motion phase.
	 */
	#tuneSpring(kind) {
		const _ = this;
		const preset = _.#springFor(kind === 'entrance' && _.#profile.effect === 'pop' ? 'pop' : kind);
		_.#spring.setAttraction(preset.attraction);
		_.#spring.setFriction(preset.friction);
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
		const flight = _.#phase === 'showing' || _.#phase === 'hiding' ? clamp(p, 0, 1) : 1;
		const clear = _.#settleAction?.backdropClearProgress;
		if (clear > 0 && clear < 1) {
			const visibleFlight = clamp((flight - clear) / (1 - clear), 0, 1);
			_.#backdropProgress = dismissalZoneProgress(_.#currentSize * visibleFlight, _.#snaps[0]);
			return;
		}
		const floor = _.#settleAction?.backdropFloorExtent;
		const extent =
			floor === undefined ? _.#currentSize * flight : floor + (_.#currentSize - floor) * flight;
		_.#backdropProgress = dismissalZoneProgress(extent, _.#snaps[0]);
	}

	#emitChange() {
		const _ = this;
		_.emit('change', {
			progress: _.#p,
			backdropProgress: _.#backdropProgress,
			phase: _.#phase,
		});
	}

	#applyFrame(p) {
		const _ = this;
		// Inert for the duration of a morph. The host owns every inline box
		// property while it runs, and a frame written underneath it would fight
		// the transition it is driving. The backdrop is pinned by beginMorph, so
		// skipping #syncBackdropProgress here is deliberate rather than an
		// oversight.
		if (_.#morphing) return;
		_.#syncBackdropProgress(p);
		if (!_.#frames || !_.#dialog) return;
		// paintedProgress is the whole rule — floor, and a profile-specific cap.
		// The component publishes --sheet-progress through the same function.
		const styles = _.#frames.getFrame(paintedProgress(_.#profile.position, p));
		for (const property of CLAMP_POSITIVE) {
			if (property in styles && parseFloat(styles[property]) < 0) styles[property] = '0px';
		}
		Object.assign(_.#dialog.style, styles);
	}

	#saveInline() {
		const _ = this;
		if (_.#savedInline || !_.#dialog) return;
		_.#savedInline = {};
		for (const property of MANAGED_PROPERTIES) {
			_.#savedInline[property] = _.#dialog.style[property];
		}
	}

	#prepareDialog() {
		const _ = this;
		if (!_.#dialog) return;
		_.#dialog.style.display = _.#display;
		_.#dialog.style.willChange = resizesWithSnaps(_.#profile)
			? 'transform, opacity, height'
			: 'transform, opacity';
	}

	#restoreInline() {
		const _ = this;
		if (!_.#dialog || !_.#savedInline) return;
		for (const property of MANAGED_PROPERTIES) {
			_.#dialog.style[property] = _.#savedInline[property];
		}
		_.#savedInline = null;
	}
}

export {
	awayOffset,
	awayTranslation,
	awayVector,
	buildDragKeyframes,
	buildExitKeyframes,
	buildOpenKeyframes,
	buildRestKeyframes,
	CLAMP_POSITIVE,
	contentSized,
	dismissalZoneProgress,
	dismissAxis,
	DISMISS_ROUTES,
	effectStyles,
	EXIT_CUSHION,
	exitCushion,
	exitClearProgress,
	exitTravel,
	paintedExtent,
	paintedProgress,
	parseDismiss,
	parseSpring,
	effectValues,
	FRAME_MS,
	resizesWithSnaps,
	restStyles,
	POP_OVERSHOOT_PERCENT,
	POP_OVERSHOOT_SCALE,
	REVEAL_PERCENT,
	SheetEngine,
	SPRING_PRESETS,
	transformOrigin,
	TRAVEL,
	velocityToSpring,
	VELOCITY_BOOST,
	MIN_SPRING_SPAN,
	REST_OVERSHOOT_PERCENT,
};
