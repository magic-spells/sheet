import test from 'node:test';
import assert from 'node:assert/strict';

import {
	canScrollFurther,
	contentClaimDirection,
	fingerFromAway,
	normalizeScrollLeft,
	scrollChainConsumes,
	CLAIM_SLOP,
	SCROLL_EDGE_TOLERANCE,
} from '../src/scroll-policy.js';
import { awayOffset, dismissAxis } from '../src/sheet-engine.js';

// Finger deltas, named the way the tests read. Screen coordinates grow down and
// right, so a finger moving up or left reports a negative delta.
const UP = -40;
const DOWN = 40;
const LEFT = -40;
const RIGHT = 40;

/** 1000px of content in a 400px window, parked at `scrollTop`. */
function tallBox(scrollTop) {
	return {
		scrollTop,
		scrollLeft: 0,
		scrollHeight: 1000,
		scrollWidth: 400,
		clientHeight: 400,
		clientWidth: 400,
	};
}

/** 1000px of content in a 400px window, parked at `scrollLeft`. */
function wideBox(scrollLeft) {
	return {
		scrollTop: 0,
		scrollLeft,
		scrollHeight: 400,
		scrollWidth: 1000,
		clientHeight: 400,
		clientWidth: 400,
	};
}

/** Nothing to scroll on either axis. */
function rigidBox() {
	return {
		scrollTop: 0,
		scrollLeft: 0,
		scrollHeight: 400,
		scrollWidth: 400,
		clientHeight: 400,
		clientWidth: 400,
	};
}

/**
 * The whole touch call site, round trip. A finger delta reaches the component
 * already collapsed into DragGesture's away-signed `drag.direction`, and the
 * policy has to recover finger space from it — so the tests drive the same
 * conversion the component does rather than handing the module a finger delta
 * it would never receive. Without this the left and right rows below would be
 * the same call twice, and dropping the inversion would stay green.
 */
function contentConsumesTouch(position, chain, fingerDelta) {
	const axis = dismissAxis(position);
	const away =
		axis === 'x' ? awayOffset(position, fingerDelta, 0) : awayOffset(position, 0, fingerDelta);
	// The low-level policy reads direction rather than distance.
	return scrollChainConsumes(chain, axis, fingerFromAway(position, Math.sign(away)));
}

/**
 * The live claim call site, including the finger-to-away conversion.
 */
function claimFromFinger(position, chain, fingerDelta) {
	const axis = dismissAxis(position);
	const away =
		axis === 'x' ? awayOffset(position, fingerDelta, 0) : awayOffset(position, 0, fingerDelta);
	return contentClaimDirection(chain, axis, position, away);
}

test('only a left sheet dismisses against its own axis, so only it inverts', () => {
	// Dismissing each profile: fingers down, left, and right respectively. Every
	// one of them is away-positive, and the finger sign they came from differs.
	assert.equal(fingerFromAway('bottom', 1), 1);
	assert.equal(fingerFromAway('left', 1), -1);
	assert.equal(fingerFromAway('right', 1), 1);
	// The inverse holds, and it round-trips awayOffset on the dismiss axis.
	assert.equal(fingerFromAway('bottom', -1), -1);
	assert.equal(fingerFromAway('left', -1), 1);
	assert.equal(fingerFromAway('right', -1), -1);
	for (const position of ['bottom', 'left', 'right']) {
		for (const finger of [-1, 1]) {
			const away =
				dismissAxis(position) === 'x'
					? awayOffset(position, finger, 0)
					: awayOffset(position, 0, finger);
			assert.equal(fingerFromAway(position, away), finger, `${position} finger ${finger}`);
		}
	}
});

test('a bottom sheet keeps scrolling under a finger moving down until the top edge', () => {
	assert.equal(contentConsumesTouch('bottom', [tallBox(300)], DOWN), true);
	assert.equal(contentConsumesTouch('bottom', [tallBox(0.5)], DOWN), true);
	assert.equal(contentConsumesTouch('bottom', [tallBox(0)], DOWN), false);
});

