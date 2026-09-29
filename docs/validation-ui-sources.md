# App text size and source navigation

Validated for Pairleaf v0.5.1 on macOS on 2026-09-29, first using the production bundle in a development Electron launch, then repeating the 14 source-navigation checks against the final universal Mac application.

- `npm run build`: TypeScript and production build passed.
- `npm test`: 185 tests passed, including settings persistence, citation parsing, exact source matching, bilingual prompts, speech citation filtering, and Markdown export.
- `npm run test:sources`: 14 integration checks passed with generated PDFs and persisted fixture answers, real PDF.js, preload, IPC, and disk storage.
- `npm run test:reading`: 20 checks passed.
- `npm run test:locale`: 6 checks passed.
- `npm run test:voice`: 13 checks passed with simulated speech and AI.

The source tests check draft cancellation, saved font size after restart, independent PDF scale, main/supplement/unopened-document navigation, multiline source geometry through zoom and rotation, multiple source choices, keyboard activation, text selection, and a delayed document-switch race. Temporary highlights do not enter the annotation list. Missing excerpts and legacy page-only references fall back to their cited page.

At 150%, the measured answer text increased from 11 px to 16.5 px. Both PDF pages remained 600 × 800 CSS pixels with 1200 × 1600 canvases; sampled PDF text remained 16 px. Fullwidth citation separators also have a real GFM table parser regression test.

One 3-second idle sample with two synthetic PDFs and the AI panel open reported approximately 0.47% summed process CPU through Electron's `app.getAppMetrics()`. The GPU process accounted for approximately 0.25% CPU in that sample; this is **not** hardware GPU utilization. This small fixture is a smoke check, not a large-paper performance benchmark. Source matching runs on navigation/render events without continuous polling.

Test artifacts are generated under the ignored `test-results/` directory. These runs used isolated profiles and no real API credentials, microphone input, or cloud AI responses. The new features have not been tested on Windows hardware.

Release package checks:

- Universal Mac binary contains arm64 and x86_64 slices; strict code-signature and DMG integrity verification passed.
- Windows installer and portable builds passed 7 static checks; 211 common packaged build files matched the final production build byte for byte. Windows speech helper matched its expected checksum.
- Gitleaks found no secrets in publishable source, either extracted app archive, or decoded main/preload source-map contents. Package allowlists exclude user settings, libraries, test artifacts and SDK/build caches.
- Platform-specific license archives and SHA-256 checksums accompany the release. Identical Folio-named installers preserve updates from pre-rename clients.
