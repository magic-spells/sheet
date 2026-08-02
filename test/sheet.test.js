import test from 'node:test';
import assert from 'node:assert/strict';

import { hasRegisterHooks, installDomStubs, StubElement } from './element-stub.js';
import { MorphEngine } from './morph-engine-stub.js';

const elementTest = hasRegisterHooks ? test : test.skip;
let SheetPanel;

if (hasRegisterHooks) {
	installDomStubs();
	({ SheetPanel } = await import('../src/sheet.js'));
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

/**
 * @param {Object} [options] - Setup switches.
 * @param {boolean} [options.morphTrigger] - Sets the `morph-trigger` attribute,
 *   which is what opts a sheet into growing out of its trigger. Without it a
 *   trigger is focus-return only and the entrance is the ordinary spring.
 */
function makeSheet({ morphTrigger = false } = {}) {
	const sheet = new SheetPanel();
	if (morphTrigger) sheet.setAttribute('morph-trigger', '');
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

function makeTrigger() {
	const trigger = new StubElement('button');
	trigger.rect = {
		top: 120,
		left: 40,
		right: 88,
		bottom: 168,
		width: 48,
		height: 48,
	};
	return trigger;
}

function wirePanelTransport({ dialog, engine, panel }) {
	panel.showModes = [];
	panel.hideModes = [];
	panel.show = (trigger) => {
		const direct = engine.animatesDialog;
		panel.showModes.push(direct);
		if (panel.fire('beforeShow').defaultPrevented) return false;
		if (direct) panel.isOpen = true;
		void engine.show({ from: trigger, to: dialog, display: 'flex' });
		return true;
	};
	panel.hide = () => {
		const direct = engine.animatesDialog;
		panel.hideModes.push(direct);
		if (panel.fire('beforeHide').defaultPrevented) return false;
		if (!direct) panel.isOpen = false;
		void engine.hide();
		return true;
	};
	engine.on('reveal', () => {
		panel.isOpen = true;
	});
	engine.on('shown', () => {
		panel.isOpen = true;
		panel.fire('shown');
	});
	engine.on('hidden', () => {
		panel.isOpen = false;
		panel.fire('hidden');
	});
}

function makeMorphSheet(t) {
	MorphEngine.instances.length = 0;
	const result = makeSheet({ morphTrigger: true });
	wirePanelTransport(result);
	t.after(() => {
		if (result.sheet.hasAttribute('engine')) result.sheet.disconnectedCallback();
	});
	return result;
}

function currentBlob() {
	return MorphEngine.instances.at(-1);
}

function blobsInBody() {
	return document.body.children.filter((child) => child.tagName === 'MORPH-BLOB');
}

elementTest('a show without a trigger keeps the spring entrance unchanged', async (t) => {
	const frames = captureFrames(t);
	const { dialog, engine, panel, sheet } = makeSheet();
	t.after(() => sheet.disconnectedCallback());
	panel.fire('beforeShow');

	const showing = engine.show({ to: dialog });

	assert.equal(engine.animatesDialog, true);
	assert.ok(frames.length > 0, 'the ordinary entrance spring is running');
	drainFrames(frames);
	await showing;
});

// show(trigger) is the documented way to open EVERY sheet, and the trigger has
// always been focus-return only. Morphing on its mere presence would silently
// rewrite the entrance of every consumer following that documentation, so the
// `morph-trigger` attribute — absent here — is what has to decide.
elementTest('a trigger without morph-trigger keeps the spring entrance', async (t) => {
	const frames = captureFrames(t);
	const { dialog, engine, panel, sheet } = makeSheet();
	t.after(() => sheet.disconnectedCallback());
	panel.fire('beforeShow');

	const showing = engine.show({ from: makeTrigger(), to: dialog });

	assert.equal(engine.animatesDialog, true, 'the un-opted sheet stays on the direct transport');
	assert.ok(frames.length > 0, 'the ordinary entrance spring is running');
	drainFrames(frames);
	await showing;
	assert.equal(engine.state, 'shown');
});

elementTest('each trigger-morph arming gate independently keeps the direct transport', (t) => {
	const originalWidth = window.innerWidth;
	const originalHeight = window.innerHeight;
	t.after(() => {
		window.innerWidth = originalWidth;
		window.innerHeight = originalHeight;
	});
	window.innerWidth = 400;
	window.innerHeight = 800;

	const cases = [
		['no morph-trigger attribute', {}, makeTrigger()],
		['no trigger', { morphTrigger: true }, undefined],
		['detached trigger', { morphTrigger: true }, Object.assign(makeTrigger(), { isConnected: false })],
		[
			'zero-size trigger',
			{ morphTrigger: true },
			Object.assign(makeTrigger(), { rect: { top: 20, left: 20, right: 20, bottom: 20, width: 0, height: 0 } }),
		],
		[
			'trigger outside the viewport',
			{ morphTrigger: true },
			Object.assign(makeTrigger(), { rect: { top: 900, left: 20, right: 68, bottom: 948, width: 48, height: 48 } }),
		],
	];

	for (const [label, options, trigger] of cases) {
		const { engine, panel, sheet } = makeSheet(options);
		let direct;
		panel.show = () => {
			direct = engine.animatesDialog;
			return true;
		};
		sheet.show(trigger);
		assert.equal(direct, true, label);
		assert.equal(engine.animatesDialog, true, label);
		sheet.disconnectedCallback();
	}

	const { dialog, engine, panel, sheet } = makeSheet({ morphTrigger: true });
	dialog.style.setProperty('--sheet-morph-duration', '0ms');
	let direct;
	panel.show = () => {
		direct = engine.animatesDialog;
		return true;
	};
	sheet.show(makeTrigger());
	assert.equal(direct, true, 'zero morph duration');
	assert.equal(engine.animatesDialog, true, 'zero morph duration');
	sheet.disconnectedCallback();
});

elementTest('a trigger morph opens through one blob and hands the settled frame to SheetEngine', (t) => {
	const { dialog, engine, panel, sheet } = makeMorphSheet(t);
	const trigger = makeTrigger();
	const progress = [];
	const reveals = [];
	let shown = 0;
	engine.on('change', ({ backdropProgress }) => progress.push(backdropProgress));
	engine.on('reveal', (detail) => reveals.push(detail));
	engine.on('shown', () => shown++);

	sheet.show(trigger);
	const blob = currentBlob();

	assert.equal(engine.animatesDialog, false);
	assert.equal(panel.showModes[0], false);
	assert.equal(blob.runs.length, 1);
	assert.equal(trigger.style.visibility, 'hidden');
	assert.equal(dialog.style.transform ?? '', '', 'SheetEngine paints no transform mid-flight');
	assert.equal(dialog.style.height ?? '', '', 'SheetEngine paints no height mid-flight');
	assert.equal(blobsInBody().length, 1);

	for (const p of [0.2, 0.5, 0.75, 1]) blob.step(p);
	assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));
	assert.equal(reveals.length, 1);
	assert.equal(reveals[0].to, dialog);
	assert.equal(engine.state, 'shown');
	assert.equal(panel.style['--sheet-progress'], '1.000');
	assert.equal(dialog.style.transform, 'translate3d(0px, 0px, 0px) scale(1)');
	assert.equal(dialog.style.height, '680px');
	assert.equal(shown, 1);
	assert.equal(blobsInBody().length, 0);
});