test('a bottom sheet keeps scrolling under a finger moving up until the bottom edge', () => {
	assert.equal(contentConsumesTouch('bottom', [tallBox(0)], UP), true);
	assert.equal(contentConsumesTouch('bottom', [tallBox(300)], UP), true);
	assert.equal(contentConsumesTouch('bottom', [tallBox(600)], UP), false);
});

test('a left sheet keeps scrolling under a finger moving left until the RIGHT edge', () => {
	// The dismissing direction. Fingers left drag the content left, which walks
	// scrollLeft up — so the sheet may only claim once the content is pinned
	// against its right edge, not its left.
	assert.equal(contentConsumesTouch('left', [wideBox(0)], LEFT), true);
	assert.equal(contentConsumesTouch('left', [wideBox(300)], LEFT), true);
	assert.equal(contentConsumesTouch('left', [wideBox(600)], LEFT), false);
});

test('a left sheet keeps scrolling under a finger moving right until the left edge', () => {
	assert.equal(contentConsumesTouch('left', [wideBox(600)], RIGHT), true);
	assert.equal(contentConsumesTouch('left', [wideBox(0.5)], RIGHT), true);
	assert.equal(contentConsumesTouch('left', [wideBox(0)], RIGHT), false);
});

test('a right sheet keeps scrolling under a finger moving right until the left edge', () => {
	// The dismissing direction for this profile, and the mirror of the left
	// sheet's: fingers right walk scrollLeft down toward zero.
	assert.equal(contentConsumesTouch('right', [wideBox(600)], RIGHT), true);
	assert.equal(contentConsumesTouch('right', [wideBox(300)], RIGHT), true);
	assert.equal(contentConsumesTouch('right', [wideBox(0)], RIGHT), false);
});

test('a right sheet keeps scrolling under a finger moving left until the RIGHT edge', () => {
	assert.equal(contentConsumesTouch('right', [wideBox(0)], LEFT), true);
	assert.equal(contentConsumesTouch('right', [wideBox(599)], LEFT), false);
	assert.equal(contentConsumesTouch('right', [wideBox(600)], LEFT), false);
});

test('content with nothing to scroll hands every finger direction to the sheet', () => {
	for (const position of ['bottom', 'left', 'right']) {
		for (const finger of [UP, DOWN, LEFT, RIGHT]) {
			assert.equal(contentConsumesTouch(position, [rigidBox()], finger), false);
		}
	}
});

test('a nested carousel consumes sideways fingers until its own edge', () => {
	// A horizontal upsell strip inside a side sheet's content. The content
	// itself has no horizontal room, so the carousel is the only thing that can
	// answer — and once it runs out, the sheet claims.
	const outer = rigidBox();
	assert.equal(contentConsumesTouch('left', [wideBox(0), outer], LEFT), true);
	assert.equal(contentConsumesTouch('left', [wideBox(598), outer], LEFT), true);
	assert.equal(contentConsumesTouch('left', [wideBox(600), outer], LEFT), false);
	assert.equal(contentConsumesTouch('left', [wideBox(600), outer], RIGHT), true);
});

test('a chain consumes when any member still has room, in any order', () => {
	assert.equal(scrollChainConsumes([rigidBox(), tallBox(300)], 'y', DOWN), true);
	assert.equal(scrollChainConsumes([tallBox(300), rigidBox()], 'y', DOWN), true);
	assert.equal(scrollChainConsumes([rigidBox(), rigidBox()], 'y', DOWN), false);
	assert.equal(scrollChainConsumes([], 'y', DOWN), false);
});

test('a finger that has not moved on the dismiss axis never consumes', () => {
	assert.equal(scrollChainConsumes([tallBox(300)], 'y', 0), false);
	assert.equal(scrollChainConsumes([wideBox(300)], 'x', 0), false);
	assert.equal(canScrollFurther(tallBox(300), 'y', 0), false);
});

