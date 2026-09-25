// The page's shared state: where the game's files are, whether the fuzz harness is driving it, how far the Start
// screen has got, which of the GameMaker extensions this build has, and browser storage that never throws.
import { createSignal } from 'solid-js';

// The script tag that loaded this file carries the game's folder (html5game), which Igor fills into index.html.
export const folder = (document.currentScript as HTMLScriptElement | null)?.dataset.folder || 'html5game';

// Under fuzz.mjs's harness (injected before anything else) the page starts the game the old way, on Start, and keeps
// out of its way: no hold before Game Start, no service worker, no frame loops of its own.
export const fuzz = !!window.__fuzz;

// ready: the game has loaded and waits just before Game Start. started: Start was pressed.
export const [ready, setReady] = createSignal(false);
export const [started, setStarted] = createSignal(false);

// The GameMaker extensions import.mjs gave this build. Each one's file is loaded by the runtime and calls
// barkley.extension(name), so a faithful build, which has only Fullscreen, never turns the others on.
export type Extension = 'Fullscreen' | 'Resume' | 'Saves' | 'Touch' | 'Gamepad' | 'Controls' | 'Crash';
const [extensions, setExtensions] = createSignal<ReadonlySet<string>>(new Set());
export const has = (name: Extension) => extensions().has(name);
export const addExtension = (name: string) => setExtensions(new Set([...extensions(), name]));

// Opened as an installed app, not in a browser tab
export const isApp = () =>
	matchMedia('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)').matches ||
	!!navigator.standalone;

// localStorage, which throws when the browser blocks storage
export const storage = {
	get(key: string): string | null {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	},
	set(key: string, value: string) {
		try {
			localStorage.setItem(key, value);
		} catch {}
	},
	remove(key: string) {
		try {
			localStorage.removeItem(key);
		} catch {}
	},
	keys(): string[] {
		try {
			return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? '');
		} catch {
			return [];
		}
	},
};

export interface Api {
	readonly started: boolean;
	load(): void;
	ready(): void;
	start(fresh?: boolean): void;
	controls(): void;
	offlineSave(): void;
	extension(name: string): void;
	// for js: probes in a play-test
	readonly resumeState: string;
	readonly padMuted: boolean;
}
