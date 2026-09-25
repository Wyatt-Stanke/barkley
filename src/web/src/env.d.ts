// What the page shares with the GameMaker runtime (BarkleyLTS.js) and the tooling around it.
import type { Api } from './page';

declare global {
	// Set by fuzz.mjs's in-page harness before anything else runs (src/fuzz-page.js).
	var __fuzz: object | undefined;
	// The page's own API: the play-test and fuzz tooling drive it, and each GameMaker extension's file calls
	// barkley.extension(name) as the runtime loads it.
	var barkley: Api;
	// The runtime: GameMaker_Init starts loading the game, and JSON_game describes it.
	function GameMaker_Init(): void;
	var JSON_game: { Textures?: unknown[] } | undefined;
	var webkitAudioContext: typeof AudioContext | undefined;

	interface Navigator {
		standalone?: boolean; // iOS Safari, opened from the home screen
	}
	interface Document {
		webkitFullscreenElement?: Element | null;
		webkitExitFullscreen?: () => void;
	}
	interface HTMLElement {
		webkitRequestFullscreen?: () => Promise<void> | void;
	}
	// Chrome's install prompt
	interface BeforeInstallPromptEvent extends Event {
		prompt(): Promise<void>;
		userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
	}
	interface WindowEventMap {
		beforeinstallprompt: BeforeInstallPromptEvent;
	}
}
