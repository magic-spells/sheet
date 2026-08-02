// Side-effect import: registers <dialog-panel> and <dialog-backdrop> so one
// install and one import set up the whole family. It stays a peerDependency —
// external in the ESM build, so every spell in a project resolves to the app's
// single copy — and its guarded defines make even a duplicate copy harmless.
import '@magic-spells/dialog-panel';
import './sheet.css';
import { DragGesture } from './drag-gesture.js';
import {
	awayOffset,
	contentSized,
	dismissAxis,
	EXIT_CUSHION,
	paintedProgress,
	parseDismiss,
	parseSpring,
	resizesWithSnaps,
	SheetEngine,
} from './sheet-engine.js';
import { contentClaimDirection, normalizeScrollLeft } from './scroll-policy.js';
import { resolveInitialSnap, resolveSnapPoints, resolveSnapTarget } from './snap-points.js';

const POSITIONS = new Set(['bottom', 'left', 'right', 'center']);
const MODES = new Set(['edge', 'card']);
const EFFECTS = new Set(['slide', 'fade-scale', 'slide-fade']);
const PROFILE_ATTRIBUTES = new Set([
	'position',
	'mode',
	'breakpoint',
	'desktop-position',
	'desktop-mode',
]);
const EFFECT_ATTRIBUTES = new Set([
	'effect',
	'desktop-effect',
	'exit-effect',
	'desktop-exit-effect',
]);
const RESIZE_THROTTLE_MS = 100;
const FLICK_VELOCITY = 0.5;
const OVERSCROLL_RESISTANCE = 0.2;
const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll']);

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
	const rtl = getComputedStyle(element).direction === 'rtl';
	return {
		scrollTop: element.scrollTop,
		scrollLeft: normalizeScrollLeft(
			element.scrollLeft,
			element.scrollWidth,
			element.clientWidth,
			rtl
		),
		scrollHeight: element.scrollHeight,
		scrollWidth: element.scrollWidth,
		clientHeight: element.clientHeight,
		clientWidth: element.clientWidth,
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
	return SCROLLABLE_OVERFLOW.has(axis === 'x' ? style.overflowX : style.overflowY);
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
	if (style.visibility === 'hidden' || style.display === 'none') return false;
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
const MORPH_PROPERTIES = [
	'top',
	'left',
	'right',
	'bottom',
	'width',
	'height',
	'maxWidth',
	'maxHeight',
	'margin',
	'borderRadius',
	'transition',
];

/**
 * The subset that actually animates, in CSS spelling.
 *
 * The rest of MORPH_PROPERTIES are neutralisers — `right: auto`, `margin: 0` —
 * held constant so they cannot fight the four box values being interpolated.
 * Doubles as the transitionend filter: content inside the dialog runs
 * transitions of its own, and only these mean the morph itself has landed.
 */
const MORPH_TRANSITION_PROPERTIES = ['top', 'left', 'width', 'height', 'border-radius'];

/**
 * Safety margin on the morph's transitionend wait.
 *
 * transitionend does not fire if the transition is interrupted, if a property
 * happens to start and end at the same value, or if the element is hidden
 * mid-flight. The timeout is what guarantees the pins are always stripped, so
 * the panel can never be stranded in morph geometry.
 */
const MORPH_TIMEOUT_PADDING_MS = 120;

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
	if (value === null || value === undefined || value === '') element.removeAttribute(name);
	else element.setAttribute(name, String(value));
}

/**
 * Gesture-driven sheet policy layered on dialog-panel's native dialog lifecycle.
 */
class SheetPanel extends HTMLElement {
	#engine = null;
	#panelRef = null;
	#dialogRef = null;
	#gestures = [];
	#scrollVeto = null;
	#scrimPress = false;
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
	#handlers;

