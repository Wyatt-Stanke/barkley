import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

// The build served over HTTP to the browsers, and the ports
// --port: the build's server; the browsers' DevTools ports are port+530 to port+629 (default 8870, 9400-9499)
export let HTTP_PORT = 8870;
// ---- static server for the build ----
const TYPES = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.css': 'text/css', // a style sheet served as anything else is ignored
	'.png': 'image/png',
	'.json': 'application/json',
	'.woff2': 'font/woff2',
};
export function serve(root) {
	const server = createServer((req, res) => {
		const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
		if (!p.startsWith(root) || !existsSync(p) || !statSync(p).isFile()) return res.writeHead(404).end();
		res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream' });
		res.end(readFileSync(p));
	});
	return new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', () => r(server)));
}

// For probe scripts, like --port
export const setPort = (n) => {
	HTTP_PORT = n;
};
