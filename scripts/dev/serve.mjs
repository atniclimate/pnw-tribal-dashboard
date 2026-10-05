// @ts-check
/**
 * Local static server (blueprint 2.1, 2.8). Serves site/ as is at http://localhost:8080/pnw-tribal-dashboard/,
 * the same subpath GitHub Pages uses, with the MIME types Pages sends (.mjs as text/javascript, which
 * module scripts and the MapLibre module worker require). Directory URLs serve index.html; a directory
 * URL without its trailing slash redirects; unknown paths get site/404.html with status 404, as on Pages.
 * The repository's dev/ pages (component gallery, module harness) are served at <BASE>dev/ by this server
 * only; dev/ sits outside site/, so assemble-site.mjs never deploys it.
 *
 *   node scripts/dev/serve.mjs [--port 8080] [--host 127.0.0.1]
 *
 * Development only. Owner: lane L0.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SITE_DIR = path.join(ROOT, 'site');
/** Development pages (repository dev/), served at `${BASE}dev/` locally and never deployed. */
export const DEV_DIR = path.join(ROOT, 'dev');
export const BASE = '/pnw-tribal-dashboard/';

/** @type {Readonly<Record<string, string>>} */
export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
});

/** @param {string} p */
async function isFile(p) {
  try { return (await stat(p)).isFile(); } catch { return false; }
}
/** @param {string} p */
async function isDir(p) {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

/**
 * Resolve a request path to a file under site/ (or under dev/ for `${BASE}dev/...`), or a redirect, or null.
 * @param {string} urlPath decoded path beginning with BASE
 * @returns {Promise<{ file: string } | { redirect: string } | null>}
 */
export async function resolvePath(urlPath) {
  let rel = urlPath.slice(BASE.length);
  let dir = SITE_DIR;
  if (rel === 'dev' || rel.startsWith('dev/')) { dir = DEV_DIR; rel = rel.slice('dev'.length).replace(/^\//, ''); }
  const target = path.resolve(dir, rel);
  if (target !== dir && !target.startsWith(dir + path.sep)) return null;
  if (await isFile(target)) return { file: target };
  if (await isDir(target)) {
    if (!urlPath.endsWith('/')) return { redirect: `${urlPath}/` };
    const index = path.join(target, 'index.html');
    if (await isFile(index)) return { file: index };
  }
  return null;
}

/** @param {{ port?: number, host?: string }} [opts] */
export function startServer(opts = {}) {
  const port = opts.port ?? 8080;
  const host = opts.host ?? '127.0.0.1';
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
      if (url.pathname === '/' || url.pathname === BASE.slice(0, -1)) { res.writeHead(302, { Location: BASE }); res.end(); return; }
      let decoded;
      try { decoded = decodeURIComponent(url.pathname); } catch { res.writeHead(400); res.end(); return; }
      const found = decoded.startsWith(BASE) ? await resolvePath(decoded) : null;
      if (found && 'redirect' in found) { res.writeHead(301, { Location: found.redirect + url.search }); res.end(); return; }
      const file = found ? found.file : path.join(SITE_DIR, '404.html');
      const status = found ? 200 : 404;
      const body = await readFile(file).catch(() => Buffer.from('Not found'));
      res.writeHead(status, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const val = (/** @type {string} */ k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const port = Number(val('--port') ?? process.env.PORT ?? 8080);
  const host = val('--host') ?? '127.0.0.1';
  await startServer({ port, host });
  console.log(`Serving site/ at http://localhost:${port}${BASE} (dev/ pages at ${BASE}dev/)`);
}
