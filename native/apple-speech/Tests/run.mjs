import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
if (process.platform !== 'darwin') { console.log('SKIP: Apple speech tests require macOS.'); process.exit(0); }
await import('../../../scripts/build-apple-speech.mjs');
const temporary = await mkdtemp(path.join(tmpdir(), 'folio-native-tests-'));
function run(command, args) { return new Promise((resolve, reject) => { const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', error = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; }); child.once('error', reject); child.once('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} failed: ${error || output}`))); }); }
try {
  const base = path.join(root, 'native/apple-speech');
  const sources = (await readdir(path.join(base, 'Sources'))).filter(name => name.endsWith('.swift')).map(name => path.join(base, 'Sources', name));
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  for (const test of ['ProtocolTests', 'LifecycleTests', 'SynthesisTests']) {
    const executable = path.join(temporary, test);
    const args = test === 'ProtocolTests' ? [path.join(base, 'Sources/Protocol.swift')] : ['-D', 'FOLIO_SPEECH_TESTS', '-framework', 'AppKit', '-framework', 'AVFoundation', '-framework', 'Speech', ...sources];
    await run('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-target', `${architecture}-apple-macos13.0`, ...args, path.join(base, 'Tests', `${test}.swift`), '-o', executable]);
    console.log(await run(executable, []));
  }
  const executable = path.join(root, 'dist-electron/apple-speech/Folio Speech.app/Contents/MacOS/FolioSpeech');
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let serial = 0;
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const lines = createInterface({ input: child.stdout }); child.stderr.resume();
  lines.on('line', line => { const message = JSON.parse(line); if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); } else assert.equal(message.event, true); });
  const timer = setTimeout(() => { child.kill('SIGTERM'); }, 20_000);
  const send = (command, fields = {}) => new Promise(resolve => { const id = String(++serial); pending.set(id, resolve); child.stdin.write(JSON.stringify({ id, command, ...fields }) + '\n'); });
  try {
    for (const locale of ['zh-CN', 'en-US']) {
      const response = await send('capabilities', { locale }); assert.equal(response.ok, true); const caps = response.result;
      assert.ok(['speech-analyzer', 'speech-recognizer', 'unsupported'].includes(caps.engine)); assert.ok(Array.isArray(caps.locales)); assert.ok(Array.isArray(caps.voices));
      assert.ok(caps.voices.every(voice => voice.id.startsWith('com.apple.') && !voice.language.includes('_'))); assert.ok(caps.locales.every(locale => !locale.includes('_')));
      assert.ok(caps.voices.every(voice => ['default', 'enhanced', 'premium'].includes(voice.quality)));
      const qualities = caps.voices.reduce((counts, voice) => { counts[voice.quality] = (counts[voice.quality] ?? 0) + 1; return counts; }, {});
      console.log(JSON.stringify({ test: 'readonly-capabilities', locale, available: caps.available, engine: caps.engine, needsModelDownload: caps.needsModelDownload, voices: caps.voices.length, qualities }));
    }
    assert.equal((await send('listen')).code, 'invalid-request');
    assert.equal((await send('speak', { sessionId: 'no-audio', text: '' })).code, 'invalid-request');
    assert.deepEqual((await send('stop-listening')).result, { text: '' }); assert.equal((await send('stop-speaking')).ok, true);
    assert.equal((await send('unknown')).code, 'invalid-request'); assert.equal((await send('shutdown')).ok, true);
    assert.deepEqual(await exited, { code: 0, signal: null });
    console.log('PASS: actual signed helper JSONL, read-only capabilities, invalid commands, idempotent stops, clean shutdown; no microphone or playback');
  } finally { clearTimeout(timer); lines.close(); if (child.exitCode === null) child.kill('SIGTERM'); }
} finally { await rm(temporary, { recursive: true, force: true }); }
