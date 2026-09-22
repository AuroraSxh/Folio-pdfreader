# Performance measurement

Published summaries describe specific historical Mac builds, not the performance of every release or platform:

- [v0.4.0 reading layout and native speech checks](../docs/performance-v0.4.0.md)
- [v0.2.1 floating assistant and drag measurement](../docs/performance-v0.2.1.md)
- [v0.2.0 reading-layout measurement](../docs/performance-v0.2.0.md)
- [Earlier rendering optimization and foreground checks](../docs/performance.md)

Dates, hardware, focus verification, and measurement limitations are included in each report. Raw samples, screenshots, temporary libraries, and generated PDFs are local run artifacts; they are not included in the source repository.

## Reading-layout harness

[`performance-reading-layout.mjs`](performance-reading-layout.mjs) launches a real Electron app with a fresh temporary library and no API keys or AI requests. It compares closed AI, a floating glass panel, and a docked panel, with idle and scrolling stages. Each stage is sampled for eight seconds. `FOLIO_PERF_DRAG=1` adds eight seconds of title dragging and eight seconds after release.

Prepare these synthetic fixtures before running; the layout harness expects existing files and does not generate them:

- `Academic-stress-main-100.pdf`: 100 pages.
- `Supplement-stress-40.pdf`: 40 pages.

Historical fixtures used two columns of dense text and a 1600 × 650 raster chart on each page, with synthetic data. Their generation code is in the setup section of [`performance.mjs`](performance.mjs). The fixture directory defaults to `test-results/performance-fixtures`; `FOLIO_PERF_FIXTURES` can select another directory. Fresh checkouts do not contain these generated PDFs. Different fixtures or builds must be reported as a new measurement, rather than treated as an exact reproduction of the historical numbers.

With fixtures prepared, build the app and run while the desktop is otherwise idle:

```sh
npm ci
npm run build
FOLIO_PERF_DRAG=1 \
FOLIO_PERF_OUTPUT=test-results/performance-current.json \
node scripts/performance-reading-layout.mjs
```

Set `FOLIO_EXECUTABLE` to a packaged executable to test that build instead of the current development build. On macOS, this is `Folio.app/Contents/MacOS/Folio` inside the application bundle. The JSON output records build and fixture hashes, per-process samples, focus state, canvas counts, and errors. Keep the app in the foreground; avoid concurrent GUI tests, builds, screen recording, or other graphics workloads. The scripts operate their own test windows and use isolated temporary data.

## Historical harnesses

[`performance.mjs`](performance.mjs) generated the fixtures and measured eight stages: empty library, import/index, dual-pane idle, scrolling and zooming, idle recovery, 200% zoom scrolling, high-zoom recovery, and reopening a cached workspace. Its command-line options are `--label <name>` and `--app-path <saved-build-directory>`. Output names are `test-results/performance-<label>.json`, `.md`, and `.png`; unlabelled `performance.json` and `performance.md` contain the latest run.

[`performance-focused.mjs`](performance-focused.mjs) was a targeted foreground check of the earlier packaged app. It retains that build's expected package path and UI selectors. Both historical harnesses may need path or selector adjustments for newer builds; they are retained to document the original method, not as a promise that a fresh checkout can reproduce old results unchanged.

For a before/after comparison, preserve each build's `dist`, `dist-electron`, and `package.json` together, use identical fixtures, and run the builds sequentially. Record any focus differences. The OS file cache is not cleared; a single fixed-order comparison is a regression check, not a statistical benchmark.

## Metric definitions

- CPU is calculated from cumulative process CPU-seconds divided by elapsed wall time: **100% equals one logical core**, as in macOS Activity Monitor. Electron's machine-normalized percentage is a separate metric. The GPU process's CPU usage is CPU work, not GPU utilization.
- Memory is the sum of process working sets, converted from KiB to MiB. Shared pages may be counted more than once, so this is not the application's private physical footprint.
- On supported Apple Silicon Macs, `ioreg` reports **system-wide** AGX device utilization. It includes WindowServer and other applications and cannot establish Folio's individual GPU use. Unsupported counters must be reported as unavailable. No per-app GPU attribution or elevated privileges are assumed.
- Maximum CPU is the highest approximately one-second interval average. These workloads do not measure battery drain, energy use, every kind of PDF, Windows performance, or long-duration memory stability.

Field definitions: [Electron CPUUsage](https://www.electronjs.org/docs/latest/api/structures/cpu-usage) and [MemoryInfo](https://www.electronjs.org/docs/latest/api/structures/memory-info).
