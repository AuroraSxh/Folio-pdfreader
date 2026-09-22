// About 60 seconds of isolated reading-layout profiling after import/warm-up.
// Run only when a foreground test has been scheduled. Never calls an AI provider.
// FOLIO_EXECUTABLE=/path/to/Folio -> packaged app; otherwise the current dist build.
// FOLIO_PERF_OUTPUT=/path/report.json (or an output directory).
// FOLIO_PERF_FIXTURES=/path/to/existing/performance-fixtures is optional.
// FOLIO_PERF_DRAG=1 adds an 8-second title drag and 8-second released idle stage.
import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

if (process.argv.includes('--help')) {
  console.log('Run after scheduling a foreground GUI test: node scripts/performance-reading-layout.mjs\nFOLIO_EXECUTABLE: packaged executable (optional; defaults to current dist)\nFOLIO_PERF_OUTPUT: JSON output file or directory\nFOLIO_PERF_FIXTURES: existing synthetic 100+40-page fixture directory\nFOLIO_PERF_DRAG=1: add 8-second title drag and 8-second released idle stages\nSix 8-second measurement stages plus setup; temporary profile; no AI requests.');
  process.exit(0);
}

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = process.env.FOLIO_EXECUTABLE ? path.resolve(process.env.FOLIO_EXECUTABLE) : undefined;
const includeDrag = process.env.FOLIO_PERF_DRAG === '1';
const outputArgument = path.resolve(process.env.FOLIO_PERF_OUTPUT || path.join(project, 'test-results/performance-reading-layout.json'));
const output = /\.json$/i.test(outputArgument) ? outputArgument : path.join(outputArgument, 'performance-reading-layout.json');
const fixtureFolder = path.resolve(process.env.FOLIO_PERF_FIXTURES || path.join(project, 'test-results/performance-fixtures'));
const files = ['Academic-stress-main-100.pdf', 'Supplement-stress-40.pdf'].map(name => path.join(fixtureFolder, name));
const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const round = value => Math.round(value * 1000) / 1000;
const stats = values => values.length ? { mean: round(values.reduce((a, b) => a + b, 0) / values.length), max: round(Math.max(...values)), min: round(Math.min(...values)) } : null;
const SAMPLE_COUNT = 8, SCROLL_STEPS = 16, SCROLL_PIXELS = 540, SCROLL_INTERVAL = 500;

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function buildIdentity() {
  if (executablePath) {
    const base = path.dirname(executablePath);
    const candidates = [path.resolve(base, '../Resources/app.asar'), path.join(base, 'resources/app.asar')];
    for (const file of candidates) {
      try { const info = await stat(file); return { type: 'packaged-asar', file, bytes: info.size, sha256: await sha256(file), executableSha256: await sha256(executablePath) }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    throw new Error('Cannot identify packaged app.asar beside FOLIO_EXECUTABLE; refusing an untraceable performance run.');
  }
  const artifacts = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) artifacts.push({ file: path.relative(project, file), sha256: await sha256(file) });
    }
  }
  await visit(path.join(project, 'dist')); await visit(path.join(project, 'dist-electron'));
  return { type: 'dist-tree', sha256: createHash('sha256').update(JSON.stringify(artifacts)).digest('hex'), files: artifacts };
}
async function systemGPU() {
  if (process.platform !== 'darwin') return { available: false, scope: 'system-wide', reason: 'Apple AGX counters require macOS' };
  try {
    const { stdout } = await exec('ioreg', ['-r', '-c', 'AGXAccelerator', '-d', '1', '-l'], { timeout: 2000, maxBuffer: 2 * 1024 ** 2 });
    const match = stdout.match(/"Device Utilization %"\s*=\s*([\d.]+)/);
    return match ? { available: true, scope: 'system-wide', percent: Number(match[1]) } : { available: false, scope: 'system-wide', reason: 'AGX utilization is not exposed' };
  } catch (error) { return { available: false, scope: 'system-wide', reason: error.message }; }
}
async function frontmostPID() {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await exec('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); String($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);'], { timeout: 2000 });
    return Number(stdout.trim()) || null;
  } catch { return null; }
}

