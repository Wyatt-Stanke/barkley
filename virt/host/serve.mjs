// The guest's window onto the host: a read-only file service plus an upload
// endpoint, bound to loopback and reached from inside the VM at the SLIRP
// gateway, 10.0.2.2. vagrant-qemu has no synced folders, so this is how the
// installers, the game and the guest-side scripts get in, and how the finished
// GMX comes back out.
//
//   node virt/host/serve.mjs [--port=8899] [--root=<dir>] [--out=<dir>]
//
// Routes:
//   GET  /files/<path>        a file under one of the roots below
//   GET  /list/<dir>          that directory as JSON (name, size)
//   PUT  /upload/<name>       writes <out>/<name>
//   GET  /ping                "ok", so the guest can wait for the host
//
// Paths are resolved inside their root; anything that escapes is a 403.

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const VIRT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

const port = Number(args.get('port') ?? process.env.BARKLEY_FILES_PORT ?? 8899);
// The repository the guest pulls its inputs from. In a git worktree `tools/`
// and `game/` live only in the main checkout, hence the override.
const repo = resolve(String(args.get('root') ?? process.env.BARKLEY_ROOT ?? join(VIRT, '..')));
const outDir = resolve(String(args.get('out') ?? join(repo, 'build', 'virt')));

// Where a /files/<prefix>/... request is served from. Each prefix is its own
// jail; nothing outside these five directories is reachable.
const roots = {
  tools: join(repo, 'tools'),
  game: join(repo, 'game', 'original'),
  guest: join(VIRT, 'guest'),
  cache: join(VIRT, 'cache'),
  // What the host made for the guest -- the .gm6 that virt/decompile.sh
  // produces. It is also where uploads land, so this is the one root the guest
  // can both read and (through PUT /upload) write.
  build: outDir,
};

function safeJoin(root, rel) {
  const full = resolve(root, normalize(rel).replace(/^([/\\]|\.\.[/\\]?)+/, ''));
  return full === root || full.startsWith(root + sep) ? full : null;
}

function resolveRequest(pathname, prefix) {
  const rel = decodeURIComponent(pathname.slice(prefix.length));
  const [name, ...rest] = rel.split('/');
  const root = roots[name];
  if (!root) return null;
  return safeJoin(root, rest.join('/'));
}

function log(...parts) {
  console.log(new Date().toISOString().slice(11, 19), ...parts);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, body, type = 'text/plain') => {
    res.writeHead(code, { 'content-type': type });
    res.end(body);
  };

  try {
    if (url.pathname === '/ping') return send(200, 'ok');

    if (req.method === 'PUT' && url.pathname.startsWith('/upload/')) {
      const name = decodeURIComponent(url.pathname.slice('/upload/'.length));
      const dest = safeJoin(outDir, name);
      if (!dest) return send(403, 'outside the output directory');
      await mkdir(dirname(dest), { recursive: true });
      const tmp = `${dest}.part`;
      await pipeline(req, createWriteStream(tmp));
      await rename(tmp, dest);
      const { size } = await stat(dest);
      log('PUT', name, `${(size / 1e6).toFixed(1)} MB`);
      return send(201, `${dest}\n`);
    }

    // Every file under a root, recursively, as JSON: the guest uses this to
    // mirror virt/guest/ into C:\barkley\guest without knowing what is in it.
    if (req.method === 'GET' && url.pathname.startsWith('/manifest/')) {
      const dir = resolveRequest(url.pathname, '/manifest/');
      if (!dir) return send(403, 'no such root');
      const files = [];
      const walk = async (base, rel) => {
        for (const e of await readdir(join(base, rel), { withFileTypes: true })) {
          const next = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(base, next);
          else if (e.isFile()) files.push({ path: next, size: (await stat(join(base, next))).size });
        }
      };
      await walk(dir, '');
      return send(200, JSON.stringify(files, null, 2), 'application/json');
    }

    if (req.method === 'GET' && url.pathname.startsWith('/list/')) {
      const dir = resolveRequest(url.pathname, '/list/');
      if (!dir) return send(403, 'no such root');
      const entries = await readdir(dir, { withFileTypes: true });
      const rows = await Promise.all(
        entries.map(async (e) => ({
          name: e.name,
          dir: e.isDirectory(),
          size: e.isFile() ? (await stat(join(dir, e.name))).size : 0,
        })),
      );
      return send(200, JSON.stringify(rows, null, 2), 'application/json');
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/files/')) {
      const file = resolveRequest(url.pathname, '/files/');
      if (!file) return send(403, 'no such root');
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) return send(404, 'not found');
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': info.size,
      });
      if (req.method === 'HEAD') return res.end();
      log('GET', url.pathname, `${(info.size / 1e6).toFixed(1)} MB`);
      return pipeline(createReadStream(file), res).catch(() => {});
    }

    return send(404, 'not found');
  } catch (err) {
    log('error', url.pathname, err.message);
    if (!res.headersSent) send(500, `${err.message}\n`);
    else res.end();
  }
});

await mkdir(outDir, { recursive: true });
server.listen(port, '127.0.0.1', () => {
  log(`serving ${repo} on http://127.0.0.1:${port} (guest: http://10.0.2.2:${port})`);
  for (const [name, dir] of Object.entries(roots)) log(`  /files/${name}/ -> ${dir}`);
  log(`  PUT /upload/ -> ${outDir}`);
});
