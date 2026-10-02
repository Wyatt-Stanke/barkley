import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chrome } from '../../src/toolchain.mjs';
import { HTTP_PORT } from './serve.mjs';
import { sleep } from './util.mjs';

// ---- one browser with one page ----
export class Browser {
	// draw: keep drawing (otherwise only replays' screenshot frames are drawn); shots: a window for screenshots
	// through: patch known crash classes (__fuzz.through)
	constructor(id, dir, source, { draw = false, shots = false, through = false } = {}) {
		Object.assign(this, { id, dir, source, draw, shots, through, port: HTTP_PORT + 530 + id });
	}
	async start() {
		this.kill();
		mkdirSync(this.dir, { recursive: true });
		// No autoplay flag: the audio context stays suspended (see __fuzz.quiet).
		this.proc = spawn(
			chrome(),
			[
				'--no-sandbox',
				`--remote-debugging-port=${this.port}`,
				'--use-angle=swiftshader',
				'--enable-unsafe-swiftshader',
				'--mute-audio',
				'--disable-background-timer-throttling',
				'--disable-renderer-backgrounding',
				'--disable-backgrounding-occluded-windows',
				'--js-flags=--max-old-space-size=4096',
				`--window-size=${this.shots ? '640,480' : '320,240'}`,
				`--user-data-dir=${path.resolve(this.dir, 'profile')}`,
				'about:blank',
			],
			{ stdio: 'ignore' },
		);
		let page;
		for (let i = 0; i < 150 && !page; i++) {
			await sleep(100);
			page = await fetch(`http://127.0.0.1:${this.port}/json/list`)
				.then((r) => r.json())
				.then((l) => l.find((t) => t.type === 'page'))
				.catch(() => null);
		}
		if (!page) throw new Error(`browser ${this.id} did not start`);
		this.ws = new WebSocket(page.webSocketDebuggerUrl);
		await new Promise((r, j) => {
			this.ws.addEventListener('open', r);
			this.ws.addEventListener('error', j);
		});
		this.pending = new Map();
		this.seq = 0;
		this.ws.addEventListener('message', ({ data }) => {
			const m = JSON.parse(data);
			if (!m.id) return;
			const p = this.pending.get(m.id);
			this.pending.delete(m.id);
			if (m.error) p?.[1](new Error(m.error.message));
			else p?.[0](m.result);
		});
		this.ws.addEventListener('close', () => {
			for (const [, p] of this.pending) p[1](new Error('browser connection closed'));
			this.pending.clear();
		});
		await this.send('Page.enable');
		await this.send('Page.addScriptToEvaluateOnNewDocument', { source: this.source });
		await this.boot();
	}
	send(method, params = {}, timeout = 120000) {
		return new Promise((r, j) => {
			const id = ++this.seq;
			const t = setTimeout(() => {
				this.pending.delete(id);
				j(new Error(`timeout: ${method}`));
			}, timeout);
			const settle = (f) => (v) => {
				clearTimeout(t);
				f(v);
			};
			this.pending.set(id, [settle(r), settle(j)]);
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}
	// Calls a function in the page with a JSON argument; throws on a page error or after the timeout.
	async call(fn, arg, timeout) {
		const expression = `(${fn})(${JSON.stringify(arg) ?? ''})`;
		const r = await this.send('Runtime.evaluate', { expression, returnByValue: true }, timeout);
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
		return r.result.value;
	}
	// Loads the page, instruments the game, presses Start and waits until Game Start has run.
	async boot() {
		await this.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/index.html` });
		for (let i = 0; ; i++) {
			if (i > 900) throw new Error(`browser ${this.id}: the game did not start`);
			await sleep(100);
			const ok = await this.call(
				([draw, through]) => {
					const b = document.getElementById('start');
					if (window.__fuzz && b && !b.disabled) {
						__fuzz.instrument();
						b.click();
						return false;
					}
					if (b || !window.__fuzz?.ready()) return false;
					__fuzz.draw(draw); // after WebGL setup
					__fuzz.quiet();
					if (through) __fuzz.through();
					return true;
				},
				[this.draw, this.through],
			).catch(() => false);
			if (ok) break;
		}
	}
	// A screenshot; step: first run a frame with drawing on (when the last frame wasn't drawn)
	async shot(file, step = false) {
		if (step) await this.call(() => __fuzz.replay({ program: [[[], 1]], drawLast: true }));
		const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
		writeFileSync(file, Buffer.from(data, 'base64'));
	}
	kill() {
		this.proc?.kill('SIGKILL');
		this.ws?.close();
	}
}
