import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
if (process.platform !== 'darwin') { console.log(JSON.stringify({ status: 'skipped', reason: 'macOS only' })); process.exit(0); }
const { appleSpeechBuild } = await import('../../scripts/build-apple-speech.mjs');
const executable = path.join(appleSpeechBuild.bundle, 'Contents/MacOS/FolioSpeech');
const child = spawn(executable, ['--file-smoke', ...process.argv.slice(2)], { stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
