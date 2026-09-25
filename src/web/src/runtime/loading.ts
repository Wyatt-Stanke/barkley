// How far the game has loaded, which the Start word shows by filling from grey to white. The runtime calls
// barkley_loading (import.mjs names it as option_html5_loadingbar) every loading frame in place of drawing its bar,
// but only once the extension scripts have loaded, so showProgress also runs on a timer until the game is ready.
//
// The runtime counts files, but ~180 small sounds (3.4 MB) load long before the 9 texture pages (37 MB), so the
// count reached 89% in the first seconds and then stood still. So the texture pages count by bytes and weigh 90%, the
// rest 10%. An <img> reports nothing until it is done, so the pages download through fetch, where their bytes can be
// counted as they arrive, and the image then loads from the downloaded blob.
import { createSignal } from 'solid-js';
import { started } from '../page';

// url -> [bytes loaded, bytes in all (0 if unknown), done]
const textures: Record<string, [number, number, boolean]> = {};
let count = { total: 0, loaded: 0 };

// percent, only ever forward
export const [progress, setProgress] = createSignal(0);

export function installTextureProgress() {
	// the DOM defines src as an accessor pair
	const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src') as Required<PropertyDescriptor>;
	Object.defineProperty(HTMLImageElement.prototype, 'src', {
		configurable: true,
		enumerable: src.enumerable,
		get() {
			return src.get.call(this);
		},
		set(url: string) {
			const img = this as HTMLImageElement;
			if (started() || !/_texture_\d+\.png/.test(url) || !window.ReadableStream) return src.set.call(img, url);
			const t: [number, number, boolean] = [0, 0, false];
			textures[url] = t;
			fetch(url, { priority: 'low' }) // after the scripts, as an image would be
				.then(async (r) => {
					if (!r.ok || !r.body) throw r.status;
					t[1] = +(r.headers.get('Content-Length') ?? 0) || 0;
					const reader = r.body.getReader();
					const parts: Uint8Array[] = [];
					for (;;) {
						const x = await reader.read();
						if (x.done) return new Blob(parts as BlobPart[], { type: 'image/png' });
						parts.push(x.value);
						t[0] += x.value.length;
					}
				})
				.then(
					(blob) => {
						const u = URL.createObjectURL(blob);
						img.addEventListener('load', () => URL.revokeObjectURL(u));
						t[2] = true;
						src.set.call(img, u);
					},
					() => {
						t[1] = 0;
						src.set.call(img, url); // load it the ordinary way
					},
				);
		},
	});
}

export function barkley_loading(_ctx: unknown, _width: number, _height: number, total: number, loaded: number) {
	count = { total, loaded };
	showProgress();
}

export function showProgress() {
	const t = Object.values(textures);
	const n = window.JSON_game?.Textures?.length ?? 0;
	let got = 0,
		all = 0,
		done = 0;
	for (const x of t) {
		got += x[0];
		all += x[1];
		if (x[2]) done++;
	}
	// pages whose size isn't known yet (not started, or no Content-Length) count as the average known one
	const sized = t.filter((x) => x[1] > 0).length;
	const tex = sized ? Math.min(1, got / (all + ((n - sized) * all) / sized)) : n ? done / n : 0;
	const c = count;
	const rest = c.total > n ? Math.max(0, c.loaded - done) / (c.total - n) : 0;
	const f = n ? 0.9 * tex + 0.1 * rest : c.total ? c.loaded / c.total : 0;
	const p = Math.floor(100 * Math.min(1, f));
	if (p > progress()) setProgress(p);
}
