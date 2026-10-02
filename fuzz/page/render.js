import { F } from './core.js';

// Drawing on or off. Off, the calls that rasterize do nothing; every other WebGL call still runs, since the runtime
// caches GL state and creates surfaces as it goes. The fuzzer never looks at the picture.
const glReal = new Map();
const noop = () => {};
F.draw = (on) => {
	for (const P of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
		if (!glReal.has(P)) {
			const fns = {};
			for (const k of [
				'drawArrays',
				'drawElements',
				'drawArraysInstanced',
				'drawElementsInstanced',
				'drawRangeElements',
				'clear',
			])
				if (typeof P[k] === 'function') fns[k] = P[k];
			glReal.set(P, fns);
		}
		for (const [k, fn] of Object.entries(glReal.get(P))) P[k] = on ? fn : noop;
	}
};

// Stops sound: the runtime mixes it in an AudioWorklet on the real-time audio thread, which in a dozen browsers at
// once starves the game threads. With the audio clock stopped, sounds keep "playing" where they are.
F.quiet = () => {
	const a = window.g_WebAudioContext;
	if (!a) return;
	a.suspend();
	a.resume = () => Promise.resolve();
};
