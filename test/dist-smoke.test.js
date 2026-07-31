import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { installDomStubs } from './element-stub.js';

// The package ships exactly two entry points. These tests execute both of the
// built artifacts rather than inspecting the source, because the class of bug
// they exist to catch — a module-format or interop mistake — is invisible until
// something actually loads the file. See CLAUDE.md's "There is no CommonJS
// build, on purpose" for why a third artifact is not coming back.
const distUrl = new URL('../dist/', import.meta.url);
const distDir = fileURLToPath(distUrl);
const esmPath = fileURLToPath(new URL('sheet.esm.js', distUrl));
const umdPath = fileURLToPath(new URL('sheet.min.js', distUrl));
const built = existsSync(esmPath) && existsSync(umdPath);

const NAMED_EXPORTS = [
	'SheetContent',
	'SheetFooter',
	'SheetHeader',
	'SheetPanel',
	'resolveInitialSnap',
	'resolveSnapPoints',
	'resolveSnapTarget',
];

const allFunctions = (names) => Object.fromEntries(names.map((name) => [name, 'function']));

test('dist ships only the ESM and minified UMD entry points', { skip: !built }, () => {
	const shipped = readdirSync(distDir)
		.filter((name) => name.endsWith('.js'))
		.sort();
	assert.deepEqual(shipped, ['sheet.esm.js', 'sheet.min.js']);
});

test('the ESM build exposes every named export', { skip: !built }, async () => {
	installDomStubs();
	const module = await import(new URL('sheet.esm.js', distUrl).href);
	assert.deepEqual(
		Object.fromEntries(NAMED_EXPORTS.map((name) => [name, typeof module[name]])),
		allFunctions(NAMED_EXPORTS)
	);
});

test('the ESM build keeps its runtime dependencies external', { skip: !built }, () => {
	const source = readFileSync(esmPath, 'utf8');
	for (const dependency of ['@magic-spells/physics-engine', '@magic-spells/frame-engine']) {
		assert.match(
			source,
			new RegExp(`from\\s*["']${dependency}["']`),
			`${dependency} should stay a bare import in the ESM build`
		);
	}
});

// Executed through a CommonJS-shaped sandbox so the UMD's `module.exports`
// branch is the one under test. Loading it as ESM would silently take the
// global branch instead and assert nothing about the exports consumers get.
test('the UMD build exposes the same exports and bundles its engines', { skip: !built }, () => {
	const stubs = installDomStubs();
	const shell = { exports: {} };
	const sandbox = {
		module: shell,
		exports: shell.exports,
		window: stubs.window,
		document: stubs.document,
		Element: globalThis.Element,
		HTMLElement: globalThis.HTMLElement,
		customElements: globalThis.customElements,
		CustomEvent: globalThis.CustomEvent,
		getComputedStyle: globalThis.getComputedStyle,
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(readFileSync(umdPath, 'utf8'), sandbox);

	assert.deepEqual(
		Object.fromEntries(NAMED_EXPORTS.map((name) => [name, typeof shell.exports[name]])),
		allFunctions(NAMED_EXPORTS)
	);
	// A bare specifier surviving into the UMD would mean the engines were left
	// external, which a plain <script> tag cannot resolve.
	assert.doesNotMatch(readFileSync(umdPath, 'utf8'), /require\(["']@magic-spells\//);
});
