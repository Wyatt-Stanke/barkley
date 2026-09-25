// Save transfer (patch modernized/09). Configuration -> SETTINGS -> Saves calls saves_open, which shows a panel
// (SavesPanel) holding every save slot as one block of text: the player copies it out of one browser and pastes it
// into another, or keeps it as a file. Saves live in browser storage, which is per origin, so they are lost by
// clearing site data or switching browser; this is the way back. Only the three save slots travel, not the settings,
// so a device keeps its own keys, screen and volume.
//
// The runtime stores each game file in localStorage under a prefix built from the game's name and id. Rather than
// rebuild that prefix (obfuscation renames everything around it), sSaveData writes a probe file and passes its name:
// the key that ends with it gives the prefix.
import { createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { storage } from '../page';

const TAG = 'BARKLEY-SAVES-1:';
const TAG_PLAIN = 'BARKLEY-SAVES-1U:'; // the same JSON, not gzipped (no CompressionStream in this browser)
// The three slots sFiler reads. Not \d+: sFileData writes slot 1 through the temp file Save10.sav, which would match.
const SLOT = /^Save[1-3]\.sav$/;
const LIMIT = 1 << 20;
let prefix: string | null = null;

// The panel: open counts up with every saves_open (0: closed), so each opening starts a fresh panel.
export const [savesOpen, setSavesOpen] = createSignal(0);
export const [saves, setSaves] = createStore({ status: '', code: '', slots: 0 });
export const slotCount = (n: number) => n + (n === 1 ? ' save slot' : ' save slots');

export function saves_open(probe: string) {
	const open = savesOpen() + 1;
	setSaves({ status: '', code: '', slots: 0 });
	setSavesOpen(open);
	prefix = find(String(probe));
	if (prefix === null) {
		setSaves(
			'status',
			'This browser has no storage for save files, so there is nothing to export and nowhere to import to.',
		);
		return 0;
	}
	const files = read(prefix),
		names = Object.keys(files);
	if (!names.length)
		setSaves('status', 'No save slots in this browser yet. Save in the game first, then come back here.');
	else
		encode(files).then(
			(code) =>
				savesOpen() === open &&
				setSaves({ code, slots: names.length, status: `${slotCount(names.length)} in this browser.` }),
			(e) => savesOpen() === open && setSaves('status', `Could not read the saves: ${e}`),
		);
	return 0;
}

// The runtime's key prefix, from the key of the probe file the game just wrote
function find(probe: string) {
	for (const k of storage.keys())
		if (k.length > probe.length && k.slice(-probe.length) === probe) return k.slice(0, k.length - probe.length);
	return null;
}

// The slot files stored under the runtime's key prefix p
function read(p: string) {
	const files: Record<string, string> = {};
	for (const k of storage.keys())
		if (k.indexOf(p) === 0 && SLOT.test(k.slice(p.length))) files[k.slice(p.length)] = storage.get(k) ?? '';
	return files;
}

// Base64, broken into lines of 100 so it copies and pastes through anything
export function base64(bytes: Uint8Array) {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s).replace(/.{100}/g, '$&\n');
}

async function encode(files: Record<string, string>) {
	const json = JSON.stringify({ version: 1, game: 'bsuajg', time: new Date().toISOString(), files });
	const bytes = new TextEncoder().encode(json);
	if (typeof CompressionStream === 'undefined') return TAG_PLAIN + base64(bytes);
	const gz = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
	return TAG + base64(new Uint8Array(await new Response(gz).arrayBuffer()));
}

async function decode(text: string) {
	text = text.replace(/\s+/g, '');
	const plain = text.indexOf(TAG_PLAIN) === 0;
	const tag = plain ? TAG_PLAIN : TAG;
	if (text.indexOf(tag) !== 0) throw new Error(`this is not a Barkley save code (it should start with ${tag})`);
	const raw = atob(text.slice(tag.length));
	const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
	if (plain) return new TextDecoder().decode(bytes);
	if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot unpack the save code');
	const un = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
	try {
		return await new Response(un).text();
	} catch {
		throw new Error('the save code is damaged or incomplete (copy the whole thing, including the first line)');
	}
}

// Writes the slots the code holds, and returns how many. Only slot files are written, whatever the code contains.
function write(json: string) {
	const report = JSON.parse(json);
	if (report?.game !== 'bsuajg' || !report.files) throw new Error('this save code is not from this game');
	const names = Object.keys(report.files).filter(
		(n) => SLOT.test(n) && typeof report.files[n] === 'string' && report.files[n].length < LIMIT,
	);
	if (!names.length) throw new Error('this save code holds no save slots');
	for (const n of names) localStorage.setItem(prefix + n, report.files[n]);
	return names.length;
}

// The panel's Import: the status line says what happened
export function importSaves(text: string) {
	return decode(text)
		.then(write)
		.then(
			(n) =>
				setSaves(
					'status',
					`Imported ${slotCount(n)}. Close this, leave Configuration and open Load Datafile to see them.`,
				),
			(e) => setSaves('status', `Could not import: ${e?.message || e}`),
		);
}