	static get observedAttributes() {
		return [
			'snap-points',
			'initial-snap',
			'position',
			'mode',
			'breakpoint',
			'desktop-position',
			'desktop-mode',
			'desktop-effect',
			'desktop-exit-effect',
			'effect',
			'exit-effect',
			// `dismiss` is deliberately absent: every guard reads dismissPolicy live
			// at event time, so there is no state to resync and observing it would
			// imply a callback that does nothing.
			'max-display-width',
			'spring',
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
				if (window.innerWidth > _.maxDisplayWidth) {
					event.preventDefault();
					return;
				}
				// Reset before the run starts; a reversal's synchronous reveal
				// re-emit lands after this and re-marks the promotion it performs.
				_.#proxyRevealed = false;
				if (_.#engine?.state !== 'hiding') _.#setProgress(0);
				_.#prepareOpen();
			},
			beforeHide: () => {
				// Covers every route out: gesture dismissal, close button,
				// Escape, backdrop click, or a programmatic hide().
				_.#drag = { active: false };
				// A morph still in flight has to be abandoned here too, or its
				// pinned box would outlive the panel and fight the exit animation
				// the engine is about to run.
				_.#finishMorph();
			},
			shown: () => {
				_.#setProgress(1);
				_.#flushPendingProfile();
				// The only moment the observer can be armed. #prepareOpen runs from
				// beforeShow and from show(), and dialog-panel is still 'hidden' at
				// both — so the isOpen gate in #syncContentObserver refused every
				// install and a content-sized panel only ever picked up an observer if
				// a window resize happened to rebuild the profile while it sat open.
				_.#syncContentObserver();
			},
			hidden: () => {
				_.#drag = { active: false };
				_.#proxyRevealed = false;
				// The force-close paths (stop(), a native close repair) emit no
				// beforeHide, so this is the only hook that can clear a #waitForMorph
				// timer they stranded — left armed, it fires up to duration + padding
				// later and writes the snapshot onto a subsequent live run. A normal
				// hide already finished the morph at beforeHide, making this a no-op.
				_.#finishMorph();
				_.#setProgress(0);
				_.#syncContentObserver();
			},
			// Escape reaches a native dialog as `cancel`. Refusing it here — rather
			// than vetoing the resulting beforeHide — is what keeps a
			// [data-action-hide-dialog] button working: by the time beforeHide fires,
			// an Escape and a button press are the same call.
			escapeGuard: (event) => {
				if (event.target !== _.#dialogRef || _.dismissPolicy.escape) return;
				event.preventDefault();
				event.stopPropagation();
			},
			// Records where a gesture BEGAN, which is the only thing that
			// distinguishes a scrim tap from a drag that merely ended out there —
			// `click` fires on the nearest common ancestor of press and release, so
			// a press inside the panel that releases on the scrim arrives retargeted
			// to the dialog and looks identical to a tap. See #outsideGuard.
			scrimPress: (event) => {
				_.#scrimPress = event.target === _.#dialogRef;
			},
			outsideGuard: (event) => {
				if (!_.#dialogRef) return;
				// Geometry, not target, and that is load-bearing in BOTH directions.
				// The native ::backdrop reports the dialog itself as its target, so a
				// scrim tap can only be recognised by position — the same test
				// dialog-panel uses, deliberately. And a drag that began on panel
				// content arrives retargeted to whatever held pointer capture, which
				// is inside the panel, so a target-based exemption would wave through
				// the exact release this guard exists to catch. Every ordinary click
				// on panel content lands inside the rect and returns here.
				const rect = _.#dialogRef.getBoundingClientRect();
				const outside =
					event.clientX < rect.left ||
					event.clientX > rect.right ||
					event.clientY < rect.top ||
					event.clientY > rect.bottom;
				if (!outside) return;
				// Two separate reasons to refuse an outside click, and they are
				// deliberately not the same question. The policy may forbid backdrop
				// dismissal outright; and a gesture that started on panel content is a
				// selection or a mis-drag, never a tap, however far out it let go.
				// A keyboard-driven click carries no preceding pointerdown, but it is
				// dispatched at the activated element's own position — inside the rect
				// — so it returns above rather than reaching this line.
				if (!_.dismissPolicy.backdrop || !_.#scrimPress) event.stopPropagation();
			},
			// A native close — <form method="dialog"> or app-level dialog.close() —
			// landing between the proxy reveal and the blob settle reaches neither of
			// dialog-panel's force-close guards: animatesDialog is false for the proxy
			// run and engine paths never arm #pendingRAF. Left alone, the blob's shown
			// handler re-opens the dialog the user explicitly closed. stop() is the
			// sanctioned force-close path: it kills the blob and forwards its own
			// terminal 'stop', which dialog-panel finalizes from.
			//
			// The repair is scoped to the FORWARD flight ('showing'), and that gate
			// is load-bearing, not defensive: dialog-panel's own proxy-hide
			// choreography demotes the dialog at hide-START — the blob flies in
			// normal flow, and a top-layer dialog would paint over it — so every
			// deliberate reverse close delivers a queued close event mid-flight
			// with the dialog closed. Reacting to it stopped the blob dead and the
			// panel vanished instead of morphing back. dialog.open is the second
			// guard: a hide reversed back to show re-promotes at its reveal
			// re-emit, so the reversed hide's queued close lands open and is
			// ignored even before the state check.
			//
			// #proxyRevealed is the staleness token, mirroring dialog-panel's
			// #pendingRAF trick: a force-close only exists AFTER this run's reveal
			// promoted the dialog. A direct or force close leaves the dialog open
			// until finalize, whose dialog.close() QUEUES a close event — so a
			// hidden listener that reopens a trigger morph in the same task puts
			// the new flight into exactly the state the other guards describe
			// ('showing', blob up, dialog not yet open) before the stale event
			// lands. beforeShow resets the token; only this run's reveal sets it.
			close: () => {
				const dialog = _.#dialogRef;
				const engine = _.#engine;
				if (
					dialog &&
					!dialog.open &&
					_.#proxyRevealed &&
					engine?.state === 'showing' &&
					engine.blobFlight
				) {
					engine.stop();
				}
			},
			// Only a proxy run emits reveal — a direct spring needs none — so this
			// marks exactly "the current flight has promoted the dialog", which is
			// the precondition for the close handler's force-close repair.
			reveal: () => {
				_.#proxyRevealed = true;
			},
			resize: throttle(() => _.#handleResize(), RESIZE_THROTTLE_MS),
			change: ({ progress, backdropProgress, phase }) =>
				_.#setProgress(progress, backdropProgress, phase),
			snapchange: (detail) => {
				_.#syncActiveSize(detail.to);
				_.dispatchEvent(
					new CustomEvent('snapchange', {
						bubbles: true,
						composed: true,
						detail,
					})
				);
			},
		};
	}

	attributeChangedCallback(name, oldValue, newValue) {
		const _ = this;
		if (oldValue === newValue || !_.#connected) return;

		if (name === 'max-display-width') {
			if (window.innerWidth > _.maxDisplayWidth && _.panel?.isOpen) _.hide();
			return;
		}

		if (name === 'spring') {
			_.#syncSpring();
			return;
		}

		if (EFFECT_ATTRIBUTES.has(name)) {
			// An entrance or exit effect changes no resting geometry, so none earns
			// a morph — a no-op FLIP whose identical boxes never emit transitionend
			// and park the engine until the safety timeout. Apply the live profile
			// directly so the next flight uses the new choreography immediately.
			if (_.panel?.isOpen) _.#applyProfile(_.#resolveProfile());
			return;
		}

		if (PROFILE_ATTRIBUTES.has(name) && _.panel?.isOpen) {
			if (_.#engine?.blobFlight) {
				_.#pendingProfile = true;
				return;
			}
			// Same treatment as a breakpoint crossing: retarget the open panel
			// rather than closing it. This is what lets a consumer flip
			// position/mode live and watch the sheet travel to its new geometry.
			_.#morphToProfile();
			return;
		}

		if (name === 'snap-points' || name === 'initial-snap') {
			if (_.#engine?.blobFlight) {
				_.#pendingProfile = true;
				return;
			}
			// Same refusal the resize path makes, and for the same reason: setSnaps
			// rewrites #currentSize to the active snap, which discards a live
			// gesture's pose. #dragMove measures displacement continuously from
			// pointerdown, so a moving finger repaints the correct pose on its very
			// next move and only a finger held still stays jumped — but the release
			// settle or the next open re-measures either way, so there is nothing to
			// gain by doing it under the finger.
			if (!_.#drag.active) _.#prepareOpen();
		}
	}

	connectedCallback() {
		const _ = this;
		if (_.#connected) return;
		_.#connected = true;
		_.#panelRef = _.panel;
		_.#dialogRef = _.dialog;
		_.#engine = new SheetEngine({
			triggerProbe: (trigger) => !!_.#usableTriggerBox(trigger),
		});
		_.#engine.on('snapchange', _.#handlers.snapchange);
		_.#engine.on('change', _.#handlers.change);
		_.#engine.on('reveal', _.#handlers.reveal);
		_.#syncSpring();
		_.setAttribute('engine', '');

		if (_.#panelRef) {
			_.#panelRef.morphEngine = _.#engine;
			if (!_.#panelRef.hasAttribute('morph-display')) {
				_.#panelRef.setAttribute('morph-display', 'flex');
			}
			_.#panelRef.addEventListener('beforeShow', _.#handlers.beforeShow);
			_.#panelRef.addEventListener('beforeHide', _.#handlers.beforeHide);
			_.#panelRef.addEventListener('shown', _.#handlers.shown);
			_.#panelRef.addEventListener('hidden', _.#handlers.hidden);
			// Capture, so a refused outside click never reaches dialog-panel's own
			// bubble-phase handler on the dialog. The pointerdown tracker shares the
			// phase for the same reason: it has to observe the press even when a
			// surface's own gesture stops propagation later.
			_.#panelRef.addEventListener('pointerdown', _.#handlers.scrimPress, true);
			_.#panelRef.addEventListener('click', _.#handlers.outsideGuard, true);
		}
		_.#dialogRef?.addEventListener('close', _.#handlers.close);

		// `cancel` does not bubble and dialog-panel listens for it on the dialog
		// itself, so the capture phase on the way DOWN to the dialog is the only
		// ordering that can get ahead of it.
		document.addEventListener('cancel', _.#handlers.escapeGuard, true);

		window.addEventListener('resize', _.#handlers.resize);
		_.#bindSurface(_.header, 'header');
		_.#bindSurface(_.footer, 'footer');
		_.#bindSurface(_.content, 'content');
		// The panel itself hosts a side sheet's handle: the pill is the panel's
		// own ::before, sitting in padding no child surface covers. Without this
		// binding the one element that advertises the swipe is the one place a
		// swipe is dead. #dragStart refuses any hit that is not the panel
		// directly, so gestures bubbling up from the surfaces above stay owned
		// by them.
		_.#bindSurface(_, 'panel');

		if (_.content) {
			_.#scrollVeto = (event) => {
				if (_.#drag.active && _.#drag.claimed && event.cancelable) event.preventDefault();
			};
			_.content.addEventListener('touchmove', _.#scrollVeto, { passive: false });
		}

		_.#applyProfile(_.#resolveProfile());
	}

	disconnectedCallback() {
		const _ = this;
		if (!_.#connected) return;
		_.#connected = false;
		window.removeEventListener('resize', _.#handlers.resize);
		document.removeEventListener('cancel', _.#handlers.escapeGuard, true);
		_.#handlers.resize.cancel();
		// Every component-owned timer and listener goes during teardown, the
		// morph's transitionend and timeout included.
		_.#clearMorphTimers();
		_.#contentObserver?.disconnect();
		_.#contentObserver = null;
		clearTimeout(_.#contentRemeasureTimer);
		_.#contentRemeasureTimer = null;
		_.#releaseMorphPins();
		_.#dialogRef?.removeEventListener('close', _.#handlers.close);

		for (const gesture of _.#gestures) gesture.destroy();
		_.#gestures = [];

		if (_.content && _.#scrollVeto) {
			_.content.removeEventListener('touchmove', _.#scrollVeto);
		}
		_.#scrollVeto = null;

		_.style.removeProperty('--sheet-active-size');
		_.#dialogRef?.style.removeProperty('--sheet-active-size');
		if (_.#panelRef) {
			_.#panelRef.removeEventListener('beforeShow', _.#handlers.beforeShow);
			_.#panelRef.removeEventListener('beforeHide', _.#handlers.beforeHide);
			_.#panelRef.removeEventListener('shown', _.#handlers.shown);
			_.#panelRef.removeEventListener('hidden', _.#handlers.hidden);
			_.#panelRef.removeEventListener('pointerdown', _.#handlers.scrimPress, true);
			_.#panelRef.removeEventListener('click', _.#handlers.outsideGuard, true);
			_.#panelRef.style.removeProperty('--sheet-progress');
			_.#panelRef.style.removeProperty('--sheet-backdrop-progress');
		}

		_.#engine?.off('change', _.#handlers.change);
		_.#engine?.off('snapchange', _.#handlers.snapchange);
		_.#engine?.off('reveal', _.#handlers.reveal);
		// Destroy before unwiring the transport: destroy() emits 'stop', and
		// dialog-panel has to still be listening — that event is what closes an
		// open dialog, emits its `hidden`, and returns focus. Unwiring first
		// strands an open modal in the top layer with scroll locked.
		_.#engine?.destroy();
		if (_.#panelRef?.morphEngine === _.#engine) _.#panelRef.morphEngine = null;
		_.#engine = null;
		_.#panelRef = null;
		_.#dialogRef = null;
		_.#profile = null;
		_.#drag = { active: false };
		_.#pendingProfile = null;
		_.removeAttribute('engine');
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
		_.#prepareOpen();
		const dialog = _.#dialogRef;
		// This is the one classification point for a trigger morph. The transport
		// bit is read by dialog-panel before beforeShow, so every gate — opt-in,
		// usable viewport box, and reduced-motion duration — has to resolve here,
		// before delegation. A failed arm during a live spring reversal deliberately
		// leaves that reversal direct, and a vetoed show disarms a hidden engine so
		// it can never create a later phantom reverse.
		const morph =
			_.morphsFromTrigger &&
			!!triggerEl &&
			!!dialog &&
			_.#morphDuration(dialog) > 0 &&
			!!_.#usableTriggerBox(triggerEl);
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
		// Still guarded here: the engine's own clamp truncates first, and
		// Math.trunc(NaN) propagates straight through it into a snap lookup.
		if (!Number.isFinite(requestedIndex)) return Promise.resolve(false);
		return _.#engine.settleTo(requestedIndex, 0);
	}

	/** @returns {number} Active snap index. */
	get activeSnap() {
		return this.#engine?.activeSnap ?? -1;
	}

	/** @returns {HTMLElement|null} Parent dialog-panel. */
	get panel() {
		return this.closest('dialog-panel');
	}

	/** @returns {HTMLDialogElement|null} Parent native dialog. */
	get dialog() {
		return this.closest('dialog');
	}

	/** @returns {SheetHeader|null} Header drag surface. */
	get header() {
		return this.querySelector('sheet-header');
	}

	/** @returns {SheetContent|null} Scrollable content region. */
	get content() {
		return this.querySelector('sheet-content');
	}

	/** @returns {SheetFooter|null} Optional footer drag surface. */
	get footer() {
		return this.querySelector('sheet-footer');
	}

	/** @returns {HTMLElement|null} Generated dialog-panel backdrop. */
	get backdrop() {
		return this.panel?.querySelector('dialog-backdrop');
	}

	/** @returns {string} Space-separated CSS snap lengths. */
	get snapPoints() {
		return this.getAttribute('snap-points') || '85vh';
	}

	/** @param {string} value - Space-separated CSS snap lengths. */
	set snapPoints(value) {
		reflectString(this, 'snap-points', value);
	}

	/** @returns {number|null} Requested initial snap, or null for the largest. */
	get initialSnap() {
		return this.hasAttribute('initial-snap')
			? Number.parseInt(this.getAttribute('initial-snap'), 10)
			: null;
	}

	/** @param {number|null} value - Zero-based initial snap index. */
	set initialSnap(value) {
		reflectString(this, 'initial-snap', value);
	}

	/** @returns {'bottom'|'left'|'right'|'center'} Mobile sheet edge. */
	get position() {
		const value = this.getAttribute('position');
		return POSITIONS.has(value) ? value : 'bottom';
	}

	/** @param {'bottom'|'left'|'right'|'center'} value - Mobile sheet edge. */
	set position(value) {
		reflectString(this, 'position', value);
	}

	/** @returns {'edge'|'card'} Mobile presentation mode. */
	get mode() {
		const value = this.getAttribute('mode');
		return MODES.has(value) ? value : 'edge';
	}

	/** @param {'edge'|'card'} value - Mobile presentation mode. */
	set mode(value) {
		reflectString(this, 'mode', value);
	}

	/** @returns {number} Desktop profile breakpoint in pixels. */
	get breakpoint() {
		const value = Number.parseFloat(this.getAttribute('breakpoint'));
		return Number.isFinite(value) ? value : 768;
	}

	/** @param {number} value - Desktop profile breakpoint in pixels. */
	set breakpoint(value) {
		reflectString(this, 'breakpoint', value);
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
		const value = this.getAttribute('desktop-position');
		if (POSITIONS.has(value)) return value;
		return this.position === 'bottom' ? 'center' : this.position;
	}

	/** @param {'bottom'|'left'|'right'|'center'} value - Desktop sheet edge. */
	set desktopPosition(value) {
		reflectString(this, 'desktop-position', value);
	}

	/** @returns {'edge'|'card'} Desktop presentation mode. */
	get desktopMode() {
		const value = this.getAttribute('desktop-mode');
		return MODES.has(value) ? value : 'card';
	}

	/** @param {'edge'|'card'} value - Desktop presentation mode. */
	set desktopMode(value) {
		reflectString(this, 'desktop-mode', value);
	}

	/** @returns {'slide'|'fade-scale'|'slide-fade'} Mobile motion effect. */
	get effect() {
		const value = this.getAttribute('effect');
		return EFFECTS.has(value) ? value : 'slide';
	}

	/** @param {'slide'|'fade-scale'|'slide-fade'} value - Mobile motion effect. */
	set effect(value) {
		reflectString(this, 'effect', value);
	}

	/** @returns {'slide'|'fade-scale'|'slide-fade'} Desktop motion effect. */
	get desktopEffect() {
		const value = this.getAttribute('desktop-effect');
		if (EFFECTS.has(value)) return value;
		// A centered dialog rests against no edge, so inheriting a bottom sheet's
		// `slide` would fly it up a whole viewport height into the middle of the
		// screen. It is the one profile that needs its own default.
		//
		// Every other profile inherits. Defaulting all card modes to `fade-scale`
		// was wrong: a desktop drawer that fades in place instead of sliding in from
		// its edge is not what anyone means by a drawer, and it forced every
		// mobile-bottom-to-desktop-side consumer to write `desktop-effect="slide"`
		// to get the obvious behaviour. A card slides from its edge like anything
		// else — slideInset already accounts for the margin it floats by.
		if (this.desktopPosition === 'center') return 'fade-scale';
		return this.effect;
	}

	/** @param {'slide'|'fade-scale'|'slide-fade'} value - Desktop motion effect. */
	set desktopEffect(value) {
		reflectString(this, 'desktop-effect', value);
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
		const value = this.getAttribute('exit-effect');
		return EFFECTS.has(value) ? value : this.effect;
	}

	/** @param {'slide'|'fade-scale'|'slide-fade'} value - Mobile exit effect. */
	set exitEffect(value) {
		reflectString(this, 'exit-effect', value);
	}

	/**
	 * Desktop exit effect. Falls back to `exit-effect` when that is set explicitly,
	 * and otherwise to the desktop entrance — so a profile that only names its
	 * desktop entrance still leaves the way it arrived.
	 * @returns {'slide'|'fade-scale'|'slide-fade'} Desktop exit effect.
	 */
	get desktopExitEffect() {
		const value = this.getAttribute('desktop-exit-effect');
		if (EFFECTS.has(value)) return value;
		const mobile = this.getAttribute('exit-effect');
		if (EFFECTS.has(mobile)) return mobile;
		return this.desktopEffect;
	}

	/** @param {'slide'|'fade-scale'|'slide-fade'} value - Desktop exit effect. */
	set desktopExitEffect(value) {
		reflectString(this, 'desktop-exit-effect', value);
	}

	/**
	 * Spring tuning override for this instance, or null while the built-in
	 * per-phase presets are in force.
	 * @returns {{attraction: number, friction: number}|null} Active tuning.
	 */
	get spring() {
		return SheetPanel.parseSpring(this.getAttribute('spring'));
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
		if (value === null || value === undefined) {
			this.removeAttribute('spring');
			return;
		}
		if (typeof value === 'string') {
			reflectString(this, 'spring', value);
			return;
		}
		const { attraction, friction } = value;
		reflectString(this, 'spring', `${attraction} ${friction}`);
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
		return parseDismiss(this.getAttribute('dismiss'));
	}

	/** @param {string|null} value - Route tokens, `none`, or `''` for locked. */
	set dismiss(value) {
		// Not reflectString: an empty string is a real value here — parseDismiss('')
		// closes every implicit route, so collapsing '' to a removed attribute
		// would silently unlock the sheet. Fail closed.
		if (value === null || value === undefined) this.removeAttribute('dismiss');
		else this.setAttribute('dismiss', String(value));
	}

	/** @returns {string|null} The raw `dismiss` attribute. */
	get dismiss() {
		return this.getAttribute('dismiss');
	}

	/**
	 * Whether `show(trigger)` grows the trigger's box into the panel rather than
	 * running the spring entrance. Opt-in, because a trigger is passed to every
	 * sheet for focus return and most of them should still slide from their edge.
	 * @returns {boolean} True when the `morph-trigger` attribute is present.
	 */
	get morphsFromTrigger() {
		return this.hasAttribute('morph-trigger');
	}

	/**
	 * Opts the sheet into growing out of the trigger passed to `show()`.
	 * @param {boolean} value - True to set `morph-trigger`, false to remove it.
	 */
	set morphsFromTrigger(value) {
		if (value) this.setAttribute('morph-trigger', '');
		else this.removeAttribute('morph-trigger');
	}

	/** @returns {number} Largest viewport width where opening is allowed. */
	get maxDisplayWidth() {
		const value = this.getAttribute('max-display-width');
		if (value === null || value === 'none') return Infinity;
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : Infinity;
	}

	/** @param {number} value - Largest opening width, or Infinity for no limit. */
	set maxDisplayWidth(value) {
		if (value === Infinity || value === null || value === undefined) {
			this.removeAttribute('max-display-width');
		} else {
			reflectString(this, 'max-display-width', value);
		}
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
			onEnd: (info) => _.#dragEnd(info),
		};
	}

	#dragStart(surface, event) {
		const _ = this;
		// The panel surface exists for the side handle strip — the only region
		// where the panel itself is the hit target. Every child surface's
		// pointerdown bubbles through the panel's gesture too, and it must be
		// refused outright (not merely ignored): DragGesture would otherwise
		// capture the pointer at slop and starve the surface that owns it.
		// Returning false is that refusal.
		if (surface === 'panel' && event?.target !== _) return false;
		if (_.#engine?.state !== 'shown' || _.#engine.morphing || _.#engine.blobFlight) {
			_.#drag = { active: false };
			return false;
		}
		// Touch reaches this once, at pointerdown. The scroll chain is measured
		// here and remains fixed for the gesture.
		_.#drag = {
			active: true,
			claimed: false,
			direction: 0,
			scrollChain: _.#scrollChain(event?.target),
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
		// A target outside the content region degrades to the content alone.
		while (node && node !== content && content.contains(node)) {
			if (scrollsOnAxis(node, axis)) chain.push(scrollMetrics(node));
			node = node.parentElement;
		}
		// The content passes the same overflow filter as every other node: a wide
		// table under `overflow-x: hidden` still reports scrollWidth > clientWidth,
		// so admitting it unconditionally made the chain claim it could scroll
		// forever and the sheet never took a gesture on that axis. An empty chain
		// means the sheet claims, which is the right answer for a content region
		// that cannot scroll at all.
		if (scrollsOnAxis(content, axis)) chain.push(scrollMetrics(content));
		return chain;
	}

	#dragMove(surface, info) {
		const _ = this;
		const drag = _.#drag;
		if (!drag.active) return;

		const offset = _.#awayOffset(info.deltaX, info.deltaY);

		// Gates run only while unclaimed. Once the sheet owns the gesture every
		// move follows the finger: re-running the axis or scroll gates after claim
		// is how a diagonal drift froze a claimed drag with the veto still on.
		if (!drag.claimed) {
			if (surface === 'content') {
				if (!_.#matchesActiveAxis(info.direction)) return;
				const position = _.#profile.position;
				const direction = contentClaimDirection(
					drag.scrollChain,
					dismissAxis(position),
					position,
					offset
				);
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
		if (_.#profile.position === 'bottom') {
			_.#engine.settleTo(_.#engine.activeSnap, 0);
		} else {
			_.#engine.returnToRest(0);
		}
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
			flickVelocity: FLICK_VELOCITY,
		});
		// A locked sheet refuses the dismissal but still has to land somewhere, so
		// the refusal is redirected to the active snap rather than vetoed later.
		// Blocking it downstream — in beforeHide, say — would leave the panel parked
		// at its dragged pose with no settle at all, because #dismiss() has already
		// gone through panel.hide() by then.
		const prevented = resolved === null && !_.dismissPolicy.swipe;
		const target = prevented ? _.#engine.activeSnap : resolved;
		_.#emitSnapRelease(velocityAway, target, prevented);

		if (target === null) {
			_.#dismiss(Math.max(velocityAway, 0));
			return;
		}
		if (_.#profile.position === 'bottom') {
			_.#engine.settleTo(target, -velocityAway);
		} else {
			_.#engine.returnToRest(-velocityAway);
		}
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
		_.dispatchEvent(
			new CustomEvent('snaprelease', {
				bubbles: true,
				composed: true,
				detail: {
					velocity,
					flick: Math.abs(velocity) > FLICK_VELOCITY,
					direction: velocity > 0 ? 'away' : velocity < 0 ? 'toward' : 'none',
					size: _.#engine.currentSize,
					target,
					prevented,
				},
			})
		);
	}

	// Away-signed projection of any x/y pair on the dismiss axis. Deltas and
	// velocities are the same question, so they share the one seam.
	#awayOffset(x, y) {
		return awayOffset(this.#profile.position, x, y);
	}

	#matchesActiveAxis(direction) {
		if (dismissAxis(this.#profile.position) === 'y') {
			return direction === 'up' || direction === 'down';
		}
		return direction === 'left' || direction === 'right';
	}

	#applyLiveOffset(offset) {
		const _ = this;
		const activeSize = _.#snaps[_.#engine.activeSnap];
		// The gesture's base pose is the size actually painted when the drag
		// claimed, not the active snap's rest. #activeSnap still names the snap
		// an interrupted settle STARTED from — it only advances when a settle
		// completes — so basing the pose on its rest teleported a mid-settle
		// claim back to the previous position and re-transitioned from there:
		// every quick second flick jumped before it moved. At rest the painted
		// size IS the active snap size, so an ordinary drag is unchanged.
		const drag = _.#drag;
		if (drag.base === undefined) drag.base = _.#engine.currentSize;
		const maximum = _.#snaps[_.#snaps.length - 1];
		let size = drag.base - offset;
		if (size > maximum) {
			size = maximum + Math.sqrt(size - maximum) * 10 * OVERSCROLL_RESISTANCE;
		}
		if (size < 0) {
			size = -Math.sqrt(-size) * 10 * OVERSCROLL_RESISTANCE;
		}
		_.#engine.dragBy(activeSize - size);
	}

	#dismiss(velocityAway) {
		const _ = this;
		_.#engine.setDismissVelocity(Math.max(0, velocityAway));
		// Classification has to precede panel.hide(): dialog-panel reads
		// animatesDialog before beforeHide. The blob stays intact until the hide is
		// accepted, then SheetEngine releases it and immediately repaints this drag
		// pose before the configured spring exit starts.
		_.#engine.armGestureExit();
		if (_.panel?.hide() === false) {
			// A consumer vetoed beforeHide. The gesture already resolved to a
			// dismissal, so the panel still has to land somewhere — the same
			// redirect a refused swipe takes. Without it the panel freezes at its
			// dragged pose, and the queued velocity would leak into the next hide.
			_.#engine.cancelGestureExit();
			_.#engine.setDismissVelocity(0);
			_.#settleBack();
		}
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
		const position = desktop ? _.desktopPosition : _.position;
		return {
			desktop,
			position,
			mode,
			effect: desktop ? _.desktopEffect : _.effect,
			exitEffect: desktop ? _.desktopExitEffect : _.exitEffect,
			// The gap an edge-mounted panel already floats by: flush for edge mode,
			// a probed --sheet-card-margin for every card mode. A centred panel's gap
			// depends on its own size, which only exists per run, so the engine
			// derives that one exactly — see slideInset in sheet-engine.js.
			edgeInset: mode === 'card' ? _.#probeLength('--sheet-card-margin', '12px') : 0,
			// How far past its edge an exit carries the panel. Probed because the
			// cushion has to clear the consumer's SHADOW, and a soft one is ordinary —
			// the demo's own blur is 60px, more than double the default cushion.
			exitCushion: _.#probeLength('--sheet-exit-cushion', `${EXIT_CUSHION}px`, EXIT_CUSHION),
			viewportWidth: window.innerWidth,
			viewportHeight: window.innerHeight,
		};
	}

	#profileKey(profile) {
		// A resize cannot change an effect attribute. Crossing the breakpoint is
		// the only way it can resolve a different effect during resize, and that
		// already changes `desktop`; position-derived defaults likewise change
		// `position`. Effect-only attribute changes take the immediate path above,
		// so including effect here could only manufacture a no-op resize morph.
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
		const requestedIndex = resolveInitialSnap(_.getAttribute('initial-snap'), snaps);
		if (profile.desktop) {
			// One entry either way. A desktop bottom panel arrives here with its
			// MEASURED content height rather than a snap: `snap-points` is a
			// mobile-profile attribute and is ignored past the breakpoint, exactly
			// as it is for center — see #measureSnaps and contentSized().
			const desktopSize = snaps[snaps.length - 1];
			_.#snaps = [desktopSize];
			_.#engine.setSnaps(_.#snaps, 0);
		} else {
			_.#snaps = snaps;
			// The engine's live index is only meaningful while it names a spot in
			// THIS snap list — a same-profile resize re-measures the heights and
			// must keep the snap the user chose. Every other profile carries one
			// snap, so its index is always 0, and reusing it across a breakpoint
			// or position morph landed the panel on the LOWEST mobile snap while a
			// fresh open resolves initial-snap to the highest.
			const carrySnap = _.panel?.isOpen && !!previous && resizesWithSnaps(previous);
			const activeIndex = carrySnap ? _.#engine.activeSnap : requestedIndex;
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
		const want =
			!!_.#profile &&
			contentSized(_.#profile) &&
			!!_.panel?.isOpen &&
			typeof ResizeObserver === 'function';
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
			if (_.#drag.active || _.#morph !== null || _.#engine?.state !== 'shown') {
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
			_.style.removeProperty('--sheet-active-size');
			_.#dialogRef?.style.removeProperty('--sheet-active-size');
			return;
		}
		_.style.setProperty('--sheet-active-size', `${size}px`);
		_.#dialogRef?.style.setProperty('--sheet-active-size', `${size}px`);
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
		// One rule, one function, shared with the engine that did the painting. An
		// unresolved profile has no rule to apply, so it falls back to the safe
		// full clamp.
		const painted = position ? paintedProgress(position, value, phase) : clamp01(value);
		_.#panelRef.style.setProperty('--sheet-progress', painted.toFixed(3));
		_.#panelRef.style.setProperty(
			'--sheet-backdrop-progress',
			clamp01(backdropProgress).toFixed(3)
		);
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
		// A content-sized profile has no CSS token to probe — its dismiss extent
		// has to come from the laid-out box itself. Two profiles land here for the
		// same reason: a centered dialog, and a bottom panel past the breakpoint,
		// where `snap-points` no longer applies at all.
		if (contentSized(profile)) {
			const height = _.#measureBox(profile).height;
			return [height || window.innerHeight * 0.5];
		}
		if (profile.position !== 'bottom') {
			// Mirror the stylesheet's width expression term for term. The two must
			// agree exactly: this number IS the painted width, and every dismissal
			// threshold and exit runway is derived from it.
			//
			//   edge  width: var(--sheet-active-size, min(26rem, 90vw))
			//   card  width: min(var(--sheet-active-size, var(--sheet-desktop-panel-width)),
			//                    var(--sheet-desktop-panel-width))
			//
			// The card row is a `min` of two terms, not a choice between them, and
			// that is the whole subtlety. `#syncActiveSize` removes the INLINE
			// `--sheet-active-size` for every side profile, but a consumer sets it in
			// CSS — that is the documented way to give a side sheet its width — so a
			// stylesheet value survives and the `min` genuinely binds. Probing the
			// desktop token alone would ignore it and re-open this same divergence
			// from the other side: a consumer asking for 300px against a 480px cap
			// paints 300 and would have measured 480.
			//
			// Absence therefore has to be TESTED rather than assumed, because the
			// inner var()'s fallback is the cap itself — unset resolves to
			// `min(cap, cap)`, which is not what probing with the generic
			// `min(26rem, 90vw)` fallback returns. That mismatch was the shipped bug:
			// a 480px painted card measured 416px.
			const cssFallback = 'min(26rem, 90vw)';
			const pixelFallback = Math.min(26 * 16, window.innerWidth * 0.9);
			const active = () => _.#probeLength('--sheet-active-size', cssFallback, pixelFallback);
			if (!(profile.desktop && profile.mode === 'card')) return [active()];
			const cap = _.#probeLength('--sheet-desktop-panel-width', cssFallback, pixelFallback);
			return [_.#tokenIsSet('--sheet-active-size') ? Math.min(active(), cap) : cap];
		}

		const dimension = 'height';
		const viewportSize = window.innerHeight;
		const probe = document.createElement('div');
		Object.assign(probe.style, {
			position: 'fixed',
			visibility: 'hidden',
			pointerEvents: 'none',
			inset: '0 auto auto 0',
			boxSizing: 'border-box',
		});
		document.body.append(probe);

		const measure = (token) => {
			probe.style[dimension] = '';
			probe.style[dimension] = token;
			const pixels = probe.getBoundingClientRect()[dimension];
			return pixels;
		};
		const snaps = resolveSnapPoints(_.snapPoints, {
			viewportHeight: window.innerHeight,
			viewportWidth: window.innerWidth,
			rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
			percentageBase: viewportSize,
			measure,
		});
		probe.remove();
		return snaps.length ? snaps : [viewportSize * 0.85];
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
		if (!dialog) return { top: 0, left: 0, width: 0, height: 0, borderRadius: '0px' };

		const previous = {
			position: _.dataset.position,
			mode: _.dataset.mode,
			desktop: _.dataset.desktop,
		};
		const closed = !dialog.open;
		const savedDisplay = dialog.style.display;
		const savedVisibility = dialog.style.visibility;
		const savedTransform = dialog.style.transform;

		_.dataset.position = profile.position;
		_.dataset.mode = profile.mode;
		_.dataset.desktop = String(profile.desktop);
		if (closed) {
			dialog.style.display = 'flex';
			dialog.style.visibility = 'hidden';
		}
		dialog.style.transform = 'none';

		const box = _.#readBox(dialog);

		dialog.style.transform = savedTransform;
		if (closed) {
			dialog.style.display = savedDisplay;
			dialog.style.visibility = savedVisibility;
		}
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete _.dataset[key];
			else _.dataset[key] = value;
		}

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
		return (
			getComputedStyle(_.dialog || _)
				.getPropertyValue(name)
				.trim() !== ''
		);
	}

	#probeLength(name, cssFallback, pixelFallback = 0) {
		const _ = this;
		const token =
			getComputedStyle(_.dialog || _)
				.getPropertyValue(name)
				.trim() || cssFallback;
		const probe = document.createElement('div');
		Object.assign(probe.style, {
			position: 'fixed',
			visibility: 'hidden',
			pointerEvents: 'none',
		});
		probe.style.width = token;
		// An invalid length never lands on the inline style, which is what tells
		// "measured nothing" apart from a legitimate zero — a shadowless panel may
		// set --sheet-exit-cushion: 0px and must get 0, not the 28px default.
		if (probe.style.width === '') return pixelFallback;
		document.body.append(probe);
		const pixels = probe.getBoundingClientRect().width;
		probe.remove();
		return pixels;
	}

	/** Pushes any `spring` attribute override down to the engine. */
	#syncSpring() {
		this.#engine?.setSpring(SheetPanel.parseSpring(this.getAttribute('spring')));
	}

	#handleResize() {
		const _ = this;
		if (window.innerWidth > _.maxDisplayWidth && _.panel?.isOpen) {
			_.hide();
			return;
		}

		const next = _.#resolveProfile();
		// MorphEngine measured both endpoints at launch and owns every dialog style
		// until its terminal event. Rebuilding the sheet profile underneath that
		// snapshot would create two geometry owners, so queue one latest-value flush
		// for `shown` instead.
		if (_.#engine?.blobFlight) {
			_.#pendingProfile = true;
			return;
		}
		if (_.#engine?.state === 'hiding') return;
		if (_.#profile && _.#profileKey(next) !== _.#profileKey(_.#profile) && _.panel?.isOpen) {
			_.#morphToProfile();
			return;
		}
		// Never re-measure under a live finger: setSnaps would reset the engine's
		// size to the active snap and silently discard the gesture. The next
		// resize tick, the release settle, or the next open re-measures instead.
		if (_.#drag.active) return;

		// Mid-morph, the instant path below would read pinned, interpolating
		// geometry — a centre profile's `#measureBox` would publish the animating
		// height as its intrinsic one. But simply waiting leaves the morph flying
		// toward a destination measured at the crossing tick, and when the pins
		// strip the panel snaps to wherever the still-moving window ended up. So
		// retarget instead: the morph path strips its own pins before measuring,
		// and always reads its `from` box live, so re-entering it mid-flight is
		// the same seamless retarget a breakpoint re-crossing already gets.
		if (_.#engine?.morphing) {
			_.#morphToProfile();
			return;
		}

		// Same profile: re-measure in place, no motion. Dragging a window edge
		// fires this every RESIZE_THROTTLE_MS, and morphing on each tick would be
		// unwatchable. Only a profile KEY change earns a morph.
		_.#applyProfile(next);
		_.#prepareOpen();
	}

	#usableTriggerBox(trigger) {
		const _ = this;
		if (!(trigger instanceof Element) || !trigger.isConnected) return null;
		// Visibility is only readable while the engine is hidden, and that is
		// exactly the arm moment. From the launch onward MorphEngine owns the
		// trigger's visibility, display and opacity — it hides the source for the
		// whole flight and keeps it hidden for as long as the panel is shown — so
		// a hidden trigger read on the hide path is the morph's own doing and says
		// nothing about what the page wants. Checking it there would refuse every
		// reverse morph. The remaining gates below are geometry, which the blob
		// does not touch, so a trigger that detaches or scrolls away while the
		// sheet is open still falls back to the direct spring exit.
		if ((_.#engine?.state ?? 'hidden') === 'hidden' && !triggerIsVisible(trigger)) return null;
		const box = _.#readBox(trigger);
		if (box.width <= 0 || box.height <= 0) return null;
		if (
			box.left >= window.innerWidth ||
			box.top >= window.innerHeight ||
			box.left + box.width <= 0 ||
			box.top + box.height <= 0
		) {
			return null;
		}
		return box;
	}

	#blobZIndex() {
		const raw = getComputedStyle(this.#dialogRef || this)
			.getPropertyValue('--sheet-blob-z-index')
			.trim();
		const value = Number.parseFloat(raw);
		return Number.isFinite(value) ? value : 1002;
	}

	#waitForMorph(dialog, duration) {
		const _ = this;
		const settle = () => _.#finishMorph();
		_.#morph = {
			dialog,
			onEnd: (event) => {
				if (event.target === dialog && MORPH_TRANSITION_PROPERTIES.includes(event.propertyName)) {
					settle();
				}
			},
			timer: setTimeout(settle, duration + MORPH_TIMEOUT_PADDING_MS),
		};
		dialog.addEventListener('transitionend', _.#morph.onEnd);
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
		if (_.#engine?.state === 'hiding') return;
		if (!dialog || !_.#engine) {
			// #prepareOpen resolves and applies the profile itself.
			_.#prepareOpen();
			return;
		}

		// Re-entrant case: a window edge dragged back and forth across the
		// breakpoint. Measuring the live rect mid-transition gives the panel's
		// actual current position, so retargeting from here is seamless — this is
		// why the `from` box is always read rather than remembered.
		const wasMorphing = _.#morph !== null;
		if (wasMorphing) _.#clearMorphTimers();

		_.#drag = { active: false };
		if (!wasMorphing && !_.#engine.beginMorph()) {
			// #prepareOpen resolves and applies the profile itself.
			_.#prepareOpen();
			return;
		}

		// Snapshot the consumer's own inline geometry once per FLIP, before any
		// pin is written. Stripping used to blank these outright, which erased
		// styles the component never owned — a consumer's inline `height` or
		// `margin` is indistinguishable from a pin once both are inline.
		//
		// The `null` guard is the re-entrant case and is load-bearing: a window
		// edge dragged back and forth re-enters here with the previous FLIP's pins
		// still on the element, and re-snapshotting would promote that scaffolding
		// to "what the consumer had". The snapshot therefore survives every
		// retarget and is released only where a strip actually runs.
		if (_.#morphInline === null) {
			// `height` is the one property on the list the ENGINE also writes
			// inline, and only for a snap-resized bottom sheet. That painted value
			// is not the consumer's, and restoring it would pin the incoming
			// profile — which paints no height at all — to the outgoing one's snap,
			// exactly the stale-survivor the blanking teardown existed to prevent.
			// A consumer's own inline height on such a profile is already overwritten
			// every frame, so there is nothing here to lose.
			const engineOwnsHeight = _.#profile ? resizesWithSnaps(_.#profile) : false;
			_.#morphInline = {};
			for (const property of MORPH_PROPERTIES) {
				const owned = engineOwnsHeight && property === 'height';
				_.#morphInline[property] = owned ? '' : (dialog.style[property] ?? '');
			}
		}

		// Always read rather than remember. Mid-transition getBoundingClientRect
		// reports the animated value, so a retarget starts from exactly where the
		// panel is right now.
		const from = _.#readBox(dialog);

		// Hand the new geometry to CSS, then read where it wants to sit. The pins
		// have to come off first or we would measure our own scaffolding.
		_.#stripMorphPins(dialog);
		_.#prepareOpen();
		const to = _.#readBox(dialog);

		const duration = _.#morphDuration(dialog);
		if (duration <= 0) {
			// prefers-reduced-motion, or a consumer who zeroed the token.
			_.#finishMorph();
			return;
		}

		_.#pinBox(dialog, from);
		// Force layout so the pinned values are the transition's genuine starting
		// point. Without this the browser coalesces both writes and animates
		// nothing.
		void dialog.offsetWidth;

		// An invalid easing token can invalidate the shorthand the same way;
		// duration is resolved in JS, while easing deliberately remains out of scope.
		dialog.style.transition = MORPH_TRANSITION_PROPERTIES.map(
			(property) => `${property} ${duration}ms var(--sheet-morph-easing, ease-out)`
		).join(', ');
		_.#pinBox(dialog, to);

		// The timeout inside #waitForMorph is the guarantee that the pins always
		// come off. transitionend does not fire for an unchanged property or an
		// interrupted transition, and a stranded pin would freeze the panel.
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
		// The single site that ends a FLIP: normal completion, the safety timeout,
		// a zero morph duration, and the close interruption from beforeHide all
		// arrive here, so this is the one place the snapshot may be released.
		_.#releaseMorphPins();
		if (!_.#engine?.morphing) return;
		_.#engine?.endMorph();
		_.#setProgress(1, 1);
	}

	#clearMorphTimers() {
		const _ = this;
		if (!_.#morph) return;
		clearTimeout(_.#morph.timer);
		_.#morph.dialog.removeEventListener('transitionend', _.#morph.onEnd);
		_.#morph = null;
	}

	#readBox(element) {
		const rect = element.getBoundingClientRect();
		return {
			top: rect.top,
			left: rect.left,
			width: rect.width,
			height: rect.height,
			borderRadius: getComputedStyle(element).borderRadius,
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
			right: 'auto',
			bottom: 'auto',
			width: `${box.width}px`,
			height: `${box.height}px`,
			maxWidth: 'none',
			maxHeight: 'none',
			margin: '0',
			borderRadius: box.borderRadius,
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
		for (const property of MORPH_PROPERTIES) dialog.style[property] = saved?.[property] ?? '';
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
	 * Resolves the morph duration in milliseconds from the CSS token, so
	 * `prefers-reduced-motion` (which zeroes it) collapses the morph to an
	 * instant swap without a second switch in JS.
	 * @param {HTMLElement} dialog - Dialog carrying the token.
	 * @returns {number} Duration in milliseconds.
	 */
	#morphDuration(dialog) {
		const raw = getComputedStyle(dialog).getPropertyValue('--sheet-morph-duration').trim();
		const match = raw.match(/^([+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?)(ms|s)$/i);
		if (!match) return 600;
		const value = Number(match[1]);
		if (!Number.isFinite(value)) return 600;
		return match[2].toLowerCase() === 'ms' ? value : value * 1000;
	}
}

class SheetHeader extends HTMLElement {}
class SheetContent extends HTMLElement {}
class SheetFooter extends HTMLElement {}

if (!customElements.get('sheet-panel')) {
	customElements.define('sheet-panel', SheetPanel);
}
if (!customElements.get('sheet-header')) {
	customElements.define('sheet-header', SheetHeader);
}
if (!customElements.get('sheet-content')) {
	customElements.define('sheet-content', SheetContent);
}
if (!customElements.get('sheet-footer')) {
	customElements.define('sheet-footer', SheetFooter);
}

export {
	SheetPanel,
	SheetContent,
	SheetFooter,
	SheetHeader,
	resolveInitialSnap,
	resolveSnapPoints,
	resolveSnapTarget,
};
