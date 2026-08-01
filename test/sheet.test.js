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
	dialog.rect = {
		top: 0,
		left: 0,
		right: 400,
		bottom: 500,
		width: 400,
		height: 500,
	};
	panel.isOpen = false;
	panel.hide = () => true;
	sheet.closestResults.set('dialog-panel', panel);
	sheet.closestResults.set('dialog', dialog);
	sheet.connectedCallback();
	return { dialog, engine: panel.morphEngine, panel, sheet };
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

elementTest(
	'a widened desktop side-card token is the exact engine rest width on both sides',
	(t) => {
		const { dialog, engine, panel, sheet } = makeSheet();
		t.after(() => sheet.disconnectedCallback());
		const originalWidth = window.innerWidth;
		window.innerWidth = 1200;
		t.after(() => {
			window.innerWidth = originalWidth;
		});

		const originalComputedStyle = globalThis.getComputedStyle;
		stubGlobal(t, 'getComputedStyle', (element) => {
			const computed = originalComputedStyle(element);
			return {
				...computed,
				getPropertyValue(name) {
					if (element === dialog && name === '--sheet-desktop-panel-width') {
						return 'min(480px, 90vw)';
					}
					return computed.getPropertyValue(name);
				},
			};
		});

		const originalCreateElement = document.createElement;
		document.createElement = (tagName) => {
			const element = originalCreateElement(tagName);
			const readRect = element.getBoundingClientRect.bind(element);
			element.getBoundingClientRect = () => {
				const width = String(element.style.width || '').trim();
				if (width === 'min(480px, 90vw)') {
					return { top: 0, left: 0, right: 480, bottom: 0, width: 480, height: 0 };
				}
				if (width === 'min(26rem, 90vw)') {
					return { top: 0, left: 0, right: 416, bottom: 0, width: 416, height: 0 };
				}
				return readRect();
			};
			return element;
		};
		t.after(() => {
			document.createElement = originalCreateElement;
		});

		sheet.setAttribute('desktop-mode', 'card');
		for (const position of ['left', 'right']) {
			sheet.setAttribute('position', position);
			panel.fire('beforeShow');
			assert.deepEqual(engine.snaps, [480], `${position} card rests at its painted 480px`);
		}

		// Edge mode deliberately uses the generic side-width fallback, not the
		// desktop card token. Pinning it here prevents the card fix spreading into
		// geometry whose existing 26rem fallback is already correct.
		sheet.setAttribute('desktop-mode', 'edge');
		panel.fire('beforeShow');
		assert.deepEqual(engine.snaps, [416]);
	}
);

elementTest('a consumer --sheet-active-size still caps a desktop side card', (t) => {
	// The other half of the same CSS expression. A desktop card is painted
	// `min(var(--sheet-active-size, var(--sheet-desktop-panel-width)),
	// var(--sheet-desktop-panel-width))` — a min of two terms, not a choice
	// between them. Probing only the desktop token satisfies the widened-token
	// test above while silently ignoring the narrower width a consumer asked
	// for, which is the same divergence that test exists to catch, mirrored.
	// CLAUDE.md's sizing rules name --sheet-active-size as THE way to give a
	// side sheet its width, so this is the documented path, not a corner.
	const { dialog, engine, panel, sheet } = makeSheet();
	t.after(() => sheet.disconnectedCallback());
	const originalWidth = window.innerWidth;
	window.innerWidth = 1200;
	t.after(() => {
		window.innerWidth = originalWidth;
	});

	const originalComputedStyle = globalThis.getComputedStyle;
	stubGlobal(t, 'getComputedStyle', (element) => {
		const computed = originalComputedStyle(element);
		return {
			...computed,
			getPropertyValue(name) {
				if (element === dialog && name === '--sheet-desktop-panel-width') {
					return 'min(480px, 90vw)';
				}
				if (element === dialog && name === '--sheet-active-size') return '300px';
				return computed.getPropertyValue(name);
			},
		};
	});

	const originalCreateElement = document.createElement;
	document.createElement = (tagName) => {
		const element = originalCreateElement(tagName);
		const readRect = element.getBoundingClientRect.bind(element);
		element.getBoundingClientRect = () => {
			const width = String(element.style.width || '').trim();
			if (width === 'min(480px, 90vw)') {
				return { top: 0, left: 0, right: 480, bottom: 0, width: 480, height: 0 };
			}
			if (width === '300px') {
				return { top: 0, left: 0, right: 300, bottom: 0, width: 300, height: 0 };
			}
			return readRect();
		};
		return element;
	};
	t.after(() => {
		document.createElement = originalCreateElement;
	});

	sheet.setAttribute('desktop-mode', 'card');
	sheet.setAttribute('position', 'right');
	panel.fire('beforeShow');
	assert.deepEqual(engine.snaps, [300], 'the narrower consumer width wins the min');

	// And edge mode, which has no cap at all, takes it whole.
	sheet.setAttribute('desktop-mode', 'edge');
	panel.fire('beforeShow');
	assert.deepEqual(engine.snaps, [300], 'edge mode reads the same token with no cap');
});

