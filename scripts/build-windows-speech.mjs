import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cached = path.join(root, '.cache', 'dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
const dotnet = process.env.FOLIO_DOTNET || (existsSync(cached) ? cached : 'dotnet');
const cache = path.join(root, '.cache', 'windows-speech');
const output = path.join(cache, 'bin');
const intermediate = path.join(cache, 'obj') + path.sep;
const destination = path.join(root, 'dist-electron', 'windows-speech');
await mkdir(cache, { recursive: true });
const result = spawnSync(dotnet, ['build', path.join(root, 'native/windows-speech/PairleafSpeech.csproj'),
  '--configuration', 'Release', '--nologo', '--disable-build-servers', '--output', output,
  `-p:BaseIntermediateOutputPath=${intermediate}`, `-p:MSBuildProjectExtensionsPath=${intermediate}`], {
  cwd: root, stdio: 'inherit', shell: false,
  env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_NOLOGO: '1', DOTNET_CLI_HOME: path.join(root, '.cache/dotnet-cli'), NUGET_PACKAGES: path.join(root, '.cache/nuget/packages') },
});
if (result.error) throw new Error('Windows speech compilation requires a .NET SDK. Install the official SDK or set FOLIO_DOTNET to its executable; it is not bundled in the app.', { cause: result.error });
if (result.status !== 0) process.exit(result.status || 1);
const executable = await readFile(path.join(output, 'PairleafSpeech.exe'));
const pe = executable.readUInt32LE(0x3c);
if (executable.toString('ascii', 0, 2) !== 'MZ' || executable.readUInt32LE(pe) !== 0x4550
  || executable.readUInt16LE(pe + 4) !== 0x8664 || executable.readUInt16LE(pe + 24) !== 0x20b
  || executable.readUInt32LE(pe + 24 + 112 + 14 * 8) === 0) throw new Error('Windows speech helper must be an x64 PE32+ managed executable.');
await mkdir(destination, { recursive: true });
for (const name of ['PairleafSpeech.exe', 'PairleafSpeech.exe.config']) await copyFile(path.join(output, name), path.join(destination, name));
console.log(`Windows speech helper built: ${path.relative(root, destination)} (x64 .NET Framework 4.8; Windows runtime testing still required)`);
