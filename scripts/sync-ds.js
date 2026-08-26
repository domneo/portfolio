// static/ds holds the built design system that app.html and the icon sprite
// load. In development it is usually a symlink into a sibling `bleed` checkout,
// so edits there show up without reinstalling; a fresh clone (CI, Vercel) has no
// sibling, so copy dist out of the pinned `bleed` dependency instead. The
// directory is gitignored either way — nothing but this script puts it there.
import { cpSync, lstatSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const target = join(root, '..', 'static', 'ds');

function linkStatus(path) {
	let link;
	try {
		link = lstatSync(path);
	} catch {
		return 'missing';
	}
	if (!link.isSymbolicLink()) return 'directory';
	try {
		statSync(path);
		return 'symlink';
	} catch {
		// Points at a checkout that isn't here — the state that broke the build.
		return 'broken-symlink';
	}
}

const status = linkStatus(target);
if (status === 'symlink') {
	console.log(`static/ds -> ${realpathSync(target)} (local checkout, left as is)`);
} else {
	let source;
	try {
		source = join(dirname(createRequire(import.meta.url).resolve('bleed/package.json')), 'dist');
	} catch {
		console.error("Cannot find the 'bleed' package. Run pnpm install.");
		process.exit(1);
	}

	if (status === 'broken-symlink') {
		console.log('static/ds pointed at a checkout that is not here; replacing it with a copy.');
		// rmSync stats before it unlinks, so with force it quietly does nothing to a
		// dangling link; unlink it by hand.
		unlinkSync(target);
	} else {
		rmSync(target, { recursive: true, force: true });
	}
	cpSync(source, target, { recursive: true });
	console.log(`static/ds copied from ${source}`);
}

// index.html needs the sprite inlined in the document (not just linked from
// static/ds), so <use href="#icon-x"> resolves without a fetch. Keep it in
// sync here rather than by hand.
const htmlPath = join(root, '..', 'index.html');
const START = '<!-- GENERATED icon sprite from bleed/dist/icons.svg by scripts/sync-ds.js — do not edit. -->';
const END = '<!-- END generated icon sprite -->';
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const indent = (text, prefix) => text.split('\n').map((line) => prefix + line).join('\n');
const rawSprite = `${START}\n${readFileSync(join(target, 'icons.svg'), 'utf8').trimEnd()}\n${END}`;

const html = readFileSync(htmlPath, 'utf8');
// Capture the existing block's indent so re-running this script re-applies the
// same prefix instead of compounding it onto what's already there.
const blockPattern = new RegExp(`^([ \\t]*)${escapeRegExp(START)}[\\s\\S]*?${escapeRegExp(END)}`, 'm');
const match = html.match(blockPattern);
const sprite = indent(rawSprite, match ? match[1] : '  ');
// Matches only the real opening tag on its own line — a plain string search
// for '<body>' would also hit that literal text inside a code comment above.
const updatedHtml = match ? html.replace(blockPattern, sprite) : html.replace(/^<body>$/m, `<body>\n${sprite}`);

if (updatedHtml !== html) {
	writeFileSync(htmlPath, updatedHtml);
	console.log('index.html icon sprite synced');
}
