import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	mocha: {
		ui: 'tdd',
		timeout: 60000, // Increased to prevent ETIMEDOUT in complex environments (e.g. OneDrive paths)
	},
	launch: {
		args: [
			'--disable-gpu',
			'--disable-extensions',
			'--disable-workspace-trust',
		],
	},
	// Pin a known-good VS Code version matching engines.vscode to reduce download flakiness
	version: '1.93.0',
});
