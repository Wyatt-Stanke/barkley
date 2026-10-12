import path from 'node:path';

// The repository (fuzz/lib/ is two levels down)
export const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
export const pick = (a) => a[Math.floor(Math.random() * a.length)];
export const stamp = () => new Date().toISOString().slice(0, 19).replace(/:/g, '').replace('T', '-');
export const dur = (ms) =>
	ms < 60000
		? `${(ms / 1000).toFixed(0)}s`
		: `${Math.floor(ms / 60000)}m${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}s`;

export const tty = process.stdout.isTTY || !!process.env.FORCE_COLOR;
const ansi = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const [dim, bold, red, green, yellow, blue, magenta, cyan] = [2, 1, '1;31', 32, 33, 34, 35, 36].map(ansi);
