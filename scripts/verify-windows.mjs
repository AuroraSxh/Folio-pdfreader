import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as asar from '@electron/asar';
import { NtExecutable, NtExecutableResource, Resource } from 'resedit';

const checks = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const packageInfo = JSON.parse(await readFile('package.json', 'utf8'));
const root = path.resolve(packageInfo.build?.directories?.output || 'release');
const appFolder = path.join(root, 'win-unpacked');
const executablePath = path.join(appFolder, 'Folio.exe');
const executable = await readFile(executablePath);

function peHeader(buffer) {
  assert.equal(buffer.toString('ascii', 0, 2), 'MZ');
  const offset = buffer.readUInt32LE(0x3c);
  assert.equal(buffer.readUInt32LE(offset), 0x00004550);
  return { machine: buffer.readUInt16LE(offset + 4), magic: buffer.readUInt16LE(offset + 24) };
}

assert.deepEqual(peHeader(executable), { machine: 0x8664, magic: 0x20b });
pass('Folio.exe is a valid Windows x64 PE32+ executable');
const resources = NtExecutableResource.from(NtExecutable.from(executable));
const versions = Resource.VersionInfo.fromEntries(resources.entries);
assert.ok(versions.length > 0);
const strings = versions.flatMap(info => info.getAllLanguagesForStringValues().map(language => info.getStringValues(language)));
assert.ok(strings.some(value => value.ProductName === 'Folio' && value.FileVersion === packageInfo.version));
assert.ok(resources.entries.some(entry => entry.type === 14), 'Application icon group is missing');
assert.ok(resources.entries.some(entry => entry.type === 3), 'Application icon images are missing');
pass('Executable has Folio product/version metadata and Windows icon resources');

const archive = path.join(appFolder, 'resources', 'app.asar');
const entries = asar.listPackage(archive).map(entry => entry.replace(/^[/\\]/, '').replaceAll('\\', '/'));
for (const file of ['package.json', 'dist/index.html', 'dist-electron/main.cjs', 'dist-electron/preload.cjs']) {
  assert.ok(entries.includes(file), 'Missing packaged file: ' + file);
}
assert.ok(entries.some(file => /pdf\.worker.*\.mjs$/.test(file)));
for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
  assert.ok(entries.some(file => file.startsWith('dist/pdf-assets/' + folder + '/')));
}
const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString());
assert.equal(manifest.main, 'dist-electron/main.cjs');
assert.equal(manifest.version, packageInfo.version);
assert.ok(!entries.some(file => /(?:^|\/)(?:settings\.json|workspace\.json|\.env)$/.test(file)));
pass('ASAR includes main/preload, renderer and offline PDF assets, without user settings or article data');

const artifacts = [];
for (const variant of ['setup', 'portable']) {
  const name = 'Folio-' + packageInfo.version + '-windows-x64-' + variant + '.exe';
  const file = path.join(root, name);
  const buffer = await readFile(file);
  peHeader(buffer);
  const size = (await stat(file)).size;
  assert.ok(size > 10 * 1024 * 1024, 'Installer does not contain a full application payload');
  artifacts.push({ file, bytes: size, sha256: createHash('sha256').update(buffer).digest('hex') });
  pass(name + ' exists and has a valid executable header');
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/windows-package-report.json', JSON.stringify({
  timestamp: new Date().toISOString(), platform: process.platform, checks, artifacts,
  windowsRuntimeTested: false,
  limitation: 'Static package verification only. Install, launch, native dialogs, DPAPI and device input still require a real Windows session.'
}, null, 2));
console.log('Windows packaging checks passed. This is not a Windows runtime test.');
