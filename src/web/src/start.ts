// Starting the game: the page loads it behind the Start screen, holds it just before Game Start (runtime/hold.ts), and
// lets it go on a click, a tap, or a character key, Enter or an arrow, so the browser allows audio from the first
// sound. Under the fuzz harness Start runs GameMaker_Init instead, as it always did.
import { batch } from 'solid-js';
import { controls_show, controlsOpen, setControlsOpen } from './extensions/controls';
import { RESUME_KEY } from './extensions/resume';
import { installOpen, setInstallOpen } from './install';
import { loadVersion, registerOffline, saveOffline } from './offline';
import { fuzz, ready, setReady, setStarted, started, storage } from './page';
import { earlyMusic, fixStreamedSounds, giveUpEarlyMusic, resumeAudio } from './runtime/audio';
import { release } from './runtime/hold';
import { setProgress, showProgress } from './runtime/loading';

let inited = false; // GameMaker_Init has run

// The game has loaded (the runtime logged "Entering main loop..."; under the fuzz harness, the page has loaded).
export function markReady() {
	if (started()) return;
	batch(() => {
		setProgress(100);
		setReady(true);
	});
	if (!fuzz) earlyMusic();
	loadVersion();
	registerOffline();
}

// fresh: forget the resume state before Game Start reads it (resume_take), so the game starts at the title
export function start(fresh?: boolean) {
	if (started()) return;
	if (fresh === true) storage.remove(RESUME_KEY);
	// the Start screen, the install prompt and the Controls panel go with it
	batch(() => {
		setStarted(true);
		setInstallOpen(false);
		setControlsOpen(false);
	});
	resumeAudio(); // the runtime unlocks audio on a pointer press only, and a key can start too
	if (!inited) {
		inited = true;
		GameMaker_Init();
	}
	setTimeout(giveUpEarlyMusic, 60000);
	release();
}

// The Controls panel is a page of its own above the Start screen, and keeps every key pressed in it.
export const openControls = () => void controls_show();

// Before Start, keys stay away from the game (the one that starts it would read as pressed in its first step). Any
// character key, Enter or an arrow starts, unless the install prompt is up.
function onKey(e: KeyboardEvent) {
	if (started()) return removeEventListener('keydown', onKey, true);
	// the Controls panel is testing these keys; nothing here may act on them or start the game
	if (controlsOpen()) return;
	if (e.ctrlKey || e.metaKey || e.altKey || installOpen()) return;
	e.stopImmediatePropagation();
	if (!ready() || !(e.key.length === 1 || e.key === 'Enter' || e.key.startsWith('Arrow'))) return;
	e.preventDefault();
	// Enter or Space on a focused link does what clicking it does
	const on = e.key === 'Enter' || e.key === ' ' ? (e.target as Element).id : '';
	if (on === 'controls-go') return openControls();
	if (on === 'offline-go') return saveOffline();
	start(on === 'fresh-go');
}

// window.onload, which index.html sets after the game's script, as the runtime's own template does
export function load() {
	addEventListener('keydown', onKey, true);
	fixStreamedSounds();
	if (fuzz) return markReady();
	inited = true;
	GameMaker_Init();
	const timer = setInterval(() => (ready() ? clearInterval(timer) : showProgress()), 100);
}
