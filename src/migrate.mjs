#!/usr/bin/env node

// Migrates the decompiled Barkley GMX (GameMaker: Studio 1.4) so it runs without the
// removed legacy APIs and can be imported into GameMaker LTS.
//
//   node src/migrate.mjs [--mode=modernized|faithful] <pristine GMX dir> <original game dir> <output GMX dir>
//
// faithful keeps the game as it was; modernized (the default) also applies patches/modernized/, which adapt it
// to the web (it fills the browser window). The original game dir is the distribution folder holding Music/,
// Voice/ and BG/.
// The unpacked, migrated code is left next to the output as <output>.code for review.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	importBackgrounds,
	importBattleBackdrops,
	importFonts,
	importSounds,
	markStereoSounds,
	soundReplacements,
} from './assets.mjs';
import { tokenize } from './lib/gml.mjs';
import { pack, unpack } from './lib/gmx.mjs';
import { transforms } from './transforms.mjs';

const args = process.argv.slice(2);
const mode = args.find((a) => a.startsWith('--mode='))?.slice('--mode='.length) ?? 'modernized';
const [src, game, out] = args.filter((a) => !a.startsWith('--mode=')).map((p) => path.resolve(p));
if (!out || !['faithful', 'modernized'].includes(mode)) {
	console.error(
		'usage: node migrate.mjs [--mode=modernized|faithful] <pristine GMX dir> <original game dir> <output GMX dir>',
	);
	process.exit(1);
}
const code = `${out}.code`;
for (const d of [out, code])
	if (fs.existsSync(d)) {
		console.error(`${d} already exists`);
		process.exit(1);
	}

const here = path.dirname(fileURLToPath(import.meta.url));
const warnings = [];
const warn = (m) => warnings.push(m);
const read = (f) => fs.readFileSync(f, 'utf8');
const files = (d = code) =>
	fs
		.readdirSync(d, { recursive: true })
		.filter((f) => f.endsWith('.gml'))
		.map((f) => f.split(path.sep).join('/'))
		.sort();
const step = (name, fn) => {
	console.log(`- ${name}`);
	fn();
};

// dereference: a symlinked input would otherwise be copied as a symlink, and every write below would land in
// the pristine export instead of the output.
step('copy project', () => fs.cpSync(src, out, { recursive: true, dereference: true }));
step('unpack code', () => unpack(out, code));

let sounds;
step('find runtime-loaded sounds', () => {
	sounds = soundReplacements(files().map((f) => read(path.join(code, f))));
});

step('delete BGM DLL wrappers and unused rt_ transitions; restore sA name', () => {
	const dir = path.join(code, 'scripts');
	for (const f of fs.readdirSync(dir)) if (/^(bgm_|rt_)/.test(f)) fs.rmSync(path.join(dir, f));
	// The game has two scripts, sa and sA (the music player). On a case-insensitive filesystem only one file survives,
	// holding sA's code under either name; game/recovered-scripts has sa, and patch 01 brings it back as sBeatAdd. On a
	// case-sensitive one (Linux, from virt/'s tar) both survive, so drop sa to get the same tree.
	const names = fs.readdirSync(dir);
	if (names.includes('sa.gml') && names.includes('sA.gml')) fs.rmSync(path.join(dir, 'sa.gml'));
	// Otherwise rename sa.gml via a temp name, for case-insensitive filesystems.
	else if (names.includes('sa.gml')) {
		fs.renameSync(path.join(dir, 'sa.gml'), path.join(dir, 'sA.tmp'));
		fs.renameSync(path.join(dir, 'sA.tmp'), path.join(dir, 'sA.gml'));
	}
});

step(`apply patches (${mode})`, () => {
	for (const dir of mode === 'modernized' ? ['patches', 'patches/modernized'] : ['patches'])
		for (const p of fs
			.readdirSync(path.join(here, dir))
			.filter((p) => p.endsWith('.patch'))
			.sort())
			execFileSync('patch', ['-p1', '-s', '-N', '-d', code, '-i', path.join(here, dir, p)], { stdio: 'inherit' });
});

