import test from 'node:test';
import assert from 'node:assert/strict';
import * as module from 'node:module';

import { installDomStubs, StubElement } from './element-stub.js';

const hasRegisterHooks = typeof module.registerHooks === 'function';
const elementTest = hasRegisterHooks ? test : test.skip;
let SheetPanel;

if (hasRegisterHooks) {
	installDomStubs();
	const cssHook = module.registerHooks({
		load(url, context, nextLoad) {
			if (url.endsWith('.css')) {
				return { format: 'module', source: '', shortCircuit: true };
			}
			return nextLoad(url, context);
		},
	});
	({ SheetPanel } = await import('../src/sheet.js'));
	cssHook.deregister();
}

function stubGlobal(t, name, value) {
	const had = name in globalThis;
	const original = globalThis[name];
	globalThis[name] = value;
	t.after(() => {
		if (had) globalThis[name] = original;
		else delete globalThis[name];
	});
}

function captureFrames(t) {
	const frames = [];
	stubGlobal(t, 'requestAnimationFrame', (fn) => frames.push(fn));
	return frames;
}

function drainFrames(frames, limit = 1000) {
	let time = 0;
	let count = 0;
	while (frames.length && count < limit) {
		time += 16.66;
		frames.shift()(time);
		count++;
	}
	assert.ok(count < limit, 'spring settled before the safety limit');
}

function pointer(init = {}) {
	return {
		isPrimary: true,
		pointerId: 1,
		clientX: 0,
		clientY: 0,
		timeStamp: 0,
		...init,
	};
}

function makeSheet() {
	const sheet = new SheetPanel();
	const panel = new StubElement('dialog-panel');
	const dialog = new StubElement('dialog');
	const backdrop = new StubElement('dialog-backdrop');
	dialog.rect = {
		top: 0,
		left: 0,
		right: 400,
		bottom: 500,
		width: 400,
		height: 500,
	};
	panel.isOpen = false;
	panel.hideCalls = 0;
	panel.hide = () => {
		panel.hideCalls++;
		return true;
	};
	panel.queryResults.set('dialog-backdrop', backdrop);
	sheet.closestResults.set('dialog-panel', panel);
	sheet.closestResults.set('dialog', dialog);
	sheet.connectedCallback();
	return { backdrop, dialog, engine: panel.morphEngine, panel, sheet };
}

elementTest('show passes the trigger straight through — never substituting the sheet', (t) => {
	const { panel, sheet } = makeSheet();
	t.after(() => sheet.disconnectedCallback());
	const received = [];
	panel.show = (trigger) => {
		received.push(trigger);
		return true;
	};
	const trigger = new StubElement('button');
	sheet.show(trigger);
	sheet.show();

	// The engine declares animatesDialog, so dialog-panel selects the engine
	// transport without a truthy trigger; a substituted trigger would steal
	// focus return. The old `trigger || this` hack must not come back.
	assert.equal(received[0], trigger);
	assert.equal(received[1], undefined);
	assert.equal(panel.morphEngine.animatesDialog, true);
});

elementTest(
	'SheetPanel refuses gesture capture while the engine is entering or exiting',
	async (t) => {
		const frames = captureFrames(t);
		const { dialog, engine, sheet } = makeSheet();
		t.after(() => sheet.disconnectedCallback());
		engine.setSnaps([500], 0);

		const opening = engine.show({ to: dialog });
		assert.equal(engine.state, 'showing');
		sheet.fire('pointerdown', pointer());
		sheet.fire('pointermove', pointer({ clientY: 8, timeStamp: 20 }));
		sheet.fire('pointerup', pointer({ clientY: 8, timeStamp: 40 }));
		assert.equal(sheet.capturedPointerIds.length, 0, 'entrance captures exactly zero pointers');
		drainFrames(frames);
		await opening;

		const hiding = engine.dismiss();
		assert.equal(engine.state, 'hiding');
		sheet.fire('pointerdown', pointer({ timeStamp: 60 }));
		sheet.fire('pointermove', pointer({ clientY: 8, timeStamp: 80 }));
		sheet.fire('pointerup', pointer({ clientY: 8, timeStamp: 100 }));
		assert.equal(sheet.capturedPointerIds.length, 0, 'exit captures exactly zero pointers');
		drainFrames(frames);
		await hiding;
	}
);