elementTest('a deliberate close morphs back and restores both owners exactly once', (t) => {
	const { dialog, engine, panel, sheet } = makeMorphSheet(t);
	const trigger = makeTrigger();
	let hidden = 0;
	engine.on('hidden', () => hidden++);
	sheet.show(trigger);
	const blob = currentBlob();
	blob.step(1);

	sheet.hide();
	assert.equal(panel.hideModes[0], false);
	assert.equal(panel.style['--sheet-backdrop-progress'], '1.000');
	blob.step(0.25);
	assert.equal(panel.style['--sheet-backdrop-progress'], '0.750');
	blob.step(1);

	assert.equal(panel.style['--sheet-backdrop-progress'], '0.000');
	assert.equal(hidden, 1);
	assert.equal(engine.state, 'hidden');
	assert.equal(dialog.style.getPropertyValue('transform'), '');
	assert.equal(dialog.style.getPropertyValue('height'), '');
	assert.equal(trigger.style.getPropertyValue('visibility'), '');
	assert.equal(blobsInBody().length, 0);
});

elementTest('a swipe close releases the blob before the exact spring exit', (t) => {
	const frames = captureFrames(t);
	const { dialog, engine, panel, sheet } = makeMorphSheet(t);
	const trigger = makeTrigger();
	const exitTransforms = [];
	sheet.show(trigger);
	currentBlob().step(1);
	engine.on('change', ({ phase }) => {
		if (phase === 'hiding') exitTransforms.push(dialog.style.transform);
	});

	sheet.fire('pointerdown', pointer());
	sheet.fire('pointermove', pointer({ clientY: 420, timeStamp: 40 }));
	sheet.fire('pointerup', pointer({ clientY: 420, timeStamp: 60 }));

	assert.equal(panel.hideModes[0], true);
	assert.equal(
		trigger.style.getPropertyValue('visibility'),
		'',
		'trigger is restored before the first spring frame'
	);
	assert.equal(blobsInBody().length, 0, 'the blob is released before the spring starts');
	assert.ok(frames.length > 0, 'the configured exit spring owns the dismissal');
	drainFrames(frames);
	assert.equal(engine.state, 'hidden');
	assert.equal(exitTransforms.at(-1), 'translate3d(0px, 708px, 0px) scale(1)');
});

