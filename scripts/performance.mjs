// Real Electron load test. Run `node scripts/performance.mjs --label baseline`
// after `npm run build`. No keys, cloud APIs, or existing library are used.
import { _electron as electron } from 'playwright';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const labelArg = process.argv.indexOf('--label');
const label = (labelArg >= 0 ? process.argv[labelArg + 1] : 'current')?.replace(/[^a-zA-Z0-9_-]/g, '') || 'current';
const appPathArg = process.argv.indexOf('--app-path');
const appPath = appPathArg >= 0 ? path.resolve(process.argv[appPathArg + 1]) : process.cwd();
const out = path.resolve('test-results');
const fixtures = path.join(out, 'performance-fixtures');
await mkdir(fixtures, { recursive: true });
const userData = await mkdtemp(path.join(os.tmpdir(), 'folio-performance-'));
const round = value => Math.round(value * 100) / 100;
const summary = values => values.length ? { mean: round(values.reduce((a, b) => a + b, 0) / values.length), max: round(Math.max(...values)), min: round(Math.min(...values)) } : null;

// A deterministic raster scientific figure. Generate locally without a canvas,
// display server, model, or network; reuse image XObjects as real papers do.
function chartPng(seed) {
  const width = 1600, height = 650;
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) pixels[y * (width * 3 + 1)] = 0;
  const pixel = (x, y, color) => { if (x < 0 || y < 0 || x >= width || y >= height) return; const i = y * (width * 3 + 1) + 1 + x * 3; pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2]; };
  const line = (x1, y1, x2, y2, color) => { const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)); for (let n = 0; n <= steps; n++) pixel(Math.round(x1 + (x2 - x1) * n / steps), Math.round(y1 + (y2 - y1) * n / steps), color); };
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let panel = 0; panel < 3; panel++) {
    const left = 50 + panel * 530, bottom = 590;
    for (let tick = 0; tick < 6; tick++) line(left, bottom - tick * 100, left + 450, bottom - tick * 100, [225, 230, 224]);
    line(left, 35, left, bottom, [70, 80, 73]); line(left, bottom, left + 450, bottom, [70, 80, 73]);
    for (let dot = 0; dot < 5500; dot++) {
      const x = Math.round(left + 10 + random() * 430);
      const y = Math.round(bottom - 25 - ((x - left) / 440 * 320 + random() * 150));
      const color = dot % 3 === 0 ? [93, 74, 126] : dot % 2 === 0 ? [75, 125, 102] : [187, 143, 77];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) pixel(x + dx, y + dy, color);
    }
  }
  const crc = buffer => { let result = 0xffffffff; for (const byte of buffer) { result ^= byte; for (let bit = 0; bit < 8; bit++) result = (result >>> 1) ^ ((result & 1) ? 0xedb88320 : 0); } return (result ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const name = Buffer.from(type); const len = Buffer.alloc(4), check = Buffer.alloc(4); len.writeUInt32BE(data.length); check.writeUInt32BE(crc(Buffer.concat([name, data]))); return Buffer.concat([len, name, data, check]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function makePaper(name, pages, supplement) {
  const destination = path.join(fixtures, name);
  try { await stat(destination); return destination; } catch { /* First run creates deterministic fixtures. */ }
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const figures = await Promise.all([11, 29, 51, 83].map(seed => pdf.embedPng(chartPng(seed))));
  pdf.setTitle(supplement ? 'Synthetic Supplementary Evidence: 40 pages' : 'Synthetic Academic Rendering Study: 100 pages');
  pdf.setAuthor('Folio performance fixture; synthetic data, not a scientific study');
  const lines = [
    'We evaluate reproducibility using matched reference samples.',
    'Independent replication supports the reported observation.',
    'The conditional response varies with exposure and context.',
    'A controlled analysis estimates uncertainty in each cohort.',
    'Supplementary methods describe additional validation data.',
    'Regression coefficients were compared across all conditions.',
    'The synthetic study presents no real scientific conclusion.',
    'Sensitivity analysis checks robustness to selection effects.',
  ];
  for (let n = 1; n <= pages; n++) {
    const page = pdf.addPage([595, 842]);
    page.drawText(supplement ? 'SUPPLEMENTARY EVIDENCE' : 'SYNTHETIC ACADEMIC RENDERING STUDY', { x: 43, y: 802, size: 13, font: bold, color: rgb(.2, .32, .25) });
    page.drawText(`Section ${Math.ceil(n / 10)} / page ${n} / performance fixture / no real research findings`, { x: 43, y: 778, size: 8, font });
    for (let column = 0; column < 2; column++) for (let row = 0; row < 49; row++) {
      const text = `${lines[(row + n + column) % lines.length]} ${n}.${row + 1}`;
      page.drawText(text, { x: 43 + column * 262, y: 753 - row * 9.15, size: 7.6, font, color: rgb(.19, .21, .2) });
    }
    page.drawImage(figures[n % figures.length], { x: 43, y: 82, width: 508, height: 206 });
    page.drawText(`Figure ${n}. Three synthetic scatter panels rendered from a 1600 x 650 pixel raster.`, { x: 43, y: 64, size: 8, font });
    page.drawText(`FOLIO PERFORMANCE FIXTURE - ${String(n).padStart(3, '0')}`, { x: 43, y: 34, size: 7, font });
  }
  await writeFile(destination, await pdf.save());
  return destination;
}

const paths = await Promise.all([makePaper('Academic-stress-main-100.pdf', 100, false), makePaper('Supplement-stress-40.pdf', 40, true)]);
const report = {
  label, timestamp: new Date().toISOString(), platform: process.platform, arch: process.arch,
  hardware: { cpu: os.cpus()[0]?.model, logicalCores: os.cpus().length, systemMemoryGiB: round(os.totalmem() / 1024 ** 3), macOSKernel: os.release() },
  methodology: {
    api: 'Electron app.getAppMetrics, primed before every stage, approximately 1 second intervals',
    cpu: 'Primary CPU % uses cumulativeCPUUsage seconds delta / wall-clock seconds delta ×100 (100% = one logical CPU core, Activity Monitor convention). Electron percentCPUUsage is also retained as whole-machine normalized CPU %. All app processes are summed. GPU-process CPU is CPU activity, not GPU utilization.',
    memory: 'workingSetSize is KiB; tables convert to MiB and sum processes. Shared pages may be counted more than once; this is not private memory or a memory-leak proof.',
    gpu: 'ioreg AGXAccelerator PerformanceStatistics Device Utilization % is SYSTEM-WIDE Apple GPU activity, including unrelated apps/WindowServer. No per-app GPU attribution is available from this API.',
    isolation: 'fresh temporary FOLIO_USER_DATA; no real API requests; app shown/foregrounded initially; focus recorded per sample; local fixtures generated before measurement and reused between runs (filesystem cache is not cleared)',
    interaction: 'Both panes scroll by 540 logical pixels every 450ms for 12 seconds; zoom alternates page-width and 100% every fourth iteration. A separate 8s 200%-zoom stage exercises large-canvas limits; an 8s cached-workspace reopen stage checks repeat indexing.',
    limits: 'One short synthetic workload per build on a shared desktop. Recovery is sampled for 27 seconds (the original 12 seconds plus 15 seconds settling); settledLast8SamplesCPUPercent separately records the final eight samples. Peak CPU means maximum one-second average, not an instantaneous hardware peak. No power/energy or long-duration leak guarantee.',
    references: ['https://www.electronjs.org/docs/latest/api/structures/cpu-usage', 'https://www.electronjs.org/docs/latest/api/structures/memory-info'],
  },
  fixtures: await Promise.all(paths.map(async file => ({ file: path.basename(file), pages: file.includes('100') ? 100 : 40, bytes: (await stat(file)).size, sha256: createHash('sha256').update(await readFile(file)).digest('hex') }))),
  buildSha256: createHash('sha256').update(await readFile(path.join(appPath, 'dist-electron/main.cjs'))).update(await readFile(path.join(appPath, 'dist/index.html'))).digest('hex'),
  stages: [], failures: [], userData,
};

async function systemGPU() {
  if (process.platform !== 'darwin') return { available: false, reason: 'Apple AGX counters are macOS-specific' };
  try {
    const { stdout } = await exec('ioreg', ['-r', '-c', 'AGXAccelerator', '-d', '1', '-l'], { timeout: 2000, maxBuffer: 2 * 1024 * 1024 });
    const match = stdout.match(/"Device Utilization %"\s*=\s*([\d.]+)/);
    return match ? { available: true, scope: 'system-wide', percent: Number(match[1]) } : { available: false, reason: 'AGX utilization counter not exposed on this Mac' };
  } catch (error) { return { available: false, reason: error.message }; }
}

let app, page;
try {
  const env = { ...process.env, FOLIO_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  app = await electron.launch({ args: [appPath], env });
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.failures.push(error.message));
  await page.getByRole('button', { name: '体验示例工作区' }).waitFor();
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(1500, 960); win.show(); win.focus(); });
  report.runtime = await app.evaluate(({ app, screen }) => ({ versions: process.versions, gpuFeatures: app.getGPUFeatureStatus(), displays: screen.getAllDisplays().map(display => ({ size: display.size, scaleFactor: display.scaleFactor, internal: display.internal })) }));

  let previousCapture;
  async function capture() {
    const settled = await Promise.allSettled([app.evaluate(({ app, BrowserWindow }) => ({ time: Date.now(), metrics: app.getAppMetrics(), focused: BrowserWindow.getAllWindows().some(window => window.isFocused()), visible: BrowserWindow.getAllWindows().some(window => window.isVisible()) })), systemGPU()]);
    if (settled[0].status !== 'fulfilled') throw settled[0].reason;
    const current = settled[0].value;
    const processes = current.metrics.map(metric => {
      const previous = previousCapture?.metrics.find(item => item.pid === metric.pid && item.creationTime === metric.creationTime);
      const cumulativeAvailable = Number.isFinite(previous?.cpu.cumulativeCPUUsage) && Number.isFinite(metric.cpu.cumulativeCPUUsage) && current.time > previousCapture.time;
      const coreCPU = cumulativeAvailable ? (metric.cpu.cumulativeCPUUsage - previous.cpu.cumulativeCPUUsage) / ((current.time - previousCapture.time) / 1000) * 100 : metric.cpu.percentCPUUsage * os.cpus().length;
      return { pid: metric.pid, type: metric.type, name: metric.name || metric.serviceName || metric.type, cpuPercent: Math.max(0, coreCPU), cpuDerivation: cumulativeAvailable ? 'cumulativeCPUSeconds delta / wall seconds ×100' : 'normalized percent × logical CPUs fallback', machineCPUPercent: metric.cpu.percentCPUUsage, cumulativeCPUSeconds: metric.cpu.cumulativeCPUUsage, idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond, workingSetMiB: metric.memory.workingSetSize / 1024, peakWorkingSetMiB: metric.memory.peakWorkingSetSize / 1024 };
    });
    previousCapture = current;
    return { time: current.time, focused: current.focused, visible: current.visible, processes, totalCPUPercent: processes.reduce((n, item) => n + item.cpuPercent, 0), totalMachineCPUPercent: processes.reduce((n, item) => n + item.machineCPUPercent, 0), totalWorkingSetMiB: processes.reduce((n, item) => n + item.workingSetMiB, 0), systemGPU: settled[1].status === 'fulfilled' ? settled[1].value : { available: false, reason: String(settled[1].reason) } };
  }

  async function stage(name, milliseconds, action) {
    console.log(`START ${name}`);
    await capture(); // prime cumulative deltas and discard first-call zeros
    const start = Date.now(), samples = [];
    let done = !action, actionError;
    const task = action ? action().then(() => { done = true; }).catch(error => { done = true; actionError = error; }) : Promise.resolve();
    while (Date.now() - start < milliseconds || !done) {
      if (Date.now() - start > 40000) throw new Error(`Stage ${name} exceeded 40 second limit`);
      await sleep(1000); samples.push(await capture());
    }
    await task; if (actionError) throw actionError;
    const types = [...new Set(samples.flatMap(sample => sample.processes.map(item => item.type)))];
    const result = {
      name, durationSeconds: round((Date.now() - start) / 1000), sampleCount: samples.length,
      focusedSampleCount: samples.filter(sample => sample.focused).length,
      visibleSampleCount: samples.filter(sample => sample.visible).length,
      cpuPercent: summary(samples.map(sample => sample.totalCPUPercent)),
      settledLast8SamplesCPUPercent: summary(samples.slice(-8).map(sample => sample.totalCPUPercent)),
      machineCPUPercent: summary(samples.map(sample => sample.totalMachineCPUPercent)),
      workingSetMiB: summary(samples.map(sample => sample.totalWorkingSetMiB)),
      systemwideGPUPercent: summary(samples.filter(sample => sample.systemGPU.available).map(sample => sample.systemGPU.percent)),
      byProcessType: Object.fromEntries(types.map(type => [type, { cpuPercent: summary(samples.map(sample => sample.processes.filter(item => item.type === type).reduce((n, item) => n + item.cpuPercent, 0))), workingSetMiB: summary(samples.map(sample => sample.processes.filter(item => item.type === type).reduce((n, item) => n + item.workingSetMiB, 0))) }])),
      samples,
    };
    report.stages.push(result);
    console.log(`DONE ${name}: CPU mean/max ${result.cpuPercent.mean}/${result.cpuPercent.max}%; memory mean/max ${result.workingSetMiB.mean}/${result.workingSetMiB.max} MiB; SYSTEM GPU mean/max ${result.systemwideGPUPercent?.mean ?? 'n/a'}/${result.systemwideGPUPercent?.max ?? 'n/a'}%`);
    await writeFile(path.join(out, `performance-${label}.json`), JSON.stringify(report, null, 2));
    return result;
  }

  await sleep(2000);
  await stage('empty-library-idle', 8000);
  await stage('import-and-index-140-pages', 10000, async () => {
    const start = Date.now();
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, paths);
    await page.getByRole('button', { name: /^导入论文/ }).click();
    let workspace;
    while (Date.now() - start < 35000) {
      workspace = (await page.evaluate(() => window.folio.bootstrap())).workspaces[0];
      if (workspace?.documents.length === 2 && workspace.documents.every(doc => doc.textStatus === 'ready' && doc.pageCount > 0)) break;
      await sleep(200);
    }
    if (!workspace?.documents.every(doc => doc.textStatus === 'ready') || !workspace.documents.some(doc => doc.pageCount === 100) || !workspace.documents.some(doc => doc.pageCount === 40)) throw new Error(`Indexing not ready after 35s: ${JSON.stringify(workspace?.documents.map(doc => ({ pages: doc.pageCount, status: doc.textStatus })))}`);
    if (!workspace.layout.split) await page.getByTitle('切换分栏 · ⌘ \\', { exact: true }).click();
    await page.locator('.pdf-pane').nth(1).locator('.textLayer span').first().waitFor({ state: 'attached' });
    report.importToDualReadySeconds = round((Date.now() - start) / 1000);
    report.documentPageCounts = workspace.documents.map(doc => doc.pageCount);
  });
  await sleep(2500);
  await stage('dual-pane-ready-idle', 10000);
  await page.screenshot({ path: path.join(out, `performance-${label}.png`) });
  await stage('dual-pane-scroll-and-zoom', 12000, async () => {
    const start = Date.now(); let step = 0;
    while (Date.now() - start < 12000) {
      await page.locator('.pdf-viewer-container').evaluateAll(elements => elements.forEach(element => element.scrollBy({ top: 540, behavior: 'instant' })));
      if (step % 4 === 0) {
        const zooms = page.getByRole('combobox', { name: '缩放比例', exact: true });
        for (let i = 0; i < await zooms.count(); i++) await zooms.nth(i).selectOption(step % 8 === 0 ? '1' : 'page-width');
      }
      step++; await sleep(450);
    }
    report.scrollIterations = step;
  });
  await stage('idle-recovery-after-interaction', 27000);
  await stage('dual-pane-200-percent-zoom', 8000, async () => {
    const zooms = page.getByRole('combobox', { name: '缩放比例', exact: true });
    for (let i = 0; i < await zooms.count(); i++) await zooms.nth(i).selectOption('2');
    const start = Date.now();
    while (Date.now() - start < 7500) {
      await page.locator('.pdf-viewer-container').evaluateAll(elements => elements.forEach(element => element.scrollBy({ top: 360, behavior: 'instant' })));
      await sleep(500);
    }
  });
  await stage('200-percent-zoom-idle-recovery', 8000);
  report.highZoomVisibleState = await page.evaluate(() => ({ canvases: document.querySelectorAll('.pdf-pane canvas').length, renderedPixelCount: [...document.querySelectorAll('.pdf-pane canvas')].reduce((sum, canvas) => sum + canvas.width * canvas.height, 0), largestCanvasPixels: Math.max(...[...document.querySelectorAll('.pdf-pane canvas')].map(canvas => canvas.width * canvas.height)), scales: [...document.querySelectorAll('select[aria-label="缩放比例"]')].map(select => select.value) }));
  await stage('reopen-cached-workspace', 8000, async () => {
    const workspace = (await page.evaluate(() => window.folio.bootstrap())).workspaces[0];
    await page.getByTitle('返回论文库', { exact: true }).click();
    const start = Date.now();
    await page.getByRole('button', { name: `打开 ${workspace.title}`, exact: true }).click();
    await page.locator('.pdf-pane').nth(1).locator('.textLayer span').first().waitFor({ state: 'attached' });
    report.cachedReopenToRenderedSeconds = round((Date.now() - start) / 1000);
  });
  report.finalVisibleState = await page.evaluate(() => ({ canvases: document.querySelectorAll('.pdf-pane canvas').length, renderedPixelCount: [...document.querySelectorAll('.pdf-pane canvas')].reduce((sum, canvas) => sum + canvas.width * canvas.height, 0), pageInputs: [...document.querySelectorAll('input[aria-label="当前页码"]')].map(input => input.value) }));
} catch (error) { report.failures.push(error.stack || String(error)); process.exitCode = 1; }
finally { if (app) await app.close().catch(error => report.failures.push(error.message)); }

