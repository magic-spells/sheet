import { build, createServer } from 'vite';
import { rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import liveReload from '@magic-spells/vite-plugin-live-reload';

const isDev = process.env.NODE_ENV === 'development';
const outDir = isDev ? 'demo/dist' : 'dist';
// External in the ESM build so the app's module graph supplies one shared copy
// of each — dialog-panel via peerDependencies, the engines via dependencies.
// All of them are bundled into the UMD, which a plain <script> tag loads as
// one self-contained file.
const externalRuntime = [
	'@magic-spells/dialog-panel',
	'@magic-spells/frame-engine',
	'@magic-spells/morph-engine',
	'@magic-spells/physics-engine',
];

function sharedBuild(overrides = {}) {
	return {
		configFile: false,
		logLevel: isDev ? 'warn' : 'info',
		css: { transformer: 'lightningcss' },
		build: {
			outDir,
			emptyOutDir: false,
			sourcemap: true,
			target: 'es2022',
			reportCompressedSize: !isDev,
			watch: isDev ? {} : null,
			...overrides.build,
		},
		...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'build')),
	};
}

function esmConfig({ emitCss = false } = {}) {
	return sharedBuild({
		build: {
			lib: {
				entry: 'src/sheet.js',
				fileName: () => 'sheet.esm.js',
				formats: ['es'],
				...(emitCss ? { cssFileName: 'sheet' } : {}),
			},
			minify: false,
			cssMinify: emitCss ? false : undefined,
			rolldownOptions: {
				external: externalRuntime,
				output: { exports: 'named' },
			},
		},
	});
}

// There is deliberately no CommonJS build, and no unminified UMD. The package
// ships exactly two entry points: `sheet.esm.js` for anything with a module
// graph, and `sheet.min.js` for a plain `<script>` tag. CommonJS is not
// supported — `package.json` has no `require` condition, so `require()` fails
// at resolution with a clear error instead of at runtime with a confusing one.
function umdMinConfig({ emitCss = false } = {}) {
	return sharedBuild({
		build: {
			lib: {
				entry: 'src/sheet.js',
				name: 'Sheet',
				fileName: () => 'sheet.min.js',
				formats: ['umd'],
				...(emitCss ? { cssFileName: 'sheet.min' } : {}),
			},
			minify: 'terser',
			terserOptions: {
				mangle: { keep_classnames: true, keep_fnames: false },
			},
			cssMinify: emitCss ? 'lightningcss' : undefined,
			rolldownOptions: {
				output: { exports: 'named' },
			},
		},
	});
}

async function main() {
	if (!isDev) {
		await rm(outDir, { recursive: true, force: true });
		await mkdir(outDir, { recursive: true });
	} else if (!existsSync(outDir)) {
		await mkdir(outDir, { recursive: true });
	}

	// The demo loads only `sheet.esm.js` and `sheet.css`, so dev skips the UMD.
	const configs = isDev
		? [esmConfig({ emitCss: true })]
		: [esmConfig({ emitCss: true }), umdMinConfig({ emitCss: true })];

	if (isDev) {
		for (const config of configs) {
			build(config).catch((error) => {
				console.error('build error:', error);
			});
		}

		const server = await createServer({
			configFile: false,
			root: 'demo',
			server: { port: 3066, open: true, strictPort: false, host: true },
			plugins: [liveReload('demo/dist')],
		});
		await server.listen();
		server.printUrls();
	} else {
		for (const config of configs) {
			await build(config);
		}
		await writeGzipSizes();
	}
}

// The demo's hero fetches these numbers, so they are measured from the real
// artifacts here rather than hand-maintained in the HTML. Written into
// demo/dist (which is committed) so both the dev server and GitHub Pages
// serve it; dev builds never empty that directory, so the file survives
// watch runs and only a production build can change it.
async function writeGzipSizes() {
	const sizes = {};
	for (const file of ['sheet.min.js', 'sheet.min.css']) {
		sizes[file] = gzipSync(await readFile(`dist/${file}`)).length;
	}
	await mkdir('demo/dist', { recursive: true });
	await writeFile('demo/dist/sizes.json', `${JSON.stringify(sizes, null, '\t')}\n`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
