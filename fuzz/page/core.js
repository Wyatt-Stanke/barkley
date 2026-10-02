export const N = window.__fuzzNames;
export const nativeSetTimeout = window.setTimeout.bind(window);
// A whole number of milliseconds: current_time then advances the same every frame, so the game's frame time
// (global.rendt) doesn't depend on where a restore left the clock (1000/60 gave 16, 17, 17, ...)
export const VSYNC = 17;
export const KEYS = { up: 38, down: 40, left: 37, right: 39, z: 90, x: 88, c: 67 };
export const F = { frame: 0, crash: null, ended: false, alerts: [] };
window.__fuzz = F;
// Every page starts as a first visit: a browser profile keeps the save files and config of earlier pages (replays
// from a fresh page would otherwise not be fresh). Snapshots carry their own.
try {
	localStorage.clear();
} catch {}
export const safe = (f, d = null) => {
	try {
		return f();
	} catch {
		return d;
	}
};

export const gml = () => window.global;
F.ready = () => !!(gml() && gml().gmlrendrate !== undefined);
export const roomName = () => room_get_name(g_pBuiltIn.get_current_room());
export const inst = (name) => GetWithArray(asset_get_index(name))[0];
