'use strict';

const fs = require('node:fs');
const path = require('node:path');

const expectedVersion = '2.0.0';
const packageRoot = path.resolve(
	__dirname,
	'..',
	'node_modules',
	'@tencent-connect',
	'openclaw-qqbot'
);
const packageJsonPath = path.join(packageRoot, 'package.json');
const bundlePath = path.join(packageRoot, 'dist', 'index.cjs');

if (!fs.existsSync(packageJsonPath)) {
	throw new Error('QQBot hardening failed: @tencent-connect/openclaw-qqbot is not installed');
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
if (packageJson.version !== expectedVersion) {
	throw new Error(
		`QQBot hardening refused unexpected plugin version ${String(packageJson.version)}; expected ${expectedVersion}`
	);
}

const source = fs.readFileSync(bundlePath, 'utf8');
const original =
	'  const slash = slashCommand({ commands: buildCommandList(account, { getRuntime: opts.getRuntime }) });\n' +
	'  bot.use(slash.middleware);';
const replacement =
	"  // RyanAI gateway hardening: the official plugin's management slash commands\n" +
	'  // must not bypass ryanai-bridge or mutate the embedded host at runtime.\n' +
	'  // This exact-version postinstall patch intentionally leaves ordinary messages intact.';

if (source.includes(replacement)) {
	process.stdout.write('QQBot hardening already applied\n');
	process.exit(0);
}

const occurrences = source.split(original).length - 1;
if (occurrences !== 1) {
	throw new Error(
		`QQBot hardening refused unexpected ${occurrences} middleware matches in ${bundlePath}`
	);
}

fs.writeFileSync(bundlePath, source.replace(original, replacement), 'utf8');
process.stdout.write('QQBot built-in slash commands disabled for RyanAI gateway\n');
