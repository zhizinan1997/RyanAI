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

let source = fs.readFileSync(bundlePath, 'utf8');
let changed = false;

const slashOriginal =
	'  const slash = slashCommand({ commands: buildCommandList(account, { getRuntime: opts.getRuntime }) });\n' +
	'  bot.use(slash.middleware);';
const slashReplacement =
	"  // RyanAI gateway hardening: the official plugin's management slash commands\n" +
	'  // must not bypass ryanai-bridge or mutate the embedded host at runtime.\n' +
	'  // This exact-version postinstall patch intentionally leaves ordinary messages intact.';

if (!source.includes(slashReplacement)) {
	const occurrences = source.split(slashOriginal).length - 1;
	if (occurrences !== 1) {
		throw new Error(
			`QQBot hardening refused unexpected ${occurrences} middleware matches in ${bundlePath}`
		);
	}
	source = source.replace(slashOriginal, slashReplacement);
	changed = true;
}

const mediaOriginal =
	'      maxBytes: 500 * 1024 * 1024,\n' +
	'      timeoutMs: 12e4\n' +
	'    });';
const legacyMediaReplacement =
	'      maxBytes: 500 * 1024 * 1024,\n' +
	'      timeoutMs: 12e4,\n' +
	'      // RyanAI gateway hardening: QQ official media may resolve through a\n' +
	'      // private-range proxy address. Permit that only for this exact HTTPS host.\n' +
	'      ...(new URL(url).hostname.toLowerCase() === "multimedia.nt.qq.com.cn" ? {\n' +
	'        ssrfPolicy: {\n' +
	'          hostnameAllowlist: ["multimedia.nt.qq.com.cn"],\n' +
	'          dangerouslyAllowPrivateNetwork: true\n' +
	'        }\n' +
	'      } : {})\n' +
	'    });';
const mediaReplacement =
	'      maxBytes: 500 * 1024 * 1024,\n' +
	'      timeoutMs: 12e4,\n' +
	'      // RyanAI gateway hardening: QQ official media may resolve through a\n' +
	'      // private-range proxy address. Permit only the exact host for known QQ media URLs.\n' +
	'      ...(["multimedia.nt.qq.com.cn", "grouptalk.c2c.qq.com"].includes(\n' +
	'        new URL(url).hostname.toLowerCase()\n' +
	'      ) ? {\n' +
	'        ssrfPolicy: {\n' +
	'          hostnameAllowlist: [new URL(url).hostname.toLowerCase()],\n' +
	'          dangerouslyAllowPrivateNetwork: true\n' +
	'        }\n' +
	'      } : {})\n' +
	'    });';

if (source.includes(legacyMediaReplacement)) {
	source = source.replace(legacyMediaReplacement, mediaReplacement);
	changed = true;
} else if (!source.includes(mediaReplacement)) {
	const occurrences = source.split(mediaOriginal).length - 1;
	if (occurrences !== 1) {
		throw new Error(
			`QQBot hardening refused unexpected ${occurrences} media downloader matches in ${bundlePath}`
		);
	}
	source = source.replace(mediaOriginal, mediaReplacement);
	changed = true;
}

if (changed) fs.writeFileSync(bundlePath, source, 'utf8');
process.stdout.write(
	changed
		? 'QQBot slash commands disabled and official media download policy hardened\n'
		: 'QQBot hardening already applied\n'
);
