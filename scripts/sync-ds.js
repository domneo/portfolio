// static/ds holds the built design system that app.html and the icon sprite
// load. In development it is usually a symlink into a sibling `bleed` checkout,
// so edits there show up without reinstalling; a fresh clone (CI, Vercel) has no
// sibling, so copy dist out of the pinned `bleed` dependency instead. The
// directory is gitignored either way — nothing but this script puts it there.
import { cpSync, lstatSync, realpathSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'ds');

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
	process.exit(0);
}

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
