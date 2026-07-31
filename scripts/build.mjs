import { build, createServer } from 'vite';
import { rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import liveReload from '@magic-spells/vite-plugin-live-reload';

const isDev = process.env.NODE_ENV === 'development';
const outDir = isDev ? 'demo/dist' : 'dist';
const runtimeDependencies = ['@magic-spells/frame-engine', '@magic-spells/physics-engine'];

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
				external: runtimeDependencies,
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
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
