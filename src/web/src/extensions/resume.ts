// Resume: after the tab reloads, or is closed and reopened, the game continues where it was. Every few steps
// resume_tick (patch modernized/06) hands the game state to resume_put, which writes it to browser storage when the
// page is hidden or closed, and at most every 5 s in case that never comes. resume_take gives it back once per page
// load, at Game Start, and forgets it. After an uncaught error (the game has stopped) nothing is kept, so a state that
// crashes isn't restored again.
import { storage } from '../page';

export const RESUME_KEY = 'barkley.resume';
let state = '',
	written = 0,
	taken = false,
	failed = false;

export const resumeState = () => state;

export function resume_put(s: string) {
	if (failed) return 0;
	state = s;
	if (Date.now() - written > 5000) write();
	return 0;
}

export function resume_take() {
	if (taken) return ''; // game_restart runs Game Start again
	taken = true;
	const s = storage.get(RESUME_KEY) || '';
	storage.remove(RESUME_KEY); // a state that fails to restore isn't tried again
	return s;
}

export function resume_clear() {
	state = '';
	storage.remove(RESUME_KEY);
	return 0;
}

function write() {
	written = Date.now();
	if (state) storage.set(RESUME_KEY, state);
}

export function enableResume() {
	addEventListener('error', () => {
		failed = true;
		resume_clear();
	});
	addEventListener('pagehide', write);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') write();
	});
}