elementTest('a vetoed gesture leaves the blob shown and the next deliberate close reverses', (t) => {
	const frames = captureFrames(t);
	const { engine, panel, sheet } = makeMorphSheet(t);
	const trigger = makeTrigger();
	sheet.show(trigger);
	const blob = currentBlob();
	blob.step(1);
	let veto = true;
	panel.addEventListener('beforeHide', (event) => {
		if (!veto) return;
		veto = false;
		event.preventDefault();
	});

	sheet.fire('pointerdown', pointer());
	sheet.fire('pointermove', pointer({ clientY: 420, timeStamp: 40 }));
	sheet.fire('pointerup', pointer({ clientY: 420, timeStamp: 60 }));
	drainFrames(frames);

	assert.equal(engine.state, 'shown');
	assert.equal(blob.state, 'shown');
	assert.equal(trigger.style.visibility, 'hidden');
	sheet.hide();
	assert.equal(panel.hideModes.at(-1), false);
	assert.equal(blob.runs.at(-1).phase, 'hiding');
	blob.step(1);
	assert.equal(engine.state, 'hidden');
});

elementTest('hide during entrance reverses one blob run without restarting the backdrop', (t) => {
	const { engine, panel, sheet } = makeMorphSheet(t);
	let shown = 0;
	let hidden = 0;
	engine.on('shown', () => shown++);
	engine.on('hidden', () => hidden++);
	sheet.show(makeTrigger());
	const blob = currentBlob();
	blob.step(0.4);
	const beforeTurn = panel.style['--sheet-backdrop-progress'];
	sheet.hide();

	assert.equal(panel.style['--sheet-backdrop-progress'], beforeTurn);
	assert.equal(blob.runs.length, 1);
	assert.deepEqual(blob.reversals, [{ from: 'showing', to: 'hiding', progress: 0.4 }]);
	blob.step(0);
	assert.equal(shown, 0);
	assert.equal(hidden, 1);
});

