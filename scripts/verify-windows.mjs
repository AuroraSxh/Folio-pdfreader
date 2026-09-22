import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as asar from '@electron/asar';
import { NtExecutable, NtExecutableResource, Resource } from 'resedit';

const checks = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const packageInfo = JSON.parse(await readFile('package.json', 'utf8'));
const productName = packageInfo.build?.productName;
assert.ok(typeof productName === 'string' && productName.length > 0 && !/[\\/]/.test(productName), 'Expected a safe build.productName');
const root = path.resolve(packageInfo.build?.directories?.output || 'release');
const appFolder = path.join(root, 'win-unpacked');
const executableName = packageInfo.build?.win?.executableName || productName;
assert.ok(typeof executableName === 'string' && !/[\\/]/.test(executableName), 'Expected a safe Windows executable name');
const executablePath = path.join(appFolder, executableName + '.exe');
const executable = await readFile(executablePath);

function peLayout(buffer) {
  assert.ok(buffer.length >= 64, 'Truncated DOS header');
  assert.equal(buffer.toString('ascii', 0, 2), 'MZ');
  const offset = buffer.readUInt32LE(0x3c);
  assert.ok(offset >= 64 && offset + 24 <= buffer.length, 'PE header is outside the file');
  assert.equal(buffer.readUInt32LE(offset), 0x00004550);
  const optionalOffset = offset + 24, optionalSize = buffer.readUInt16LE(offset + 20), sectionCount = buffer.readUInt16LE(offset + 6);
  assert.ok(optionalSize >= 2 && optionalOffset + optionalSize + sectionCount * 40 <= buffer.length, 'Truncated PE optional header/section table');
  return { machine: buffer.readUInt16LE(offset + 4), magic: buffer.readUInt16LE(optionalOffset), optionalOffset, optionalSize, sectionCount, sectionOffset: optionalOffset + optionalSize };
}
function peHeader(buffer) {
  const { machine, magic } = peLayout(buffer);
  return { machine, magic };
}
function rvaOffset(buffer, pe, rva, size) {
  assert.ok(rva > 0 && size > 0, 'Empty managed PE data directory');
  for (let i = 0; i < pe.sectionCount; i++) {
    const section = pe.sectionOffset + i * 40;
    const virtualAddress = buffer.readUInt32LE(section + 12), rawSize = buffer.readUInt32LE(section + 16), rawOffset = buffer.readUInt32LE(section + 20);
    const delta = rva - virtualAddress;
    if (delta >= 0 && delta + size <= rawSize) {
      assert.ok(rawOffset + delta + size <= buffer.length, 'Managed PE data points outside the file');
      return rawOffset + delta;
    }
  }
  assert.fail('Managed PE data is not backed by a file section');
}

assert.deepEqual(peHeader(executable), { machine: 0x8664, magic: 0x20b });
pass(executableName + '.exe is a valid Windows x64 PE32+ executable');
const resources = NtExecutableResource.from(NtExecutable.from(executable));
const versions = Resource.VersionInfo.fromEntries(resources.entries);
assert.ok(versions.length > 0);
const strings = versions.flatMap(info => info.getAllLanguagesForStringValues().map(language => info.getStringValues(language)));
assert.ok(strings.some(value => value.ProductName === productName && value.FileVersion === packageInfo.version));
assert.ok(resources.entries.some(entry => entry.type === 14), 'Application icon group is missing');
assert.ok(resources.entries.some(entry => entry.type === 3), 'Application icon images are missing');
pass('Executable has ' + productName + ' product/version metadata and Windows icon resources');

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

