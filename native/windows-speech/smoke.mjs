import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// This script is deliberately Windows-only. The default path never opens a
// microphone or plays audio; device checks require explicit command-line flags.
if (process.platform !== 'win32') throw new Error('Run this smoke test in a real Windows session. Cross-platform fake tests are Tests/run.mjs.');
const args = process.argv.slice(2);
function option(name, fallback) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--helper' || args[i] === '--locale') { if (!args[++i]) throw new Error('Missing option value'); }
  else if (!['--listen', '--speak'].includes(args[i])) throw new Error('Unknown option: ' + args[i]);
}
const helper = path.resolve(option('--helper', 'dist-electron/windows-speech/PairleafSpeech.exe'));
const locale = option('--locale', 'en-US');
await access(helper); await access(helper + '.config');
const env = {};
for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'COMSPEC']) {
  const actual = Object.keys(process.env).find(name => name.toLowerCase() === key.toLowerCase());
  if (actual) env[actual] = process.env[actual];
}
const child = spawn(helper, [], { windowsHide: true, shell: false, stdio: 'pipe', env });
const pending = new Map(), events = [], waiters = new Set();
let buffer = '', closed = false;
const exited = new Promise(resolve => child.once('close', code => { closed = true; resolve(code); }));
child.stderr.resume();
child.stdout.setEncoding('utf8');
function fail(error) {
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear();
  for (const item of waiters) { clearTimeout(item.timer); item.reject(error); } waiters.clear();
}
child.on('error', fail);
child.once('close', () => fail(new Error('Speech helper exited')));
child.stdout.on('data', data => {
  buffer += data;
  if (Buffer.byteLength(buffer, 'utf8') > 1048576) { fail(new Error('Unexpectedly large helper output')); child.kill(); return; }
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { fail(new Error('Invalid helper JSON')); child.kill(); return; }
    if (message.event === true) {
      events.push(message);
      if (events.length > 4096) { fail(new Error('Too many speech events')); child.kill(); return; }
      for (const waiter of [...waiters]) {
        if (message.sessionId !== waiter.session) continue;
        if (message.type === 'error') { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.reject(new Error('Native speech error: ' + message.code)); }
        else if (message.type === waiter.type) { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(message); }
      }
    } else {
      const item = pending.get(message.id);
      if (item) { pending.delete(message.id); clearTimeout(item.timer); message.ok ? item.resolve(message.result) : item.reject(new Error('Native command error: ' + message.code)); }
    }
  }
});
function send(command, data = {}) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timed out: ' + command)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, command, ...data }) + '\n', error => { if (error) fail(error); });
  });
}
function waitEvent(session, type) {
  const existing = events.find(event => event.sessionId === session && (event.type === type || event.type === 'error'));
  if (existing) return existing.type === 'error' ? Promise.reject(new Error('Native speech error: ' + existing.code)) : Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const item = { session, type, resolve, reject };
    item.timer = setTimeout(() => { waiters.delete(item); reject(new Error('Timed out waiting for ' + type)); }, 30000);
    waiters.add(item);
  });
}
try {
  const capabilities = await send('capabilities', { locale });
  assert.equal(capabilities.engine, 'windows-speech');
  assert.equal(typeof capabilities.available, 'boolean');
  assert.equal(capabilities.needsModelDownload, false);
  assert.ok(Array.isArray(capabilities.locales) && Array.isArray(capabilities.voices));
  assert.ok(capabilities.voices.every(voice => /^windows\.sapi\.[a-f0-9]{64}$/.test(voice.id)));
  assert.equal(events.length, 0);
  assert.deepEqual(await send('stop-listening', { sessionId: 'not-active' }), { text: '' });
  await send('stop-speaking');
  console.log(JSON.stringify({ recognitionAvailable: capabilities.available, reason: capabilities.reason,
    recognitionLocales: capabilities.locales, voices: capabilities.voices.map(voice => ({ name: voice.name, language: voice.language })) }, null, 2));
  console.log('PASS protocol and capability checks (no microphone or playback requested)');
  if (args.includes('--listen')) {
    assert.ok(capabilities.available, 'The selected locale has no usable local dictation engine on this machine.');
    const sessionId = randomUUID();
    await send('listen', { sessionId, locale, allowModelDownload: false }); await waitEvent(sessionId, 'listening');
    console.log('Microphone is active for 8 seconds. Say a short question in ' + locale + '.');
    await delay(8000);
    const result = await send('stop-listening', { sessionId });
    assert.ok(typeof result.text === 'string' && result.text.trim().length > 0, 'No words recognized; confirm desktop microphone permission and the selected language.');
    const count = events.length; await delay(300);
    assert.equal(events.length, count, 'Recognition continued after stop');
    console.log('PASS microphone recognition and stop; transcript omitted from logs (' + result.text.length + ' characters)');
  }
  if (args.includes('--speak')) {
    const hasChinese = capabilities.voices.some(voice => voice.language === 'zh-CN');
    const hasEnglish = capabilities.voices.some(voice => voice.language === 'en-US');
    const segments = hasChinese && hasEnglish ? [
      { text: '这里讨论 ', locale: 'zh-CN' }, { text: 'CD 4 positive', locale: 'en-US' },
      { text: ' 细胞和 ', locale: 'zh-CN' }, { text: 'flox flox', locale: 'en-US' }, { text: ' 小鼠。', locale: 'zh-CN' },
    ] : [{ text: locale.startsWith('zh') ? '这是语音朗读测试。' : 'This is a speech playback test.', locale }];
    const sessionId = randomUUID();
    console.log('Explicit playback test: audio will play through the default output device.');
    await send('speak', { sessionId, locale, text: segments.map(segment => segment.text).join(''), segments, rate: 0.5 });
    await waitEvent(sessionId, 'speech-end');
    assert.equal(events.filter(event => event.sessionId === sessionId && event.type === 'speech-start').length, 1);
    assert.equal(events.filter(event => event.sessionId === sessionId && event.type === 'speech-end').length, 1);
    console.log('PASS one speech-start/end for playback session');
    const cancelled = randomUUID();
    await send('speak', { sessionId: cancelled, locale, text: segments.map(segment => segment.text).join('').repeat(20) });
    await waitEvent(cancelled, 'speech-start'); await send('stop-speaking', { sessionId: cancelled });
    const ended = await waitEvent(cancelled, 'speech-end'); assert.equal(ended.code, 'cancelled');
    console.log('PASS playback cancellation');
  }
  await send('shutdown');
  const exitCode = await Promise.race([exited, delay(5000, undefined, { ref: false }).then(() => { throw new Error('Helper did not exit after shutdown'); })]);
  assert.equal(exitCode, 0);
  console.log('PASS helper shutdown');
} finally {
  if (!closed) child.kill();
  fail(new Error('Smoke test finished'));
}
