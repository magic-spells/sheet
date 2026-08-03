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
	dialog.open = false;
	dialog.returnValue = '';
	dialog.showModalCalls = 0;
	dialog.showModal = () => {
		dialog.open = true;
		dialog.showModalCalls++;
	};
	dialog.close = (result) => {
		if (result !== undefined) dialog.returnValue = result;
		dialog.open = false;
		queueMicrotask(() => dialog.fire('close'));
	};
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

elementTest('dialog-panel show is vetoed above max-display-width', (t) => {
	const frames = captureFrames(t);
	const originalWidth = window.innerWidth;
	window.innerWidth = 901;
	t.after(() => {
		window.innerWidth = originalWidth;
	});
	const result = makeSheet();
	const { dialog, engine, panel, sheet } = result;
	wirePanelTransport(result);
	t.after(() => sheet.disconnectedCallback());
	sheet.maxDisplayWidth = 900;
	let beforeShow;
	panel.addEventListener('beforeShow', (event) => {
		beforeShow = event;
	});

	assert.equal(panel.show(), false);
	assert.equal(beforeShow.defaultPrevented, true);
	assert.equal(panel.isOpen, false);
	assert.equal(dialog.open, false);
	assert.equal(engine.state, 'hidden');
	assert.equal(frames.length, 0, 'the refused route never starts an entrance');
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

/**
 * A trigger the page has hidden, by one of the three ways that matter.
 *
 * The box is deliberately left usable so the assertion is about the style check
 * alone: a real `display: none` element would also measure zero, and leaning on
 * that would leave the visibility and opacity cases untested.
 * @param {string} property - Inline style property to set.
 * @param {string} value - Value that makes the trigger invisible.
 * @returns {Object} Trigger stub.
 */
function hiddenTrigger(property, value) {
	const trigger = makeTrigger();
	trigger.style[property] = value;
	return trigger;
}

function wirePanelTransport({ dialog, engine, panel }) {
	panel.showModes = [];
	panel.hideModes = [];
	panel.finalizes = 0;
	const finalize = () => {
		if (dialog.open) dialog.close();
		panel.isOpen = false;
		panel.finalizes++;
		panel.fire('hidden');
	};
	panel.show = (trigger) => {
		const direct = engine.animatesDialog;
		panel.showModes.push(direct);
		if (panel.fire('beforeShow').defaultPrevented) return false;
		if (direct) {
			panel.isOpen = true;
			dialog.showModal();
		}
		void engine.show({ from: trigger, to: dialog, display: 'flex' });
		return true;
	};
	panel.hide = () => {
		const direct = engine.animatesDialog;
		panel.hideModes.push(direct);
		if (panel.fire('beforeHide').defaultPrevented) return false;
		if (!direct) {
			panel.isOpen = false;
			if (dialog.open) dialog.close();
		}
		void engine.hide();
		return true;
	};
	engine.on('reveal', () => {
		panel.isOpen = true;
		if (!dialog.open) dialog.showModal();
	});
	engine.on('shown', () => {
		panel.isOpen = true;
		if (!dialog.open) dialog.showModal();
		panel.fire('shown');
	});
	engine.on('hidden', finalize);
	engine.on('stop', finalize);
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
		[
			'detached trigger',
			{ morphTrigger: true },
			Object.assign(makeTrigger(), { isConnected: false }),
		],
		[
			'zero-size trigger',
			{ morphTrigger: true },
			Object.assign(makeTrigger(), {
				rect: { top: 20, left: 20, right: 20, bottom: 20, width: 0, height: 0 },
			}),
		],
		[
			'trigger outside the viewport',
			{ morphTrigger: true },
			Object.assign(makeTrigger(), {
				rect: { top: 900, left: 20, right: 68, bottom: 948, width: 48, height: 48 },
			}),
		],
		// MorphEngine's blob clones the trigger's subtree and forces visibility,
		// display and opacity back on to render it, so a trigger the page hid
		// would have its content flashed across the flight.
		['visibility:hidden trigger', { morphTrigger: true }, hiddenTrigger('visibility', 'hidden')],
		['display:none trigger', { morphTrigger: true }, hiddenTrigger('display', 'none')],
		['fully transparent trigger', { morphTrigger: true }, hiddenTrigger('opacity', '0')],
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

elementTest(
	'a trigger morph opens through one blob and hands the settled frame to SheetEngine',
	(t) => {
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
	}
);

elementTest(
	'a native close during proxy reveal stops and finalizes without reopening',
	async (t) => {
		const { dialog, engine, panel, sheet } = makeMorphSheet(t);
		let hidden = 0;
		panel.addEventListener('hidden', () => hidden++);
		sheet.show(makeTrigger());
		const blob = currentBlob();
		blob.step(0.75);

		assert.equal(dialog.open, true);
		assert.equal(dialog.showModalCalls, 1);
		dialog.close('result');
		await Promise.resolve();

		assert.equal(blob.stops, 1);
		assert.equal(engine.state, 'hidden');
		assert.equal(panel.finalizes, 1);
		assert.equal(hidden, 1);
		blob.step(1);
		assert.equal(dialog.open, false);
		assert.equal(dialog.showModalCalls, 1);
		assert.equal(panel.finalizes, 1);
		assert.equal(hidden, 1);
		assert.equal(dialog.returnValue, 'result');
	}
);

elementTest('a normal proxy entrance ignores close events while the dialog is open', (t) => {
	const { dialog, engine, sheet } = makeMorphSheet(t);
	sheet.show(makeTrigger());
	const blob = currentBlob();
	blob.step(0.75);

	dialog.fire('close');
	assert.equal(dialog.open, true);
	assert.equal(blob.stops, 0);
	assert.equal(engine.blobFlight, true);
	blob.step(1);
	assert.equal(engine.state, 'shown');
});

elementTest('a reversed proxy hide ignores its queued close after re-promotion', async (t) => {
	const { dialog, engine, panel, sheet } = makeMorphSheet(t);
	const trigger = makeTrigger();
	sheet.show(trigger);
	const blob = currentBlob();
	blob.step(1);

	sheet.hide();
	assert.equal(dialog.open, false);
	sheet.show(trigger);
	assert.equal(dialog.open, true);
	await Promise.resolve();

	assert.equal(blob.stops, 0);
	assert.equal(engine.blobFlight, true);
	assert.equal(panel.finalizes, 0);
	blob.step(0);
	assert.equal(engine.state, 'shown');
});

elementTest('blob flights clone the trigger forward but never the live dialog in reverse', (t) => {
	const { sheet } = makeMorphSheet(t);
	sheet.show(makeTrigger());
	const blob = currentBlob();
	assert.equal(blob.runs[0].cloneContents, true);
	blob.step(1);

	sheet.hide();
	assert.equal(blob.runs[1].cloneContents, false);
	blob.step(1);
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

// A direct or force close leaves the dialog open until finalize, whose
// dialog.close() QUEUES its close event — so a hidden listener that reopens a
// trigger morph in the same task puts the NEW flight into exactly the state the
// force-close repair looks for ('showing', blob up, dialog not yet promoted)
// before the stale event lands. Only a reveal belonging to the current run may
// arm the repair.
elementTest('a stale queued close from the previous run spares a same-task reopen', async (t) => {
	const frames = captureFrames(t);
	const { dialog, engine, panel, sheet } = makeMorphSheet(t);
	sheet.show();
	drainFrames(frames);
	assert.equal(engine.state, 'shown');

	let reopened = false;
	panel.addEventListener('hidden', () => {
		if (reopened) return;
		reopened = true;
		sheet.show(makeTrigger());
	});
	sheet.hide();
	drainFrames(frames);

	assert.equal(reopened, true);
	assert.equal(engine.state, 'showing');
	const blob = currentBlob();
	assert.equal(dialog.open, false, 'the reopened proxy run has not promoted yet');
	// The previous run's queued close lands on the new flight.
	await Promise.resolve();

	assert.equal(blob.stops, 0);
	assert.equal(engine.blobFlight, true);
	blob.step(1);
	assert.equal(engine.state, 'shown');
	assert.equal(dialog.open, true);
});

elementTest('a plain open and close never touches consumer inline dialog styles', async (t) => {
	const frames = captureFrames(t);
	const result = makeSheet();
	const { dialog, engine, sheet } = result;
	wirePanelTransport(result);
	t.after(() => sheet.disconnectedCallback());
	dialog.style.margin = '24px';
	dialog.style.maxHeight = '70vh';

	sheet.show();
	drainFrames(frames);
	assert.equal(engine.state, 'shown');
	sheet.hide();
	drainFrames(frames);
	assert.equal(engine.state, 'hidden');

	assert.equal(dialog.style.margin, '24px');
	assert.equal(dialog.style.maxHeight, '70vh');
});

// stop() emits no beforeHide, so hidden is the only hook that can clear a
// stranded #waitForMorph timer and restore the consumer's snapshot.
elementTest('a force-close during a profile morph restores pins at hidden', (t) => {
	const frames = captureFrames(t);
	const result = makeSheet();
	const { dialog, engine, panel, sheet } = result;
	wirePanelTransport(result);
	t.after(() => sheet.disconnectedCallback());
	dialog.style.margin = '18px';

	sheet.show();
	drainFrames(frames);
	sheet.setAttribute('position', 'right');
	sheet.attributeChangedCallback('position', 'bottom', 'right');
	assert.equal(engine.morphing, true);
	assert.equal(dialog.style.transition !== '', true, 'the FLIP owns an inline transition');

	engine.stop();
	panel.fire('hidden');

	assert.equal(engine.morphing, false);
	assert.equal(dialog.style.transition, '');
	assert.equal(dialog.style.margin, '18px');
});

// dialog-panel demotes the dialog at hide-START for a proxy reverse — the blob
// flies in normal flow, so a top-layer dialog would paint over it — which means
// EVERY deliberate reverse close delivers a queued close event mid-flight with
// the dialog closed. The force-close repair must not read that as an app-level
// close: doing so stopped the blob dead and the panel vanished instead of
// morphing back into its trigger.
elementTest(
	'a deliberate reverse close survives its own queued demotion close event',
	async (t) => {
		const { dialog, engine, panel, sheet } = makeMorphSheet(t);
		sheet.show(makeTrigger());
		const blob = currentBlob();
		blob.step(1);

		sheet.hide();
		assert.equal(dialog.open, false);
		// Let the demotion's queued close event land while the reverse is in flight.
		await Promise.resolve();

		assert.equal(blob.stops, 0);
		assert.equal(engine.blobFlight, true);
		assert.equal(engine.state, 'hiding');
		blob.step(1);
		assert.equal(engine.state, 'hidden');
		assert.equal(panel.finalizes, 1);
		assert.equal(blobsInBody().length, 0);
	}
);

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

elementTest(
	'a vetoed gesture leaves the blob shown and the next deliberate close reverses',
	(t) => {
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
	}
);

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

// The other half of the hidden-trigger gate. MorphEngine hides the source for
// the whole flight and keeps it hidden for as long as the panel is shown, so by
// the time the hide path probes the trigger its hidden style is the morph's own
// doing. Checking visibility there would refuse every reverse morph — this
// pins the ownership gate so the arm-time check can never be widened onto it.
elementTest('the blob hiding its own trigger never refuses the reverse morph', (t) => {
	const { engine, panel, sheet } = makeMorphSheet(t);
	const trigger = makeTrigger();
	sheet.show(trigger);
	const blob = currentBlob();
	blob.step(1);

	assert.equal(trigger.style.visibility, 'hidden', 'the blob owns the trigger while shown');
	assert.equal(engine.animatesDialog, false, 'and the close still classifies as a proxy reverse');
	sheet.hide();
	assert.equal(panel.hideModes[0], false);
	assert.equal(blob.runs.at(-1).phase, 'hiding');
	blob.step(1);
	assert.equal(engine.state, 'hidden');
});

// Geometry is the gate the blob does not own, so it is the one that still
// answers on the hide path. A page that pulls the trigger out of layout gets
// the direct spring exit rather than a morph back into nothing.
elementTest('a trigger removed from layout while open takes the direct spring exit', (t) => {
	const frames = captureFrames(t);
	const { engine, panel, sheet } = makeMorphSheet(t);
	const trigger = makeTrigger();
	sheet.show(trigger);
	currentBlob().step(1);

	trigger.style.display = 'none';
	trigger.rect = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };

	assert.equal(engine.animatesDialog, true);
	sheet.hide();
	assert.equal(panel.hideModes[0], true);
	assert.equal(blobsInBody().length, 0);
	drainFrames(frames);
	assert.equal(engine.state, 'hidden');
});

// prefers-reduced-motion zeroes --sheet-morph-duration, and the policy is that
// this disables the trigger morph rather than replacing the entrance with a
// jump: the panel still arrives on the ordinary spring, exactly as it would
// without `morph-trigger`. Classification alone would pass with no entrance at
// all, so the spring has to be asserted too.
elementTest('a zeroed morph duration keeps the ordinary spring entrance', (t) => {
	const frames = captureFrames(t);
	const { dialog, engine, panel, sheet } = makeMorphSheet(t);
	dialog.style.setProperty('--sheet-morph-duration', '0ms');

	sheet.show(makeTrigger());

	assert.equal(panel.showModes[0], true, 'reduced motion selects the direct transport');
	assert.equal(MorphEngine.instances.length, 0, 'and never builds a blob');
	assert.equal(engine.state, 'showing');
	assert.equal(dialog.style.transform, 'translate3d(0px, 708px, 0px) scale(1)');
	assert.ok(frames.length > 0, 'the ordinary entrance spring is running');
	drainFrames(frames);
	assert.equal(engine.state, 'shown');
	assert.equal(dialog.style.transform, 'translate3d(0px, 0px, 0px) scale(1)');
});

elementTest('morphsFromTrigger reflects the attribute in both directions', () => {
	const sheet = new SheetPanel();
	assert.equal(sheet.morphsFromTrigger, false);

	sheet.morphsFromTrigger = true;
	assert.equal(sheet.getAttribute('morph-trigger'), '');
	assert.equal(sheet.morphsFromTrigger, true);

	sheet.morphsFromTrigger = false;
	assert.equal(sheet.hasAttribute('morph-trigger'), false);
	assert.equal(sheet.morphsFromTrigger, false);
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

elementTest('a hide dispatched during a profile morph releases the park before the exit', (t) => {
	const frames = captureFrames(t);
	const result = makeSheet();
	const { dialog, engine, panel, sheet } = result;
	wirePanelTransport(result);
	t.after(() => sheet.disconnectedCallback());

	sheet.show();
	drainFrames(frames);
	assert.equal(engine.state, 'shown');
	assert.equal(panel.isOpen, true);

	sheet.setAttribute('position', 'right');
	sheet.attributeChangedCallback('position', 'bottom', 'right');
	assert.equal(engine.morphing, true);
	const transformAtHideStart = dialog.style.transform;
	const exitTransforms = [];
	engine.on('change', ({ phase }) => {
		if (phase === 'hiding') exitTransforms.push(dialog.style.transform);
	});

	sheet.hide();
	assert.equal(engine.morphing, false);
	drainFrames(frames);

	assert.equal(engine.state, 'hidden');
	assert.notEqual(exitTransforms[0], transformAtHideStart);
});

/**
 * Opens a sheet on a side profile with consumer-authored inline geometry.
 *
 * A side profile is deliberate: the engine paints no `height` for one, so the
 * only writer of the properties asserted below is the profile FLIP itself.
 * @param {Object} t - Test context.
 * @param {string} [position] - Starting position.
 * @returns {Object} Sheet parts plus the captured frame queue.
 */
function openStyledSheet(t, position = 'right') {
	const frames = captureFrames(t);
	const result = makeSheet();
	wirePanelTransport(result);
	t.after(() => {
		if (result.sheet.hasAttribute('engine')) result.sheet.disconnectedCallback();
	});
	result.sheet.setAttribute('position', position);
	result.dialog.style.height = '333px';
	result.dialog.style.margin = '7px';
	result.sheet.show();
	drainFrames(frames);
	assert.equal(result.engine.state, 'shown');
	return { ...result, frames };
}

function startProfileMorph(sheet, from, to) {
	sheet.setAttribute('position', to);
	sheet.attributeChangedCallback('position', from, to);
}

elementTest('profile morph durations accept only CSS time tokens', (t) => {
	const { dialog, engine, sheet } = openStyledSheet(t);
	const cases = [
		['600ms', 600],
		['0.6s', 600],
		['600', 600],
		['601', 600],
		['0', 0],
		['0.', 0],
		['0s', 0],
		['calc(300ms + 300ms)', 600],
		['garbage', 600],
	];
	let from = 'right';

	for (const [token, milliseconds] of cases) {
		const to = from === 'right' ? 'left' : 'right';
		dialog.style.setProperty('--sheet-morph-duration', token);
		startProfileMorph(sheet, from, to);

		if (milliseconds === 0) {
			assert.equal(engine.morphing, false, `${token} collapses the morph`);
			assert.equal(dialog.style.transition, '');
		} else {
			assert.equal(engine.morphing, true, `${token} starts the morph`);
			assert.match(dialog.style.transition, new RegExp(`top ${milliseconds}ms `));
			assert.doesNotMatch(dialog.style.transition, /var\(--sheet-morph-duration/);
			dialog.fire('transitionend', { target: dialog, propertyName: 'height' });
		}

		from = to;
	}
});

// The :root declaration inside the reduced-motion media query can lose the
// cascade to a later or more specific consumer token. Reading the preference
// itself is what keeps both users of the token off: the trigger blob and the
// profile FLIP.
elementTest('the reduced-motion media query overrides a consumer morph duration', (t) => {
	const frames = captureFrames(t);
	const originalMatchMedia = window.matchMedia;
	window.matchMedia = () => ({ matches: true });
	t.after(() => {
		window.matchMedia = originalMatchMedia;
	});
	const { dialog, engine, panel, sheet } = makeMorphSheet(t);
	dialog.style.setProperty('--sheet-morph-duration', '400ms');

	sheet.show(makeTrigger());
	assert.equal(panel.showModes[0], true, 'the trigger uses the direct spring transport');
	assert.equal(MorphEngine.instances.length, 0, 'no trigger blob is built');
	drainFrames(frames);
	assert.equal(engine.state, 'shown');

	startProfileMorph(sheet, 'bottom', 'left');
	assert.equal(engine.morphing, false, 'the profile swaps without a FLIP');
	assert.equal(dialog.style.transition, '');
});

// The FLIP writes its pins onto the same inline properties a consumer may
// already have set, so blanking them on teardown silently deleted styles the
// component never owned. Every path that ends a morph has to restore instead.
elementTest('a completed profile morph restores the inline styles it pinned over', (t) => {
	const { dialog, engine, sheet } = openStyledSheet(t);

	startProfileMorph(sheet, 'right', 'left');
	assert.equal(engine.morphing, true);
	assert.equal(dialog.style.height, '500px', 'the FLIP pins the measured box');
	assert.equal(dialog.style.margin, '0');

	dialog.fire('transitionend', { target: dialog, propertyName: 'height' });

	assert.equal(engine.morphing, false);
	assert.equal(dialog.style.height, '333px');
	assert.equal(dialog.style.margin, '7px');
	assert.equal(dialog.style.top, '', 'a pin the consumer never set still goes');
	assert.equal(dialog.style.transition, '');
});

elementTest('the morph safety timeout restores them too', async (t) => {
	const { dialog, engine, sheet } = openStyledSheet(t);
	// transitionend never fires for an interrupted transition or a property whose
	// start equals its end, so the timeout is the guarantee — and it is a strip
	// site like any other.
	dialog.style.setProperty('--sheet-morph-duration', '1ms');

	startProfileMorph(sheet, 'right', 'left');
	assert.equal(dialog.style.height, '500px');
	await new Promise((resolve) => setTimeout(resolve, 160));

	assert.equal(engine.morphing, false);
	assert.equal(dialog.style.height, '333px');
	assert.equal(dialog.style.margin, '7px');
});

elementTest('a close interrupting a morph restores them before the exit runs', (t) => {
	const { dialog, engine, frames, sheet } = openStyledSheet(t);

	startProfileMorph(sheet, 'right', 'left');
	assert.equal(dialog.style.height, '500px');

	sheet.hide();

	// beforeHide abandons the FLIP, so the exit has to animate the consumer's
	// box rather than the pinned one.
	assert.equal(engine.morphing, false);
	assert.equal(dialog.style.height, '333px');
	assert.equal(dialog.style.margin, '7px');
	drainFrames(frames);
	assert.equal(engine.state, 'hidden');
});

// A window edge dragged back and forth re-enters #morphToProfile with the
// previous FLIP's pins still on the dialog. Re-snapshotting there would promote
// that scaffolding to "what the consumer had" and the restore would hand back
// the pins forever.
elementTest('a re-entrant profile morph keeps the original consumer styles', (t) => {
	const { dialog, engine, sheet } = openStyledSheet(t);

	startProfileMorph(sheet, 'right', 'left');
	assert.equal(dialog.style.height, '500px');
	startProfileMorph(sheet, 'left', 'center');
	assert.equal(engine.morphing, true, 'the retarget stays parked');
	assert.equal(dialog.style.height, '500px', 'and is still pinned');

	dialog.fire('transitionend', { target: dialog, propertyName: 'height' });

	assert.equal(dialog.style.height, '333px');
	assert.equal(dialog.style.margin, '7px');
});

// The one property on the pin list the ENGINE also writes. A mobile bottom
// sheet's inline height is its painted snap, not a consumer style, and the
// profile it is morphing into paints no height at all — so carrying it across
// would pin a side sheet to the bottom sheet's snap forever.
elementTest('a snap-painted height is never carried across a profile morph', (t) => {
	const frames = captureFrames(t);
	const result = makeSheet();
	const { dialog, engine, sheet } = result;
	wirePanelTransport(result);
	t.after(() => sheet.disconnectedCallback());
	sheet.setAttribute('snap-points', '500px');
	sheet.show();
	drainFrames(frames);
	assert.equal(dialog.style.height, '500px', 'the bottom sheet paints its snap inline');

	startProfileMorph(sheet, 'bottom', 'right');
	dialog.fire('transitionend', { target: dialog, propertyName: 'height' });

	assert.equal(dialog.style.height, '', 'the side profile is left to the stylesheet');
});

// Every non-snap profile carries exactly one snap, so its live index is always
// 0 — and reusing that index across a breakpoint morph landed the panel on the
// LOWEST mobile snap, while a fresh mobile open resolves initial-snap to the
// highest. The index may only be carried between two snap-resized profiles;
// everything else re-resolves initial-snap exactly like a fresh open. The
// crossing is driven by the breakpoint attribute because a desktop profile
// measures the stubbed dialog box — a side profile's width probe resolves
// nothing under the stubs, and its refused setSnaps would mask the carry.
elementTest('a morph back below the breakpoint lands on initial-snap, not the lowest', (t) => {
	const frames = captureFrames(t);
	const originalWidth = window.innerWidth;
	t.after(() => {
		window.innerWidth = originalWidth;
	});
	window.innerWidth = 400;
	const result = makeSheet();
	const { dialog, engine, sheet } = result;
	wirePanelTransport(result);
	t.after(() => sheet.disconnectedCallback());
	sheet.setAttribute('snap-points', '200px 500px');
	sheet.show();
	drainFrames(frames);
	assert.equal(engine.activeSnap, 1, 'a fresh open resolves to the highest snap');

	sheet.setAttribute('breakpoint', '300');
	sheet.attributeChangedCallback('breakpoint', null, '300');
	dialog.fire('transitionend', { target: dialog, propertyName: 'height' });
	assert.equal(engine.snaps.length, 1, 'the desktop profile carries one snap');
	assert.equal(engine.activeSnap, 0);

	sheet.setAttribute('breakpoint', '768');
	sheet.attributeChangedCallback('breakpoint', '300', '768');
	dialog.fire('transitionend', { target: dialog, propertyName: 'height' });

	assert.deepEqual(engine.snaps, [200, 500]);
	assert.equal(engine.activeSnap, 1);
	assert.equal(engine.currentSize, 500);
	assert.equal(dialog.style.height, '500px');
});

// #activeSnap only advances when a settle COMPLETES, so during a snap flight it
// still names the snap the settle started from. A second flick claiming
// mid-settle used that stale rest as its base pose, teleporting the panel back
// to the previous position before re-transitioning — visible on every quick
// double flick, in both directions. The drag must continue from the size
// actually painted at the moment it claims.
elementTest('a flick claiming mid-settle continues from the painted size', (t) => {
	const frames = captureFrames(t);
	const result = makeSheet();
	const { dialog, engine, sheet } = result;
	wirePanelTransport(result);
	t.after(() => sheet.disconnectedCallback());
	sheet.setAttribute('snap-points', '200px 500px');
	sheet.show();
	drainFrames(frames);
	assert.equal(engine.currentSize, 500);

	// Flick down toward the lower snap, then interrupt the settle mid-flight.
	sheet.fire('pointerdown', pointer());
	sheet.fire('pointermove', pointer({ clientY: 60, timeStamp: 40 }));
	sheet.fire('pointerup', pointer({ clientY: 60, timeStamp: 50 }));
	for (let index = 0; index < 6; index++) {
		assert.ok(frames.length > 0, `settle frame ${index + 1} is queued`);
		frames.shift()(index * 16.66);
	}
	const midSize = engine.currentSize;
	assert.ok(midSize > 200 && midSize < 440, `the settle is genuinely mid-flight (${midSize})`);

	// Second flick, upward, while the first settle is still running. The claim
	// must continue from the painted size — the stale #activeSnap still says
	// 500, and basing the pose there painted 500 + drag on the first move.
	sheet.fire('pointerdown', pointer({ timeStamp: 200 }));
	sheet.fire('pointermove', pointer({ clientY: -40, timeStamp: 240 }));
	// The paint rounds to four decimals; the tolerance is orders of magnitude
	// below the ~150px teleport this test exists to refuse.
	const painted = Number.parseFloat(dialog.style.height);
	assert.ok(Math.abs(painted - (midSize + 40)) < 0.001, `${painted} continues ${midSize} + 40`);

	sheet.fire('pointerup', pointer({ clientY: -40, timeStamp: 250 }));
	drainFrames(frames);
	assert.equal(engine.activeSnap, 1, 'the upward flick steps back to the higher snap');
	assert.equal(engine.currentSize, 500);
	assert.equal(dialog.style.height, '500px');
});

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

elementTest('a vetoed trigger-morph show disarms the hidden engine', (t) => {
	const frames = captureFrames(t);
	const { engine, panel, sheet } = makeMorphSheet(t);
	const triggerA = makeTrigger();
	const triggerB = makeTrigger();
	triggerB.rect = { top: 240, left: 80, right: 128, bottom: 288, width: 48, height: 48 };
	let veto = true;
	panel.addEventListener('beforeShow', (event) => {
		if (!veto) return;
		veto = false;
		event.preventDefault();
	});

	assert.equal(sheet.show(triggerA), false);
	assert.equal(engine.state, 'hidden');
	assert.equal(engine.animatesDialog, true);

	assert.equal(sheet.show(), true);
	assert.equal(engine.state, 'showing');
	assert.equal(panel.showModes.at(-1), true);
	drainFrames(frames);
	assert.equal(engine.state, 'shown');

	assert.equal(sheet.hide(), true);
	drainFrames(frames);
	assert.equal(engine.state, 'hidden');

	assert.equal(sheet.show(triggerB), true);
	const blob = currentBlob();
	assert.equal(panel.showModes.at(-1), false);
	assert.equal(blob.runs.at(-1).from, triggerB);
	assert.equal(blob.runs.at(-1).to.tagName, 'DIALOG');
	blob.step(1);
});

/**
 * Drives the capture-phase scrim guard the way the browser does: a pointerdown
 * that records where the gesture began, then the click the browser retargets
 * and dispatches at the RELEASE coordinates.
 *
 * The dialog stub's rect is 0,0 → 400,500, so anything above y=0 is scrim.
 * @param {Object} panel - dialog-panel stub the guard is bound to.
 * @param {Object} pressTarget - Element the gesture started on.
 * @param {Object} release - Release coordinates.
 * @returns {boolean} True when the guard swallowed the click.
 */
function scrimGesture(panel, pressTarget, release) {
	panel.fire('pointerdown', { target: pressTarget });
	const click = panel.fire('click', { target: pressTarget, detail: 1, ...release });
	return click.propagationStopped;
}

elementTest('a press on panel content that releases on the scrim is not a tap', (t) => {
	const { dialog, panel, sheet } = makeSheet();
	t.after(() => sheet.disconnectedCallback());
	const content = new StubElement('sheet-content');

	// The bug this guards: pointer capture retargets the click to whatever held
	// it — inside the panel — while dialog-panel's dialogClick only ever tests
	// the release COORDINATES, which are out on the scrim. Selecting text and
	// letting go past the edge closed the sheet.
	assert.equal(scrimGesture(panel, content, { clientX: 200, clientY: -80 }), true);

	// A genuine scrim tap is untouched: same release point, gesture began there.
	assert.equal(scrimGesture(panel, dialog, { clientX: 200, clientY: -80 }), false);
});

elementTest('a swipe that begins on the scrim still dismisses however far it travels', (t) => {
	const { dialog, panel, sheet } = makeSheet();
	t.after(() => sheet.disconnectedCallback());

	// The near-miss case: aiming for the sheet's edge, landing just above it,
	// then swiping. A distance-based tap gate would refuse this; starting
	// position is what separates it from the selection release above.
	assert.equal(scrimGesture(panel, dialog, { clientX: 200, clientY: -220 }), false);
});

elementTest('an ordinary click inside the panel box never reaches the guard', (t) => {
	const { panel, sheet } = makeSheet();
	t.after(() => sheet.disconnectedCallback());
	const button = new StubElement('button');

	// Inside the rect, so the geometry test returns before any policy question.
	// Dropping the old target-based exemption must not start swallowing these.
	assert.equal(scrimGesture(panel, button, { clientX: 200, clientY: 250 }), false);
});

elementTest('dismiss="none" still refuses a scrim tap it would otherwise allow', (t) => {
	const { dialog, panel, sheet } = makeSheet();
	t.after(() => sheet.disconnectedCallback());
	sheet.setAttribute('dismiss', 'none');

	assert.equal(sheet.dismissPolicy.backdrop, false);
	assert.equal(scrimGesture(panel, dialog, { clientX: 200, clientY: -80 }), true);
});

elementTest('a pointerless click outside the rect is never swallowed by backdrop policy', (t) => {
	const { dialog, panel, sheet } = makeSheet();
	t.after(() => sheet.disconnectedCallback());
	const button = new StubElement('button');
	// Pointerless clicks always report (0,0), so the rect must not contain the
	// origin or this test returns at geometry and passes without exercising the
	// capture-phase bug.
	dialog.rect = {
		top: 360,
		left: 0,
		right: 420,
		bottom: 900,
		width: 420,
		height: 540,
	};
	dialog.contains = (target) => target === dialog || target === button;
	const activate = () =>
		panel.fire('click', {
			target: button,
			detail: 0,
			clientX: 0,
			clientY: 0,
		});

	assert.equal(activate().propagationStopped, false);
	sheet.setAttribute('dismiss', 'none');
	assert.equal(activate().propagationStopped, false);
});

elementTest('a real scrim tap at the same outside coordinates still passes through', (t) => {
	const { dialog, panel, sheet } = makeSheet();
	t.after(() => sheet.disconnectedCallback());
	dialog.rect = {
		top: 360,
		left: 0,
		right: 420,
		bottom: 900,
		width: 420,
		height: 540,
	};

	assert.equal(scrimGesture(panel, dialog, { clientX: 0, clientY: 0 }), false);
});

/**
 * Replays a pointerless click the way the browser delivers one, because the stub
 * neither bubbles nor honours the capture flag.
 *
 * The two calls are the two seams this mechanism is built on, in the order a real
 * dispatch visits them: #outsideGuard runs in CAPTURE on the dialog-panel, on the
 * way down, and records the source; #pointerlessArm runs in BUBBLE on the panel,
 * on the way back up, after the target's own listeners and before the event
 * reaches the dialog dialog-panel misreads it on. `arm: false` stops between the
 * two, which is exactly where a consumer's own click handler lives.
 * @param {Object} sheet - SheetPanel under test.
 * @param {Object} panel - dialog-panel stub.
 * @param {Object} target - Element the activation landed on.
 * @param {boolean} [arm=true] - Whether to run the bubble half.
 */
function pointerlessClick(sheet, panel, target, arm = true) {
	panel.fire('click', { target, detail: 0, clientX: 0, clientY: 0 });
	if (arm) sheet.fire('click', { target });
}

elementTest('a pointerless non-closing control vetoes dialog-panel spurious hide', (t) => {
	const { dialog, panel, sheet } = makeSheet();
	t.after(() => sheet.disconnectedCallback());
	const button = new StubElement('button');
	dialog.contains = (target) => target === dialog || target === button;

	pointerlessClick(sheet, panel, button);
	const beforeHide = panel.fire('beforeHide');

	assert.equal(beforeHide.defaultPrevented, true);
});

// The other hide that arrives inside the same dispatch, and the reason the flag
// alone is not enough: a consumer's own `sheet.hide()` runs at the button, BELOW
// the panel, so it reaches beforeHide before anything has armed. Refusing it
// would make a keyboard user unable to save-and-close.
elementTest('a control that hides itself before the arm seam is not vetoed', (t) => {
	const { dialog, panel, sheet } = makeSheet();
	t.after(() => sheet.disconnectedCallback());
	const button = new StubElement('button');
	dialog.contains = (target) => target === dialog || target === button;

	pointerlessClick(sheet, panel, button, false);

	assert.equal(panel.fire('beforeHide').defaultPrevented, false);
});

elementTest('a pointerless close control still reaches the deliberate hide route', (t) => {
	const { dialog, panel, sheet } = makeSheet();
	t.after(() => sheet.disconnectedCallback());
	const close = new StubElement('button');
	close.closestResults.set('[data-action-hide-dialog]', close);
	dialog.contains = (target) => target === dialog || target === close;

	pointerlessClick(sheet, panel, close);
	const beforeHide = panel.fire('beforeHide');

	assert.equal(beforeHide.defaultPrevented, false);
});

elementTest('beforeHide without a pointerless click is never vetoed', (t) => {
	const { panel, sheet } = makeSheet();
	t.after(() => sheet.disconnectedCallback());

	assert.equal(panel.fire('beforeHide').defaultPrevented, false);
});

// A macrotask boundary, not a microtask one. The event loop drains microtasks
// between listener callbacks, so a microtask-scheduled release would have expired
// before dialogClick was ever judged by it — the veto never fired at all.
elementTest('the pointerless source expires after the click dispatch task', async (t) => {
	const { dialog, panel, sheet } = makeSheet();
	t.after(() => sheet.disconnectedCallback());
	const button = new StubElement('button');
	dialog.contains = (target) => target === dialog || target === button;

	pointerlessClick(sheet, panel, button);
	await Promise.resolve();
	assert.equal(panel.fire('beforeHide').defaultPrevented, true, 'survives a microtask');

	pointerlessClick(sheet, panel, button);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(panel.fire('beforeHide').defaultPrevented, false, 'released on the next task');
});

elementTest('each click and outer hidden event consume their own scrim press', (t) => {
	const { dialog, panel, sheet } = makeSheet();
	t.after(() => sheet.disconnectedCallback());
	const button = new StubElement('button');
	dialog.rect = {
		top: 360,
		left: 0,
		right: 420,
		bottom: 900,
		width: 420,
		height: 540,
	};

	panel.fire('pointerdown', { target: dialog });
	assert.equal(
		panel.fire('click', { target: button, detail: 0, clientX: 0, clientY: 0 }).propagationStopped,
		false
	);
	assert.equal(
		panel.fire('click', { target: dialog, detail: 1, clientX: 0, clientY: 0 }).propagationStopped,
		true,
		'the next click cannot inherit the consumed press'
	);

	panel.fire('pointerdown', { target: dialog });
	panel.fire('hidden');
	assert.equal(
		panel.fire('click', { target: dialog, detail: 1, clientX: 0, clientY: 0 }).propagationStopped,
		true,
		"a reopened panel cannot inherit the previous run's press"
	);
});

elementTest('nested dialog-panel lifecycle events do not drive the outer sheet', (t) => {
	const frames = captureFrames(t);
	const result = makeSheet();
	const { engine, panel, sheet } = result;
	wirePanelTransport(result);
	t.after(() => sheet.disconnectedCallback());
	sheet.setAttribute('snap-points', '200px 500px');
	sheet.show();
	drainFrames(frames);

	sheet.fire('pointerdown', pointer());
	sheet.fire('pointermove', pointer({ clientY: 120, timeStamp: 40 }));
	assert.equal(engine.currentSize, 380);
	assert.equal(panel.style.getPropertyValue('--sheet-progress'), '0.760');
	assert.equal(panel.style.getPropertyValue('--sheet-backdrop-progress'), '1.000');
	sheet.maxDisplayWidth = 399;
	const nested = new StubElement('dialog-panel');

	for (const type of ['beforeShow', 'beforeHide', 'shown', 'hidden']) {
		const event = panel.fire(type, { target: nested });
		assert.equal(event.defaultPrevented, false, `${type} is not vetoed`);
		assert.equal(
			panel.style.getPropertyValue('--sheet-progress'),
			'0.760',
			`${type} leaves panel progress untouched`
		);
		assert.equal(
			panel.style.getPropertyValue('--sheet-backdrop-progress'),
			'1.000',
			`${type} leaves backdrop progress untouched`
		);
	}

	sheet.fire('pointermove', pointer({ clientY: 200, timeStamp: 80 }));
	assert.equal(engine.currentSize, 300, 'the outer drag stays active');
	assert.equal(panel.style.getPropertyValue('--sheet-progress'), '0.600');
	assert.equal(panel.style.getPropertyValue('--sheet-backdrop-progress'), '1.000');
});

elementTest('a dismissal vetoed at beforeHide reports the snap it actually landed on', (t) => {
	const frames = captureFrames(t);
	const result = makeSheet();
	const { engine, panel, sheet } = result;
	wirePanelTransport(result);
	t.after(() => sheet.disconnectedCallback());
	sheet.setAttribute('snap-points', '200px 500px');
	sheet.show();
	drainFrames(frames);

	// A consumer with an unsaved-changes guard: beforeHide is cancelable, and
	// dialog-panel returns false without ever calling engine.hide().
	panel.hide = () => false;
	const releases = () =>
		sheet.dispatchedEvents.filter((event) => event.type === 'snaprelease').map((e) => e.detail);

	// Swipe down hard enough to resolve to a dismissal.
	sheet.fire('pointerdown', pointer());
	sheet.fire('pointermove', pointer({ clientY: 600, timeStamp: 40 }));
	sheet.fire('pointerup', pointer({ clientY: 600, timeStamp: 50 }));
	drainFrames(frames);

	// Emitting before the hide was attempted was the bug: a consumer keying
	// teardown off `target === null` cleared its draft, released its camera and
	// logged a dismissal while the sheet stayed open and fully interactive. The
	// refused-`dismiss` path already reported the truth; the veto is the other
	// way a resolved dismissal fails to happen and it reported the opposite.
	const detail = releases();
	assert.equal(detail.length, 1);
	assert.notEqual(detail[0].target, null, 'never reports a dismissal that did not happen');
	assert.equal(detail[0].target, engine.activeSnap);
	assert.equal(detail[0].prevented, true);
	assert.equal(panel.isOpen, true, 'and the sheet is still open, which is the point');
});

elementTest('a hide vetoed mid-drag hands the gesture back instead of freezing it', async (t) => {
	const frames = captureFrames(t);
	const result = makeSheet();
	const { engine, panel, sheet } = result;
	wirePanelTransport(result);
	t.after(() => sheet.disconnectedCallback());
	sheet.setAttribute('snap-points', '200px 500px');
	sheet.show();
	drainFrames(frames);

	// Mid-drag, finger still down.
	sheet.fire('pointerdown', pointer());
	sheet.fire('pointermove', pointer({ clientY: 120, timeStamp: 40 }));
	const draggedSize = engine.currentSize;
	assert.ok(draggedSize < 500, `the drag is live (${draggedSize})`);

	// A programmatic hide from somewhere else entirely — a router guard, an
	// inactivity timeout, a close-all-overlays call — that a consumer then
	// vetoes. #dismiss() repairs only its OWN route, so before this fix nothing
	// restored the gesture: #dragMove and #dragEnd both early-return on
	// !active, so the release ran no settle and the panel stayed frozen at its
	// dragged, half-faded pose.
	panel.hide = () => {
		panel.fire('beforeHide');
		return false;
	};
	sheet.hide();
	await Promise.resolve();

	// The finger is still down and still moving, so the panel must still follow.
	sheet.fire('pointermove', pointer({ clientY: 200, timeStamp: 80 }));
	assert.ok(
		engine.currentSize < draggedSize,
		`the panel still tracks the finger, got ${engine.currentSize} vs ${draggedSize}`
	);

	// And the release must actually land somewhere rather than stranding it.
	sheet.fire('pointerup', pointer({ clientY: 200, timeStamp: 90 }));
	drainFrames(frames);
	assert.equal(engine.activeSnap, 0, 'the release settles onto a real snap');
	assert.equal(engine.currentSize, 200, 'and lands on it rather than freezing mid-drag');
	assert.equal(panel.isOpen, true, 'with the sheet still open, since the hide was refused');
});
