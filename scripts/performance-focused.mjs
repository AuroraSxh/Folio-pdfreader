// Targeted packaged-app foreground idle check. Does not touch the user's library.
import { _electron as electron } from 'playwright';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const exec = promisify(execFile);
const round = value => Math.round(value * 100) / 100;
const summarize = values => ({ mean: round(values.reduce((sum, value) => sum + value, 0) / values.length), max: round(Math.max(...values)), min: round(Math.min(...values)) });
for (const [from, to] of [['performance-focused-previous.json', 'performance-focused-unfocused-electron.json'], ['performance-focused.json', 'performance-focused-unfocused-native.json']]) {
  try { const prior = JSON.parse(await readFile(`test-results/${from}`, 'utf8')); if (prior.focusedSampleCount === 0) await copyFile(`test-results/${from}`, `test-results/${to}`); } catch { /* Preserve available earlier attempts. */ }
}
const userData = await mkdtemp(path.join(os.tmpdir(), 'folio-focused-performance-'));
const executablePath = path.resolve('release/mac-arm64/Folio.app/Contents/MacOS/Folio');
const files = ['Academic-stress-main-100.pdf', 'Supplement-stress-40.pdf'].map(name => path.resolve('test-results/performance-fixtures', name));
const report = {
  timestamp: new Date().toISOString(), executablePath, userData,
  hardware: { cpu: os.cpus()[0]?.model, logicalCores: os.cpus().length, memoryGiB: os.totalmem() / 1024 ** 3 },
  methodology: 'Packaged app with isolated temporary data. Import 100+40 page PDFs, scroll both panes, zoom both to 200%, scroll again. User leaves desktop idle. Native PID-specific activation, initial dual-pane idle 8 samples, then scroll and 200% zoom; settle 5 seconds and collect 20 approximately one-second intervals. Each sample verifies BrowserWindow focus AND macOS frontmost PID. Any focus loss is recorded and requests reactivation for the next sample. CPU = cumulative process CPU seconds delta / wall seconds ×100; 100% means one logical core. Working sets summed in MiB may double-count shared pages. AGX device utilization is system-wide, never per-app GPU use. No AI API requests. Other normal Folio instance remains open; recorded PIDs belong only to this test instance.',
  executableSha256: createHash('sha256').update(await readFile(executablePath)).digest('hex'),
  samples: [], stages: [], focusRestorations: [], failures: [],
};
let application;
try {
  const env = { ...process.env, FOLIO_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  application = await electron.launch({ executablePath, args: [], env });
  const page = await application.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.failures.push(error.message));
  await page.getByRole('button', { name: '体验示例工作区' }).waitFor();
  const focus = () => application.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1500, 960); window.show(); window.focus(); app.focus({ steal: true });
    return { pid: process.pid, focused: window.isFocused(), visible: window.isVisible() };
  });
  report.initialFocus = await focus();
  console.log(`START packaged foreground check; isolated browser PID ${report.initialFocus.pid}`);
  const browserPID = Number(report.initialFocus.pid);
  const nativeFocus = async () => {
    await focus();
    const script = `ObjC.import("AppKit"); const target = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${browserPID}); JSON.stringify({exists:!target.isNil(),activated:target.isNil()?false:target.activateWithOptions(3),frontmostPID:$.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier});`;
    const activation = JSON.parse((await exec('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 5000 })).stdout);
    await delay(300);
    return { ...activation, focused: await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()) };
  };
  const capture = async () => {
    const results = await Promise.allSettled([
      application.evaluate(({ app, BrowserWindow }) => ({ time: Date.now(), metrics: app.getAppMetrics(), focused: BrowserWindow.getAllWindows().some(window => window.isFocused()), visible: BrowserWindow.getAllWindows().some(window => window.isVisible()) })),
      exec('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); String($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);'], { timeout: 3000 }),
      exec('ioreg', ['-r', '-c', 'AGXAccelerator', '-d', '1', '-l'], { timeout: 3000, maxBuffer: 2 * 1024 * 1024 }),
    ]);
    if (results[0].status !== 'fulfilled') throw results[0].reason;
    const frontmostPID = results[1].status === 'fulfilled' ? Number(results[1].value.stdout.trim()) : null;
    const match = results[2].status === 'fulfilled' ? results[2].value.stdout.match(/"Device Utilization %"\s*=\s*([\d.]+)/) : null;
    return { ...results[0].value, frontmostPID, verifiedForeground: results[0].value.focused && frontmostPID === browserPID, systemGPUPercent: match ? Number(match[1]) : null };
  };
  const sampleStage = async (name, count) => {
    let previous = await capture(); const samples = [];
    for (let index = 0; index < count; index++) {
      await delay(1000); const current = await capture();
      const processes = current.metrics.map(metric => {
        const before = previous.metrics.find(item => item.pid === metric.pid && item.creationTime === metric.creationTime);
        const cpu = before && Number.isFinite(metric.cpu.cumulativeCPUUsage) && Number.isFinite(before.cpu.cumulativeCPUUsage)
          ? (metric.cpu.cumulativeCPUUsage - before.cpu.cumulativeCPUUsage) / ((current.time - previous.time) / 1000) * 100
          : metric.cpu.percentCPUUsage * os.cpus().length;
        return { pid: metric.pid, type: metric.type, cpuPercent: Math.max(0, cpu), cumulativeCPUSeconds: metric.cpu.cumulativeCPUUsage, workingSetMiB: metric.memory.workingSetSize / 1024 };
      });
      samples.push({ time: current.time, focused: current.focused, frontmostPID: current.frontmostPID, verifiedForeground: current.verifiedForeground, visible: current.visible, systemGPUPercent: current.systemGPUPercent, cpuPercent: processes.reduce((sum, process) => sum + process.cpuPercent, 0), workingSetMiB: processes.reduce((sum, process) => sum + process.workingSetMiB, 0), processes });
      previous = current;
      if (!current.verifiedForeground) { report.focusRestorations.push({ stage: name, index, previousPID: current.frontmostPID, activation: await nativeFocus() }); previous = await capture(); }
      if ((index + 1) % 5 === 0) console.log(`${name} ${index + 1}/${count}; foreground=${current.verifiedForeground}; nativePID=${current.frontmostPID}; CPU=${round(samples.at(-1).cpuPercent)}%`);
    }
    const result = {
      name, samples, focusedSampleCount: samples.filter(sample => sample.focused).length,
      verifiedForegroundSampleCount: samples.filter(sample => sample.verifiedForeground).length, visibleSampleCount: samples.filter(sample => sample.visible).length,
      cpuPercent: summarize(samples.map(sample => sample.cpuPercent)), final10CPUPercent: summarize(samples.slice(-10).map(sample => sample.cpuPercent)),
      workingSetMiB: summarize(samples.map(sample => sample.workingSetMiB)),
      systemwideGPUPercent: samples.every(sample => sample.systemGPUPercent !== null) ? summarize(samples.map(sample => sample.systemGPUPercent)) : null,
      byProcessType: Object.fromEntries([...new Set(samples.flatMap(sample => sample.processes.map(process => process.type)))].map(type => [type, {
        cpuPercent: summarize(samples.map(sample => sample.processes.filter(process => process.type === type).reduce((sum, process) => sum + process.cpuPercent, 0))),
        workingSetMiB: summarize(samples.map(sample => sample.processes.filter(process => process.type === type).reduce((sum, process) => sum + process.workingSetMiB, 0))),
      }])),
    };
    report.stages.push(result);
    return result;
  };

  await application.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, files);
  await page.getByRole('button', { name: /^导入论文/ }).click();
  const importStarted = Date.now(); let workspace;
  while (Date.now() - importStarted < 35000) {
    workspace = (await page.evaluate(() => window.folio.bootstrap())).workspaces[0];
    if (workspace?.documents.length === 2 && workspace.documents.every(document => document.textStatus === 'ready') && workspace.documents.some(document => document.pageCount === 100) && workspace.documents.some(document => document.pageCount === 40)) break;
    await delay(200);
  }
  if (workspace?.documents.length !== 2 || !workspace.documents.every(document => document.textStatus === 'ready')) throw new Error('140-page index did not become ready');
  if (!workspace.layout.split) await page.getByTitle('切换分栏 · ⌘ \\', { exact: true }).click();
  await page.locator('.pdf-pane').nth(1).locator('.textLayer span').first().waitFor({ state: 'attached' });
  report.pageCounts = workspace.documents.map(document => document.pageCount);
  report.initialNativeActivation = await nativeFocus();
  console.log(`NATIVE START ${JSON.stringify(report.initialNativeActivation)}`);
  await delay(3000);
  await sampleStage('dual-pane-foreground-idle', 8);
  for (let step = 0; step < 18; step++) {
    await page.locator('.pdf-viewer-container').evaluateAll(elements => elements.forEach(element => element.scrollBy({ top: 540, behavior: 'instant' })));
    await delay(450);
  }
  const zooms = page.getByRole('combobox', { name: '缩放比例', exact: true });
  for (let i = 0; i < await zooms.count(); i++) await zooms.nth(i).selectOption('2');
  for (let step = 0; step < 8; step++) {
    await page.locator('.pdf-viewer-container').evaluateAll(elements => elements.forEach(element => element.scrollBy({ top: 360, behavior: 'instant' })));
    await delay(500);
  }
  await page.evaluate(() => {
    window.__folioIdleDiagnostics = { mutations: 0, pointermove: 0, wheel: 0, keydown: 0, scroll: 0 };
    new MutationObserver(records => { window.__folioIdleDiagnostics.mutations += records.length; }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    for (const type of ['pointermove', 'wheel', 'keydown', 'scroll']) document.addEventListener(type, () => { window.__folioIdleDiagnostics[type]++; }, { capture: true, passive: true });
  });
  report.preSampleFocus = await nativeFocus();
  console.log(`SETTLING 5s; native foreground ${JSON.stringify(report.preSampleFocus)}`);
  await delay(5000);
  const postZoom = await sampleStage('200-percent-foreground-recovery', 20);
  Object.assign(report, postZoom);
  report.rendererDiagnostics = await page.evaluate(() => ({ events: window.__folioIdleDiagnostics, documentFocused: document.hasFocus(), visibility: document.visibilityState, scales: [...document.querySelectorAll('select[aria-label="缩放比例"]')].map(select => select.value), pages: [...document.querySelectorAll('input[aria-label="当前页码"]')].map(input => input.value) }));
  await page.screenshot({ path: 'test-results/performance-focused.png' });
} catch (error) { report.failures.push(error.stack || String(error)); process.exitCode = 1; }
finally { if (application) await application.close().catch(error => report.failures.push(error.message)); }
try { await copyFile('test-results/performance-focused.json', 'test-results/performance-focused-previous.json'); } catch { /* First run. */ }
await writeFile('test-results/performance-focused.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ focused: `${report.focusedSampleCount}/${report.samples.length}`, verifiedForeground:report.verifiedForegroundSampleCount, stages:report.stages.map(({samples,byProcessType,...stage})=>stage), visible: report.visibleSampleCount, cpuPercent: report.cpuPercent, final10CPUPercent: report.final10CPUPercent, workingSetMiB: report.workingSetMiB, byProcessType: report.byProcessType, diagnostics: report.rendererDiagnostics, failures: report.failures }, null, 2));
