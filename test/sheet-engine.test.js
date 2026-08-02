import test from 'node:test';
import assert from 'node:assert/strict';
import FrameEngine from '@magic-spells/frame-engine';
import { installDomStubs, StubElement } from './element-stub.js';
import { MorphEngine } from './morph-engine-stub.js';

import {
	awayOffset,
	awayTranslation,
	contentSized,
	dismissAxis,
	buildDragKeyframes,
	buildExitKeyframes,
	buildOpenKeyframes,
	buildRestKeyframes,
	dismissalZoneProgress,
	EFFECT_BLUR,
	EXIT_CUSHION,
	exitClearProgress,
	exitTravel,
	paintedExtent,
	paintedProgress,
	parseDismiss,
	parseSpring,
	resizesWithSnaps,
	SheetEngine,
	SPRING_PRESETS,
	transformOrigin,
	velocityToSpring,
	VELOCITY_BOOST,
	FRAME_MS,
} from '../src/sheet-engine.js';

installDomStubs();

const SIZE_PROPERTIES = ['width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight'];

function profileFor(position, overrides = {}) {
	return {
		position,
		mode: 'edge',
		effect: 'slide',
		viewportWidth: 1000,
		viewportHeight: 800,
		...overrides,
	};
}

function assertNoSizeProperties(keyframes, label) {
	for (const [percent, styles] of Object.entries(keyframes)) {
		for (const property of SIZE_PROPERTIES) {
			assert.ok(
				!(property in styles),
				`${label}: keyframe ${percent} must not animate ${property}`
			);
		}
	}
}

function trackPropertyKeys(keyframes) {
	return [...new Set(Object.values(keyframes).flatMap((frame) => Object.keys(frame)))].sort();
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
		count += 1;
	}
	assert.ok(count < limit, 'spring settled before the safety limit');
	return count;
}

function makeDialog() {
	return { style: {} };
}

