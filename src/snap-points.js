const SIMPLE_LENGTH = /^(-?\d*\.?\d+)(px|vh|dvh|svh|lvh|vw|rem|%)?$/i;

// Sitting exactly on a snap leaves sub-pixel noise in the measured size, so
// "strictly past" needs a little room or a flick from a snap resolves to itself.
const SNAP_EPSILON = 1;

function splitSnapPoints(value) {
	const tokens = [];
	let token = '';
	let depth = 0;
	for (const char of String(value || '').trim()) {
		if (/\s/.test(char) && depth === 0) {
			if (token) tokens.push(token);
			token = '';
			continue;
		}
		if (char === '(') depth++;
		else if (char === ')') depth = Math.max(0, depth - 1);
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
function resolveSnapPoints(
	value,
	{
		viewportHeight,
		viewportWidth = viewportHeight,
		rootFontSize = 16,
		percentageBase = viewportHeight,
		measure,
	}
) {
	const tokens = splitSnapPoints(value);
	const pixels = tokens
		.map((token) => {
			if (measure) return measure(token);
			const match = token.match(SIMPLE_LENGTH);
			if (!match) return NaN;
			const number = Number(match[1]);
			const unit = (match[2] || 'px').toLowerCase();
			if (unit === 'px') return number;
			if (unit === 'vw') return (number / 100) * viewportWidth;
			if (unit === 'rem') return number * rootFontSize;
			if (unit === '%') return (number / 100) * percentageBase;
			return (number / 100) * viewportHeight;
		})
		.filter((number) => Number.isFinite(number) && number > 0)
		.map((number) => Math.round(number * 100) / 100)
		.sort((a, b) => a - b);

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
	if (value === null || value === undefined || value === '') return snaps.length - 1;
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

	// Inward overscroll is a visual affordance, not a position in the snap range:
	// the component rubber-bands an overpull to `maximum + 2*sqrt(overpull)`,
	// which clears SNAP_EPSILON as soon as the overpull passes a quarter of a
	// pixel. Stepping from that unclamped size made a downward flick from
	// the top resolve to the top — the snap it was already on — so the flick did
	// nothing. Clamping first is what keeps "one snap in the flick's direction"
	// true from anywhere the panel can actually be dragged to.
	currentSize = Math.min(currentSize, snaps[snaps.length - 1]);

	// Step from the live position rather than the snap where the gesture began.
	// Otherwise dragging from 20vh past 88vh and flicking up targets 55vh.
	if (velocityAway > flickVelocity) {
		let below = null;
		for (let index = 0; index < snaps.length; index++) {
			if (snaps[index] >= currentSize - SNAP_EPSILON) break;
			below = index;
		}
		// Running out of snaps below is what dismisses the sheet.
		return below;
	}

	if (velocityAway < -flickVelocity) {
		const above = snaps.findIndex((size) => size > currentSize + SNAP_EPSILON);
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

export { resolveInitialSnap, resolveSnapPoints, resolveSnapTarget, SNAP_EPSILON };
