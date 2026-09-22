import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = path.join(root, 'native/apple-speech');
const outputRoot = path.join(root, 'dist-electron/apple-speech');
const bundle = path.join(outputRoot, 'Folio Speech.app');
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '', stderr = '';
    child.stdout?.on('data', data => { stdout += data; }); child.stderr?.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} failed (${code}):\n${stderr || stdout}`)));
  });
}
async function files(directory) {
  const output = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(filename)); else if (entry.isFile()) output.push(filename);
  }
  return output;
}
export async function buildAppleSpeech() {
  if (process.platform !== 'darwin') return { skipped: true, reason: 'macOS only' };
  const [sdk, sdkVersion, compiler] = await Promise.all([run('xcrun', ['--show-sdk-path']), run('xcrun', ['--show-sdk-version']), run('xcrun', ['swiftc', '--version'])]);
  if (Number(sdkVersion.split('.')[0]) < 26) throw new Error('Building Folio Speech requires the macOS 26 SDK (Xcode/Command Line Tools 26+). The resulting helper supports macOS 13+.');
  const sources = (await files(path.join(sourceRoot, 'Sources'))).filter(file => file.endsWith('.swift'));
  const inputs = [...sources, ...await files(path.join(sourceRoot, 'Resources')), path.join(sourceRoot, 'entitlements.plist'), fileURLToPath(import.meta.url)];
  const digest = createHash('sha256').update(`${sdk}\n${sdkVersion}\n${compiler}\narm64,x86_64\nmacOS13.0`);
  for (const file of inputs) digest.update(file).update(await readFile(file));
  const fingerprint = digest.digest('hex'), cacheFile = path.join(outputRoot, '.build-cache.json');
  const cached = await readFile(cacheFile, 'utf8').then(JSON.parse).catch(() => null);
  if (cached?.fingerprint === fingerprint) {
    try { await run('codesign', ['--verify', '--strict', bundle]); await run('lipo', [path.join(bundle, 'Contents/MacOS/FolioSpeech'), '-verify_arch', 'arm64', 'x86_64']); return { bundle, cached: true }; } catch { /* Rebuild missing or invalid output. */ }
  }
  const temporary = await mkdtemp(path.join(tmpdir(), 'folio-speech-build-'));
  try {
    const stage = path.join(temporary, 'Folio Speech.app'), contents = path.join(stage, 'Contents');
    await mkdir(path.join(contents, 'MacOS'), { recursive: true }); await mkdir(path.join(contents, 'Resources'), { recursive: true });
    const binaries = await Promise.all(['arm64', 'x86_64'].map(async arch => {
      const output = path.join(temporary, `FolioSpeech-${arch}`);
      await run('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-O', '-target', `${arch}-apple-macos13.0`, '-sdk', sdk, '-framework', 'AppKit', '-framework', 'AVFoundation', '-framework', 'Speech', ...sources, '-o', output]);
      return output;
    }));
    await run('xcrun', ['lipo', '-create', ...binaries, '-output', path.join(contents, 'MacOS/FolioSpeech')]);
    await cp(path.join(sourceRoot, 'Resources/Info.plist'), path.join(contents, 'Info.plist'));
    for (const locale of ['en', 'zh-Hans']) await cp(path.join(sourceRoot, `Resources/${locale}.lproj`), path.join(contents, `Resources/${locale}.lproj`), { recursive: true });
    await run('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--timestamp=none', '--entitlements', path.join(sourceRoot, 'entitlements.plist'), stage]);
    await run('codesign', ['--verify', '--strict', stage]);
    await mkdir(outputRoot, { recursive: true });
    const old = path.join(outputRoot, `.old-${process.pid}.app`);
    await rename(bundle, old).catch(error => { if (error.code !== 'ENOENT') throw error; });
    try { await rename(stage, bundle); } catch (error) { await rename(old, bundle).catch(() => {}); throw error; }
    await rm(old, { recursive: true, force: true });
    await writeFile(cacheFile, JSON.stringify({ fingerprint, sdkVersion, target: 'macOS13.0', architectures: ['arm64', 'x86_64'] }) + '\n');
    console.log('Built Folio Speech.app (universal, macOS 13+).');
    return { bundle, cached: false };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
// Importing from build.mjs/dev.mjs is sufficient; module caching avoids duplicates.
export const appleSpeechBuild = await buildAppleSpeech();
