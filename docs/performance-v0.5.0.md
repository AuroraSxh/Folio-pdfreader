# Pairleaf 0.5.0 performance check

Tested on Apple M1 Pro with 10 logical cores and 16 GiB RAM. The final Mac universal app used two synthetic PDFs (100 + 40 pages), an isolated profile, and no AI requests or microphone.

App ASAR SHA-256: `45e4e5276383b6838a33ca55a806e557f2083da95c68e5403b5ba3f838a2df23`.

| Stage | Mean CPU | Summed working set |
| --- | ---: | ---: |
| closed-idle | 0.763% | 1018.9 MiB |
| closed-pdf-scroll | 9.396% | 1032.9 MiB |
| overlay-idle | 3.087% | 1065.4 MiB |

CPU is summed across this app instance; 100% means one logical core. Working sets can double-count shared pages and are not private memory. Each stage is eight seconds after warm-up; this is not a long-duration memory or energy test.

Only stages with all eight samples in the foreground are included above. Focus changed during overlay scrolling and both docked stages, so those results are excluded from foreground comparisons; the test did not repeatedly reclaim focus. System-wide GPU counters included other applications and cannot establish Pairleaf GPU usage.

The real Apple speech helper was absent at startup, appeared for a voice-capability query, and exited after its two-second idle timeout. This checks idle lifecycle, not recording or playback performance.

Windows CPU/GPU use and actual speech-device behavior have not been measured. Windows checks here were cross-build/static and simulated-device tests only.

Local reports: `test-results/v0.5.0-release/performance-reading-layout.json` and `native-ipc.json` (generated files are not committed).
