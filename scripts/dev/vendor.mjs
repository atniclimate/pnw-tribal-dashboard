// @ts-check
/**
 * Vendor the runtime dependencies into site/static/vendor/ (blueprint 2.3):
 *   maplibre-gl 6.12.0 from node_modules/maplibre-gl/dist/ (maplibre-gl.mjs, maplibre-gl-shared.mjs,
 *   maplibre-gl-worker.mjs, maplibre-gl.css, plus LICENSE.txt from the package) into
 *   vendor/maplibre-gl-6.12.0/, and topojson-client 3.1.0 into vendor/topojson-client-3.1.0/; then write
 *   vendor/manifest.json with each npm tarball URL, its `integrity` value from package-lock.json, and the
 *   SHA-256 of every vendored file. scripts/check/vendor-integrity.mjs recomputes all of it in CI.
 *
 * The installed packages were fetched by `npm ci`, which verifies each tarball against the lockfile
 * `integrity` value, so the copied bytes are the tarball bytes. This script refuses to run when the
 * installed version differs from the plan, or when the lockfile does not carry the same version.
 * The manifest is deterministic (no clock). Owner: lane L8. A version bump is one reviewed change that
 * edits VENDOR_PLAN and package.json together and re-runs this script (npm run vendor).
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const VENDOR_PLAN = Object.freeze({
  'maplibre-gl': Object.freeze({ version: '6.12.0', dir: 'maplibre-gl-6.12.0', files: ['dist/maplibre-gl.mjs', 'dist/maplibre-gl-shared.mjs', 'dist/maplibre-gl-worker.mjs', 'dist/maplibre-gl.css', 'LICENSE.txt'] }),
  'topojson-client': Object.freeze({ version: '3.1.0', dir: 'topojson-client-3.1.0', files: ['dist/topojson-client.min.js', 'LICENSE'] }),
});

/** @param {Uint8Array | Buffer} bytes @returns {string} lowercase hex SHA-256 */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Builds the manifest object from the vendored directory and the lockfile. Shared with check:vendor.
 * @param {string} root repository root
 * @returns {Promise<{ schema: string, packages: Record<string, { version: string, tarball: string, integrity: string, license: string, dir: string, files: Record<string, { sha256: string, bytes: number }> }> }>}
 */
export async function buildManifest(root = ROOT) {
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  /** @type {Record<string, any>} */
  const packages = {};
  for (const [name, plan] of Object.entries(VENDOR_PLAN)) {
    const entry = lock.packages?.[`node_modules/${name}`];
    if (!entry || entry.version !== plan.version) throw new Error(`package-lock.json does not pin ${name}@${plan.version}`);
    const dir = path.join(root, 'site', 'static', 'vendor', plan.dir);
    /** @type {Record<string, { sha256: string, bytes: number }>} */
    const files = {};
    for (const rel of plan.files) {
      const base = path.basename(rel);
      const bytes = await readFile(path.join(dir, base));
      files[base] = { sha256: sha256(bytes), bytes: bytes.length };
    }
    packages[name] = {
      version: plan.version,
      tarball: entry.resolved,
      integrity: entry.integrity,
      license: entry.license ?? 'unknown',
      dir: plan.dir,
      files,
    };
  }
  return { schema: 'cthd.vendor-manifest/1', packages };
}

/**
 * Copies the planned files out of node_modules and writes vendor/manifest.json.
 * @param {{ root?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function vendor(opts = {}) {
  const root = opts.root ?? ROOT;
  const outRoot = path.join(root, 'site', 'static', 'vendor');
  await mkdir(outRoot, { recursive: true });
  for (const [name, plan] of Object.entries(VENDOR_PLAN)) {
    const pkgDir = path.join(root, 'node_modules', name);
    const pkg = JSON.parse(await readFile(path.join(pkgDir, 'package.json'), 'utf8'));
    if (pkg.version !== plan.version) throw new Error(`node_modules/${name} is ${pkg.version}; the vendor plan pins ${plan.version}. Run npm ci.`);
    const dest = path.join(outRoot, plan.dir);
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    for (const rel of plan.files) await copyFile(path.join(pkgDir, rel), path.join(dest, path.basename(rel)));
  }
  // Remove vendored directories that are no longer in the plan (a version bump leaves the old folder).
  /** @type {Set<string>} */
  const keep = new Set([...Object.values(VENDOR_PLAN).map((p) => p.dir), 'manifest.json']);
  for (const name of await readdir(outRoot)) if (!keep.has(name)) await rm(path.join(outRoot, name), { recursive: true, force: true });
  const manifest = await buildManifest(root);
  await writeFile(path.join(outRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`vendor: wrote ${Object.keys(VENDOR_PLAN).length} packages and manifest.json`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await vendor();
}
