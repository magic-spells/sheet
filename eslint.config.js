import js from '@eslint/js';
import globals from 'globals';

/** @type {import('eslint').Linter.Config[]} */
export default [
	{
		ignores: ['**/dist/', '**/demo/*.js', '**/node_modules/'],
	},
	{
		files: ['src/**/*.js'],
		...js.configs.recommended,
		languageOptions: {
			ecmaVersion: 2024,
			sourceType: 'module',
			globals: {
				...globals.browser,
				...globals.es2024,
			},
		},
		rules: {
			'no-unused-vars': 'warn',
			'no-console': 'off',
		},
	},
	{
		files: ['scripts/**/*.js', 'scripts/**/*.mjs', 'test/**/*.js'],
		languageOptions: {
			ecmaVersion: 2024,
			sourceType: 'module',
			globals: {
				...globals.node,
				...globals.es2024,
			},
		},
	},
];