elementTest('show during reverse turns the same blob and re-reveals synchronously', (t) => {
	const { dialog, engine, panel, sheet } = makeMorphSheet(t);
	const trigger = makeTrigger();
	sheet.show(trigger);
	const blob = currentBlob();
	blob.step(1);
	sheet.hide();
	blob.step(0.4);
	const beforeTurn = panel.style['--sheet-backdrop-progress'];
	let reveals = 0;
	let shown = 0;
	engine.on('reveal', ({ to }) => {
		assert.equal(to, dialog);
		reveals++;
	});
	engine.on('shown', () => shown++);

	sheet.show(trigger);
	assert.equal(reveals, 1, 'the reverse emits reveal in the show() task');
	assert.equal(panel.style['--sheet-backdrop-progress'], beforeTurn);
	assert.equal(blob.runs.length, 2, 'the landed hide is the only second run');
	assert.deepEqual(blob.reversals, [{ from: 'hiding', to: 'showing', progress: 0.4 }]);
	blob.step(0);
	assert.equal(shown, 1);
});

for (const action of ['stop', 'destroy', 'disconnectedCallback']) {
	elementTest(`${action} mid-flight clears both owners and the next show paints p = 0`, (t) => {
		const frames = captureFrames(t);
		const result = makeMorphSheet(t);
		const { dialog, engine, panel, sheet } = result;
		const trigger = makeTrigger();
		sheet.show(trigger);
		currentBlob().step(0.4);

		if (action === 'disconnectedCallback') sheet.disconnectedCallback();
		else engine[action]();
		assert.equal(blobsInBody().length, 0);
		assert.equal(trigger.style.getPropertyValue('visibility'), '');
		assert.equal(dialog.style.transform ?? '', '');
		assert.equal(dialog.style.height ?? '', '');

		if (action !== 'stop') {
			if (sheet.hasAttribute('engine')) sheet.disconnectedCallback();
			sheet.connectedCallback();
			result.engine = panel.morphEngine;
			wirePanelTransport({ dialog, engine: result.engine, panel });
		}
		sheet.show();
		assert.equal(panel.style['--sheet-progress'], '0.000');
		assert.equal(dialog.style.transform, 'translate3d(0px, 708px, 0px) scale(1)');
		drainFrames(frames);
	});
}

elementTest('a profile change waits for the blob and applies after shown', async (t) => {
	const originalWidth = window.innerWidth;
	window.innerWidth = 400;
	t.after(() => {
		window.innerWidth = originalWidth;
	});
	const { engine, sheet } = makeMorphSheet(t);
	sheet.setAttribute('breakpoint', '600');
	sheet.setAttribute('desktop-position', 'right');
	sheet.show(makeTrigger());
	const blob = currentBlob();
	assert.equal(sheet.dataset.position, 'bottom');
	assert.equal(sheet.dataset.desktop, 'false');

	window.innerWidth = 800;
	window.fire('resize');
	await new Promise((resolve) => setTimeout(resolve, 110));
	assert.equal(engine.blobFlight, true);
	assert.equal(sheet.dataset.position, 'bottom');
	assert.equal(sheet.dataset.desktop, 'false');

	blob.step(1);
	assert.equal(sheet.dataset.position, 'right');
	assert.equal(sheet.dataset.desktop, 'true');
});

elementTest('a vanished close trigger releases the blob and takes the direct spring exit', (t) => {
	const frames = captureFrames(t);
	const { engine, panel, sheet } = makeMorphSheet(t);
	const trigger = makeTrigger();
	sheet.show(trigger);
	currentBlob().step(1);
	trigger.isConnected = false;

	assert.equal(engine.animatesDialog, true, 'the pure getter classifies without releasing');
	assert.equal(trigger.style.visibility, 'hidden');
	sheet.hide();
	assert.equal(panel.hideModes[0], true);
	assert.equal(trigger.style.getPropertyValue('visibility'), '');
	assert.equal(blobsInBody().length, 0);
	assert.ok(frames.length > 0);
	drainFrames(frames);
	assert.equal(engine.state, 'hidden');
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
