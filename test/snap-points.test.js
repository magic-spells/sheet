import test from 'node:test';
import assert from 'node:assert/strict';

import {
	resolveInitialSnap,
	resolveSnapPoints,
	resolveSnapTarget,
	SNAP_EPSILON,
} from '../src/snap-points.js';

const SNAPS = [200, 550, 900];
const FLICK_VELOCITY = 0.5;

function target(currentSize, velocityAway) {
	return resolveSnapTarget({
		currentSize,
		velocityAway,
		snaps: SNAPS,
		flickVelocity: FLICK_VELOCITY,
	});
}

test('resolveSnapPoints converts viewport lengths and sorts them', () => {
	assert.deepEqual(
		resolveSnapPoints('90vh 20vh 55vh', {
			viewportHeight: 1000,
			viewportWidth: 1200,
		}),
		[200, 550, 900]
	);
});

test('resolveSnapPoints handles px, rem, vw, percentages, and duplicates', () => {
	assert.deepEqual(
		resolveSnapPoints('100px 5rem 10vw 25% 100px', {
			viewportHeight: 800,
			viewportWidth: 1000,
			rootFontSize: 16,
			percentageBase: 400,
		}),
		[80, 100]
	);
});

test('resolveSnapPoints keeps spaced calc() expressions as one token', () => {
	const measured = [];
	const values = {
		'calc(100vh - 2rem)': 968,
		'50vh': 500,
	};
	assert.deepEqual(
		resolveSnapPoints('calc(100vh - 2rem) 50vh', {
			viewportHeight: 1000,
			measure: (token) => {
				measured.push(token);
				return values[token];
			},
		}),
		[500, 968]
	);
	assert.deepEqual(measured, ['calc(100vh - 2rem)', '50vh']);
});

test('resolveSnapPoints keeps min() and clamp() expressions intact', () => {
	for (const [value, pixels] of [
		['min(400px, 50vh)', 400],
		['clamp(20rem, 50vh, 30rem)', 480],
	]) {
		const measured = [];
		assert.deepEqual(
			resolveSnapPoints(value, {
				viewportHeight: 1000,
				measure: (token) => {
					measured.push(token);
					return pixels;
				},
			}),
			[pixels]
		);
		assert.deepEqual(measured, [value]);
	}
});

test('resolveSnapPoints leaves plain whitespace-separated lists unchanged', () => {
	const measured = [];
	resolveSnapPoints('90vh 20vh 55vh', {
		viewportHeight: 1000,
		measure: (token) => {
			measured.push(token);
			return Number.parseFloat(token) * 10;
		},
	});
	assert.deepEqual(measured, ['90vh', '20vh', '55vh']);
});

test('resolveInitialSnap defaults to the largest snap and clamps explicit indices', () => {
	const snaps = [200, 550, 900];
	assert.equal(resolveInitialSnap(null, snaps), 2);
	assert.equal(resolveInitialSnap('', snaps), 2);
	assert.equal(resolveInitialSnap('1', snaps), 1);
	assert.equal(resolveInitialSnap('99', snaps), 2);
	assert.equal(resolveInitialSnap('-4', snaps), 0);
	assert.equal(resolveInitialSnap(null, []), -1);
});

test('an upward flick steps to the next snap above the live position', () => {
	assert.equal(target(550, -0.8), 2);
});

test('a downward flick steps to the next snap below the live position', () => {
	assert.equal(target(550, 0.8), 0);
});

test('a flick resolves from a mid-drag position that crossed snaps', () => {
	assert.equal(
		target(880, -0.8),
		2,
		'an up-flick near 90vh keeps moving up instead of targeting the middle snap'
	);
	assert.equal(
		target(880, 0.8),
		1,
		'a down-flick near 90vh steps down from the live position instead of dismissing'
	);
});

test('a dismiss-direction flick below the lowest snap resolves to dismissal', () => {
	assert.equal(target(150, 0.8), null);
});

test('a sub-threshold release chooses the nearest snap or closed edge', () => {
	assert.equal(target(520, 0.2), 1);
	assert.equal(target(80, 0.2), null, 'zero remains a dismissal candidate');
	assert.equal(target(520, FLICK_VELOCITY), 1, 'the threshold itself is not a flick');
});

test('SNAP_EPSILON steps past the snap under sub-pixel release noise', () => {
	assert.equal(SNAP_EPSILON, 1);
	assert.equal(target(550 + SNAP_EPSILON * 0.75, 0.8), 0);
	assert.equal(target(550 - SNAP_EPSILON * 0.75, -0.8), 2);
});

test('inward overscroll cannot make a flick resolve to the snap it started on', () => {
	const top = SNAPS[SNAPS.length - 1];
	// #applyLiveOffset rubber-bands an overpull u past the top snap to
	// `top + 2*sqrt(u)`, which clears SNAP_EPSILON as soon as u passes 0.25px —
	// a quarter pixel of finger travel. Every one of these released above it.
	const overpulled = [
		top + 2 * Math.sqrt(0.3),
		top + 2 * Math.sqrt(5),
		top + 2 * Math.sqrt(25),
		top + 200,
	];
	for (const size of overpulled) {
		assert.ok(size > top + SNAP_EPSILON, `${size} is past the epsilon`);
		assert.equal(target(size, 0.8), 1, `a down-flick from ${size} steps to 550`);
		assert.equal(target(size, -0.8), 2, `an up-flick from ${size} holds the top`);
		assert.equal(target(size, 0.2), 2, `a slow release from ${size} returns to the top`);
	}
});