step('generate sRoomCaption from room captions', () => {
	// LTS rooms have no caption, so room_caption is gone; patch 12 calls this instead.
	const dir = path.join(out, 'rooms');
	const lines = fs
		.readdirSync(dir)
		.filter((f) => f.endsWith('.room.gmx'))
		.sort()
		.flatMap((f) => {
			// <caption/> when it is empty, which is how an XML writer other than GameMaker's spells it.
			const caption = /<caption>([^<]*)<\/caption>/.exec(read(path.join(dir, f)))?.[1] ?? '';
			return caption ? [`if (argument0=${f.slice(0, -'.room.gmx'.length)}) return "${caption}";`] : [];
		});
	write('scripts/sRoomCaption.gml', `//Caption of room argument0\n${lines.join('\n')}\nreturn '';\n`);
});

const objects = new Set(
	fs
		.readdirSync(path.join(out, 'objects'))
		.filter((f) => f.endsWith('.object.gmx'))
		.map((f) => f.slice(0, -'.object.gmx'.length)),
);
// Room instances: object -> [room, instance name, has creation code]
const placed = new Map();
// Attributes by name, not by position: another XML writer may order them differently.
const attrOf = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
for (const f of fs.readdirSync(path.join(out, 'rooms')).filter((f) => f.endsWith('.room.gmx')))
	for (const [tag] of read(path.join(out, 'rooms', f)).matchAll(/<instance\s[^>]*>/g)) {
		const [obj, name, cc] = ['objName', 'name', 'code'].map((a) => attrOf(tag, a));
		if (obj === undefined || name === undefined) continue;
		placed.set(obj, [...(placed.get(obj) ?? []), [f.slice(0, -'.room.gmx'.length), name, !!cc]]);
	}
const hasCreate = (o) => fs.existsSync(path.join(code, 'objects', o, '0_0.gml'));
for (const [name, fn] of Object.entries(
	transforms({ addFile: (p, c) => write(p, c), warn, mode, objects, placed, hasCreate }),
)) {
	step(`transform: ${name}`, () => {
		for (const f of files()) {
			const before = read(path.join(code, f));
			let after;
			try {
				after = fn(before, f);
			} catch (e) {
				throw new Error(`${f}: ${e.message}`);
			}
			if (after !== before) write(f, after);
		}
	});
}
function write(p, c) {
	fs.mkdirSync(path.dirname(path.join(code, p)), { recursive: true });
	fs.writeFileSync(path.join(code, p), c);
}

step('pack code into project', () => pack(code, out));

step('import Music, Voice, BG and font assets', () => {
	importSounds(out, game, sounds, warn);
	markStereoSounds(out);
	importBackgrounds(out, game, warn);
	importBattleBackdrops(out, game);
	importFonts(out, game, warn);
});

step('game settings: new audio engine, no interpolation', () => {
	const f = path.join(out, 'Configs', 'Default.config.gmx');
	fs.writeFileSync(
		f,
		read(f)
			.replace('<option_use_new_audio>false<', '<option_use_new_audio>true<')
			.replace('<option_interpolate>true<', '<option_interpolate>false<'),
	);
});

// Anything still using an API that GameMaker LTS removed, including inside strings.
const REMOVED =
	/^(execute_string|execute_file|object_add|object_event_add|external_\w+|sound_\w+|image_single|file_(open_\w+|close|readln|writeln|eof|read_\w+|write_\w+)|display_(set_size|test_all|reset)|sprite_replace|background_replace|background_get_transparent|bgm_\w+|rt_\w+|object_delete|variable_local_\w+|make_color|room_caption)$/;
step('audit', () => {
	const hits = {};
	for (const f of files()) {
		for (const t of tokenize(read(path.join(code, f)))) {
			const words = t.type === 'id' ? [t.value] : t.type === 'str' ? (t.value.match(/\w+/g) ?? []) : [];
			for (const w of words.filter((w) => REMOVED.test(w))) {
				hits[w] ??= new Set();
				hits[w].add(f);
			}
		}
	}
	for (const [w, fs_] of Object.entries(hits))
		warn(`still uses ${w}: ${[...fs_].slice(0, 5).join(', ')}${fs_.size > 5 ? ` (+${fs_.size - 5} more)` : ''}`);
});

console.log(
	warnings.length
		? `\n${warnings.length} item(s) to review:\n${warnings.map((w) => `  ${w}`).join('\n')}`
		: '\nNo items to review.',
);
console.log(`\nMigrated project: ${out}\nMigrated code tree: ${code}`);