elementTest(
	'SheetPanel refuses gesture capture while a profile morph owns the panel',
	async (t) => {
		const frames = captureFrames(t);
		const { dialog, engine, sheet } = makeSheet();
		t.after(() => sheet.disconnectedCallback());
		engine.setSnaps([500], 0);
		const opening = engine.show({ to: dialog });
		drainFrames(frames);
		await opening;
		assert.equal(engine.beginMorph(), true);

		sheet.fire('pointerdown', pointer());
		sheet.fire('pointermove', pointer({ clientY: 8, timeStamp: 20 }));
		sheet.fire('pointerup', pointer({ clientY: 8, timeStamp: 40 }));
		assert.equal(sheet.capturedPointerIds.length, 0, 'morph captures exactly zero pointers');
		engine.endMorph();
	}
);

elementTest(
	'a hide-to-show reversal keeps the painted progress before its first frame',
	async (t) => {
		const frames = captureFrames(t);
		const { dialog, engine, panel, sheet } = makeSheet();
		t.after(() => sheet.disconnectedCallback());
		sheet.setAttribute('snap-points', '500px');
		panel.fire('beforeShow');
		const opening = engine.show({ to: dialog });
		drainFrames(frames);
		await opening;

		const hiding = engine.hide();
		for (let index = 0; index < 5; index++) {
			assert.ok(frames.length > 0, `dismissal frame ${index + 1} is queued`);
			frames.shift()(index * 16.66);
		}
		const progress = panel.style.getPropertyValue('--sheet-progress');
		const backdropProgress = panel.style.getPropertyValue('--sheet-backdrop-progress');
		assert.notEqual(progress, '0.000');
		assert.notEqual(backdropProgress, '0.000');

		panel.fire('beforeShow');
		assert.equal(panel.style.getPropertyValue('--sheet-progress'), progress);
		assert.equal(panel.style.getPropertyValue('--sheet-backdrop-progress'), backdropProgress);

		const reopening = engine.show({ to: dialog });
		assert.equal(panel.style.getPropertyValue('--sheet-progress'), progress);
		assert.equal(panel.style.getPropertyValue('--sheet-backdrop-progress'), backdropProgress);
		drainFrames(frames);
		await Promise.all([hiding, reopening]);
	}
);

elementTest('a refused backdrop micro-drag settles exactly back to the active snap', async (t) => {
	const frames = captureFrames(t);
	const { backdrop, dialog, engine, panel, sheet } = makeSheet();
	t.after(() => sheet.disconnectedCallback());
	sheet.setAttribute('snap-points', '500px');
	sheet.setAttribute('dismiss', 'swipe escape');
	panel.fire('beforeShow');
	panel.isOpen = true;
	const opening = engine.show({ to: dialog });
	drainFrames(frames);
	await opening;

	backdrop.fire('pointerdown', pointer());
	backdrop.fire('pointermove', pointer({ clientY: 6, timeStamp: 20 }));
	assert.equal(engine.currentSize, 494, 'the unslopped move paints the six-pixel displacement');
	backdrop.fire('pointerup', pointer({ clientY: 6, timeStamp: 40 }));
	drainFrames(frames);

	assert.equal(panel.hideCalls, 0);
	const release = sheet.dispatchedEvents.at(-1);
	assert.equal(release.type, 'snaprelease');
	assert.equal(release.bubbles, true);
	assert.equal(release.composed, true);
	assert.deepEqual(release.detail, {
		velocity: 0.15,
		flick: false,
		direction: 'away',
		size: 494,
		target: 0,
		prevented: true,
	});
	assert.equal(engine.currentSize, 500);
	assert.equal(dialog.style.transform, 'translate3d(0px, 0px, 0px) scale(1)');
});

// A bottom panel is sized by a snap point, so inheriting itself past the
// breakpoint stands a one-paragraph sheet as a full-width 85vh slab. Center is
// the one profile sized by its own content, so that is where bottom falls out
// to; every other position rests against an edge on any viewport and inherits
// itself. The entrance follows: desktopEffect already answers fade-scale for a
// desktop center, so a plain bottom sheet must not inherit `slide` and fly a
// viewport height up into the middle of the screen.
elementTest('an unstated desktop position falls out to center only from bottom', () => {
	const sheet = new SheetPanel();

	assert.equal(sheet.position, 'bottom', 'bottom is the mobile default');
	assert.equal(sheet.desktopPosition, 'center');
	assert.equal(sheet.desktopEffect, 'fade-scale');

	sheet.setAttribute('desktop-position', 'bottom');
	assert.equal(sheet.desktopPosition, 'bottom', 'the explicit opt-in still wins');
	assert.equal(sheet.desktopEffect, 'slide', 'and it arrives the way the mobile profile does');
	sheet.removeAttribute('desktop-position');

	for (const position of ['left', 'right', 'center']) {
		sheet.setAttribute('position', position);
		assert.equal(sheet.desktopPosition, position, `${position} inherits itself`);
	}
});