const rows = report.stages.map(stage => `| ${stage.name} | ${stage.durationSeconds} | ${stage.cpuPercent.mean} / ${stage.cpuPercent.max}% | ${stage.machineCPUPercent.mean} / ${stage.machineCPUPercent.max}% | ${stage.workingSetMiB.mean} / ${stage.workingSetMiB.max} | ${stage.systemwideGPUPercent ? `${stage.systemwideGPUPercent.mean} / ${stage.systemwideGPUPercent.max}%` : 'unavailable'} |`);
let markdown = `# Folio measured performance — ${label}\n\n${report.timestamp} · ${report.hardware.cpu} · ${report.hardware.logicalCores} logical cores · ${report.hardware.systemMemoryGiB} GiB RAM\n\nWorkload: 100-page main PDF + 40-page supplement, 98 lines of dense text and one 1600 × 650 raster chart on each page. Fresh library; no AI API requests. Import to both panes ready: ${report.importToDualReadySeconds ?? 'failed'} s.\n\n| Stage | Seconds | App CPU mean / max (100% = 1 core) | Machine CPU mean / max | Working set MiB mean / max | SYSTEM GPU mean / max |\n|---|---:|---:|---:|---:|---:|\n${rows.join('\n')}\n\nPrimary CPU uses cumulative CPU seconds delta / wall seconds × 100, summed across processes: **100% means one logical CPU core**. Machine CPU is Electron's whole-machine normalized percentage, approximately ${report.hardware.logicalCores}× smaller on this ${report.hardware.logicalCores}-core Mac. These include the GPU process's **CPU** activity, not GPU utilization. GPU counters are **system-wide**, include other applications and WindowServer, and cannot be attributed to Folio. Summed working sets can double-count shared pages. One short synthetic run cannot establish long-duration stability or battery impact.\n\nElectron metric definitions: [CPUUsage](https://www.electronjs.org/docs/latest/api/structures/cpu-usage), [MemoryInfo](https://www.electronjs.org/docs/latest/api/structures/memory-info).\n\nHarness / renderer errors: ${report.failures.length ? report.failures.join('\n') : 'none'}.\n`;
const recovery = report.stages.find(stage => stage.name === 'idle-recovery-after-interaction')?.settledLast8SamplesCPUPercent;
if (recovery) markdown += `\nSettled recovery, final eight samples of 27 seconds: CPU mean ${recovery.mean}%, maximum ${recovery.max}% (100% = one core).\n`;
await writeFile(path.join(out, `performance-${label}.json`), JSON.stringify(report, null, 2));
await writeFile(path.join(out, 'performance.json'), JSON.stringify(report, null, 2));
await writeFile(path.join(out, `performance-${label}.md`), markdown);
await writeFile(path.join(out, 'performance.md'), markdown);
const settled = report.stages.find(stage => stage.name === 'idle-recovery-after-interaction')?.settledLast8SamplesCPUPercent;
if (settled) console.log(`Settled recovery (final 8 samples of 27 seconds): CPU mean/max ${settled.mean}/${settled.max}% of one core`);
console.log(markdown);