assert.ok(!entries.some(file => /(?:^|\/)(?:apple-speech|windows-speech|(?:Folio|Pairleaf)Speech\.exe(?:\.config)?)(?:\/|$)/i.test(file)), 'Native speech helpers must be outside ASAR');
const packagedFiles = (await readdir(appFolder, { recursive: true })).map(file => file.replaceAll('\\', '/'));
const disallowed = /(?:^|\/)(?:apple-speech|(?:Folio|Pairleaf) Speech\.app|\.cache|\.build-cache\.json|dotnet|dotnet-cli|nuget|windows-speech-tests|obj)(?:\/|$)/i;
assert.ok(![...entries, ...packagedFiles].some(file => disallowed.test(file)), 'Mac speech helper or build/SDK cache entered the Windows package');
const helperDirectory = path.join(appFolder, 'resources', 'windows-speech');
assert.deepEqual((await readdir(helperDirectory)).sort(), ['PairleafSpeech.exe', 'PairleafSpeech.exe.config'], 'Windows speech resources must contain exactly the executable and configuration');
const helperPath = path.join(helperDirectory, 'PairleafSpeech.exe');
const helper = await readFile(helperPath), helperPE = peLayout(helper);
assert.deepEqual(peHeader(helper), { machine: 0x8664, magic: 0x20b });
assert.ok(helperPE.optionalSize >= 112 + 15 * 8, 'Managed x64 helper has no CLI data directory');
assert.ok(helper.readUInt32LE(helperPE.optionalOffset + 108) >= 15, 'Managed x64 helper has no CLI data directory');
const cliDirectory = helperPE.optionalOffset + 112 + 14 * 8;
const cliRva = helper.readUInt32LE(cliDirectory), cliSize = helper.readUInt32LE(cliDirectory + 4);
assert.ok(cliSize >= 72, 'Managed helper CLI header is too short');
const cli = rvaOffset(helper, helperPE, cliRva, cliSize);
assert.ok(helper.readUInt32LE(cli) >= 72 && helper.readUInt32LE(cli) <= cliSize, 'Invalid CLI header size');
assert.ok(helper.readUInt16LE(cli + 4) >= 2, 'Unsupported CLI runtime header');
const metadataSize = helper.readUInt32LE(cli + 12);
assert.ok(metadataSize >= 16, 'Managed helper metadata is missing');
const metadata = rvaOffset(helper, helperPE, helper.readUInt32LE(cli + 8), metadataSize);
assert.equal(helper.readUInt32LE(metadata), 0x424a5342, 'Missing CLR metadata signature');
const cliFlags = helper.readUInt32LE(cli + 16);
assert.equal(cliFlags & 1, 1, 'Speech helper must contain managed IL');
assert.equal(cliFlags & 2, 0, 'Speech helper must not require a 32-bit process');
const helperConfig = await readFile(helperPath + '.config', 'utf8');
assert.ok(!/<!DOCTYPE|<!ENTITY/i.test(helperConfig), 'Helper configuration cannot reference external XML entities');
const runtime = helperConfig.match(/<supportedRuntime\b[^>]*>/i)?.[0] || '';
assert.ok(/\bversion=["']v4\.0["']/.test(runtime) && /\bsku=["']\.NETFramework,Version=v4\.8["']/.test(runtime), 'Speech helper must select .NET Framework 4.8');
pass('Windows native speech helper/config are outside ASAR; helper has x64 PE32+, CLI/CLR metadata and .NET Framework 4.8 configuration');
pass('Windows package excludes Mac speech bundles and build/SDK caches');

const artifacts = [];
for (const variant of ['setup', 'portable']) {
  const target = variant === 'setup' ? 'nsis' : 'portable';
  const template = packageInfo.build?.[target]?.artifactName || packageInfo.build?.win?.artifactName || packageInfo.build?.artifactName;
  assert.equal(typeof template, 'string', 'Expected artifactName for ' + target);
  const variables = { productName, name: packageInfo.name, version: packageInfo.version, arch: 'x64', ext: 'exe', os: 'win' };
  const name = template.replace(/\$\{([^}]+)\}/g, (_match, variable) => {
    assert.ok(Object.hasOwn(variables, variable), 'Unsupported artifactName variable: ' + variable);
    return variables[variable];
  });
  assert.ok(name.endsWith('.exe') && !/[\\/]/.test(name) && !name.includes('${'), 'Expected a safe Windows artifact filename');
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
  productName, version: packageInfo.version,
  speechHelper: { bytes: helper.length, sha256: createHash('sha256').update(helper).digest('hex'), framework: '.NET Framework 4.8', architecture: 'x64' },
  windowsRuntimeTested: false,
  limitation: 'Static package verification only. Install, launch, native dialogs, DPAPI and device input still require a real Windows session.'
}, null, 2));
console.log('Windows packaging checks passed. This is not a Windows runtime test.');
