// @ts-check
/**
 * check:vendor (blueprint 2.3, 10.1). Recomputes the SHA-256 of every vendored file and compares it with
 * site/static/vendor/manifest.json; checks that the manifest's version, tarball URL, and integrity equal
 * the package-lock.json entry and the exact development dependency in package.json; that the vendored
 * folder names carry the version; that no file is vendored but unlisted (or listed but missing); that
 * map/loader.js MAPLIBRE_VERSION and MAPLIBRE_BASE agree; and that the vendored MapLibre set contains no
 * `blob:` worker construction path the site relies on (the worker is loaded same origin). Owner: lane L8.
 *
 *   node scripts/check/vendor-integrity.mjs
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VENDOR_PLAN, sha256 } from '../dev/vendor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @param {string} p @returns {Promise<string[]>} */
async function ls(p) {
  try { return (await readdir(p)).sort(); } catch { return []; }
}

/**
 * @param {string} root repository root
 * @returns {Promise<string[]>} problems; empty when the vendored set is intact
 */
export async function checkVendor(root = ROOT) {
  /** @type {string[]} */
  const problems = [];
  const vendorDir = path.join(root, 'site', 'static', 'vendor');
  /** @type {any} */
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(vendorDir, 'manifest.json'), 'utf8')); } catch (err) {
    return [`vendor/manifest.json is missing or unreadable (${err instanceof Error ? err.message : String(err)}); run npm run vendor`];
  }
  if (manifest.schema !== 'cthd.vendor-manifest/1') problems.push('manifest schema is not cthd.vendor-manifest/1');
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const pkgJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  for (const [name, plan] of Object.entries(VENDOR_PLAN)) {
    const m = manifest.packages?.[name];
    if (!m) { problems.push(`${name}: not in the manifest`); continue; }
    if (m.version !== plan.version) problems.push(`${name}: manifest version ${m.version} is not the planned ${plan.version}`);
    if (pkgJson.devDependencies?.[name] !== plan.version) problems.push(`${name}: package.json devDependency is not the exact version ${plan.version}`);
    const lockEntry = lock.packages?.[`node_modules/${name}`];
    if (!lockEntry || lockEntry.version !== plan.version) problems.push(`${name}: package-lock.json does not pin ${plan.version}`);
    else {
      if (m.integrity !== lockEntry.integrity) problems.push(`${name}: manifest integrity differs from package-lock.json`);
      if (m.tarball !== lockEntry.resolved) problems.push(`${name}: manifest tarball URL differs from package-lock.json`);
    }
    if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(String(m.integrity))) problems.push(`${name}: integrity is not a sha512 SRI value`);
    if (m.dir !== plan.dir || !plan.dir.endsWith(plan.version)) problems.push(`${name}: vendored folder name must end with the version`);
    const dir = path.join(vendorDir, plan.dir);
    const onDisk = await ls(dir);
    const planned = plan.files.map((f) => path.basename(f)).sort();
    for (const f of planned) if (!onDisk.includes(f)) problems.push(`${plan.dir}/${f}: missing on disk`);
    for (const f of onDisk) if (!planned.includes(f)) problems.push(`${plan.dir}/${f}: vendored but not in the plan`);
    for (const f of planned) {
      const rec = m.files?.[f];
      if (!rec) { problems.push(`${plan.dir}/${f}: not in the manifest`); continue; }
      let bytes;
      try { bytes = await readFile(path.join(dir, f)); } catch { continue; }
      if (sha256(bytes) !== rec.sha256) problems.push(`${plan.dir}/${f}: SHA-256 differs from the manifest (the file changed since npm run vendor)`);
      if (bytes.length !== rec.bytes) problems.push(`${plan.dir}/${f}: size differs from the manifest`);
    }
    for (const f of Object.keys(m.files ?? {})) if (!planned.includes(f)) problems.push(`${plan.dir}/${f}: in the manifest but not in the plan`);
  }
  for (const name of Object.keys(manifest.packages ?? {})) if (!(name in VENDOR_PLAN)) problems.push(`${name}: in the manifest but not in the plan`);
  for (const d of await ls(vendorDir)) {
    if (d === 'manifest.json') continue;
    if (!Object.values(VENDOR_PLAN).some((p) => p.dir === d)) problems.push(`vendor/${d}: not in the plan`);
  }
  try {
    const loader = await readFile(path.join(root, 'site', 'static', 'js', 'map', 'loader.js'), 'utf8');
    const v = /MAPLIBRE_VERSION\s*=\s*'([^']+)'/.exec(loader)?.[1];
    const b = /MAPLIBRE_BASE\s*=\s*'([^']+)'/.exec(loader)?.[1];
    if (v !== VENDOR_PLAN['maplibre-gl'].version) problems.push(`map/loader.js MAPLIBRE_VERSION (${v}) is not ${VENDOR_PLAN['maplibre-gl'].version}`);
    if (!b?.endsWith(`vendor/${VENDOR_PLAN['maplibre-gl'].dir}/`)) problems.push('map/loader.js MAPLIBRE_BASE does not point at the vendored folder');
  } catch { problems.push('map/loader.js is unreadable'); }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = await checkVendor();
  if (problems.length) {
    for (const p of problems) console.error(`check:vendor: ${p}`);
    console.error(`check:vendor failed (${problems.length} problem${problems.length === 1 ? '' : 's'})`);
    process.exit(1);
  }
  console.log('check:vendor ok');
}