elementTest(
	'changing effect on an open panel updates the profile without a no-op morph',
	async (t) => {
		const frames = captureFrames(t);
		const { dialog, engine, panel, sheet } = makeSheet();
		t.after(() => sheet.disconnectedCallback());
		sheet.setAttribute('snap-points', '500px');
		panel.fire('beforeShow');
		panel.isOpen = true;
		const opening = engine.show({ to: dialog });
		drainFrames(frames);
		await opening;

		sheet.setAttribute('effect', 'slide-fade');
		sheet.attributeChangedCallback('effect', null, 'slide-fade');

		assert.equal(engine.state, 'shown');
		assert.equal(engine.morphing, false);
		assert.equal(sheet.dataset.effect, 'slide-fade');
		assert.equal(dialog.style.transition, undefined);
	}
);

elementTest(
	'changing desktop-effect on an open desktop panel updates without a no-op morph',
	async (t) => {
		const frames = captureFrames(t);
		const originalWidth = window.innerWidth;
		window.innerWidth = 1200;
		t.after(() => {
			window.innerWidth = originalWidth;
		});
		const { dialog, engine, panel, sheet } = makeSheet();
		t.after(() => sheet.disconnectedCallback());
		sheet.setAttribute('position', 'right');
		dialog.style.setProperty('--sheet-desktop-panel-width', '480px');
		panel.fire('beforeShow');
		panel.isOpen = true;
		const opening = engine.show({ to: dialog });
		drainFrames(frames);
		await opening;

		sheet.setAttribute('desktop-effect', 'slide-fade');
		sheet.attributeChangedCallback('desktop-effect', null, 'slide-fade');

		assert.equal(engine.state, 'shown');
		assert.equal(engine.morphing, false);
		assert.equal(sheet.dataset.effect, 'slide-fade');
		assert.equal(dialog.style.transition, undefined);
	}
);

elementTest('intrinsic box measurement neutralises and restores an inline transform', (t) => {
	const originalWidth = window.innerWidth;
	window.innerWidth = 1200;
	t.after(() => {
		window.innerWidth = originalWidth;
	});
	const { dialog, engine, panel, sheet } = makeSheet();
	t.after(() => sheet.disconnectedCallback());
	const entranceTransform = 'translate3d(0px, 0px, 0px) scale(0.95)';
	dialog.style.transform = entranceTransform;
	dialog.getBoundingClientRect = () => {
		const transformed = dialog.style.transform !== 'none';
		const height = transformed ? 475 : 500;
		return { top: 0, left: 0, right: 400, bottom: height, width: 400, height };
	};

	panel.fire('beforeShow');

	assert.deepEqual(engine.snaps, [500]);
	assert.equal(dialog.style.transform, entranceTransform);
});
