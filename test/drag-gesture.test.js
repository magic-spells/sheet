import test from 'node:test';
import assert from 'node:assert/strict';

import { DragGesture, VelocityTracker } from '../src/drag-gesture.js';

class StubElement {
	constructor() {
		this.listeners = new Map();
		this.capturedPointerId = null;
	}

	addEventListener(type, listener) {
		this.listeners.set(type, listener);
	}

	removeEventListener(type, listener) {
		if (this.listeners.get(type) === listener) this.listeners.delete(type);
	}

	setPointerCapture(pointerId) {
		this.capturedPointerId = pointerId;
	}

	fire(type, event) {
		this.listeners.get(type)?.(event);
	}
}

const ev = (overrides = {}) => ({
	isPrimary: true,
	pointerId: 1,
	clientX: 0,
	clientY: 0,
	timeStamp: 0,
	...overrides,
});

test('VelocityTracker calculates velocity over its sample window', () => {
	const tracker = new VelocityTracker();
	tracker.add(0, 0);
	tracker.add(100, 100);
	assert.equal(tracker.velocity, 1);
});

test('VelocityTracker evicts stale samples after a pause', () => {
	const tracker = new VelocityTracker(100);
	tracker.add(0, 0);
	tracker.add(100, 50);
	tracker.add(110, 200);
	assert.equal(tracker.velocity, 10 / 150);
});

test('VelocityTracker returns zero with fewer than two samples', () => {
	const tracker = new VelocityTracker();
	assert.equal(tracker.velocity, 0);
	tracker.add(20, 10);
	assert.equal(tracker.velocity, 0);
});

test('VelocityTracker reports the last leg, not the whole window', () => {
	const tracker = new VelocityTracker();
	// Fast one way, then pulled back the other before release. Averaging the
	// window reports the direction the gesture came FROM, so the sheet leaves
	// opposite to the finger that released it.
	tracker.add(0, 0);
	tracker.add(120, 60);
	tracker.add(80, 100);
	assert.ok(tracker.velocity < 0, 'reversal wins over the earlier travel');
	assert.equal(tracker.velocity, -40 / 40);
});

test('VelocityTracker skips zero-length steps when finding the reversal', () => {
	const tracker = new VelocityTracker();
	// A slow drag quantises to repeated positions constantly; those are not
	// turns and must not cut the run short.
	tracker.add(0, 0);
	tracker.add(10, 20);
	tracker.add(10, 40);
	tracker.add(20, 60);
	assert.equal(tracker.velocity, 20 / 60);
});

test('DragGesture reports no flick for a finger that stopped before lifting', () => {
	const el = new StubElement();
	let end = null;
	const gesture = new DragGesture(el, { onEnd: (info) => (end = info) });

	el.fire('pointerdown', ev({ clientY: 0, timeStamp: 0 }));
	el.fire('pointermove', ev({ clientY: 100, timeStamp: 40 }));
	el.fire('pointermove', ev({ clientY: 200, timeStamp: 80 }));
	// Held still for 300ms. A stationary pointer fires no pointermove, so
	// without sampling the release the window never ages past the last motion.
	el.fire('pointerup', ev({ clientY: 200, timeStamp: 380 }));

	assert.ok(Math.abs(end.velocityY) < 0.05, `expected a dead stop, got ${end.velocityY}`);
	gesture.destroy();
});

test('DragGesture reports a complete start, move, and end flow', () => {
	const el = new StubElement();
	const calls = [];
	const gesture = new DragGesture(el, {
		onStart: (info) => calls.push(['start', info]),
		onMove: (info) => calls.push(['move', info]),
		onEnd: (info) => calls.push(['end', info]),
	});

	el.fire('pointerdown', ev({ clientY: 20, timeStamp: 10 }));
	assert.equal(el.capturedPointerId, null);
	el.fire('pointermove', ev({ clientY: 120, timeStamp: 110 }));
	el.fire('pointerup', ev({ clientY: 130, timeStamp: 130 }));

	assert.equal(el.capturedPointerId, 1);
	assert.equal(calls[0][1].y, 20);
	assert.equal(calls[1][1].deltaY, 100);
	assert.equal(calls[1][1].direction, 'down');
	assert.ok(calls[1][1].velocityY > 0.9);
	assert.equal(calls[2][1].deltaY, 110);
	assert.equal(calls[2][1].duration, 120);
	// The release is its own sample, so the reported velocity is the finger's
	// speed into the lift (10px over the last 20ms) rather than the faster
	// stretch it arrived on. The window evicts the pointerdown sample at t=10.
	assert.equal(calls[2][1].velocityY, 0.5);
	assert.equal(calls[2][1].cancelled, false);
	gesture.destroy();
});

test('DragGesture leaves a tap uncaptured so clicks reach interactive children', () => {
	const el = new StubElement();
	const gesture = new DragGesture(el);
	el.fire('pointerdown', ev({ clientY: 40 }));
	el.fire('pointermove', ev({ clientY: 43, timeStamp: 20 }));
	el.fire('pointerup', ev({ clientY: 42, timeStamp: 40 }));
	assert.equal(el.capturedPointerId, null);
	gesture.destroy();
});

