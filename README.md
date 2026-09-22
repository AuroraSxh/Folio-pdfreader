# Folio

[English](README.md) · [简体中文](README.zh-CN.md)

A desktop PDF reader for academic papers. Keep a paper and its supplements in one workspace, read them side by side, and discuss them with an embedded AI companion.

**AI assistance requires your own API key. No key is included, and offline reading needs no key.**

## Features

- Read main and supplementary PDFs side by side or stacked, with independent scrolling and zoom.
- Copy text, highlight, underline, strike through, and add comments. Undo edits and export annotated PDFs.
- Ask DeepSeek or another supported AI provider to explain passages and help with reading notes.
- Talk to the AI on Mac using Apple speech recognition and system voices. Voice is off by default. [Voice setup and tutorial](docs/apple-voice.md#english-guide)
- Export notes to Obsidian or Markdown. Papers, annotations, and notes stay on your computer.
- Switch between English and Chinese, and check GitHub for updates from the app.

## Download

[Latest release](https://github.com/AuroraSxh/Folio-pdfreader/releases/latest)

| Platform | Version | Download |
| --- | --- | --- |
| macOS 13+, Apple Silicon / Intel | 0.4.1 | [Universal DMG](https://github.com/AuroraSxh/Folio-pdfreader/releases/download/v0.4.1/Folio-0.4.1-mac-universal.dmg) |
| Windows 10 / 11, x64 | 0.3.0 | [Installer](https://github.com/AuroraSxh/Folio-pdfreader/releases/download/v0.3.0/Folio-0.3.0-windows-x64-setup.exe) · [Portable](https://github.com/AuroraSxh/Folio-pdfreader/releases/download/v0.3.0/Folio-0.3.0-windows-x64-portable.exe) |

On Mac, open the DMG and drag Folio into Applications. To update, quit the old version and replace it. Your papers and notes are kept.

Mac builds are not Developer ID signed or notarized; Windows builds are unsigned. Tested on Apple Silicon. Intel Mac has not been tested on hardware, and Windows packages have only passed static checks.

## Update history

<!-- Add every release to both READMEs, newest first. Keep earlier entries. -->

| Version | Changes |
| --- | --- |
| [0.4.1](https://github.com/AuroraSxh/Folio-pdfreader/releases/tag/v0.4.1) | Better mixed-language speech and scientific term pronunciation; shorter spoken citations, separate Chinese/English voices, and voice previews. Voice stays off until started. Includes a setup tutorial and deletion of individual question-and-answer exchanges. |
| [0.4.0](https://github.com/AuroraSxh/Folio-pdfreader/releases/tag/v0.4.0) | Mac voice conversations using Apple speech recognition and system voices, with a shared text history and controls that stay available when the AI panel is hidden. |
| [0.3.0](https://github.com/AuroraSxh/Folio-pdfreader/releases/tag/v0.3.0) | English and Chinese UI, menus, and note exports; GitHub update checks and verified installer downloads. |
| [0.2.2](https://github.com/AuroraSxh/Folio-pdfreader/releases/tag/v0.2.2) | Add comments to selected text from the context menu; edit or delete annotations, with undo. First GitHub release. |
| 0.2.1 | Drag the floating AI companion and remember its position. |
| 0.2.0 | Compact navigation, floating AI panel, focus mode, underlines, strikethroughs, and undo/redo. |
| 0.1.0 | Initial reader: paper workspaces, split PDFs with independent zoom, AI assistance, and Obsidian export. |

## Development

Node.js 24 and npm are required. Mac builds also use Xcode Command Line Tools with the macOS 26 SDK to build the native speech helper. See [Mac voice support](docs/apple-voice.md).

```bash
npm ci
npm run dev
```

```bash
npm run build       # Production build
npm test            # Unit tests
npm run test:locale # Language and update UI checks
npm run test:voice  # Voice UI checks with simulated speech and AI
npm run test:chat-deletion # Delete-exchange UI and persistence checks
npm run dist:dmg    # Universal Mac DMG; build on a Mac
npm run dist:win    # Windows x64 installer and portable app
```

Built with Electron, React, TypeScript, and PDF.js. [Performance testing](scripts/PERFORMANCE.md)

## License

All rights reserved; no open-source license is granted. See [LICENSE](LICENSE). Third-party components retain their own licenses: [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt).
