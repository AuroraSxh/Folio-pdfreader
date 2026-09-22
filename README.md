# Folio

[English](README.md) · [简体中文](README.zh-CN.md)

A desktop PDF reader for academic papers. Keep a paper and its supplements in one workspace, read them side by side, and discuss them with an embedded AI companion.

**AI assistance requires your own API key. No key is included, and offline reading needs no key.**

## Features

- Read main and supplementary PDFs side by side or stacked, with independent scrolling and zoom.
- Copy text, highlight, underline, strike through, and add comments. Undo edits and export annotated PDFs.
- Ask DeepSeek or another supported AI provider to explain passages and help with reading notes.
- Export notes to Obsidian or Markdown. Papers, annotations, and notes stay on your computer.

## Download

[Latest release](https://github.com/AuroraSxh/Folio-pdfreader/releases/latest)

| Platform | v0.2.2 |
| --- | --- |
| macOS 13+, Apple Silicon / Intel | [Universal DMG](https://github.com/AuroraSxh/Folio-pdfreader/releases/download/v0.2.2/Folio-0.2.2-mac-universal.dmg) |
| Windows 10 / 11, x64 | [Installer](https://github.com/AuroraSxh/Folio-pdfreader/releases/download/v0.2.2/Folio-0.2.2-windows-x64-setup.exe) · [Portable](https://github.com/AuroraSxh/Folio-pdfreader/releases/download/v0.2.2/Folio-0.2.2-windows-x64-portable.exe) |

On Mac, open the DMG and drag Folio into Applications. To update, quit the old version and replace it. Your papers and notes are kept.

Mac builds are not Developer ID signed or notarized; Windows builds are unsigned. Tested on Apple Silicon. Intel Mac has not been tested on hardware, and Windows packages have only passed static checks.

## Development

Node.js 24 and npm are required.

```bash
npm ci
npm run dev
```

```bash
npm run build       # Production build
npm test            # Unit tests
npm run dist:dmg    # Universal Mac DMG; build on a Mac
npm run dist:win    # Windows x64 installer and portable app
```

Built with Electron, React, TypeScript, and PDF.js. [Performance testing](scripts/PERFORMANCE.md)

## License

All rights reserved; no open-source license is granted. See [LICENSE](LICENSE). Third-party components retain their own licenses: [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt).