test('DragGesture captures once two-axis movement passes slop', () => {
	const el = new StubElement();
	const gesture = new DragGesture(el);
	el.fire('pointerdown', ev({ clientX: 40, clientY: 40 }));
	el.fire('pointermove', ev({ clientX: 43, clientY: 43, timeStamp: 20 }));
	assert.equal(el.capturedPointerId, null);
	el.fire('pointermove', ev({ clientX: 45, clientY: 45, timeStamp: 40 }));
	assert.equal(el.capturedPointerId, 1);
	gesture.destroy();
});

test('DragGesture captures on upward drags', () => {
	const el = new StubElement();
	const gesture = new DragGesture(el);
	el.fire('pointerdown', ev({ clientY: 200 }));
	el.fire('pointermove', ev({ clientY: 170, timeStamp: 20 }));
	assert.equal(el.capturedPointerId, 1);
	gesture.destroy();
});

test('DragGesture abandons a gesture its onStart refuses', () => {
	const el = new StubElement();
	const calls = [];
	const gesture = new DragGesture(el, {
		// The panel surface refuses bubbled pointerdowns whose hit target is a
		// child surface; a refused gesture must go fully inert, or it captures
		// the pointer out from under the surface that owns it at slop.
		onStart: () => {
			calls.push('start');
			return false;
		},
		onMove: () => calls.push('move'),
		onEnd: () => calls.push('end'),
	});

	el.fire('pointerdown', ev({ timeStamp: 0 }));
	el.fire('pointermove', ev({ clientY: 100, timeStamp: 40 }));
	el.fire('pointerup', ev({ clientY: 120, timeStamp: 80 }));

	assert.deepEqual(calls, ['start']);
	assert.equal(el.capturedPointerId, null, 'a refused gesture must not capture the pointer');
	gesture.destroy();
});

test('DragGesture ignores non-primary and foreign pointers', () => {
	const el = new StubElement();
	const calls = [];
	const gesture = new DragGesture(el, {
		onStart: () => calls.push('start'),
		onMove: () => calls.push('move'),
		onEnd: () => calls.push('end'),
	});

	el.fire('pointerdown', ev({ isPrimary: false }));
	el.fire('pointermove', ev());
	el.fire('pointerup', ev());
	assert.deepEqual(calls, []);

	el.fire('pointerdown', ev());
	el.fire('pointermove', ev({ pointerId: 2, clientY: 100 }));
	el.fire('pointerup', ev({ pointerId: 2, clientY: 100 }));
	assert.deepEqual(calls, ['start']);
	el.fire('pointerup', ev());
	assert.deepEqual(calls, ['start', 'end']);
	gesture.destroy();
});

test('DragGesture reports pointer cancellation with zero velocity on both axes', () => {
	const el = new StubElement();
	let endInfo;
	const gesture = new DragGesture(el, {
		onEnd: (info) => {
			endInfo = info;
		},
	});
	el.fire('pointerdown', ev());
	el.fire('pointermove', ev({ clientX: 50, clientY: 100, timeStamp: 100 }));
	el.fire('pointercancel', ev({ clientX: 60, clientY: 120, timeStamp: 120 }));
	assert.equal(endInfo.cancelled, true);
	assert.equal(endInfo.velocityX, 0);
	assert.equal(endInfo.velocityY, 0);
	gesture.destroy();
});

test('DragGesture destroy removes every listener', () => {
	const el = new StubElement();
	const gesture = new DragGesture(el);
	assert.deepEqual([...el.listeners.keys()].sort(), [
		'pointercancel',
		'pointerdown',
		'pointermove',
		'pointerup',
	]);
	gesture.destroy();
	assert.equal(el.listeners.size, 0);
});

test('DragGesture reports horizontal delta, direction, and velocity', () => {
	const el = new StubElement();
	let moveInfo;
	const gesture = new DragGesture(el, {
		onMove: (info) => {
			moveInfo = info;
		},
	});
	el.fire('pointerdown', ev({ clientX: 100, timeStamp: 0 }));
	el.fire('pointermove', ev({ clientX: 20, clientY: 10, timeStamp: 80 }));
	assert.equal(moveInfo.deltaX, -80);
	assert.equal(moveInfo.deltaY, 10);
	assert.equal(moveInfo.direction, 'left');
	assert.ok(moveInfo.velocityX < -0.9);
	gesture.destroy();
});

test('DragGesture chooses direction from the dominant total-delta axis', () => {
	const el = new StubElement();
	const directions = [];
	const gesture = new DragGesture(el, {
		onMove: ({ direction }) => directions.push(direction),
	});
	el.fire('pointerdown', ev());
	el.fire('pointermove', ev({ clientX: 60, clientY: -20, timeStamp: 20 }));
	el.fire('pointermove', ev({ clientX: 20, clientY: -80, timeStamp: 40 }));
	assert.deepEqual(directions, ['right', 'up']);
	gesture.destroy();
});
