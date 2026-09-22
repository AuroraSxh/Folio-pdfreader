import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cached = path.join(root, '.cache/dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
const dotnet = process.env.FOLIO_DOTNET || (existsSync(cached) ? cached : 'dotnet');
const cache = path.join(root, '.cache/windows-speech-tests');
const obj = path.join(cache, 'obj') + path.sep;
const bin = path.join(cache, 'bin');
await mkdir(cache, { recursive: true });
const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_NOLOGO: '1',
  DOTNET_CLI_HOME: path.join(root, '.cache/dotnet-cli'), NUGET_PACKAGES: path.join(root, '.cache/nuget/packages') };
function run(args) {
  const result = spawnSync(dotnet, args, { cwd: root, stdio: 'inherit', env, shell: false });
  if (result.error) throw new Error('Tests require the .NET 10 SDK (or FOLIO_DOTNET).', { cause: result.error });
  if (result.status !== 0) process.exit(result.status || 1);
}
run(['build', path.join(root, 'native/windows-speech/Tests/ProtocolTests.csproj'), '-c', 'Release', '--nologo', '--disable-build-servers',
  '--output', bin, `-p:BaseIntermediateOutputPath=${obj}`, `-p:MSBuildProjectExtensionsPath=${obj}`]);
run([path.join(bin, 'ProtocolTests.dll')]);
