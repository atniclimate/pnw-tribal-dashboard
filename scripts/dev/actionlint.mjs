// @ts-check
/**
 * Run actionlint over .github/workflows (blueprint 10.1; L0 and L9 acceptance).
 *
 * Looks for the actionlint binary in node_modules/.bin/ (where `node scripts/dev/actionlint.mjs --install`
 * places the official release for this platform, downloaded with the GitHub CLI) or on PATH. The binary is
 * never committed. CI installs it with the pinned release in ci.yml.
 *
 *   node scripts/dev/actionlint.mjs            lint
 *   node scripts/dev/actionlint.mjs --install  download the pinned release with `gh release download`
 *
 * Development tool. Owner: lane L0.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ACTIONLINT_VERSION = '1.7.12';
const BIN_DIR = path.join(ROOT, 'node_modules', '.bin');
const EXE = process.platform === 'win32' ? 'actionlint.exe' : 'actionlint';

function findBinary() {
  const local = path.join(BIN_DIR, EXE);
  if (existsSync(local)) return local;
  const probe = spawnSync(EXE, ['-version'], { encoding: 'utf8' });
  return probe.status === 0 ? EXE : null;
}

function install() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const ext = os === 'windows' ? 'zip' : 'tar.gz';
  const asset = `actionlint_${ACTIONLINT_VERSION}_${os}_${arch}.${ext}`;
  const tmp = path.join(ROOT, '.cache', 'actionlint');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const dl = spawnSync('gh', ['release', 'download', `v${ACTIONLINT_VERSION}`, '-R', 'rhysd/actionlint', '-p', asset, '-D', tmp], { stdio: 'inherit' });
  if (dl.status !== 0) throw new Error('gh release download failed; install actionlint manually');
  // Windows ships bsdtar, which reads zip archives; GNU tar from Git Bash does not. Relative names avoid
  // GNU tar reading a drive letter as a remote host.
  const winTar = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe');
  const tarBin = process.platform === 'win32' && existsSync(winTar) ? winTar : 'tar';
  const ex = spawnSync(tarBin, ['-xf', asset], { cwd: tmp, stdio: 'inherit' });
  if (ex.status !== 0) throw new Error('could not extract the actionlint archive');
  const found = readdirSync(tmp).find((n) => n === EXE);
  if (!found) throw new Error('actionlint binary not found in the archive');
  mkdirSync(BIN_DIR, { recursive: true });
  renameSync(path.join(tmp, found), path.join(BIN_DIR, EXE));
  console.log(`installed actionlint ${ACTIONLINT_VERSION} to node_modules/.bin/${EXE}`);
}

if (process.argv.includes('--install')) install();
const bin = findBinary();
if (!bin) {
  console.error('actionlint is not installed; run node scripts/dev/actionlint.mjs --install');
  process.exit(2);
}
const r = spawnSync(bin, ['-color'], { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