await mkdir(path.dirname(output), { recursive: true });
const userData = await mkdtemp(path.join(os.tmpdir(), 'folio-reading-layout-performance-'));
const report = {
  timestamp: new Date().toISOString(), platform: process.platform, executablePath: executablePath || 'development Electron with current dist', userData, includeDrag,
  hardware: { cpu: os.cpus()[0]?.model, logicalCPUs: os.cpus().length, memoryGiB: round(os.totalmem() / 1024 ** 3), kernel: os.release() },
  methodology: {
    duration: `${includeDrag ? 'Eight' : 'Six'} 8-second measurement stages; layout transitions, import, and warm-up are timed separately. ${includeDrag ? 'Includes 16 seconds of title-drag/released-idle measurements.' : 'Usually approximately one minute plus import.'}`,
    phases: 'AI closed idle/scroll; glass overlay idle/scroll; docked panel without blur idle/scroll. Same two PDFs, fixed 100% zoom, same start page, 16 scroll steps × 540 CSS pixels per pane over 8 seconds.',
    ...(includeDrag ? { drag: 'Additional overlay title drag: 240 real Playwright pointer moves scheduled at 30 Hz over 8 seconds, then mouse release and 8 seconds idle. Only the panel moves; PDF geometry, CSS-style mutations, and every process CPU sample are retained. Programmatic pointer delivery and sampling add measurement overhead.' } : {}),
    cpu: 'Per-process cumulativeCPUUsage seconds delta / elapsed wall seconds ×100, summed. 100% = one logical CPU core. New/exited processes are disclosed; unavailable intervals are not invented. GPU-process CPU is CPU activity, not GPU utilization.',
    memory: 'Electron workingSetSize KiB converted to MiB and summed across this test instance. Shared pages can be double-counted. This is not private memory or a leak test.',
    gpu: 'ioreg AGX Device Utilization % measures SYSTEM-WIDE GPU activity, including WindowServer and every other application. It CANNOT be attributed to Folio.',
    isolation: 'Fresh FOLIO_USER_DATA, existing synthetic 100+40-page fixtures, no provider API keys, auto-summary and auto-memory disabled. Does not call AI or alter any user desktop preference.',
    focus: 'One initial activation only. Each sample records this window visibility/focus; native frontmost PID recorded at stage boundaries. Focus loss is reported and never corrected repeatedly.',
    caveats: 'Short fixed-order run on a shared desktop; caches are warmed, not cleared. Docking changes viewport width but not PDF zoom or scroll distance. Sampling has overhead. Thermal state, filesystem cache, and unrelated apps may influence results; this is not an energy or long-duration guarantee.',
  },
  stages: [], warnings: [], failures: [],
};
let application;
const runStart = performance.now();
try {
  report.build = await buildIdentity();
  report.fixtures = await Promise.all(files.map(async file => ({ file, bytes: (await stat(file)).size, sha256: await sha256(file) })));
  const env = { ...process.env, FOLIO_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  application = await electron.launch({ args: executablePath ? [] : [project], ...(executablePath ? { executablePath } : {}), env });
  const page = await application.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.failures.push(error.message));
  await page.getByRole('button', { name: '体验示例工作区' }).waitFor();
  report.runtime = await application.evaluate(({ app, BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0]; win.setSize(1500, 960); win.show(); win.focus(); app.focus({ steal: true });
    return { pid: process.pid, appPath: app.getAppPath(), versions: process.versions, gpuFeatures: app.getGPUFeatureStatus(), displayScaleFactors: screen.getAllDisplays().map(display => display.scaleFactor) };
  });
  // Native activation targets this exact test PID once; no global "open Folio" or repeated focus stealing.
  if (process.platform === 'darwin') {
    try {
      const script = `ObjC.import("AppKit"); const target=$.NSRunningApplication.runningApplicationWithProcessIdentifier(${Number(report.runtime.pid)}); String(target.isNil()?false:target.activateWithOptions(3));`;
      report.initialNativeActivation = (await exec('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 2000 })).stdout.trim();
    } catch (error) { report.warnings.push(`Initial native activation unavailable: ${error.message}`); }
  }
  await page.evaluate(async () => {
    const bootstrap = await window.folio.bootstrap();
    if (Object.values(bootstrap.settings.providers).some(provider => provider.hasKey || provider.apiKey)) throw new Error('Isolated performance profile unexpectedly contains a provider key');
    await window.folio.saveSettings({ ...bootstrap.settings, autoSummary: false, autoMemory: false });
  });
  const importStart = performance.now();
  await application.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, files);
  await page.getByRole('button', { name: /^导入论文/ }).click();
  let workspace;
  const deadline = performance.now() + 35000;
  while (performance.now() < deadline) {
    workspace = (await page.evaluate(() => window.folio.bootstrap())).workspaces[0];
    if (workspace?.documents.length === 2 && workspace.documents.every(doc => doc.textStatus === 'ready') && workspace.documents.some(doc => doc.pageCount === 100) && workspace.documents.some(doc => doc.pageCount === 40)) break;
    await delay(200);
  }
  assert(workspace?.documents.length === 2 && workspace.documents.every(doc => doc.textStatus === 'ready'), 'Both fixture indexes must be ready');
  assert.deepEqual(workspace.documents.map(doc => doc.pageCount).sort((a, b) => a - b), [40, 100]);
  if (!workspace.layout.split) {
    await page.getByRole('button', { name: '阅读布局', exact: true }).click();
    await page.getByRole('menuitemradio', { name: /纵向分割/ }).click();
  }
  await page.locator('.pdf-pane').nth(1).locator('.textLayer span').first().waitFor({ state: 'attached' });
  assert.equal(await page.locator('.pdf-pane').count(), 2);
  const zooms = page.getByRole('combobox', { name: '缩放比例', exact: true });
  for (let index = 0; index < await zooms.count(); index++) await zooms.nth(index).selectOption('1');
  report.importSeconds = round((performance.now() - importStart) / 1000);
  report.pageCounts = workspace.documents.map(doc => doc.pageCount);

  async function rendererState() {
    return page.evaluate(() => {
      const shell = document.querySelector('.assistant-shell');
      const style = shell ? getComputedStyle(shell) : null;
      const canvases = [...document.querySelectorAll('.pdf-pane canvas')];
      return {
        documentFocused: document.hasFocus(), visibility: document.visibilityState,
        reducedTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
        assistant: shell ? { className: shell.className, open: style.display !== 'none', backdropFilter: style.backdropFilter || style.webkitBackdropFilter, background: style.backgroundColor, width: shell.getBoundingClientRect().width, height: shell.getBoundingClientRect().height, left: shell.getBoundingClientRect().left, top: shell.getBoundingClientRect().top } : null,
        panes: [...document.querySelectorAll('.pdf-viewer-container')].map(element => ({ width: element.clientWidth, height: element.clientHeight, scrollTop: element.scrollTop, scrollLeft: element.scrollLeft })),
        scales: [...document.querySelectorAll('select[aria-label="缩放比例"]')].map(select => select.value),
        canvasCount: canvases.filter(canvas => canvas.width && canvas.height).length,
        canvasPixels: canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0),
        largestCanvasPixels: Math.max(0, ...canvases.map(canvas => canvas.width * canvas.height)),
      };
    });
  }
  async function setPanel(mode) {
    const toggle = page.getByRole('button', { name: '阅读伙伴', exact: true });
    const open = await toggle.getAttribute('aria-expanded') === 'true';
    if (mode === 'closed') { if (open) await toggle.click(); }
    else {
      if (!open) await toggle.click();
      await page.locator('.assistant-shell').waitFor({ state: 'visible' });
      const pin = page.getByRole('button', { name: mode === 'overlay' ? '取消固定阅读伙伴' : '固定阅读伙伴', exact: true });
      if (await pin.isVisible()) await pin.click();
      await page.locator(`.assistant-shell.is-${mode}`).waitFor({ state: 'visible' });
    }
    const state = await rendererState();
    if (mode === 'overlay' && !state.assistant.backdropFilter?.includes('blur(')) report.warnings.push('Overlay blur is not active; the system reduced-transparency preference may disable it. These samples do not measure a blurred overlay.');
    if (mode === 'docked') assert.equal(state.assistant.backdropFilter, 'none', 'Docked comparison must not apply backdrop blur');
  }
  async function setScroll(top) {
    await page.locator('.pdf-viewer-container').evaluateAll((elements, y) => elements.forEach(element => element.scrollTo({ top: y, left: 0, behavior: 'instant' })), top);
  }
  async function preparePhase(mode) {
    await setPanel(mode);
    // Touch the exact upcoming route outside the measured interval; keep normal cache limits.
    for (let step = 0; step <= SCROLL_STEPS; step++) { await setScroll(step * SCROLL_PIXELS); await delay(30); }
    await setScroll(0); await delay(1600);
  }
  async function capture() {
    const results = await Promise.allSettled([
      application.evaluate(({ app, BrowserWindow }) => ({ time: Date.now(), metrics: app.getAppMetrics(), focused: BrowserWindow.getAllWindows().some(win => win.isFocused()), visible: BrowserWindow.getAllWindows().some(win => win.isVisible()) })),
      systemGPU(),
    ]);
    if (results[0].status !== 'fulfilled') throw results[0].reason;
    return { ...results[0].value, systemGPU: results[1].status === 'fulfilled' ? results[1].value : { available: false, reason: String(results[1].reason) } };
  }
  async function stage(name, scrolling, interaction) {
    const before = await rendererState(), nativeBefore = await frontmostPID();
    let previous = await capture();
    const start = performance.now(), samples = [];
    let actionFailure;
    const action = (interaction ? interaction(start) : scrolling ? (async () => {
      for (let step = 1; step <= SCROLL_STEPS; step++) {
        await delay(start + (step - 1) * SCROLL_INTERVAL - performance.now());
        await setScroll(step * SCROLL_PIXELS);
      }
    })() : Promise.resolve()).catch(error => { actionFailure = error; });
    console.log(`START ${name} (${SAMPLE_COUNT}s)`);
    for (let index = 1; index <= SAMPLE_COUNT; index++) {
      await delay(start + index * 1000 - performance.now());
      const current = await capture(), seconds = (current.time - previous.time) / 1000;
      const processes = current.metrics.map(metric => {
        const prior = previous.metrics.find(value => value.pid === metric.pid && value.creationTime === metric.creationTime);
        const valid = prior && Number.isFinite(metric.cpu.cumulativeCPUUsage) && Number.isFinite(prior.cpu.cumulativeCPUUsage) && seconds > 0;
        const cpuSeconds = valid ? Math.max(0, metric.cpu.cumulativeCPUUsage - prior.cpu.cumulativeCPUUsage) : null;
        return { pid: metric.pid, creationTime: metric.creationTime, type: metric.type, cumulativeCPUSeconds: metric.cpu.cumulativeCPUUsage, intervalCPUSeconds: cpuSeconds, cpuPercent: cpuSeconds === null ? null : cpuSeconds / seconds * 100, workingSetMiB: metric.memory.workingSetSize / 1024 };
      });
      samples.push({ time: current.time, intervalSeconds: seconds, focused: current.focused, visible: current.visible, processes, systemGPU: current.systemGPU,
        cpuPercent: processes.reduce((sum, process) => sum + (process.cpuPercent ?? 0), 0), cpuSeconds: processes.reduce((sum, process) => sum + (process.intervalCPUSeconds ?? 0), 0),
        workingSetMiB: processes.reduce((sum, process) => sum + process.workingSetMiB, 0), missingCPUProcessCount: processes.filter(process => process.cpuPercent === null).length,
        exitedPIDs: previous.metrics.filter(prior => !current.metrics.some(metric => metric.pid === prior.pid && metric.creationTime === prior.creationTime)).map(process => process.pid),
      });
      previous = current;
    }
    await action; if (actionFailure) throw actionFailure;
    const duration = samples.reduce((sum, sample) => sum + sample.intervalSeconds, 0);
    const cpuSeconds = samples.reduce((sum, sample) => sum + sample.cpuSeconds, 0);
    const result = { name, scrolling, durationSeconds: round(duration), sampleCount: samples.length,
      focusedSampleCount: samples.filter(sample => sample.focused).length, visibleSampleCount: samples.filter(sample => sample.visible).length,
      nativeFrontmostPIDBefore: nativeBefore, nativeFrontmostPIDAfter: await frontmostPID(), before, after: await rendererState(),
      cpuSeconds: round(cpuSeconds), cpuPercent: { ...stats(samples.map(sample => sample.cpuPercent)), timeWeightedMean: round(cpuSeconds / duration * 100) },
      workingSetMiB: stats(samples.map(sample => sample.workingSetMiB)), systemwideGPUPercent: stats(samples.filter(sample => sample.systemGPU.available).map(sample => sample.systemGPU.percent)),
      scrollSteps: scrolling ? SCROLL_STEPS : 0, requestedScrollPixelsPerPane: scrolling ? SCROLL_STEPS * SCROLL_PIXELS : 0, samples,
    };
    if (result.focusedSampleCount !== samples.length) report.warnings.push(`${name}: focus changed during measurement; no focus restoration attempted.`);
    if (samples.some(sample => sample.missingCPUProcessCount || sample.exitedPIDs.length)) report.warnings.push(`${name}: process churn makes cumulative CPU an incomplete lower bound for some intervals.`);
    report.stages.push(result);
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(`DONE ${name}: CPU ${result.cpuPercent.timeWeightedMean}% of one core; working set ${result.workingSetMiB.mean} MiB; SYSTEM GPU ${result.systemwideGPUPercent?.mean ?? 'unavailable'}%`);
    return result;
  }
  const measurementStart = performance.now();
  for (const mode of ['closed', 'overlay', 'docked']) {
    await preparePhase(mode);
    await stage(`${mode}-idle`, false);
    await stage(`${mode}-pdf-scroll`, true);
  }
  if (includeDrag) {
    await preparePhase('overlay');
    const handle = page.getByRole('group', { name: '移动阅读伙伴', exact: true });
    await handle.waitFor({ state: 'visible' });
    const area = await page.locator('.reader-body').boundingBox();
    const shell = await page.locator('.assistant-shell').boundingBox();
    const header = await handle.boundingBox();
    assert(area && shell && header, 'Floating panel drag geometry must be visible');
    const offset = { x: 30, y: header.y - shell.y + header.height / 2 };
    const route = { left: area.x + 12, right: Math.max(area.x + 12, area.x + area.width - shell.width - 12), top: area.y + 12, bottom: Math.max(area.y + 12, area.y + area.height - shell.height - 12) };
    const beginDiagnostics = async () => page.evaluate(() => {
      const shell = document.querySelector('.assistant-shell');
      const diagnostics = { panelStyleMutations: 0, pointerMoves: 0 };
      const observer = new MutationObserver(records => { diagnostics.panelStyleMutations += records.length; });
      observer.observe(shell, { attributes: true, attributeFilter: ['style'] });
      const pointer = () => { diagnostics.pointerMoves++; };
      window.addEventListener('pointermove', pointer, { passive: true });
      window.__folioDragDiagnostics = { diagnostics, dispose: () => { observer.disconnect(); window.removeEventListener('pointermove', pointer); } };
    });
    const endDiagnostics = async () => page.evaluate(() => {
      const { diagnostics, dispose } = window.__folioDragDiagnostics;
      dispose(); delete window.__folioDragDiagnostics;
      return diagnostics;
    });
    await page.mouse.move(shell.x + offset.x, shell.y + offset.y);
    await beginDiagnostics();
    const drag = await stage('overlay-title-drag', false, async start => {
      await page.mouse.down();
      try {
        for (let step = 1; step <= 240; step++) {
          await delay(start + (step - 1) * 1000 / 30 - performance.now());
          const progress = step / 240;
          // Move right-to-left-to-right, with a small vertical excursion allowed by the viewport.
          const x = route.left + (route.right - route.left) * (1 + Math.cos(progress * Math.PI * 2)) / 2;
          const y = route.top + (route.bottom - route.top) * (1 - Math.cos(progress * Math.PI * 4)) / 2;
          await page.mouse.move(x + offset.x, y + offset.y);
        }
      } finally { await page.mouse.up(); }
    });
    drag.interaction = { kind: 'title-drag', scheduledPointerMoves: 240, targetHz: 30, route, ...(await endDiagnostics()) };
    assert(drag.interaction.panelStyleMutations > 0, 'Actual drag must change the floating panel position');
    assert.deepEqual(drag.after.panes.map(pane => [pane.width, pane.height, pane.scrollTop]), drag.before.panes.map(pane => [pane.width, pane.height, pane.scrollTop]), 'Dragging the overlay must not resize or scroll PDF panes');
    await beginDiagnostics();
    const released = await stage('overlay-released-idle', false);
    released.interaction = { kind: 'released-idle', ...(await endDiagnostics()) };
    if (released.interaction.pointerMoves) report.warnings.push('Pointer input occurred during released-idle sampling; treat that stage as user-interrupted.');
    if (released.interaction.panelStyleMutations) report.warnings.push('Floating-panel CSS styles changed during released-idle sampling; inspect raw activity before claiming idle stability.');
    report.dragComparison = { dragCPUPercent: drag.cpuPercent.timeWeightedMean, releasedCPUPercent: released.cpuPercent.timeWeightedMean, releasedStyleMutations: released.interaction.panelStyleMutations, releasedPointerMoves: released.interaction.pointerMoves };
  }
  report.measurementAndTransitionsSeconds = round((performance.now() - measurementStart) / 1000);
} catch (error) { report.failures.push(error.stack || String(error)); process.exitCode = 1; }
finally {
  // Close only the instance launched with this temporary profile; other Folio windows are untouched.
  if (application) await application.close().catch(error => { report.failures.push(`Test-instance close failed: ${error.message}`); process.exitCode = 1; });
  report.totalSeconds = round((performance.now() - runStart) / 1000);
  await writeFile(output, JSON.stringify(report, null, 2));
}
const rows = report.stages.map(stage => `| ${stage.name} | ${stage.cpuPercent.timeWeightedMean} / ${stage.cpuPercent.max} | ${stage.workingSetMiB.mean} / ${stage.workingSetMiB.max} | ${stage.systemwideGPUPercent ? `${stage.systemwideGPUPercent.mean} / ${stage.systemwideGPUPercent.max}` : 'unavailable'} | ${stage.focusedSampleCount}/${stage.sampleCount} |`);
const markdown = `# Folio reading layout measurements\n\n${report.timestamp}\n\nBuild: ${report.build?.type ?? 'unavailable'} SHA-256 ${report.build?.sha256 ?? 'unavailable'}. Synthetic 100-page PDF + 40-page supplement; 100% zoom; each scrolling stage requests 16 × 540 CSS pixels per pane. No AI requests or provider keys. Total runtime ${report.totalSeconds}s.\n\n| Stage | CPU weighted mean / max % (100%=one core) | Working set mean / max MiB | SYSTEM GPU mean / max % | Focused samples |\n|---|---:|---:|---:|---:|\n${rows.join('\n')}\n\nGPU figures cover the whole system and cannot be attributed to Folio. Working-set sums can double-count shared pages. This short fixed-order test does not establish battery impact or long-term memory stability. Full raw process samples, focus/visibility, canvas pixels, actual blur CSS, fixture and build hashes are in the JSON report.\n\nWarnings: ${report.warnings.length ? report.warnings.join('; ') : 'none'}.\n\nFailures: ${report.failures.length ? report.failures.join('; ') : 'none'}.\n`;
await writeFile(output.replace(/\.json$/i, '.md'), markdown);
console.log(`Report: ${output}`);