test('the far edge carries a pixel of tolerance and the near edge does not', () => {
	assert.equal(SCROLL_EDGE_TOLERANCE, 1);
	// 600 is flush; 599 is one pixel short and still reads as arrived.
	assert.equal(canScrollFurther(tallBox(598.9), 'y', 1), true);
	assert.equal(canScrollFurther(tallBox(599), 'y', 1), false);
	assert.equal(canScrollFurther(tallBox(600), 'y', 1), false);
	assert.equal(canScrollFurther(tallBox(0.5), 'y', -1), true);
	assert.equal(canScrollFurther(tallBox(0), 'y', -1), false);
});

test('an unclaimed bottom drag reverses into the live dismiss direction', () => {
	const chain = [tallBox(0)];
	assert.equal(contentClaimDirection(chain, 'y', 'bottom', UP), 0);
	assert.equal(contentClaimDirection(chain, 'y', 'bottom', DOWN), 1);
});

test('content claim waits through jitter and includes the slop boundary', () => {
	assert.equal(CLAIM_SLOP, 5);
	assert.equal(contentClaimDirection([], 'y', 'bottom', 2), 0);
	assert.equal(contentClaimDirection([tallBox(0)], 'y', 'bottom', 2), 0);
	assert.equal(contentClaimDirection([], 'y', 'bottom', 5), 0);
	assert.equal(contentClaimDirection([], 'y', 'bottom', 6), 1);
});

test('content mid-scroll keeps both finger directions', () => {
	assert.equal(contentClaimDirection([tallBox(300)], 'y', 'bottom', UP), 0);
	assert.equal(contentClaimDirection([tallBox(300)], 'y', 'bottom', DOWN), 0);
});

test('a left sheet claims each finger direction only at its matching scroll edge', () => {
	assert.equal(claimFromFinger('left', [wideBox(0)], LEFT), 0);
	assert.equal(claimFromFinger('left', [wideBox(0)], RIGHT), -1);
	assert.equal(claimFromFinger('left', [wideBox(600)], LEFT), 1);
	assert.equal(claimFromFinger('left', [wideBox(600)], RIGHT), 0);
});

test('a right sheet claims each finger direction only at its matching scroll edge', () => {
	assert.equal(claimFromFinger('right', [wideBox(0)], LEFT), 0);
	assert.equal(claimFromFinger('right', [wideBox(0)], RIGHT), 1);
	assert.equal(claimFromFinger('right', [wideBox(600)], LEFT), -1);
	assert.equal(claimFromFinger('right', [wideBox(600)], RIGHT), 0);
});

test('empty content claims past slop with the live away sign for every edge', () => {
	for (const position of ['bottom', 'left', 'right']) {
		const axis = dismissAxis(position);
		for (const offset of [-40, 40]) {
			assert.equal(
				contentClaimDirection([], axis, position, offset),
				Math.sign(offset),
				`${position} away ${offset}`
			);
		}
	}
});

test('LTR horizontal offsets pass through normalization', () => {
	assert.equal(normalizeScrollLeft(300, 1000, 400, false), 300);
});

test('an RTL left edge normalizes to zero with room only toward the right edge', () => {
	const scrollLeft = normalizeScrollLeft(-600, 1000, 400, true);
	const metrics = wideBox(scrollLeft);
	assert.equal(scrollLeft, 0);
	assert.equal(canScrollFurther(metrics, 'x', -1), false);
	assert.equal(canScrollFurther(metrics, 'x', 1), true);
});

test('an RTL start edge normalizes to max with room only toward the left edge', () => {
	const scrollLeft = normalizeScrollLeft(0, 1000, 400, true);
	const metrics = wideBox(scrollLeft);
	assert.equal(scrollLeft, 600);
	assert.equal(canScrollFurther(metrics, 'x', 1), false);
	assert.equal(canScrollFurther(metrics, 'x', -1), true);
});

test('a right sheet claims at the RTL far edge while mid-scroll content consumes', () => {
	const farEdge = wideBox(normalizeScrollLeft(-600, 1000, 400, true));
	const middle = wideBox(normalizeScrollLeft(-300, 1000, 400, true));
	assert.equal(claimFromFinger('right', [farEdge], RIGHT), 1);
	assert.equal(claimFromFinger('right', [middle], RIGHT), 0);
});
