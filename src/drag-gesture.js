/**
 * Rolling velocity sampler measured in pixels per millisecond.
 */
class VelocityTracker {
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
		_.#samples.push({ value, t });

		const cutoff = t - _.#windowMs;
		while (_.#samples.length > 2 && _.#samples[0].t < cutoff) {
			_.#samples.shift();
		}
	}

	/** @returns {number} Current pixels-per-millisecond velocity. */
	get velocity() {
		const samples = this.#samples;
		if (samples.length < 2) return 0;

		const last = samples[samples.length - 1];

		// Walk back from the newest sample and stop at the first reversal.
		// Averaging the whole window instead keeps reporting the direction the
		// gesture came FROM: pull a fast downward drag back up and lift, and the
		// window still reads downward, so the sheet leaves in the opposite
		// direction to the finger that released it. Zero-length steps are
		// skipped rather than treated as a turn — a slow drag quantises to them
		// constantly.
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
}

// Movement, in pixels, that separates a tap from a drag. Below this the
// pointer stays uncaptured so clicks compose on whatever the user pressed.
const SLOP = 5;

function directionFromDelta(deltaX, deltaY) {
	if (Math.abs(deltaX) > Math.abs(deltaY)) {
		return deltaX < 0 ? 'left' : 'right';
	}
	return deltaY < 0 ? 'up' : 'down';
}

/**
 * Dependency-free two-axis Pointer Events gesture adapter.
 */
class DragGesture {
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
			// An uncaptured pointer that leaves the element never comes back with a
			// pointerup, so end the gesture here or it is stranded active forever.
			//
			// This is a MOUSE-ONLY hole, and that is worth stating so it is not
			// re-litigated: a direct pointer (touch, or pen in contact) gets implicit
			// pointer capture to its own pointerdown target, so it keeps targeting
			// that element wherever it travels and always delivers its own pointerup.
			// Only a mouse can be pressed on a surface, drifted across the boundary
			// inside SLOP, and released on the far side.
			//
			// Stranded is not merely untidy. Chrome and Firefox give the mouse a
			// stable pointerId, so the next plain HOVER over the surface still
			// matches #pointerId, resumes calling onMove, crosses slop and captures a
			// button-less pointer — after which the consumer follows the bare cursor
			// around the screen until some unrelated click finally delivers a
			// pointerup.
			//
			// Guarded on #captured because once capture is set the element becomes
			// the effective target of every pointer event for that pointer, and
			// boundary events are only re-fired when the capture target itself
			// changes. So a captured drag cannot fire pointerleave mid-flight and
			// abort itself; the leave that arrives after an implicit release at
			// pointerup lands with #active already false and early-returns. The guard
			// in #handlePointerEnd holds too: pointerleave is a PointerEvent carrying
			// the id of the pointer that left, so the tracked pointer's leave matches
			// and a bystander pointer's does not.
			//
			// Cancelled, not a clean end: the user did not release here, and zeroed
			// velocity plus `cancelled: true` is what routes the consumer to a
			// settle-back. A pointer that wandered off must never be able to dismiss.
			pointerleave: (event) => {
				if (!_.#captured) _.#handlePointerEnd(event, true);
			},
		};

		for (const [type, handler] of Object.entries(_.#handlers)) {
			el.addEventListener(type, handler);
		}
	}

	#handlePointerDown(event) {
		const _ = this;
		// A captured gesture is guaranteed its own pointerup, so never let a
		// second pointer interrupt it. An uncaptured one may have been
		// abandoned outside the element, so allow it to be restarted.
		if (!event.isPrimary || (_.#active && _.#captured)) return;

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
		// Deliberately no setPointerCapture here. Capturing on pointerdown
		// retargets pointerup to this element, so the browser composes the
		// click on it instead of the button the user pressed — which silently
		// breaks every interactive child of a drag surface.
		//
		// A start callback may refuse the gesture by returning exactly `false`,
		// and a refused gesture goes fully inert: it never tracks and never
		// captures. The seam exists for surfaces that overlap — a pointerdown on
		// a child surface bubbles to its ancestors' gestures too, and an ancestor
		// that merely ignored the callbacks would still capture the pointer out
		// from under the surface that owns it the moment movement passes slop.
		if (_.#onStart?.({ event, x: event.clientX, y: event.clientY }) === false) {
			_.#active = false;
			_.#pointerId = null;
		}
	}

	#handlePointerMove(event) {
		const _ = this;
		if (!_.#active || event.pointerId !== _.#pointerId) return;

		const deltaX = event.clientX - _.#startX;
		const deltaY = event.clientY - _.#startY;

		// Once the pointer has clearly moved this is a drag, not a tap, so
		// capture to keep receiving events if it leaves the element.
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
			velocityY: _.#trackerY.velocity,
		});
	}

	#handlePointerEnd(event, cancelled) {
		const _ = this;
		if (!_.#active || event.pointerId !== _.#pointerId) return;

		const deltaX = event.clientX - _.#startX;
		const deltaY = event.clientY - _.#startY;
		_.#active = false;
		_.#captured = false;
		// The release is itself a sample. A stationary pointer fires no
		// pointermove, and the window never evicts below two samples, so without
		// this a finger that stopped dead still reports the flick it arrived on.
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
			cancelled,
		});
		_.#pointerId = null;
	}

	/** Removes every pointer listener and resets tracking state. */
	destroy() {
		const _ = this;
		for (const [type, handler] of Object.entries(_.#handlers)) {
			_.#el.removeEventListener(type, handler);
		}
		_.#active = false;
		_.#captured = false;
		_.#pointerId = null;
		_.#trackerX.reset();
		_.#trackerY.reset();
	}
}

export { DragGesture, VelocityTracker };