function translateYOf(styles) {
	return Number.parseFloat(styles.transform.match(/translate3d\([^,]+,\s*(-?[\d.]+)px/)[1]);
}

function translateY(dialog) {
	return translateYOf(dialog.style);
}

function translateX(dialog) {
	return Number.parseFloat(dialog.style.transform.match(/translate3d\((-?[\d.]+)px/)[1]);
}

function makeEngine() {
	const engine = new SheetEngine();
	engine.setProfile({
		position: 'bottom',
		mode: 'edge',
		effect: 'slide',
		viewportWidth: 1000,
		viewportHeight: 800,
	});
	engine.setSnaps([200, 500], 1);
	return engine;
}

test('SheetEngine show reaches shown and emits mostly monotonic frames', async (t) => {
	const frames = captureFrames(t);
	const engine = makeEngine();
	const dialog = makeDialog();
	const progress = [];
	engine.on('change', ({ progress: value }) => progress.push(value));
	const shown = engine.show({ to: dialog, display: 'flex' });
	drainFrames(frames);
	await shown;

	assert.equal(engine.state, 'shown');
	assert.equal(dialog.style.height, '500px');
	assert.ok(
		progress.slice(0, 10).every((value, index) => index === 0 || value > progress[index - 1])
	);
	assert.ok(Math.max(...progress) <= 1.014, 'the default entrance barely overshoots');
	// ~533ms at 60fps; the exact budget is asserted in the preset timing test.
	assert.ok(progress.length <= 36, `the entrance settles in ${progress.length} frames`);
	assert.ok(progress.at(-1) > 0.99, 'the spring converges on the shown frame');
	engine.destroy();
});

test('SheetEngine hide while showing reverses to hidden', async (t) => {
	const frames = captureFrames(t);
	const engine = makeEngine();
	const dialog = makeDialog();
	const show = engine.show({ to: dialog });
	for (let index = 0; index < 5; index++) {
		frames.shift()(index * 16.66);
	}
	const hide = engine.hide();
	assert.equal(engine.state, 'hiding');
	drainFrames(frames);
	await Promise.all([show, hide]);
	assert.equal(engine.state, 'hidden');
	engine.destroy();
});

test('a cancelled entrance rebases onto its configured exit effect', async (t) => {
	const frames = captureFrames(t);
	const transforms = [];
	const opacities = [];
	const dialog = {
		style: new Proxy(
			{},
			{
				set(target, property, value) {
					target[property] = value;
					if (property === 'transform' && typeof value === 'string') transforms.push(value);
					if (property === 'opacity' && typeof value === 'string') opacities.push(value);
					return true;
				},
			}
		),
	};
	const engine = new SheetEngine();
	engine.setProfile(profileFor('bottom', { effect: 'fade-scale', exitEffect: 'slide' }));
	engine.setSnaps([500], 0);

	const opening = engine.show({ to: dialog });
	for (let index = 0; index < 5; index++) frames.shift()(index * 16.66);
	const painted = { ...dialog.style };
	transforms.length = 0;
	opacities.length = 0;

	let clearedWithBackdrop = 0;
	engine.on('change', ({ phase }) => {
		if (phase !== 'hiding') return;
		if (translateY(dialog) >= 500 && engine.backdropProgress > 0) clearedWithBackdrop++;
	});
	const hiding = engine.hide();
	assert.deepEqual({ ...dialog.style }, painted, 'the rebase starts at the exact painted pose');
	assert.equal(drainFrames(frames), 19, 'the rebased exit runs for the exit preset duration');
	await Promise.all([opening, hiding]);

	assert.equal(
		transforms.at(-1),
		'translate3d(0px, 528px, 0px) scale(1)',
		'the cancelled fade-scale entrance lands on slide exit geometry'
	);
	assert.equal(opacities.at(-1), '1', 'the configured exit effect supplies the hidden opacity');
	assert.equal(clearedWithBackdrop, 0, 'the backdrop is clear on every off-screen frame');
	engine.destroy();
});

test('show during a dismissal retargets onto the entrance rest frame', async (t) => {
	const frames = captureFrames(t);
	const transforms = [];
	const dialog = {
		style: new Proxy(
			{},
			{
				set(target, property, value) {
					target[property] = value;
					if (property === 'transform') transforms.push(value);
					return true;
				},
			}
		),
	};
	const engine = new SheetEngine();
	engine.setProfile(profileFor('left'));
	engine.setSnaps([400], 0);

	const opened = engine.show({ to: dialog });
	drainFrames(frames);
	await opened;
	engine.dragBy(250);
	assert.equal(translateX(dialog), -250);

	const dismissed = engine.dismiss();
	for (let index = 0; index < 5; index++) {
		assert.ok(frames.length > 0, `dismissal frame ${index + 1} is queued`);
		frames.shift()(index * 16.66);
	}
	engine.setSnaps([400], 0);
	assert.equal(engine.currentSize, 150, 'reconfiguration does not replace the live flight size');

	transforms.length = 0;
	const reopened = engine.show({ to: dialog });
	drainFrames(frames);
	await Promise.all([dismissed, reopened]);

	const rest = 'translate3d(0px, 0px, 0px) scale(1)';
	assert.equal(dialog.style.transform, rest);
	assert.deepEqual(
		transforms.slice(-2),
		[rest, rest],
		'the terminal entrance frame and settled repaint are identical'
	);
	assert.equal(engine.backdropProgress, 1, 'the dismissed track leaves no stale backdrop remap');
	engine.destroy();
});

test('hide-to-show reversals start at the exact painted exit frame and settle at rest', async (t) => {
	for (const [label, effect, exitEffect, expectedBackdropBefore, expectedFirstProgress] of [
		['slide to slide', 'slide', 'slide', 0.34964792986009613, 0.40716959970012173],
		[
			'slide entrance with fade-scale exit',
			'slide',
			'fade-scale',
			0.3841362972160001,
			0.40716959970012173,
		],
		[
			'fade-scale entrance with slide exit',
			'fade-scale',
			'slide',
			0.34964792986009613,
			0.40716959970012173,
		],
	]) {
		const frames = captureFrames(t);
		const engine = new SheetEngine();
		const dialog = makeDialog();
		const changes = [];
		engine.setProfile(profileFor('bottom', { effect, exitEffect }));
		engine.setSnaps([500], 0);

		const opening = engine.show({ to: dialog });
		drainFrames(frames);
		await opening;
		const rest = { ...dialog.style };
		engine.on('change', (event) => changes.push(event));

		const hiding = engine.hide();
		for (let index = 0; index < 5; index++) {
			assert.ok(frames.length > 0, `${label} hide frame ${index + 1} is queued`);
			frames.shift()(index * 16.66);
		}
		const painted = { ...dialog.style };
		assert.equal(
			engine.backdropProgress,
			expectedBackdropBefore,
			`${label} reaches the pinned pre-reversal backdrop value`
		);
		assert.equal(
			changes.at(-1).progress,
			0.3841362972160001,
			`${label} reaches the pinned pre-reversal painted progress`
		);

		const reversalStart = changes.length;
		const reopening = engine.show({ to: dialog });
		assert.deepEqual({ ...dialog.style }, painted, `${label} reversal is exactly continuous`);
		// expectedBackdropBefore, not a constant. A slide exit remaps its backdrop
		// through backdropClearProgress, so the two slide rows genuinely paint a
		// LOWER opacity than the raw p x size the other two land on — which is why
		// that column already varies per row. Seeding the reversal from raw p x size
		// discarded the remap and shoved those two rows back up to the unremapped
		// number on the first reversal frame, and this assertion pinned the jump
		// while its own message claimed the floor was exact. It is exact now.
		assert.equal(
			engine.backdropProgress,
			expectedBackdropBefore,
			`${label} reversal keeps the exact visible-extent floor`
		);
		drainFrames(frames);
		await Promise.all([hiding, reopening]);
		const reversalChanges = changes.slice(reversalStart);
		assert.equal(
			reversalChanges[0].progress,
			expectedFirstProgress,
			`${label} first published reversal progress continues from the painted floor`
		);
		assert.equal(reversalChanges.at(-1).progress, 1, `${label} publishes progress 1 at settle`);
		assert.equal(engine.backdropProgress, 1, `${label} backdrop reaches 1 at settle`);
		assert.deepEqual({ ...dialog.style }, rest, `${label} settles at the exact open rest frame`);
		engine.destroy();
	}
});

test('a zero-travel hide defers hidden until after the caller returns', async (t) => {
	const frames = captureFrames(t);
	const engine = makeEngine();
	const dialog = makeDialog();
	let insideHide = true;
	let hiddenInsideHide;
	engine.on('hidden', () => {
		hiddenInsideHide = insideHide;
	});

	const opening = engine.show({ to: dialog });
	const hiding = engine.hide();
	assert.equal(hiddenInsideHide, undefined, 'hide does not emit hidden synchronously');
	insideHide = false;
	await hiding;
	assert.equal(hiddenInsideHide, false);
	assert.equal(engine.state, 'hidden');

	const reopened = engine.show({ to: dialog });
	drainFrames(frames);
	await Promise.all([opening, reopened]);
	assert.equal(engine.state, 'shown', 'the transport accepts a later show');
	engine.destroy();
});

test('SheetEngine settleTo changes the active snap and emits snapchange', async (t) => {
	const frames = captureFrames(t);
	const engine = makeEngine();
	const dialog = makeDialog();
	engine.setSnaps([200, 500], 0);
	const events = [];
	const changes = [];
	const order = [];
	engine.on('change', (detail) => {
		changes.push(detail);
		order.push('change');
	});
	engine.on('snapchange', (detail) => {
		events.push(detail);
		order.push('snapchange');
	});
	const show = engine.show({ to: dialog });
	drainFrames(frames);
	await show;

	const settle = engine.settleTo(1, 0);
	drainFrames(frames);
	await settle;
	assert.equal(engine.activeSnap, 1);
	assert.equal(dialog.style.height, '500px');
	assert.deepEqual(events, [{ from: 0, to: 1 }]);
	assert.equal(changes.at(-1).progress, 1, 'the settled repaint is published exactly');
	assert.deepEqual(order.slice(-2), ['change', 'snapchange']);
	engine.destroy();
});

test('live reconfiguration lands a pending snap before rebuilding frames', async (t) => {
	const reconfigure = async (kind) => {
		const frames = captureFrames(t);
		const engine = new SheetEngine();
		const dialog = makeDialog();
		engine.setProfile(profileFor('bottom'));
		engine.setSnaps([160, 440, 720], 2);
		const opened = engine.show({ to: dialog });
		drainFrames(frames);
		await opened;

		const settling = engine.settleTo(1, 0);
		for (let index = 0; index < 5; index++) {
			assert.ok(frames.length > 0, `${kind} settle frame ${index + 1} is queued`);
			frames.shift()(index * 16.66);
		}

		if (kind === 'profile') {
			engine.setProfile(profileFor('bottom', { viewportHeight: 900 }));
		} else {
			engine.setSnaps([160, 440, 720], 1);
		}

		const subsequent = [];
		while (frames.length) {
			frames.shift()(100);
			subsequent.push(translateY(dialog));
		}
		await settling;
		const result = {
			activeSnap: engine.activeSnap,
			currentSize: engine.currentSize,
			height: dialog.style.height,
			transform: dialog.style.transform,
			subsequent,
		};
		engine.destroy();
		return result;
	};

	for (const kind of ['profile', 'snaps']) {
		const result = await reconfigure(kind);
		assert.deepEqual(
			{
				activeSnap: result.activeSnap,
				currentSize: result.currentSize,
				height: result.height,
				transform: result.transform,
			},
			{
				activeSnap: 1,
				currentSize: 440,
				height: '440px',
				transform: 'translate3d(0px, 0px, 0px) scale(1)',
			},
			`${kind} lands on the pending destination`
		);
		assert.ok(
			result.subsequent.every((value) => value === 0),
			`${kind} leaves every queued frame at translateY(0)`
		);
	}
});

test('SheetEngine dismiss emits hidden', async (t) => {
	const frames = captureFrames(t);
	const engine = makeEngine();
	const dialog = makeDialog();
	const events = [];
	engine.on('hidden', () => events.push('hidden'));
	const show = engine.show({ to: dialog });
	drainFrames(frames);
	await show;
	const dismiss = engine.dismiss(0.7);
	drainFrames(frames);
	await dismiss;
	assert.equal(engine.state, 'hidden');
	assert.deepEqual(events, ['hidden']);
	engine.destroy();
});

test('SheetEngine declares itself a direct engine', () => {
	const engine = new SheetEngine();
	assert.equal(engine.animatesDialog, true);
	engine.destroy();
});

test('inline styles are already restored when hidden fires', async (t) => {
	const frames = captureFrames(t);
	const engine = makeEngine();
	const dialog = makeDialog();
	dialog.style.display = 'grid';
	const show = engine.show({ to: dialog, display: 'flex' });
	drainFrames(frames);
	await show;

	let displayAtHidden;
	engine.on('hidden', () => {
		displayAtHidden = dialog.style.display;
	});
	const hidden = engine.dismiss(0.5);
	drainFrames(frames);
	await hidden;

	// dialog-panel's finalize runs synchronously inside this emit; the pose it
	// closes over must already be the consumer's own inline styles.
	assert.equal(displayAtHidden, 'grid');
	assert.equal(engine.state, 'hidden');
	engine.destroy();
});

test('a hidden listener can re-enter show and the inline snapshot survives', async (t) => {
	const frames = captureFrames(t);
	const engine = makeEngine();
	const dialog = makeDialog();
	dialog.style.display = 'grid';
	const show = engine.show({ to: dialog, display: 'flex' });
	drainFrames(frames);
	await show;

	// Re-enter show from inside the hidden emit — the "close A, open B" flow.
	// With the old emit-then-restore order the outer settle wiped the new
	// run's styles AND nulled the snapshot it had just saved, so the second
	// cycle below could never restore the consumer's own display again.
	let reentered = null;
	engine.on('hidden', () => {
		if (!reentered) reentered = engine.show({ to: dialog, display: 'flex' });
	});
	const hidden = engine.dismiss(0.5);
	drainFrames(frames);
	await hidden;
	assert.equal(engine.state, 'shown', 'the re-entrant entrance ran to completion');

	const second = engine.dismiss(0.5);
	drainFrames(frames);
	await second;
	assert.equal(engine.state, 'hidden');
	assert.equal(dialog.style.display, 'grid', 'the re-entrant run kept a valid inline snapshot');
	engine.destroy();
});

test('SheetEngine clamps height at zero during negative drag overshoot', async (t) => {
	const frames = captureFrames(t);
	const engine = makeEngine();
	const dialog = makeDialog();
	const show = engine.show({ to: dialog });
	drainFrames(frames);
	await show;
	engine.dragBy(1000);
	assert.ok(Number.parseFloat(dialog.style.height) >= 0);
	engine.destroy();
});

// Bottom is the ONLY profile that paints a size. Side sheets are fixed width and
// a centered dialog is sized by its content, so both express every size change as
// translation. Center is included here deliberately: it shares the bottom sheet's
// axis, and it would be an easy mistake to give it the bottom sheet's height track
// along with it.
test('non-resizing profiles never carry a size property', () => {
	for (const position of ['left', 'right', 'center']) {
		for (const effect of ['slide', 'fade-scale', 'slide-fade']) {
			const profile = profileFor(position, { effect });
			assertNoSizeProperties(buildOpenKeyframes(profile, 400, 400), `open ${position}/${effect}`);
		}
		const profile = profileFor(position);
		assertNoSizeProperties(buildDragKeyframes(profile, 400, 400, 400), `drag ${position}`);
		assertNoSizeProperties(buildRestKeyframes(profile, 400, 250, 400), `rest ${position}`);
	}
});

// `snap-points` is a MOBILE-profile attribute and is ignored past the breakpoint,
// so a desktop bottom panel is sized by its own content exactly like `center` and
// joins the non-resizing profiles above. Emitting a pixel height there is not
// merely redundant: it pins the box, so the next measurement reads back the
// number the previous frame wrote rather than the content's own height, and the
// content ResizeObserver has nothing left to observe.
test('a desktop bottom profile is content-sized and never carries a size property', () => {
	const desktop = profileFor('bottom', { desktop: true });
	const mobile = profileFor('bottom');

	assert.equal(contentSized(desktop), true);
	assert.equal(contentSized(profileFor('center')), true);
	assert.equal(contentSized(mobile), false);
	assert.equal(
		contentSized(profileFor('left', { desktop: true })),
		false,
		'a side sheet is sized by a CSS token, not by its content'
	);
	assert.equal(resizesWithSnaps(mobile), true, 'a mobile bottom sheet still paints its snaps');
	assert.equal(resizesWithSnaps(desktop), false);

	for (const effect of ['slide', 'fade-scale', 'slide-fade']) {
		const profile = profileFor('bottom', { desktop: true, effect });
		assertNoSizeProperties(
			buildOpenKeyframes(profile, 400, 400, 400),
			`open desktop bottom/${effect}`
		);
		assertNoSizeProperties(
			buildExitKeyframes(profile, 400, 400, 400, { effect }),
			`exit desktop bottom/${effect}`
		);
	}
	assertNoSizeProperties(buildDragKeyframes(desktop, 400, 400, 400, 400), 'drag desktop bottom');

	// The mobile twin is unchanged and still paints the snap it rests on.
	assert.equal(buildDragKeyframes(mobile, 400, 400, 400, 400)[100].height, '400px');
});

test('a desktop bottom drag translates its content-sized box instead of resizing it', () => {
	const desktop = profileFor('bottom', { desktop: true });

	// Same axis as ever — it is still a bottom sheet, pulled away downward — but
	// the whole size change is expressed as translation, like a centred dialog.
	const drag = buildDragKeyframes(desktop, 400, 400, 400, 400);
	assert.equal(drag[0].transform, 'translate3d(0px, 400px, 0px) scale(1)');
	assert.equal(drag[100].transform, 'translate3d(0px, 0px, 0px) scale(1)');

	// Read back out as numbers: a content-sized panel paints its resting extent
	// wherever the drag took it, and has already travelled the whole difference.
	// That is what keeps the exit runway honest — a shrinking height would let it
	// stop short.
	assert.equal(paintedExtent(desktop, 120, 400, 400), 400);
	assert.equal(awayTranslation(desktop, 120, 400, 400), 280);
	assert.equal(
		paintedExtent(profileFor('bottom'), 120, 400, 400),
		400,
		'a snapped bottom sheet below its floor paints the floor, so both agree here'
	);
	assert.equal(awayTranslation(profileFor('bottom'), 120, 400, 400), 280);
});

test('entrance and exit tracks expose the same property keys for every profile and effect', () => {
	for (const position of ['bottom', 'left', 'right', 'center']) {
		for (const effect of ['slide', 'fade-scale', 'slide-fade']) {
			const profile = profileFor(position, { effect });
			const entrance = buildOpenKeyframes(profile, 400, 400, 200);
			const exit = buildExitKeyframes(profile, 400, 400, 200, { effect });
			assert.deepEqual(
				trackPropertyKeys(exit),
				trackPropertyKeys(entrance),
				`${position}/${effect}`
			);
		}
	}
});

test('every track on every profile and effect carries a filter on every keyframe', () => {
	// The back-fill trap, one property over from the transform rule. FrameEngine
	// treats `filter` as composite and back-fills a zeroed default onto any
	// keyframe that omits it — so one bare frame becomes a hard blur(0px) and
	// bends the track through it. Asserting presence per FRAME, not per track, is
	// the point: a track whose ends carry filter and whose reveal frame does not
	// passes any per-track check and still has the corner.
	for (const position of ['bottom', 'left', 'right', 'center']) {
		for (const effect of ['slide', 'fade-scale', 'slide-fade']) {
			const profile = profileFor(position, { effect });
			const tracks = {
				entrance: buildOpenKeyframes(profile, 400, 400, 200),
				exit: buildExitKeyframes(profile, 400, 400, 200, { effect }),
				drag: buildDragKeyframes(profile, 400, 400, 400, 200),
				snap: buildRestKeyframes(profile, 200, 400, 400, 200),
			};
			for (const [name, keyframes] of Object.entries(tracks)) {
				for (const [percent, frame] of Object.entries(keyframes)) {
					assert.ok(
						'filter' in frame,
						`${position}/${effect} ${name} keyframe ${percent} omits filter`
					);
				}
			}
		}
	}
});

test('only the fading effects blur, and their blur is spent before the track ends', () => {
	// Two invariants in one place because they are the same rule seen from both
	// ends. A slide arrives at full clarity from off screen and must never blur.
	// Whatever does blur has to be FLAT by the end, or spring overshoot past p=1
	// extrapolates it and the panel softens again as it settles — the same flicker
	// the reveal frame already exists to keep opacity out of.
	const profile = profileFor('center', { viewportHeight: 800 });
	const blurAt = (frames, p) => Number(frames.getFrame(p).filter.match(/blur\(([\d.]+)px\)/)[1]);

	const slide = new FrameEngine(buildOpenKeyframes({ ...profile, effect: 'slide' }, 373, 373, 373));
	assert.equal(blurAt(slide, 0), 0, 'slide must not blur at its hidden frame');
	assert.equal(blurAt(slide, 1), 0, 'slide must not blur at rest');

	for (const effect of ['fade-scale', 'slide-fade']) {
		const frames = new FrameEngine(buildOpenKeyframes({ ...profile, effect }, 373, 373, 373));
		assert.equal(blurAt(frames, 0), EFFECT_BLUR[effect], `${effect} starts at its peak blur`);
		assert.equal(blurAt(frames, 0.8), 0, `${effect} is clear by the reveal frame`);
		assert.equal(blurAt(frames, 1), 0, `${effect} is clear at rest`);
		// Past rest is where the flatness earns its keep: an overshooting spring
		// extrapolates whatever slope the last segment had.
		assert.equal(blurAt(frames, 1.25), 0, `${effect} stays clear through overshoot`);
	}
});

test('a fading exit walks its blur back in as it leaves', () => {
	// The entrance frames read backwards, so the panel is sharp while it is still
	// legible and softens only as it goes. Pinned at exact values because "it
	// blurred more than zero" is satisfied by a track that blurs at the wrong end.
	const profile = profileFor('center', { effect: 'fade-scale', viewportHeight: 800 });
	const frames = new FrameEngine(buildExitKeyframes(profile, 373, 373, 373, {}));
	const blurAt = (p) => Number(frames.getFrame(p).filter.match(/blur\(([\d.]+)px\)/)[1]);

	assert.equal(blurAt(1), 0, 'clear at the release pose');
	assert.equal(blurAt(0.8), 0, 'still clear through the flat band');
	assert.equal(blurAt(0.4), 4, 'softening on the way out');
	assert.equal(blurAt(0), EFFECT_BLUR['fade-scale'], 'at its peak when hidden');
});

// The split that makes `center` possible: which axis a profile travels on is a
// separate question from whether it resizes. Bottom and center answer the first
// the same way and the second differently.
test('the dismiss axis is independent of whether a profile resizes', () => {
	assert.equal(dismissAxis('bottom'), 'y');
	assert.equal(dismissAxis('center'), 'y', 'a centered dialog is swiped away downward');
	assert.equal(dismissAxis('left'), 'x');
	assert.equal(dismissAxis('right'), 'x');

	// Fingers down dismisses a centered dialog, exactly as for a bottom sheet.
	assert.equal(awayOffset('center', 0, 40), 40);
	assert.equal(awayOffset('center', 40, 0), 0, 'horizontal motion is not a centre dismissal');
	assert.equal(awayOffset('center', 0, 40), awayOffset('bottom', 0, 40));

	assert.equal(transformOrigin(profileFor('center')), 'center center');
});

test('centre keyframes travel vertically and settle on the middle', () => {
	// Travel lands on y, not x. Putting it on x would fly the panel out sideways.
	// The DISTANCE follows the same rule every profile follows — own reach plus the
	// gap to the edge — and for a centred panel that gap is half the leftover
	// viewport, so 400 in an 800 viewport travels 400 + 200 + cushion.
	const slide = buildOpenKeyframes(profileFor('center', { effect: 'slide' }), 400, 400);
	assert.equal(slide[0].transform, `translate3d(0px, ${400 + 200 + EXIT_CUSHION}px, 0px) scale(1)`);
	assert.equal(slide[100].transform, 'translate3d(0px, 0px, 0px) scale(1)');

	// A short rise from below, same axis.
	const slideFade = buildOpenKeyframes(profileFor('center', { effect: 'slide-fade' }), 400, 400);
	assert.equal(slideFade[0].transform, 'translate3d(0px, 24px, 0px) scale(1)');

	// Dragging it downward translates rather than shrinking it.
	const drag = buildDragKeyframes(profileFor('center'), 400, 400, 400);
	assert.equal(drag[0].transform, 'translate3d(0px, 400px, 0px) scale(1)');
	assert.equal(drag[100].transform, 'translate3d(0px, 0px, 0px) scale(1)');

	assert.deepEqual(
		buildRestKeyframes(profileFor('center'), 400, 250, 400),
		{},
		'a centred dialog has no snap-to-snap keyframes'
	);
});

test('a centred slide clears the edge it is nowhere near, and no further', () => {
	// A centred panel rests mid-screen, so unlike every edge profile it starts a
	// long way from the edge a slide has to clear. Clearing it is the easy half;
	// clearing it TIGHTLY is the half that matters, because excess runway is the
	// empty-screen-under-a-live-overlay problem the runway rule exists to prevent.
	const viewportHeight = 800;
	const runwayFor = (size) =>
		Number.parseFloat(
			buildOpenKeyframes(
				profileFor('center', { effect: 'slide', viewportHeight }),
				size,
				size
			)[0].transform.match(/,\s*(-?[\d.]+)px/)[1]
		);

	for (const size of [200, 400, 600, 780]) {
		const runway = runwayFor(size);
		// Resting centred, the gap from the panel's own bottom to the screen's is
		// what the slide actually has to cover.
		const needed = viewportHeight - (viewportHeight - size) / 2;
		assert.ok(runway >= needed, `size ${size}: runway ${runway} must clear ${needed}`);
		assert.equal(
			runway,
			needed + EXIT_CUSHION,
			`size ${size}: runway must clear by exactly the shared cushion, not by a guess`
		);
	}

	// The bound that was tried and rejected: half the viewport always clears, but
	// it overshoots by half the panel — 33% past off-screen for a 373px dialog.
	const size = 400;
	assert.ok(
		runwayFor(size) < size + viewportHeight / 2 + EXIT_CUSHION,
		'the exact gap must beat the safe-bound guess it replaced'
	);
});

test('an edge profile still takes its inset from the component', () => {
	// slideInset only special-cases centre; every other profile keeps the probed
	// value the component resolves, and a profile without one reads as flush.
	const inset = 12;
	const card = buildOpenKeyframes(
		profileFor('right', { effect: 'slide', edgeInset: inset }),
		400,
		400
	);
	assert.equal(
		card[0].transform,
		`translate3d(${400 + inset + EXIT_CUSHION}px, 0px, 0px) scale(1)`
	);

	// A centred profile ignores edgeInset even when one is supplied, because its
	// own geometry is the authority.
	const centred = buildOpenKeyframes(
		profileFor('center', { effect: 'slide', viewportHeight: 800, edgeInset: 9999 }),
		400,
		400
	);
	assert.equal(
		centred[0].transform,
		`translate3d(0px, ${400 + 200 + EXIT_CUSHION}px, 0px) scale(1)`
	);
});

test('a centred dialog returns to rest rather than snapping', async (t) => {
	const frames = captureFrames(t);
	const engine = new SheetEngine();
	const dialog = makeDialog();
	engine.setProfile(profileFor('center'));
	engine.setSnaps([200, 500], 0);

	assert.deepEqual(engine.snaps, [500], 'a centred profile keeps one resting size');
	const show = engine.show({ to: dialog });
	drainFrames(frames);
	await show;

	engine.dragBy(120);
	assert.equal(engine.currentSize, 380);
	assert.equal(dialog.style.transform, 'translate3d(0px, 120px, 0px) scale(1)');

	assert.equal(await engine.settleTo(1, 0.8), false, 'settleTo stays bottom-only');

	const changes = [];
	engine.on('change', (detail) => changes.push(detail));
	const returning = engine.returnToRest(0.8);
	drainFrames(frames);
	await returning;
	assert.equal(engine.currentSize, 500);
	assert.equal(dialog.style.transform, 'translate3d(0px, 0px, 0px) scale(1)');
	assert.equal(changes.at(-1).progress, 1, 'the return repaint is published exactly');
	engine.destroy();
});

test('a centred live drag continues below zero until the panel clears the viewport', async (t) => {
	const frames = captureFrames(t);
	const engine = new SheetEngine();
	const dialog = makeDialog();
	engine.setProfile(profileFor('center', { mode: 'card', viewportHeight: 800 }));
	engine.setSnaps([373], 0);
	const show = engine.show({ to: dialog });
	drainFrames(frames);
	await show;

	engine.dragBy(373);
	assert.deepEqual(
		{
			progress: engine.progress,
			translate: translateY(dialog),
			backdrop: engine.backdropProgress,
		},
		{ progress: 0, translate: 373, backdrop: 0.3640238704177323 },
		'logical zero is still inset from the edge, so neither track may stop there'
	);

	engine.dragBy(600);
	assert.deepEqual(
		{
			progress: engine.progress,
			translate: translateY(dialog),
			backdrop: engine.backdropProgress,
		},
		{ progress: -0.6085790884718498, translate: 600, backdrop: 0 },
		'the landed track extrapolates 1:1 until the box has crossed the edge'
	);
	engine.destroy();
});

test('a parked engine writes nothing and refuses every gesture', async (t) => {
	const frames = captureFrames(t);
	const engine = makeEngine();
	const dialog = makeDialog();
	const show = engine.show({ to: dialog });
	drainFrames(frames);
	await show;

	assert.equal(engine.morphing, false);
	assert.equal(engine.beginMorph(), true);
	assert.equal(engine.morphing, true);

	// The host owns every inline box property for the duration, so a frame
	// written underneath it would fight the transition it is driving.
	const parked = { ...dialog.style };
	engine.dragBy(200);
	assert.deepEqual(dialog.style, parked, 'dragBy paints nothing while parked');
	assert.equal(await engine.settleTo(0, 0.8), false, 'settleTo refuses while parked');
	assert.deepEqual(dialog.style, parked, 'a refused settle paints nothing');

	// Held at 1 so the overlay cannot blink while the resting size changes
	// underneath it.
	assert.equal(engine.backdropProgress, 1);

	// A different profile takes over, exactly as the host would apply it.
	engine.setProfile(profileFor('right'));
	engine.setSnaps([420], 0);
	assert.deepEqual(dialog.style, parked, 'reconfiguring while parked still paints nothing');

	engine.endMorph();
	assert.equal(engine.morphing, false);
	assert.equal(engine.progress, 1, 'the panel resumes at rest');
	assert.equal(
		dialog.style.transform,
		'translate3d(0px, 0px, 0px) scale(1)',
		'and repaints against the new profile'
	);
	engine.destroy();
});

test('a parked centred dialog refuses returnToRest too', async (t) => {
	const frames = captureFrames(t);
	const engine = new SheetEngine();
	const dialog = makeDialog();
	engine.setProfile(profileFor('center'));
	engine.setSnaps([500], 0);
	const show = engine.show({ to: dialog });
	drainFrames(frames);
	await show;

	engine.dragBy(120);
	engine.beginMorph();
	// beginMorph lands the panel at rest first: a resize arriving mid-drag must
	// not bake a half-finished transform into the box the host measures.
	assert.equal(dialog.style.transform, 'translate3d(0px, 0px, 0px) scale(1)');
	assert.equal(engine.currentSize, 500);

	assert.equal(await engine.returnToRest(0.8), false, 'returnToRest refuses while parked');
	engine.endMorph();
	engine.destroy();
});

test('beginMorph declines while the panel is hidden', () => {
	const engine = new SheetEngine();
	engine.setProfile(profileFor('bottom'));
	engine.setSnaps([500], 0);
	assert.equal(engine.beginMorph(), false, 'nothing to morph while hidden');
	assert.equal(engine.morphing, false);
	// endMorph on an unparked engine is inert rather than throwing, so every exit
	// route can call it unconditionally.
	engine.endMorph();
	assert.equal(engine.morphing, false);
	engine.destroy();
});

test('beginMorph refuses and endMorph stays inert during a blob flight', () => {
	MorphEngine.instances.length = 0;
	const engine = makeEngine();
	const trigger = new StubElement('button');
	const dialog = new StubElement('dialog');
	trigger.rect = { top: 20, left: 20, right: 68, bottom: 68, width: 48, height: 48 };
	dialog.rect = { top: 100, left: 0, right: 400, bottom: 600, width: 400, height: 500 };
	engine.armMorph(trigger);
	void engine.show({ from: trigger, to: dialog });
	const blob = MorphEngine.instances.at(-1);

	assert.equal(engine.blobFlight, true);
	assert.equal(engine.beginMorph(), false);
	engine.endMorph();
	assert.equal(engine.blobFlight, true);
	assert.equal(engine.morphing, false);
	assert.equal(dialog.style.getPropertyValue('transform'), '');
	assert.equal(dialog.style.getPropertyValue('height'), '');

	blob.step(1);
	engine.destroy();
});

test('endMorph during a reverse blob flight releases only the profile park', () => {
	MorphEngine.instances.length = 0;
	const engine = makeEngine();
	const trigger = new StubElement('button');
	const dialog = new StubElement('dialog');
	engine.armMorph(trigger);
	void engine.show({ to: dialog });
	const blob = MorphEngine.instances.at(-1);
	blob.step(1);
	assert.equal(engine.beginMorph(), true);
	dialog.style.transform = 'host-profile-pin';

	void engine.hide();
	assert.equal(engine.blobFlight, true);
	engine.endMorph();

	assert.equal(engine.morphing, false);
	assert.equal(engine.blobFlight, true);
	assert.equal(dialog.style.transform, 'host-profile-pin');
	blob.step(1);
	assert.equal(engine.state, 'hidden');
	engine.destroy();
});

test('closing during a profile morph resets both transports before an immediate reopen', async (t) => {
	for (const transport of ['direct', 'trigger']) {
		const frames = captureFrames(t);
		MorphEngine.instances.length = 0;
		const engine = makeEngine();
		const dialog = new StubElement('dialog');
		let blob;

		if (transport === 'trigger') {
			const trigger = new StubElement('button');
			engine.armMorph(trigger);
			void engine.show({ to: dialog });
			blob = MorphEngine.instances.at(-1);
			blob.step(1);
		} else {
			const shown = engine.show({ to: dialog });
			drainFrames(frames);
			await shown;
		}

		assert.equal(engine.beginMorph(), true, `${transport} profile morph starts`);
		let hidden;
		if (transport === 'trigger') {
			hidden = engine.hide();
			engine.endMorph();
			blob.step(1);
		} else {
			engine.endMorph();
			hidden = engine.hide();
			drainFrames(frames);
		}
		await hidden;

		assert.equal(engine.state, 'hidden', `${transport} close lands hidden`);
		assert.equal(engine.morphing, false, `${transport} close releases the profile park`);
		const reopened = engine.show({ to: dialog });
		assert.equal(
			dialog.style.transform,
			'translate3d(0px, 528px, 0px) scale(1)',
			`${transport} reopen paints its p = 0 frame`
		);
		drainFrames(frames);
		await reopened;
		engine.destroy();
	}
});

test('stop clears a stranded morph after the blob already hid', () => {
	MorphEngine.instances.length = 0;
	const engine = makeEngine();
	const trigger = new StubElement('button');
	const dialog = new StubElement('dialog');
	engine.armMorph(trigger);
	void engine.show({ to: dialog });
	const blob = MorphEngine.instances.at(-1);
	blob.step(1);
	assert.equal(engine.beginMorph(), true);
	void engine.hide();
	blob.step(1);

	assert.equal(engine.state, 'hidden');
	assert.equal(engine.morphing, true);
	engine.stop();
	assert.equal(engine.morphing, false);
	engine.destroy();
});

test('reverse blob close supersedes settle and return springs', async (t) => {
	for (const kind of ['settleTo', 'returnToRest']) {
		const frames = captureFrames(t);
		MorphEngine.instances.length = 0;
		const engine = new SheetEngine();
		const dialog = new StubElement('dialog');
		const writesAfterHidden = [];
		let trackWrites = false;
		dialog.style = new Proxy(dialog.style, {
			set(target, property, value) {
				if (trackWrites) writesAfterHidden.push([property, value]);
				target[property] = value;
				return true;
			},
		});
		if (kind === 'settleTo') {
			engine.setProfile(profileFor('bottom'));
			engine.setSnaps([200, 500], 1);
		} else {
			engine.setProfile(profileFor('right'));
			engine.setSnaps([500], 0);
		}
		const trigger = new StubElement('button');
		engine.armMorph(trigger);
		void engine.show({ to: dialog });
		const blob = MorphEngine.instances.at(-1);
		blob.step(1);
		engine.dragBy(120);

		const phases = [];
		const snapchanges = [];
		engine.on('change', ({ phase }) => phases.push(phase));
		engine.on('snapchange', (detail) => snapchanges.push(detail));
		engine.on('hidden', () => {
			trackWrites = true;
		});
		const settling = kind === 'settleTo' ? engine.settleTo(0, -1.5) : engine.returnToRest(1.5);
		for (let index = 0; index < 3; index++) frames.shift()(index * 16.66);

		void engine.hide();
		blob.step(1);
		drainFrames(frames);
		await settling;

		assert.equal(engine.state, 'hidden', kind);
		assert.equal(phases.at(-1), 'hidden', kind);
		assert.deepEqual(snapchanges, [], kind);
		assert.deepEqual(writesAfterHidden, [], kind);
		assert.deepEqual(
			{
				display: dialog.style.getPropertyValue('display'),
				height: dialog.style.getPropertyValue('height'),
				transform: dialog.style.getPropertyValue('transform'),
			},
			{ display: '', height: '', transform: '' },
			kind
		);
		trackWrites = false;
		engine.destroy();
	}
});

test('reversing a blob close drops the cancelled snap and lands at rest', async (t) => {
	const frames = captureFrames(t);
	MorphEngine.instances.length = 0;
	const engine = makeEngine();
	const trigger = new StubElement('button');
	const dialog = new StubElement('dialog');
	engine.armMorph(trigger);
	void engine.show({ to: dialog });
	const blob = MorphEngine.instances.at(-1);
	blob.step(1);
	engine.dragBy(120);
	const settling = engine.settleTo(0, -1.5);
	for (let index = 0; index < 3; index++) frames.shift()(index * 16.66);

	void engine.hide();
	blob.step(0.4);
	void engine.show({ to: dialog });
	blob.step(0);
	drainFrames(frames);
	await settling;

	assert.deepEqual(
		{
			activeSnap: engine.activeSnap,
			currentSize: engine.currentSize,
			height: dialog.style.height,
			state: engine.state,
			transform: dialog.style.transform,
		},
		{
			activeSnap: 1,
			currentSize: 500,
			height: '500px',
			state: 'shown',
			transform: 'translate3d(0px, 0px, 0px) scale(1)',
		}
	);
	engine.destroy();
});

test('snap velocity scales against the signed segment the settle must cross', () => {
	// The spring always runs 0 -> TRAVEL, so a release velocity is only
	// meaningful as a share of the pixel distance THAT run covers. For a snap
	// that distance is the segment, and on every downward snap it is negative —
	// scaling against the resting size (always positive) inverted the sign.
	assert.ok(velocityToSpring(-1, 480 - 600) > 0, 'a flick down onto a smaller snap drives forward');
	assert.ok(velocityToSpring(1, 720 - 600) > 0, 'a flick up onto a larger snap drives forward');
	assert.ok(velocityToSpring(1, 480 - 600) < 0, 'flicking away from the target opposes it');
	assert.equal(velocityToSpring(-1, -120), velocityToSpring(1, 120), 'mirrored gestures agree');
	assert.ok(
		velocityToSpring(-1, -20) > velocityToSpring(-1, -240),
		'the same speed is a bigger share of a shorter hop'
	);
	assert.equal(velocityToSpring(-1, -120), (FRAME_MS * VELOCITY_BOOST * 100) / 120);
});

test('a spanless settle yields no velocity rather than a non-finite one', () => {
	// PhysicsEngine throws on a non-finite velocity, and settleTo(activeSnap)
	// on a cancelled gesture or snapTo() can land exactly on the destination.
	assert.equal(velocityToSpring(-1, 0), 0);
	assert.equal(velocityToSpring(-1, 0.5), 0);
	assert.equal(velocityToSpring(Number.NaN, -120), 0);
	assert.equal(velocityToSpring(-1, Number.NaN), 0);
});

test('short snap hops cap flick energy without changing a normal hop', async (t) => {
	const settle = async (span, flick) => {
		const frames = captureFrames(t);
		const engine = new SheetEngine();
		const dialog = makeDialog();
		engine.setProfile(profileFor('bottom'));
		engine.setSnaps([480, 720], 1);
		const opened = engine.show({ to: dialog });
		drainFrames(frames);
		await opened;
		engine.dragBy(240 - span);

		const sizes = [];
		engine.on('change', ({ phase }) => {
			if (phase === 'snapping') {
				sizes.push(Number.parseFloat(dialog.style.height) - translateY(dialog));
			}
		});
		const settled = engine.settleTo(0, -flick);
		const frameCount = drainFrames(frames);
		await settled;

		let reversals = 0;
		let direction = 0;
		for (let index = 1; index < sizes.length; index++) {
			const next = Math.sign(sizes[index] - sizes[index - 1]);
			if (next && direction && next !== direction) reversals++;
			if (next) direction = next;
		}
		const result = {
			span,
			flick,
			overshoot: Number((480 - Math.min(...sizes)).toFixed(4)),
			reversals,
			frameCount,
		};
		engine.destroy();
		return result;
	};

	const measured = [];
	for (const [span, flick] of [
		[240, 1.5],
		[5, 0.5],
		[1.5, 1.5],
		[1, 3],
	]) {
		measured.push(await settle(span, flick));
	}
	assert.deepEqual(measured, [
		{ span: 240, flick: 1.5, overshoot: 7.215, reversals: 1, frameCount: 33 },
		{ span: 5, flick: 0.5, overshoot: 0.2778, reversals: 1, frameCount: 32 },
		{ span: 1.5, flick: 1.5, overshoot: 0.0833, reversals: 1, frameCount: 32 },
		{ span: 1, flick: 3, overshoot: 0.0556, reversals: 1, frameCount: 32 },
	]);
});

test('snap overshoot frames never bend the settled track', () => {
	const profile = profileFor('bottom');
	const cases = [
		[480, 240],
		[720, 480],
		[720, 260],
		[100, 240],
		[100, 480],
		[240, 720],
	];
	for (const [from, to] of cases) {
		const all = buildRestKeyframes(profile, from, to, 480, 240);
		const settled = Object.fromEntries(
			Object.entries(all).filter(([percent]) => Number(percent) <= 100)
		);
		const before = new FrameEngine(settled);
		const after = new FrameEngine(all);
		for (let step = 0; step <= 100; step++) {
			assert.deepEqual(
				after.getFrame(step / 100),
				before.getFrame(step / 100),
				`${from}->${to} is untouched at p=${step / 100}`
			);
		}
	}
});

test('snap overshoot below the lowest snap translates instead of squashing', () => {
	const profile = profileFor('bottom');
	// Settling down onto the floor. Past p=1 the panel must slide, not shrink —
	// a height ramp below the floor reflows the content mid-settle.
	const frames = new FrameEngine(buildRestKeyframes(profile, 300, 240, 480, 240));
	for (const p of [1.024, 1.1, 1.4]) {
		const styles = frames.getFrame(p);
		assert.equal(styles.height, '240px', `height holds at the floor at p=${p}`);
		assert.ok(
			Number.parseFloat(styles.transform.match(/translate3d\([^,]+,\s*([^,]+)px/)[1]) > 0,
			`the remainder becomes translateY at p=${p}`
		);
	}
});

test('snap overshoot above the lowest snap never lifts the bottom edge', () => {
	const profile = profileFor('bottom');
	// Settling UP onto the floor out of the dismissal zone. Extrapolating the
	// pure-translation track drove translateY negative, lifting the sheet off
	// the bottom of the viewport.
	const frames = new FrameEngine(buildRestKeyframes(profile, 100, 240, 480, 240));
	for (const p of [1.024, 1.1, 1.4]) {
		const styles = frames.getFrame(p);
		const y = Number.parseFloat(styles.transform.match(/translate3d\([^,]+,\s*([^,]+)px/)[1]);
		assert.ok(y >= 0, `translateY stays grounded at p=${p} (got ${y})`);
		assert.ok(Number.parseFloat(styles.height) >= 240, `and the height stretches at p=${p}`);
	}
});

test('bottom-sheet keyframes still animate height for snap points', () => {
	const profile = profileFor('bottom');
	const drag = buildDragKeyframes(profile, 500, 500, 500, 200);
	assert.equal(drag[0].height, '200px');
	assert.equal(drag[0].transform, 'translate3d(0px, 200px, 0px) scale(1)');
	assert.equal(drag[40].height, '200px');
	assert.equal(drag[40].transform, 'translate3d(0px, 0px, 0px) scale(1)');
	assert.equal(drag[100].height, '500px');
	assert.equal(drag[100].transform, 'translate3d(0px, 0px, 0px) scale(1)');
	const rest = buildRestKeyframes(profile, 100, 200, 500, 200);
	assert.equal(rest[0].height, '200px');
	assert.equal(rest[0].transform, 'translate3d(0px, 100px, 0px) scale(1)');
	assert.equal(rest[100].height, '200px');
	assert.equal(rest[100].transform, 'translate3d(0px, 0px, 0px) scale(1)');
	for (const styles of Object.values(drag)) {
		assert.ok(!('width' in styles), 'bottom sheets never animate width');
		assert.ok('transform' in styles, 'every bottom drag keyframe carries a full transform');
	}
});

test('open keyframes pin a logical size below the lowest snap to the floor', () => {
	const keyframes = buildOpenKeyframes(profileFor('bottom'), 120, 500, 240);
	assert.equal(keyframes[100].height, '240px');
	assert.equal(keyframes[100].transform, 'translate3d(0px, 120px, 0px) scale(1)');
});

test('side-sheet size changes become translation along the dismiss axis', () => {
	const left = buildDragKeyframes(profileFor('left'), 400, 400, 400);
	assert.equal(left[0].transform, 'translate3d(-400px, 0px, 0px) scale(1)');
	assert.equal(left[100].transform, 'translate3d(0px, 0px, 0px) scale(1)');

	const right = buildDragKeyframes(profileFor('right'), 400, 400, 400);
	assert.equal(right[0].transform, 'translate3d(400px, 0px, 0px) scale(1)');
	assert.equal(right[100].transform, 'translate3d(0px, 0px, 0px) scale(1)');
	assert.deepEqual(
		buildRestKeyframes(profileFor('left'), 400, 250, 400),
		{},
		'side sheets have no snap-to-snap keyframes'
	);
});

test('side sheets expose no snap-to-snap behavior', async (t) => {
	const frames = captureFrames(t);
	const engine = new SheetEngine();
	const dialog = makeDialog();
	const changes = [];
	engine.setProfile(profileFor('right'));
	engine.setSnaps([200, 500], 0);
	engine.on('snapchange', (detail) => changes.push(detail));

	assert.deepEqual(engine.snaps, [500], 'a side profile retains one fixed width');
	const show = engine.show({ to: dialog });
	drainFrames(frames);
	await show;

	engine.dragBy(120);
	assert.equal(engine.currentSize, 380);
	assert.equal(dialog.style.transform, 'translate3d(120px, 0px, 0px) scale(1)');

	assert.equal(await engine.settleTo(1, 0.8), false, 'settleTo is bottom-only');
	assert.equal(engine.currentSize, 380, 'an ignored settle does not move the sheet');

	const returning = engine.returnToRest(0.8);
	drainFrames(frames);
	await returning;
	assert.equal(engine.currentSize, 500);
	assert.equal(engine.activeSnap, 0);
	assert.equal(dialog.style.transform, 'translate3d(0px, 0px, 0px) scale(1)');
	assert.deepEqual(changes, [], 'returning to the one width emits no snapchange');
	engine.destroy();
});

test('an interrupted side drag exits from where it was released', async (t) => {
	const frames = captureFrames(t);
	const engine = new SheetEngine();
	const dialog = makeDialog();
	engine.setProfile(profileFor('right'));
	engine.setSnaps([400], 0);

	const show = engine.show({ to: dialog });
	drainFrames(frames);
	await show;

	// Drag the 400px sheet half off-screen, then dismiss mid-gesture.
	engine.dragBy(200);
	assert.equal(dialog.style.transform, 'translate3d(200px, 0px, 0px) scale(1)');

	const translateX = () =>
		Number.parseFloat(dialog.style.transform.match(/translate3d\((-?[\d.]+)px/)[1]);
	const path = [];
	engine.on('change', () => path.push(translateX()));

	const hidden = engine.dismiss(0.5);
	// The regression this pins: rebuilding the exit from p=1 repainted the sheet
	// at rest (0px) for a frame before it flew out.
	assert.equal(translateX(), 200, 'the exit starts at the drag position, not rest');

	drainFrames(frames);
	await hidden;
	assert.equal(engine.state, 'hidden');
	for (let index = 1; index < path.length; index++) {
		assert.ok(path[index] >= path[index - 1] - 0.5, 'the exit never doubles back toward rest');
	}
	// Not merely `>= 399`. A flush exit also satisfies that, which is exactly why
	// the old bound never caught the panel stopping with its shadow — and, in card
	// mode, a sliver of itself — still on screen.
	assert.ok(
		path.at(-1) >= 400 + EXIT_CUSHION - 0.5,
		`the sheet clears its edge by the cushion, ended at ${path.at(-1)}`
	);
	engine.destroy();
});

test('a harder flick leaves sooner', async (t) => {
	// True only because the exit normalises its release velocity over the span the
	// run actually covers. Over the resting size — the shipped bug — a 400px sheet
	// dragged to 60px and thrown measured the same frames as a standing release:
	// the seed was scaled by restSize/|segment| and the attraction term swamped it,
	// so every flick-to-close settled identically however hard it was thrown.
	const framesToGone = async (velocity) => {
		const frames = captureFrames(t);
		const engine = new SheetEngine();
		const dialog = makeDialog();
		engine.setProfile(profileFor('right'));
		engine.setSnaps([400], 0);
		const show = engine.show({ to: dialog });
		drainFrames(frames);
		await show;

		engine.dragBy(340); // 400 -> 60px, nearly dismissed
		let count = 0;
		let gone = null;
		engine.on('change', ({ progress }) => {
			count += 1;
			if (gone === null && progress <= 0) gone = count;
		});
		const hidden = engine.dismiss(velocity);
		drainFrames(frames);
		await hidden;
		engine.destroy();
		return gone ?? count;
	};

	const slow = await framesToGone(0);
	const firm = await framesToGone(1.5);
	const hard = await framesToGone(3);
	assert.ok(firm < slow, `a firm flick (${firm}) beats a slow release (${slow})`);
	assert.ok(hard < firm, `a hard flick (${hard}) beats a firm one (${firm})`);
});

test('slide exit distance is signed per position and only as long as it needs to be', () => {
	// The runway is the panel plus its inset plus a small cushion — never a
	// viewport. profileFor is edge-mounted, so its inset is 0.
	const edge = (size) => size + EXIT_CUSHION;

	const left = buildOpenKeyframes(profileFor('left'), 400, 400);
	assert.equal(left[0].transform, `translate3d(${-edge(400)}px, 0px, 0px) scale(1)`);
	assert.equal(left[100].transform, 'translate3d(0px, 0px, 0px) scale(1)');

	const right = buildOpenKeyframes(profileFor('right'), 400, 400);
	assert.equal(right[0].transform, `translate3d(${edge(400)}px, 0px, 0px) scale(1)`);

	const bottom = buildOpenKeyframes(profileFor('bottom'), 500, 500);
	assert.equal(bottom[0].transform, `translate3d(0px, ${edge(500)}px, 0px) scale(1)`);

	// The regression this pins: a viewport-long runway left a small panel gone
	// well before p reached 0, so the overlay lingered over an empty screen.
	const roomy = buildOpenKeyframes(
		profileFor('left', { viewportWidth: 4000, viewportHeight: 4000 }),
		400,
		400
	);
	assert.equal(
		roomy[0].transform,
		left[0].transform,
		'a bigger screen is a longer flight, not more'
	);
});

test('every exit clears the screen by exactly one cushion, from rest and mid-drag', () => {
	// The regression this pins is the one that shipped: a dismissal continuing a
	// live drag reused the DRAG keyframes and sprang to their 0% frame, which is
	// exactly flush — no inset, no cushion. So a card-mode swipe-close stopped
	// with --sheet-card-margin still showing, an edge-mode one left its whole
	// shadow, and a centred dialog stopped with a third of itself on screen.
	const away = (position, keyframes) => {
		const [x, y] = keyframes[0].transform
			.match(/translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/)
			.slice(1)
			.map(Number);
		return awayOffset(position, x, y);
	};

	// The runway is always `painted extent + gap from the edge + one cushion`. What
	// differs per profile is only which extent is painted, and that is exactly the
	// resize-versus-translate split: a side sheet is fixed width, so its exit pose
	// is absolute and a drag cannot change it, while a bottom sheet above its floor
	// has genuinely resized and correctly clears the smaller height it now paints.
	for (const mode of ['edge', 'card']) {
		const inset = mode === 'card' ? 12 : 0;

		for (const position of ['left', 'right']) {
			const profile = profileFor(position, { mode, edgeInset: inset });
			const expected = 400 + inset + EXIT_CUSHION;

			assert.equal(
				away(position, buildExitKeyframes(profile, 400, 400)),
				expected,
				`${position}/${mode} exit from rest`
			);
			assert.equal(
				away(position, buildExitKeyframes(profile, 200, 400)),
				expected,
				`${position}/${mode} exit continuing a drag is the same absolute pose`
			);
		}

		const bottom = profileFor('bottom', { mode, edgeInset: inset });
		assert.equal(
			away('bottom', buildExitKeyframes(bottom, 500, 500, 200)),
			500 + inset + EXIT_CUSHION,
			`bottom/${mode} exit from rest clears its resting height`
		);
		// Between snaps it has resized, so the runway follows the height it paints.
		assert.equal(
			away('bottom', buildExitKeyframes(bottom, 300, 500, 200)),
			300 + inset + EXIT_CUSHION,
			`bottom/${mode} exit between snaps clears the height it now paints`
		);
		// Below the floor the height is pinned there and the rest becomes
		// translation, so the runway stops shrinking however deep the drag went.
		for (const size of [150, 40, 0]) {
			assert.equal(
				away('bottom', buildExitKeyframes(bottom, size, 500, 200)),
				200 + inset + EXIT_CUSHION,
				`bottom/${mode} exit from ${size}px clears the pinned floor`
			);
		}
	}

	// Centre is the profile the old code missed by the widest margin: it rests
	// against no edge, so translating by its own height leaves (vh - h) / 2 of it
	// on screen. On this 800px viewport a 300px dialog kept 250px visible.
	const centre = profileFor('center');
	const gap = (800 - 300) / 2;
	assert.equal(
		away('center', buildExitKeyframes(centre, 300, 300)),
		300 + gap + EXIT_CUSHION,
		'a centred dialog clears the bottom edge it is nowhere near'
	);
	assert.equal(
		away('center', buildExitKeyframes(centre, 200, 300)),
		300 + gap + EXIT_CUSHION,
		'and still clears it when the drag is already underway'
	);
});

test('a non-translating exit stays in place from rest and follows the finger mid-drag', () => {
	// fade-scale scales down IN PLACE. The `away > 0` guard on the cushion floor
	// is what keeps that true: without it the exit from rest would pick up a
	// cushion of stray downward drift.
	const profile = profileFor('bottom', { effect: 'fade-scale' });
	assert.equal(
		translateYOf(buildExitKeyframes(profile, 500, 500)[0]),
		0,
		'fade-scale exit from rest does not travel'
	);

	// Continuing a drag it must not double back toward rest either — it carries
	// on past the release pose by one cushion while it shrinks and fades. This
	// is what a desktop swipe-down looks like under desktop-exit-effect.
	const dragged = buildExitKeyframes(profile, 100, 500, 200);
	assert.equal(
		translateYOf(dragged[0]),
		awayTranslation(profile, 100, 500, 200) + EXIT_CUSHION,
		'fade-scale exit continuing a drag carries on outward'
	);
	assert.equal(dragged[0].opacity, '0', 'fade-scale still fades out');
});

test('an exit from an overpulled negative size still points away from rest', () => {
	// #applyLiveOffset rubber-bands a pull past the closed edge to about -68px, and
	// a profile rebuild during that drag hands the engine that live size. The
	// cushion floor is what keeps the runway from pointing back toward rest.
	const profile = profileFor('right');
	const keyframes = buildExitKeyframes(profile, -68, 400);
	const x = Number.parseFloat(keyframes[0].transform.match(/translate3d\((-?[\d.]+)px/)[1]);
	assert.ok(x >= 400 + 68, `the runway clears the overpull, got ${x}`);
	assert.ok(x > awayTranslation(profile, -68, 400), 'and never points back toward rest');
});

test('no exit keyframe animates a size property except a bottom sheet height', () => {
	for (const position of ['left', 'right', 'center']) {
		for (const size of [400, 200, -40]) {
			assertNoSizeProperties(
				buildExitKeyframes(profileFor(position), size, 400),
				`${position} exit at size ${size}`
			);
		}
	}
	// A bottom sheet is the one that may, and it pins the PAINTED height — the
	// floor — for the whole run rather than animating it.
	const bottom = buildExitKeyframes(profileFor('bottom'), 100, 500, 200);
	assert.equal(bottom[0].height, '200px');
	assert.equal(bottom[100].height, '200px');
});

test('exit travel is the runway left, floored at the extent still on screen', () => {
	const profile = profileFor('right');

	// From rest the run covers the whole runway.
	assert.equal(exitTravel(profile, 400, 400), 400 + EXIT_CUSHION);

	// Continuing a drag it covers only what is left. Handing this the resting size
	// instead understated a flick by ~2.8x on a deep drag, which is why every
	// flick-to-close settled at the same speed however hard it was thrown.
	assert.equal(exitTravel(profile, 200, 400), 400 + EXIT_CUSHION - 200);
	assert.ok(
		exitTravel(profile, 200, 400) < 400,
		'a half-dragged panel travels less than its width'
	);

	// A non-translating exit crosses its own extent by vanishing. Normalising a
	// flick over the cushion alone would seed ~100 spring units on a 100-unit run.
	const fading = profileFor('right', { effect: 'fade-scale' });
	assert.equal(exitTravel(fading, 400, 400), 400, 'from rest, the panel’s own extent');
	assert.equal(exitTravel(fading, 200, 400), 200, 'mid-drag, the extent still showing');
	assert.ok(exitTravel(fading, 200, 400) > EXIT_CUSHION, 'never just the cushion');
});

test('paintedExtent and awayTranslation split resizing from translating', () => {
	// The two halves of restStyles' piecewise rule, read back out. A bottom sheet
	// resizes above its floor and translates below it; nothing else ever resizes.
	const bottom = profileFor('bottom');
	assert.equal(paintedExtent(bottom, 300, 500, 200), 300, 'above the floor, the live height');
	assert.equal(paintedExtent(bottom, 100, 500, 200), 200, 'below it, the floor holds');
	assert.equal(awayTranslation(bottom, 300, 500, 200), 0, 'above the floor, no translation');
	assert.equal(awayTranslation(bottom, 100, 500, 200), 100, 'below it, translation 1:1');

	for (const position of ['left', 'right', 'center']) {
		const profile = profileFor(position);
		assert.equal(paintedExtent(profile, 100, 400), 400, `${position} is intrinsically sized`);
		assert.equal(awayTranslation(profile, 100, 400), 300, `${position} translates the difference`);
	}
});

test('a card inset lengthens the slide runway by exactly its gap', () => {
	// A card floats --sheet-card-margin from the edge, so clearing the screen costs
	// that gap on top of the panel's own size.
	const inset = 12;

	const bottom = buildOpenKeyframes(
		profileFor('bottom', { mode: 'card', edgeInset: inset }),
		500,
		500
	);
	assert.equal(
		bottom[0].transform,
		`translate3d(0px, ${500 + inset + EXIT_CUSHION}px, 0px) scale(1)`
	);

	const right = buildOpenKeyframes(
		profileFor('right', { mode: 'card', edgeInset: inset }),
		400,
		400
	);
	assert.equal(
		right[0].transform,
		`translate3d(${400 + inset + EXIT_CUSHION}px, 0px, 0px) scale(1)`
	);

	// Exactly the gap and nothing else: the same panels flush against the edge
	// travel `inset` pixels less.
	const y = (keyframes) => Number.parseFloat(keyframes[0].transform.match(/,\s*(-?[\d.]+)px/)[1]);
	const x = (keyframes) => Number.parseFloat(keyframes[0].transform.match(/\((-?[\d.]+)px/)[1]);
	assert.equal(y(bottom) - y(buildOpenKeyframes(profileFor('bottom'), 500, 500)), inset);
	assert.equal(x(right) - x(buildOpenKeyframes(profileFor('right'), 400, 400)), inset);
});

test('a profile with no edgeInset field is treated as edge-mounted', () => {
	// The engine must not require the field — a profile assembled without it,
	// by a consumer or by an older component, sits flush.
	const bare = { position: 'left', mode: 'edge', effect: 'slide' };
	assert.ok(!('edgeInset' in bare), 'the field really is absent');

	const keyframes = buildOpenKeyframes(bare, 300, 300);
	assert.equal(
		keyframes[0].transform,
		`translate3d(${-(300 + EXIT_CUSHION)}px, 0px, 0px) scale(1)`
	);
	assert.deepEqual(
		keyframes,
		buildOpenKeyframes({ ...bare, edgeInset: 0 }, 300, 300),
		'an absent inset builds the same frames as a zero one'
	);
});

test('fading effects reach full opacity before the geometry settles', () => {
	const keyframes = buildOpenKeyframes(profileFor('bottom', { effect: 'fade-scale' }), 500, 500);
	const percents = Object.keys(keyframes).map(Number);
	assert.deepEqual(percents, [0, 80, 100], 'the default reveal lands at exactly 80% of travel');
	const reveal = percents[1];
	assert.equal(keyframes[reveal].opacity, '1');
	assert.equal(keyframes[0].opacity, '0');

	const opaque = buildOpenKeyframes(profileFor('bottom', { effect: 'slide' }), 500, 500);
	assert.deepEqual(Object.keys(opaque).map(Number), [0, 100], 'opaque effects add no extra frame');
});

test('the opacity reveal frame stays collinear with the geometry', () => {
	// FrameEngine back-fills composite properties onto keyframes that omit them,
	// using zeroed defaults. A partial reveal frame would therefore bend the
	// transform track and blow up under spring overshoot, so the frame must
	// carry the exact linear midpoint of the outer frames.
	const parse = (transform) => transform.match(/-?\d+(\.\d+)?/g).map(Number);
	for (const position of ['bottom', 'left', 'right']) {
		for (const effect of ['fade-scale', 'slide-fade']) {
			const keyframes = buildOpenKeyframes(profileFor(position, { effect }), 400, 400);
			const percents = Object.keys(keyframes)
				.map(Number)
				.sort((a, b) => a - b);
			assert.equal(percents.length, 3, `${position}/${effect} has a reveal frame`);

			const [from, mid, to] = percents.map((p) => parse(keyframes[p].transform));
			const factor = percents[1] / 100;
			for (let index = 0; index < from.length; index++) {
				assert.ok(
					Math.abs(mid[index] - (from[index] + (to[index] - from[index]) * factor)) < 1e-6,
					`${position}/${effect} transform component ${index} is collinear`
				);
			}
			assert.equal(keyframes[percents[1]].opacity, '1');
		}
	}
});

test('cards scale from the edge they rest against', () => {
	assert.equal(transformOrigin(profileFor('bottom', { mode: 'card' })), 'center bottom');
	assert.equal(transformOrigin(profileFor('left', { mode: 'card' })), 'left center');
	assert.equal(transformOrigin(profileFor('right', { mode: 'card' })), 'right center');
});

/**
 * Builds a shown engine with the given snaps, ready for drag sampling.
 * @param {import('node:test').TestContext} t - Test context.
 * @param {number[]} snaps - Snap sizes in pixels.
 * @param {number} activeIndex - Active snap index.
 * @returns {Promise<{engine: SheetEngine, frames: Function[], dialog: Object}>} Shown engine.
 */
async function shownEngine(t, snaps, activeIndex) {
	const frames = captureFrames(t);
	const engine = new SheetEngine();
	const dialog = makeDialog();
	engine.setProfile({
		position: 'bottom',
		mode: 'edge',
		effect: 'slide',
		viewportWidth: 400,
		viewportHeight: 800,
	});
	engine.setSnaps(snaps, activeIndex);
	const show = engine.show({ to: dialog });
	drainFrames(frames);
	await show;
	return { engine, frames, dialog };
}

test('bottom dismissal-zone drag holds the lowest height and translates with the finger', async (t) => {
	const { engine, dialog } = await shownEngine(t, [200, 500], 1);

	engine.dragBy(300);
	assert.equal(engine.currentSize, 200);
	assert.equal(dialog.style.height, '200px');
	assert.equal(translateY(dialog), 0);

	engine.dragBy(350);
	assert.equal(engine.currentSize, 150);
	assert.equal(dialog.style.height, '200px');
	assert.equal(translateY(dialog), 50);

	engine.dragBy(425);
	assert.equal(engine.currentSize, 75);
	assert.equal(dialog.style.height, '200px');
	assert.equal(translateY(dialog), 125, 'every further pixel becomes one pixel of translation');

	engine.dragBy(500);
	assert.equal(engine.currentSize, 0);
	assert.equal(dialog.style.height, '200px');
	assert.equal(translateY(dialog), 200, 'logical zero paints fully off-screen');
	engine.destroy();
});

test('bottom drag between snaps still resizes with zero translation', async (t) => {
	const { engine, dialog } = await shownEngine(t, [200, 500], 1);

	engine.dragBy(100);
	assert.equal(engine.currentSize, 400);
	assert.equal(dialog.style.height, '400px');
	assert.equal(translateY(dialog), 0);

	engine.dragBy(250);
	assert.equal(engine.currentSize, 250);
	assert.equal(dialog.style.height, '250px');
	assert.equal(translateY(dialog), 0);
	engine.destroy();
});

test('single-snap upward overscroll stretches height instead of lifting the sheet', async (t) => {
	const { engine, dialog } = await shownEngine(t, [400], 0);

	// Above rest the sheet must grow taller, never detach from the bottom edge.
	// The regression this pins: with the active snap as the floor, the 0→100
	// track is pure translation, and extrapolating it lifted the panel 40px up.
	engine.dragBy(-40);
	assert.equal(engine.currentSize, 440);
	assert.equal(dialog.style.height, '440px');
	assert.equal(translateY(dialog), 0);

	// Below rest the same frames still translate 1:1.
	engine.dragBy(150);
	assert.equal(dialog.style.height, '400px');
	assert.equal(translateY(dialog), 150);
	engine.destroy();
});

test('an interrupted bottom dismissal-zone drag exits from its painted state', async (t) => {
	const { engine, frames, dialog } = await shownEngine(t, [200, 500], 1);
	engine.dragBy(400);
	assert.equal(engine.currentSize, 100);
	assert.equal(dialog.style.height, '200px');
	assert.equal(translateY(dialog), 100);
	assert.equal(engine.backdropProgress, 0.5);

	const path = [];
	engine.on('change', () => {
		path.push({
			height: Number.parseFloat(dialog.style.height),
			y: translateY(dialog),
			backdrop: engine.backdropProgress,
		});
	});
	const hidden = engine.dismiss(0.5);
	assert.equal(dialog.style.height, '200px', 'the exit keeps the painted height');
	assert.equal(translateY(dialog), 100, 'the exit starts at the drag translation');
	assert.equal(engine.backdropProgress, 0.5, 'the backdrop keeps the logical release position');

	drainFrames(frames);
	await hidden;
	assert.equal(engine.state, 'hidden');
	assert.ok(
		path.every(({ height }) => height === 200),
		'height stays at the lowest snap'
	);
	for (let index = 1; index < path.length; index++) {
		assert.ok(path[index].y >= path[index - 1].y - 0.5, 'the exit never doubles back');
	}
	const clearedAt = path.findIndex(({ y }) => y >= 200);
	assert.notEqual(clearedAt, -1, 'the panel crosses the viewport edge');
	assert.ok(
		path.slice(clearedAt).every(({ backdrop }) => backdrop === 0),
		'the backdrop is gone once the panel box clears, not after its shadow cushion'
	);
	assert.ok(
		path.at(-1).y >= 200 + EXIT_CUSHION - 0.5,
		`the lowest-height panel clears the edge by the cushion, ended at ${path.at(-1).y}`
	);
	engine.destroy();
});

test('settling from below the lowest snap starts translated and lands cleanly', async (t) => {
	const { engine, frames, dialog } = await shownEngine(t, [200, 500], 1);
	engine.dragBy(400);
	assert.equal(dialog.style.height, '200px');
	assert.equal(translateY(dialog), 100);

	const path = [];
	engine.on('change', () => {
		path.push({ height: Number.parseFloat(dialog.style.height), y: translateY(dialog) });
	});
	const settle = engine.settleTo(0, 0);
	assert.equal(dialog.style.height, '200px', 'frame zero keeps the painted height');
	assert.equal(translateY(dialog), 100, 'frame zero keeps the release translation');

	drainFrames(frames);
	await settle;
	assert.equal(engine.currentSize, 200);
	assert.equal(engine.activeSnap, 0);
	assert.equal(dialog.style.height, '200px');
	assert.equal(translateY(dialog), 0);
	// Squishing means dropping BELOW the floor. The settling breath stretches
	// slightly past it instead, and must never turn back into a lift off the
	// bottom edge — which is what extrapolating the pure-translation track did.
	assert.ok(
		path.every(({ height }) => height >= 200),
		'the return never squishes the panel'
	);
	assert.ok(
		path.every(({ y }) => y >= 0),
		'and never lifts it off the bottom edge'
	);
	engine.destroy();
});

test('a side sheet never paints past flush', async (t) => {
	// A side sheet is fixed width and sits against its edge, so there is no
	// such thing as "further in than flush" — every position past p=1 opens a
	// sliver of backdrop down the side. Both an inward rubber-band and the
	// spring's settling breath used to do exactly that.
	for (const position of ['left', 'right']) {
		const frames = captureFrames(t);
		const engine = new SheetEngine();
		const dialog = makeDialog();
		engine.setProfile({
			position,
			mode: 'edge',
			effect: 'slide',
			viewportWidth: 1000,
			viewportHeight: 800,
		});
		engine.setSnaps([400], 0);
		const show = engine.show({ to: dialog });
		drainFrames(frames);
		await show;

		const inward = position === 'left' ? 1 : -1;
		const gap = () => {
			const x = Number.parseFloat(dialog.style.transform.match(/translate3d\((-?[\d.]+)px/)[1]);
			return x * inward; // positive means pulled away from the edge
		};

		engine.dragBy(-120); // pulled inward, past flush
		assert.ok(gap() <= 0.001, `${position} drag overscroll stays flush (${gap()})`);

		const gaps = [];
		engine.on('change', () => gaps.push(gap()));
		const settle = engine.returnToRest(-4);
		drainFrames(frames);
		await settle;
		assert.ok(
			gaps.every((value) => value <= 0.001),
			`${position} return never opens a gap (worst ${Math.max(...gaps)})`
		);
		engine.destroy();
	}
});

test('a bottom sheet still breathes past its snap', async (t) => {
	// Guards the side clamp above from being applied everywhere: a bottom
	// sheet's overshoot is a harmless height stretch and must survive.
	const { engine, frames, dialog } = await shownEngine(t, [240, 480, 720], 2);
	engine.dragBy(120);
	const heights = [];
	engine.on('change', () => heights.push(Number.parseFloat(dialog.style.height)));
	const settle = engine.settleTo(1, -1.5);
	drainFrames(frames);
	await settle;
	assert.ok(Math.min(...heights) < 480, 'the bottom snap still overshoots');
	engine.destroy();
});

test('paintedProgress states the paint rule once for both writers', () => {
	// The engine paints by this and the component publishes by it, so the two can
	// never disagree about what a position was allowed to be.
	assert.equal(paintedProgress('bottom', 1.024), 1.024, "a snap's breath flows through");
	assert.equal(paintedProgress('bottom', 1.5), 1.5, 'and so does a larger one');
	assert.equal(paintedProgress('left', 1.024), 1, 'a left sheet is refused any paint past flush');
	assert.equal(paintedProgress('right', 1.024), 1, 'and so is a right sheet');
	assert.equal(paintedProgress('right', 1), 1, 'flush itself is untouched');
	assert.equal(paintedProgress('bottom', 1), 1);
	for (const position of ['bottom', 'left', 'right']) {
		assert.equal(paintedProgress(position, -0.4), 0, `${position} floors below the hidden frame`);
		assert.equal(paintedProgress(position, 0), 0, `${position} keeps the hidden frame`);
		assert.equal(paintedProgress(position, 0.5), 0.5, `${position} passes mid-travel through`);
	}
	assert.equal(paintedProgress('center', -0.4, 'showing'), 0, 'a flight still protects scale');
	assert.equal(paintedProgress('center', -0.4, 'hiding'), 0, 'both flight directions floor');
	for (const phase of ['dragging', 'snapping', 'returning', 'shown']) {
		assert.equal(
			paintedProgress('center', -0.4, phase),
			-0.4,
			`${phase} keeps the linear landed track live below zero`
		);
	}
});

test('the engine paints exactly what paintedProgress allows', async (t) => {
	// A real overshooting settle, checked against the helper frame by frame: the
	// bottom sheet's raw breath is both permitted and visible in the paint.
	const { engine, frames, dialog } = await shownEngine(t, [240, 480, 720], 2);
	engine.dragBy(120);
	const seen = [];
	engine.on('change', ({ progress }) =>
		seen.push({ progress, height: Number.parseFloat(dialog.style.height) })
	);
	const settle = engine.settleTo(1, -1.5);
	drainFrames(frames);
	await settle;

	const overshot = seen.filter(({ progress }) => progress > 1);
	assert.ok(overshot.length, 'the snap spring really did overshoot');
	for (const { progress } of overshot) {
		assert.equal(paintedProgress('bottom', progress), progress, 'and none of it is withheld');
	}
	assert.ok(
		Math.min(...overshot.map(({ height }) => height)) < 480,
		'the permitted breath reaches the panel'
	);
	engine.destroy();
});

test('a side sheet is denied the paint the helper denies it', async (t) => {
	// The mirror case, against a live spring: every raw position past flush that
	// the engine reports is one the helper caps, and the panel stays at the edge.
	const frames = captureFrames(t);
	const engine = new SheetEngine();
	const dialog = makeDialog();
	engine.setProfile(profileFor('right'));
	engine.setSnaps([400], 0);
	const show = engine.show({ to: dialog });
	drainFrames(frames);
	await show;

	const seen = [];
	engine.on('change', ({ progress }) => {
		const x = Number.parseFloat(dialog.style.transform.match(/translate3d\((-?[\d.]+)px/)[1]);
		seen.push({ progress, x });
	});
	engine.dragBy(-120); // pulled inward, past flush
	const settle = engine.returnToRest(-4);
	drainFrames(frames);
	await settle;

	const past = seen.filter(({ progress }) => progress > 1);
	assert.ok(past.length, 'the spring really did report positions past flush');
	for (const { progress, x } of past) {
		assert.equal(paintedProgress('right', progress), 1, 'the helper caps them');
		assert.ok(x >= -0.001, `and the panel never leaves its edge (${x})`);
	}
	engine.destroy();
});

test('a side return paints a distinct pose on every spring frame after a hard flick', async (t) => {
	const frames = captureFrames(t);
	const engine = new SheetEngine();
	const dialog = makeDialog();
	engine.setProfile(profileFor('right'));
	engine.setSnaps([400], 0);
	const show = engine.show({ to: dialog });
	drainFrames(frames);
	await show;

	engine.dragBy(20);
	const poses = [];
	const progress = [];
	engine.on('change', ({ phase, progress: value }) => {
		if (phase === 'returning') {
			poses.push(dialog.style.transform);
			progress.push(value);
		}
	});
	const returning = engine.returnToRest(3);
	const frameCount = drainFrames(frames);
	await returning;

	assert.deepEqual(
		{
			frameCount,
			paintedFrames: poses.length,
			distinctPoses: new Set(poses).size,
			maxProgress: Number(Math.max(...progress).toFixed(6)),
			first: poses[0],
			last: poses.at(-1),
		},
		{
			frameCount: 11,
			paintedFrames: 9,
			distinctPoses: 9,
			maxProgress: 0.998623,
			first: 'translate3d(14.7716px, 0px, 0px) scale(1)',
			last: 'translate3d(0.5507px, 0px, 0px) scale(1)',
		}
	);
	engine.destroy();
});

test('a side return spends a harder flick rather than swallowing it', async (t) => {
	// The companion to the test above, and the half it cannot see. Capping the
	// seed is what stops the paint clamp from eating frames, but cap it too hard
	// and the run stops answering the gesture at all: at the bare attraction
	// impulse every release from v=1 upward settled in an identical 200ms, which
	// is the "every settle looks the same however hard it was thrown" failure the
	// snap preset's tuning notes already warn about, reintroduced one function
	// over. Distinctness alone is satisfied by a run that ignores velocity
	// entirely, so the spread has to be asserted separately.
	const measure = async (velocityPxMs) => {
		const frames = captureFrames(t);
		const engine = new SheetEngine();
		engine.setProfile(profileFor('right'));
		engine.setSnaps([400], 0);
		const show = engine.show({ to: makeDialog() });
		drainFrames(frames);
		await show;

		engine.dragBy(120);
		let painted = 0;
		engine.on('change', ({ phase }) => {
			if (phase === 'returning') painted++;
		});
		const returning = engine.returnToRest(velocityPxMs);
		drainFrames(frames);
		await returning;
		engine.destroy();
		return painted;
	};

	const [still, gentle, hard] = [await measure(0), await measure(1), await measure(3)];
	assert.deepEqual(
		{ still, gentle, hard },
		{ still: 18, gentle: 16, hard: 14 },
		'a 120px pull spends its release velocity across a measurable range of run lengths'
	);
	// Stated as an ordering too, so a retune that keeps three distinct numbers but
	// inverts them — a harder flick taking LONGER because its overshoot is being
	// clamped away — fails here rather than reading as a pass.
	assert.ok(still > gentle && gentle > hard, 'and a harder flick is always the shorter run');
});

test('a harder flick reaches its snap sooner', async (t) => {
	const framesToTarget = async (velocityPxMs) => {
		const { engine, frames, dialog } = await shownEngine(t, [240, 480, 720], 2);
		engine.dragBy(120); // released at 600px, settling down to 480
		let count = 0;
		let arrived = null;
		engine.on('change', () => {
			count += 1;
			if (arrived === null && Number.parseFloat(dialog.style.height) <= 480) arrived = count;
		});
		const settle = engine.settleTo(1, velocityPxMs);
		drainFrames(frames);
		await settle;
		engine.destroy();
		return arrived;
	};

	// Total settle frames are NOT monotonic in flick strength — a hard flick
	// spends the difference decaying its overshoot. Time to the destination is.
	// Scaling velocity against the resting size made all three identical, and
	// made the hardest flick the slowest of them.
	const slow = await framesToTarget(0);
	const flick = await framesToTarget(-1);
	const hard = await framesToTarget(-2.5);
	assert.ok(flick < slow, `a flick lands sooner than a slow release (${flick} vs ${slow})`);
	assert.ok(hard < flick, `and a harder flick sooner still (${hard} vs ${flick})`);
});

test('a downward flick moves toward its snap from the very first frame', async (t) => {
	const { engine, frames, dialog } = await shownEngine(t, [240, 480, 720], 2);
	engine.dragBy(120);
	assert.equal(dialog.style.height, '600px');

	const heights = [];
	engine.on('change', () => heights.push(Number.parseFloat(dialog.style.height)));
	const settle = engine.settleTo(1, -1.5);
	drainFrames(frames);
	await settle;

	assert.ok(heights[0] < 600, `the first frame already closes on the snap (${heights[0]})`);
	assert.ok(Math.min(...heights) < 480, 'the flick carries the panel past its destination');
	assert.ok(Math.min(...heights) > 440, 'but only by a breath');
	assert.equal(dialog.style.height, '480px');
	assert.equal(engine.activeSnap, 1);
	engine.destroy();
});

test('dismissal-zone mapping saturates at and above rest', () => {
	// Snapped sheet: rest is the lowest snap (240).
	assert.equal(dismissalZoneProgress(720, 240), 1, 'top snap');
	assert.equal(dismissalZoneProgress(480, 240), 1, 'middle snap');
	assert.equal(dismissalZoneProgress(240, 240), 1, 'lowest snap');
	assert.equal(dismissalZoneProgress(900, 240), 1, 'flung above the top snap saturates');
	assert.equal(dismissalZoneProgress(120, 240), 0.5, 'halfway into the dismissal zone');
	assert.equal(dismissalZoneProgress(0, 240), 0, 'fully dismissed');

	// Snapless sheet: rest is its only size, so the whole travel is the zone.
	assert.equal(dismissalZoneProgress(480, 480), 1);
	assert.equal(dismissalZoneProgress(600, 480), 1, 'upward overscroll saturates');
	assert.equal(dismissalZoneProgress(240, 480), 0.5);
	assert.equal(dismissalZoneProgress(0, 480), 0);

	// Degenerate geometry never yields NaN opacity.
	assert.equal(dismissalZoneProgress(100, 0), 0);
	assert.equal(dismissalZoneProgress(100, Number.NaN), 0);
});

test('a slide exit preserves the backdrop saturation band before edge clearing', async (t) => {
	const frames = captureFrames(t);
	const engine = new SheetEngine();
	const profile = profileFor('bottom', { exitCushion: 72 });
	engine.setProfile(profile);
	engine.setSnaps([160, 440, 720], 2);
	const opened = engine.show({ to: makeDialog() });
	drainFrames(frames);
	await opened;

	const clear = exitClearProgress(profile, 720, 720, 160, 'slide');
	assert.equal(clear, 1 / 11);
	const samples = [];
	engine.on('change', ({ progress, phase }) => {
		if (phase === 'hiding') {
			const flight = Math.max(0, Math.min(1, progress));
			const visibleFlight = Math.max(0, Math.min(1, (flight - clear) / (1 - clear)));
			samples.push({
				backdrop: engine.backdropProgress,
				progress,
				visibleExtent: 720 * visibleFlight,
			});
		}
	});
	const hidden = engine.dismiss();
	assert.equal(engine.backdropProgress, 1);
	drainFrames(frames);
	await hidden;

	for (const sample of samples) {
		assert.equal(
			sample.backdrop,
			dismissalZoneProgress(sample.visibleExtent, 160),
			`p=${sample.progress} follows the dismissal-zone mapping`
		);
	}
	const saturated = samples.filter(
		({ progress, visibleExtent }) => progress < 1 && visibleExtent >= 160
	);
	assert.ok(saturated.length > 0, 'the spring samples the saturation band');
	assert.ok(
		saturated.every(({ backdrop }) => backdrop === 1),
		'every sampled extent at or above the lowest snap is exactly opaque'
	);
	assert.ok(
		samples.filter(({ visibleExtent }) => visibleExtent < 160).some(({ backdrop }) => backdrop < 1),
		'the backdrop falls only after crossing the lowest snap'
	);
	assert.ok(
		samples.filter(({ progress }) => progress <= clear).every(({ backdrop }) => backdrop === 0),
		'the backdrop is exactly clear by the edge crossing'
	);
	assert.equal(engine.backdropProgress, 0);
	engine.destroy();

	const { engine: dragged, frames: draggedFrames } = await shownEngine(t, [160, 440, 720], 2);
	dragged.dragBy(640);
	assert.equal(dragged.currentSize, 80);
	assert.equal(dragged.backdropProgress, 0.5);
	const draggedHidden = dragged.dismiss();
	assert.equal(dragged.backdropProgress, 0.5, 'p=1 preserves the release opacity exactly');
	drainFrames(draggedFrames);
	await draggedHidden;
	dragged.destroy();
});

test('a snapped sheet holds the backdrop through every snap-to-snap drag', async (t) => {
	const { engine } = await shownEngine(t, [240, 480, 720], 2);

	const held = [];
	for (let size = 720; size >= 240; size -= 20) {
		engine.dragBy(720 - size);
		held.push(engine.backdropProgress);
	}
	assert.ok(
		held.every((value) => value === 1),
		`backdrop untouched across snap travel (saw ${[...new Set(held)].join(', ')})`
	);

	const falling = [];
	for (let size = 240; size >= 0; size -= 20) {
		engine.dragBy(720 - size);
		falling.push(engine.backdropProgress);
	}
	assert.equal(falling[0], 1, 'still full at the lowest snap');
	assert.equal(falling.at(-1), 0, 'zero once fully dismissed');
	assert.ok(
		falling.every((value, index) => index === 0 || value <= falling[index - 1]),
		'and never rises on the way down'
	);
	engine.destroy();
});

test('a snap-to-snap spring settle never disturbs the backdrop', async (t) => {
	const { engine, frames } = await shownEngine(t, [240, 480, 720], 2);
	const seen = [];
	engine.on('change', () => seen.push(engine.backdropProgress));
	const settle = engine.settleTo(0, 0);
	drainFrames(frames);
	await settle;

	assert.ok(seen.length > 3, 'the settle actually animated');
	assert.ok(
		seen.every((value) => value === 1),
		`settling between snaps holds at 1 (min ${Math.min(...seen)})`
	);
	assert.equal(engine.activeSnap, 0);
	engine.destroy();
});

test('upward overscroll never lightens the backdrop', async (t) => {
	// Snapless, like an inset card: a single snap is both rest and lowest.
	const { engine, frames } = await shownEngine(t, [480], 0);

	const pulled = [];
	for (let extra = 0; extra <= 120; extra += 10) {
		engine.dragBy(-extra);
		pulled.push(engine.backdropProgress);
	}
	assert.ok(
		pulled.every((value) => value === 1),
		`overscroll saturates at 1 (saw ${[...new Set(pulled)].join(', ')})`
	);

	const settling = [];
	engine.on('change', () => settling.push(engine.backdropProgress));
	const settle = engine.settleTo(0, 0);
	drainFrames(frames);
	await settle;
	assert.ok(settling.length > 3, 'the settle actually animated');
	assert.ok(
		settling.every((value) => value === 1),
		`settle back from overscroll holds at 1 (min ${Math.min(...settling)})`
	);
	engine.destroy();
});

test('a snapless sheet fades its backdrop across the whole downward travel', async (t) => {
	const { engine } = await shownEngine(t, [480], 0);
	const seen = [];
	for (let size = 480; size >= 0; size -= 60) {
		engine.dragBy(480 - size);
		seen.push(+engine.backdropProgress.toFixed(3));
	}
	assert.deepEqual(seen, [1, 0.875, 0.75, 0.625, 0.5, 0.375, 0.25, 0.125, 0]);
	engine.destroy();
});

test('a snapped sheet is fully opaque by the time it reaches its lowest snap', async (t) => {
	// Opening to a mid snap must never rest under a half-faded overlay.
	const frames = captureFrames(t);
	const engine = new SheetEngine();
	engine.setProfile({
		position: 'bottom',
		mode: 'edge',
		effect: 'slide',
		viewportWidth: 400,
		viewportHeight: 800,
	});
	engine.setSnaps([240, 480, 720], 1);
	const seen = [];
	engine.on('change', ({ progress }) => seen.push({ progress, backdrop: engine.backdropProgress }));
	const show = engine.show({ to: makeDialog() });
	drainFrames(frames);
	await show;

	assert.equal(seen[0].backdrop < 1, true, 'the overlay ramps in rather than popping');
	// Visible extent is 480p; it crosses the lowest snap (240) at p = 0.5.
	const crossing = seen.find((sample) => sample.progress >= 0.5);
	assert.equal(crossing.backdrop, 1, 'full opacity once the lowest snap is reached');
	assert.ok(
		seen.filter((s) => s.progress >= 0.5).every((s) => s.backdrop === 1),
		'and stays there for the rest of the entrance'
	);
	assert.equal(engine.backdropProgress, 1, 'at rest on a mid snap');
	engine.destroy();
});

test('an oscillating entrance never walks the backdrop backwards', async (t) => {
	// dismissalZoneProgress saturates the top, so overshoot past rest cannot
	// lighten the overlay -- but a spring loose enough to oscillate comes back
	// DOWN through rest on every return swing, and that dip is below the
	// saturation band where the clamp has nothing to say. The panel is meant to
	// bounce; the scrim is a fade, not a tracker.
	const frames = captureFrames(t);
	const engine = new SheetEngine();
	engine.setProfile(profileFor('bottom', { effect: 'fade-scale', viewportWidth: 420 }));
	engine.setSnaps([414], 0);
	engine.setSpring({ attraction: 0.2, friction: 0.15 });

	const seen = [];
	engine.on('change', ({ progress, backdropProgress }) =>
		seen.push({ progress, backdrop: backdropProgress })
	);
	const show = engine.show({ to: makeDialog() });
	drainFrames(frames);
	await show;

	assert.ok(
		Math.max(...seen.map((s) => s.progress)) > 1.05,
		'the override really does oscillate, or this asserts nothing'
	);
	assert.ok(
		seen.some((s, i) => i > 0 && s.progress < seen[i - 1].progress),
		'and the panel really does swing back through rest'
	);
	const backdrop = seen.map((s) => s.backdrop);
	const dip = backdrop.findIndex((value, i) => i > 0 && value < backdrop[i - 1]);
	assert.equal(
		dip,
		-1,
		dip === -1
			? ''
			: `the overlay dipped at frame ${dip}: ${backdrop[dip - 1].toFixed(3)} -> ${backdrop[dip].toFixed(3)}`
	);
	assert.equal(engine.backdropProgress, 1, 'and it lands saturated');
	engine.destroy();
});

test('an oscillating reversal never walks the exit backdrop forwards', async (t) => {
	// The same envelope, mirrored: a dismissal reversing out of a bouncy
	// entrance must keep fading rather than pulsing back up on the swing.
	const frames = captureFrames(t);
	const engine = new SheetEngine();
	engine.setProfile(profileFor('bottom', { effect: 'fade-scale', viewportWidth: 420 }));
	engine.setSnaps([414], 0);
	engine.setSpring({ attraction: 0.2, friction: 0.15 });

	const show = engine.show({ to: makeDialog() });
	for (let index = 0; index < 4; index++) frames.shift()(index * 16.66);

	const backdrop = [];
	engine.on('change', ({ backdropProgress }) => backdrop.push(backdropProgress));
	const hide = engine.hide();
	drainFrames(frames);
	await Promise.all([show, hide]);

	assert.ok(backdrop.length > 3, 'the exit actually animated');
	const rise = backdrop.findIndex((value, i) => i > 0 && value > backdrop[i - 1]);
	assert.equal(
		rise,
		-1,
		rise === -1
			? ''
			: `the overlay rose at frame ${rise}: ${backdrop[rise - 1].toFixed(3)} -> ${backdrop[rise].toFixed(3)}`
	);
	engine.destroy();
});

test('a side dismissal continues its drag pose without a backdrop jump', async (t) => {
	// The exit keeps the drag keyframes and starts the spring where the finger
	// left the panel, so #currentSize is frozen at the drag value for the whole
	// flight. Unless the run is told the flight covers the resting width, the
	// overlay computes currentSize * p / rest — p squared — and pops darker on
	// the first frame while the panel has not moved at all.
	for (const position of ['left', 'right']) {
		const frames = captureFrames(t);
		const engine = new SheetEngine();
		const dialog = makeDialog();
		engine.setProfile({
			position,
			mode: 'edge',
			effect: 'slide',
			viewportWidth: 1000,
			viewportHeight: 800,
		});
		engine.setSnaps([400], 0);
		const show = engine.show({ to: dialog });
		drainFrames(frames);
		await show;

		engine.dragBy(200); // half off the edge
		const released = engine.backdropProgress;
		assert.equal(released, 0.5, `${position} drag pose is half faded`);

		const flight = [];
		engine.on('change', () => flight.push(engine.backdropProgress));
		const hidden = engine.dismiss(0.5);
		assert.equal(
			engine.backdropProgress,
			released,
			`${position} exit starts where the drag left the overlay`
		);

		drainFrames(frames);
		await hidden;
		assert.equal(engine.state, 'hidden');
		assert.ok(flight.length > 3, `${position} exit actually animated`);
		assert.ok(
			flight.every((value, index) => index === 0 || value <= flight[index - 1] + 1e-9),
			`${position} overlay never brightens on the way out`
		);
		assert.ok(flight[0] <= released + 1e-9, `${position} first flight frame does not jump darker`);
		assert.equal(engine.backdropProgress, 0, `${position} overlay is clear once hidden`);
		engine.destroy();
	}
});

test('dismiss token parsing opens every route by default and none on request', () => {
	const all = { swipe: true, backdrop: true, escape: true };
	const none = { swipe: false, backdrop: false, escape: false };

	// Absent is what a sheet has always been: every implicit route open.
	assert.deepEqual(parseDismiss(null), all);
	assert.deepEqual(parseDismiss(undefined), all);
	assert.deepEqual(parseDismiss('all'), all);
	assert.deepEqual(parseDismiss('swipe backdrop escape'), all);

	// The confirm-action case.
	assert.deepEqual(parseDismiss('none'), none);
	assert.deepEqual(parseDismiss(''), none, 'an empty attribute locks it');
	assert.deepEqual(parseDismiss('   '), none);

	// Naming a subset opens exactly that subset — a drawer a stray swipe cannot
	// close, but a click outside still can.
	assert.deepEqual(parseDismiss('backdrop escape'), { swipe: false, backdrop: true, escape: true });
	assert.deepEqual(parseDismiss('swipe'), { swipe: true, backdrop: false, escape: false });
	assert.deepEqual(parseDismiss('escape,backdrop'), {
		swipe: false,
		backdrop: true,
		escape: true,
	});
	assert.deepEqual(parseDismiss('  SWIPE   Escape '), {
		swipe: true,
		backdrop: false,
		escape: true,
	});

	// A typo degrades to a stricter sheet, never a broken one — and `none` wins
	// over anything alongside it.
	assert.deepEqual(parseDismiss('swype'), none, 'an unknown token opens nothing');
	assert.deepEqual(parseDismiss('none swipe'), none, 'none is not overridden by a route');
	// Contradictory input fails safe rather than picking a winner: a sheet that
	// refuses a gesture it should have taken is recoverable, one that closes a
	// confirm it should have held is not.
	assert.deepEqual(parseDismiss('all none'), none, 'none wins a contradiction');
});

test('spring attribute parsing accepts two valid floats and rejects the rest', () => {
	assert.deepEqual(parseSpring('0.2 0.5'), { attraction: 0.2, friction: 0.5 });
	assert.deepEqual(parseSpring('  0.055   0.32  '), { attraction: 0.055, friction: 0.32 });
	assert.deepEqual(parseSpring('0.2,0.5'), { attraction: 0.2, friction: 0.5 }, 'commas allowed');
	assert.deepEqual(parseSpring('.2 .5'), { attraction: 0.2, friction: 0.5 });

	// Both dials are exclusive of 0 and 1; anything else falls back to presets.
	assert.equal(parseSpring('0 0.5'), null, 'zero attraction');
	assert.equal(parseSpring('1 0.5'), null, 'attraction of one');
	assert.equal(parseSpring('0.2 0'), null, 'zero friction');
	assert.equal(parseSpring('0.2 1'), null, 'friction of one');
	assert.equal(parseSpring('-0.2 0.5'), null, 'negative');
	assert.equal(parseSpring('0.2'), null, 'one value');
	assert.equal(parseSpring('0.2 0.5 0.7'), null, 'three values');
	assert.equal(parseSpring('fast loose'), null, 'not numbers');
	assert.equal(parseSpring(''), null);
	assert.equal(parseSpring(null), null);
	assert.equal(parseSpring(undefined), null);
});

test('spring override governs arrival and never degrades the exit', async (t) => {
	// Scaling exits proportionally saturated the dial ceiling and produced a
	// 2933ms exit for spring="0.3 0.55". Exits are pinned to their preset.
	const hideFrames = async (override) => {
		const frames = captureFrames(t);
		const engine = new SheetEngine();
		engine.setProfile({
			position: 'bottom',
			mode: 'edge',
			effect: 'slide',
			viewportWidth: 400,
			viewportHeight: 800,
		});
		engine.setSnaps([480], 0);
		if (override) engine.setSpring(override);
		const show = engine.show({ to: makeDialog() });
		drainFrames(frames);
		await show;
		let count = 0;
		engine.on('change', () => count++);
		const hide = engine.hide();
		drainFrames(frames);
		await hide;
		engine.destroy();
		return count;
	};

	const preset = await hideFrames(null);
	for (const override of [
		{ attraction: 0.3, friction: 0.55 },
		{ attraction: 0.02, friction: 0.22 },
		{ attraction: 0.9, friction: 0.9 },
	]) {
		const withOverride = await hideFrames(override);
		assert.equal(
			withOverride,
			preset,
			`exit is unaffected by spring ${override.attraction}/${override.friction}`
		);
	}
});

test('spring override applies to the entrance', () => {
	const engine = new SheetEngine();
	assert.equal(engine.spring, null, 'presets are in force by default');

	engine.setSpring({ attraction: 0.1, friction: 0.4 });
	assert.deepEqual(engine.spring, { attraction: 0.1, friction: 0.4 });

	// Invalid values are ignored rather than throwing or disabling motion.
	engine.setSpring({ attraction: 0, friction: 0.4 });
	assert.deepEqual(engine.spring, { attraction: 0.1, friction: 0.4 }, 'zero rejected');
	engine.setSpring({ attraction: 1, friction: 0.4 });
	assert.deepEqual(engine.spring, { attraction: 0.1, friction: 0.4 }, 'one rejected');
	engine.setSpring({ attraction: Number.NaN, friction: 0.4 });
	assert.deepEqual(engine.spring, { attraction: 0.1, friction: 0.4 }, 'NaN rejected');

	engine.setSpring(null);
	assert.equal(engine.spring, null, 'null restores the presets');
	engine.destroy();
});

test('an override actually changes measured settle time', async (t) => {
	const settleFrames = async (override) => {
		const frames = captureFrames(t);
		const engine = new SheetEngine();
		engine.setProfile({
			position: 'bottom',
			mode: 'edge',
			effect: 'slide',
			viewportWidth: 400,
			viewportHeight: 800,
		});
		engine.setSnaps([480], 0);
		if (override) engine.setSpring(override);
		let count = 0;
		engine.on('change', () => count++);
		const show = engine.show({ to: makeDialog() });
		drainFrames(frames);
		await show;
		engine.destroy();
		return count;
	};

	const preset = await settleFrames(null);
	const slower = await settleFrames({ attraction: 0.02, friction: 0.25 });
	const faster = await settleFrames({ attraction: 0.3, friction: 0.55 });

	assert.ok(slower > preset, `a weaker spring settles slower (${slower} vs ${preset} frames)`);
	assert.ok(faster < preset, `a stronger spring settles faster (${faster} vs ${preset} frames)`);
});

test('dismiss axis follows the sheet edge', () => {
	assert.equal(dismissAxis('bottom'), 'y');
	assert.equal(dismissAxis('left'), 'x');
	assert.equal(dismissAxis('right'), 'x');
});

test('touch drags dismiss in the direction the finger travels', () => {
	// Touch deltas are already finger motion, so they map straight through.
	assert.ok(awayOffset('bottom', 0, 60) > 0, 'finger down dismisses a bottom sheet');
	assert.ok(awayOffset('bottom', 0, -60) < 0, 'finger up does not');
	assert.ok(awayOffset('left', -60, 0) > 0, 'finger left dismisses a left sheet');
	assert.ok(awayOffset('left', 60, 0) < 0, 'finger right does not');
	assert.ok(awayOffset('right', 60, 0) > 0, 'finger right dismisses a right sheet');
	assert.ok(awayOffset('right', -60, 0) < 0, 'finger left does not');
	// Off-axis motion never contributes.
	assert.equal(Math.abs(awayOffset('bottom', 999, 0)), 0);
	assert.equal(Math.abs(awayOffset('left', 0, 999)), 0);
	assert.equal(Math.abs(awayOffset('right', 0, 999)), 0);
});

test('every preset is damped enough that nothing wobbles', () => {
	// No phase oscillates. `snap` is the one that breathes past its target, and
	// it does so once, by a few percent — the room a flick needs to read as a
	// throw.
	for (const name of ['entrance', 'exit', 'snap', 'rest']) {
		const preset = SPRING_PRESETS[name];
		assert.ok(preset.attraction > 0 && preset.attraction < 1);
		assert.ok(preset.friction > 0 && preset.friction < 1);
		assert.ok(simulateSpring(preset).maxProgress <= 1.03);
	}
});

/**
 * Mirrors the physics-engine integrator and the engine's early-settle detector
 * so spring tuning can be asserted without a browser. Verified against measured
 * browser runs: these numbers match real settle times to within a frame.
 *
 * `t90` is the time to 90% of travel. Springs front-load their motion, so that
 * is what governs perceived speed — tuning on settle time alone once produced a
 * 350ms entrance that reached 90% in 100ms and read as a snap, not a movement.
 * @param {{attraction: number, friction: number}} preset - Spring preset.
 * @returns {{frames: number, ms: number, t90: number|null, maxProgress: number, early: boolean}} Run summary.
 */
function simulateSpring({ attraction, friction }) {
	// Mirrors the engine: travel and both settle epsilons must match sheet-engine.js
	const travel = 100;
	let position = 0;
	let velocity = 0;
	let last = 0;
	let settleCount = 0;
	let maxProgress = 0;
	let t90 = null;

	for (let frame = 1; frame <= 900; frame++) {
		velocity += (travel - position) * attraction;
		velocity *= 1 - friction;
		position += velocity;
		maxProgress = Math.max(maxProgress, position / travel);
		if (t90 === null && position >= 0.9 * travel) t90 = Math.round(frame * 16.66);

		if (Math.abs(position - travel) < 0.3 && Math.abs(position - last) < 0.15) {
			if (++settleCount >= 2) {
				return { frames: frame, ms: Math.round(frame * 16.66), t90, maxProgress, early: true };
			}
		} else {
			settleCount = 0;
		}
		last = position;
	}
	return { frames: 900, ms: 14994, t90, maxProgress, early: false };
}

test('spring presets land in their timing budgets', () => {
	const budgets = {
		entrance: { ms: [450, 550], t90: [250, 320], overshoot: [0, 0.005] },
		exit: { ms: [250, 360], t90: [100, 200], overshoot: [0, 0.005] },
		// The snap spring is the only one allowed to breathe. A flick needs
		// somewhere to go, and 0.15/0.455 absorbed it within a frame at any
		// velocity — every settle looked identical however hard it was thrown.
		snap: { ms: [500, 640], t90: [170, 250], overshoot: [0.015, 0.035] },
		rest: { ms: [300, 400], t90: [140, 240], overshoot: [0, 0.005] },
		// The blob is the one motion with room for a real bounce: it is arriving,
		// nothing waits on it, and the overshoot reads as the panel springing out
		// of the trigger. Budgeted well above snap's breath on purpose.
		morph: { ms: [480, 590], t90: [140, 200], overshoot: [0.04, 0.075] },
		// The return is the morph in with attraction eased off and friction
		// raised: same elastic character, a little calmer and a little less
		// breath. Reaching for a HIGH attraction instead is the mistake this
		// budget exists to prevent — 0.42 settled fast on paper (t90 67ms) and
		// read as stiff, because a spring that covers 90% of its distance in
		// four frames is a yank with a wobble on the end, not a spring. The
		// t90 floor is what keeps a future retune from going back there.
		// Tuned by eye to a low attraction: the return travels at roughly the
		// arrival's weight rather than snapping back. High attraction was tried
		// repeatedly and rejected every time — 0.42 (t90 67ms) and 0.28 (t90
		// 117ms) both read as too abrupt, whatever their overshoot. What that
		// costs is the bounce: at a=0.07 the pull is too weak to carry much
		// momentum past the target, so friction at 0.34 leaves well under 1%.
		morphBack: { ms: [470, 570], t90: [170, 240], overshoot: [0.008, 0.02] },
	};

	for (const [name, budget] of Object.entries(budgets)) {
		const run = simulateSpring(SPRING_PRESETS[name]);
		assert.ok(run.early, `${name} trips the early-settle detector instead of idling`);
		assert.ok(
			run.ms >= budget.ms[0] && run.ms <= budget.ms[1],
			`${name} settles in ${run.ms}ms (want ${budget.ms.join('-')})`
		);
		assert.ok(
			run.t90 >= budget.t90[0] && run.t90 <= budget.t90[1],
			`${name} reaches 90% of travel at ${run.t90}ms (want ${budget.t90.join('-')})`
		);
		// Per-preset rather than blanket, so snap's deliberate breath cannot be
		// used as cover for any other phase drifting loose.
		const overshoot = Math.max(0, run.maxProgress - 1);
		assert.ok(
			overshoot >= budget.overshoot[0] && overshoot <= budget.overshoot[1],
			`${name} overshoots ${overshoot.toFixed(4)} (want ${budget.overshoot.join('-')})`
		);
	}

	assert.ok(
		Math.max(0, simulateSpring(SPRING_PRESETS.snap).maxProgress - 1) >
			Math.max(0, simulateSpring(SPRING_PRESETS.rest).maxProgress - 1),
		'a bottom snap breathes where a side return, which has no room, does not'
	);

	// The whole point of splitting the blob presets: the direction is what
	// decides the bounce, not the engine. Asserted as an ordering rather than as
	// two absolute numbers so a later retune of both cannot quietly collapse
	// them back into one value that satisfies each budget on its own.
	const morphIn = simulateSpring(SPRING_PRESETS.morph);
	const morphOut = simulateSpring(SPRING_PRESETS.morphBack);
	assert.ok(
		Math.max(0, morphIn.maxProgress - 1) > Math.max(0, morphOut.maxProgress - 1) + 0.02,
		'growing out of the trigger bounces harder than returning to it'
	);
	// The blob pair follows exit-against-entrance on SETTLE only. It does not on
	// t90 — the return reaches 90% at 233ms against the arrival's 167ms — and
	// that is a deliberate exception rather than drift. Every tuning that made
	// the return quicker off the line needed a high attraction (0.28, 0.42), and
	// each was rejected on sight as too abrupt for a panel collapsing back into
	// a small button. The blob is not the sheet: an edge-anchored panel leaving
	// the screen wants to go, a box shrinking into its own trigger wants to be
	// followed. So the return is the calmer motion here, and only the tail is
	// asked to be shorter.
	assert.ok(
		morphOut.ms < morphIn.ms,
		'the return to the trigger settles sooner than the flight out of it'
	);

	// Leaving should always feel faster than arriving.
	assert.ok(simulateSpring(SPRING_PRESETS.exit).ms < simulateSpring(SPRING_PRESETS.entrance).ms);
});

test('a profile change away from bottom drops the height its track wrote', async (t) => {
	const frames = captureFrames(t);
	const engine = makeEngine();
	const dialog = makeDialog();
	const shown = engine.show({ to: dialog, display: 'flex' });
	drainFrames(frames);
	await shown;
	assert.equal(dialog.style.height, '500px', 'a bottom sheet paints a pixel height');

	// Only a bottom profile emits a size property, and #applyFrame's Object.assign
	// cannot clear one the new track never mentions — so a stale pixel height would
	// pin a side drawer to the geometry it just left.
	engine.setProfile(profileFor('right'));
	engine.setSnaps([400], 0);
	assert.equal(dialog.style.height, '', 'the bottom height is gone');
	assert.equal(translateX(dialog), 0, 'the side drawer rests flush against its edge');
});

// The same hazard wearing the same position. Crossing the breakpoint on `bottom`
// switches it from snap-resized to content-sized without changing `position`, so
// a rule keyed on position alone would leave the last snap height pinned inline —
// defeating `height: fit-content` and freezing the content-resize observer.
test('crossing the breakpoint on bottom drops the height its mobile track wrote', async (t) => {
	const frames = captureFrames(t);
	const engine = makeEngine();
	const dialog = makeDialog();
	const shown = engine.show({ to: dialog, display: 'flex' });
	drainFrames(frames);
	await shown;
	assert.equal(dialog.style.height, '500px', 'the mobile bottom sheet paints its snap');

	engine.setProfile(profileFor('bottom', { desktop: true }));
	engine.setSnaps([320], 0);
	assert.equal(dialog.style.height, '', 'the snap height is gone');
	assert.equal(translateY(dialog), 0, 'and the content-sized panel rests flush on its edge');
});

test('a profile change mid-entrance retargets the running spring', async (t) => {
	const frames = captureFrames(t);
	const engine = makeEngine();
	const dialog = makeDialog();
	const shown = engine.show({ to: dialog, display: 'flex' });
	// Part-way into the entrance, while the spring is still running: beginMorph
	// refuses any state but 'shown', so the host's only route is this rebuild.
	for (let index = 0; index < 6; index++) {
		assert.ok(frames.length > 0, `entrance frame ${index + 1} is queued`);
		frames.shift()(index * 16.66);
	}
	assert.equal(engine.state, 'showing');
	assert.ok(dialog.style.height, 'the bottom track is still painting a height');

	engine.setProfile(profileFor('right'));
	engine.setSnaps([400], 0);
	// The run must finish in the NEW geometry rather than landing in the old one
	// and snapping at settle.
	assert.equal(dialog.style.height, '', 'the run stops repainting the old size');
	drainFrames(frames);
	await shown;
	assert.equal(engine.state, 'shown');
	assert.equal(dialog.style.height, '', 'and never reintroduces it');
	assert.equal(translateX(dialog), 0, 'the entrance settles flush, with no jump');
});
