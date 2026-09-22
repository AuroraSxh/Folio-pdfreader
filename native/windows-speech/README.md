# Windows system speech helper (experimental)

`PairleafSpeech.exe` uses Windows SAPI through .NET Framework 4.8 `System.Speech` for local dictation and text-to-speech. It needs no speech API key and makes no network requests. It does not use browser Web Speech, Azure Speech, WinRT dictation, or automatically download language models.

**Windows device testing has not been performed.** A successful cross-build or fake-device test is not evidence that recognition, microphone release, playback, or CPU usage works on a particular Windows installation. Windows 11's old Windows Speech Recognition interface is deprecated; the installed SAPI dictation engines vary. This helper does not promise recognition on every Windows 10/11 machine, including 24H2/25H2. Capability probing must succeed on the actual computer.

## Build and package

```sh
node scripts/build-windows-speech.mjs
node native/windows-speech/Tests/run.mjs
```

Build with an official .NET SDK, using `FOLIO_DOTNET` if it is not on PATH. The scripts also detect `.cache/dotnet/dotnet` (`dotnet.exe` on Windows). The protocol tests use the .NET 10 SDK. Downloads are not performed by these scripts. Restore uses Microsoft's pinned `Microsoft.NETFramework.ReferenceAssemblies.net48` 1.0.3 development package, allowing compilation on a Mac without installing Windows developer packs. Intermediate files, restored packages and SDK state stay under the ignored `.cache/` directory.

Only these build outputs belong in the Windows application's `resources/windows-speech/` directory:

- `dist-electron/windows-speech/PairleafSpeech.exe`
- `dist-electron/windows-speech/PairleafSpeech.exe.config`

The executable is x64 PE32+ managed code. It uses the installed Windows .NET Framework 4.8/4.8.1 runtime; the modern .NET SDK and reference assemblies are **build dependencies**, never shipped. Windows 10 1903 and newer include 4.8; Windows 11 includes 4.8 or 4.8.1. Older Windows installations require the framework separately. Missing runtime/process startup failure is reported by the Electron supervisor as `helper-unavailable`/`helper-exited`.

Keep this directory out of the generic ASAR files and all Mac resources. The helper has no app window and is spawned with `shell:false`, `windowsHide:true` and piped standard handles. Its environment needs normal Windows paths such as `SystemRoot`, `WINDIR`, `TEMP`, `TMP`, `USERPROFILE`, `APPDATA` and `LOCALAPPDATA`; do not forward API credentials. No installer registration, elevation or MSIX identity is needed.

## Protocol and lifecycle

One UTF-8 JSON object per line, using the same request, reply and event envelopes as the Apple helper. Supported commands are `capabilities`, `listen`, `stop-listening`, `speak`, `stop-speaking` and `shutdown`. Request/session IDs are bounded safe identifiers. Lines are limited to 1 MiB, transcript/speech text to 128 KiB. Speech accepts up to 256 segments whose text must concatenate exactly to top-level `text`; pause ranges from 0 to 0.5 seconds. No supplied speech text is interpreted as SSML.

`capabilities.available` means that a local recognizer for the requested locale actually loaded a dictation grammar. Probing never opens the microphone. It does not establish microphone permission. `locales` lists only successfully probed engines; `voices` remains available even if recognition is unavailable. `engine` is `windows-speech`, `needsModelDownload` is false. Missing/unloadable engines return `recognizer-unavailable`, an unavailable locale returns `unsupported-locale`. Installing a language feature might help, but cannot be promised to restore a missing SAPI engine.

Voice IDs are `windows.sapi.` plus SHA-256 of the native voice identifier. Only enabled installed SAPI voices are listed, all with quality `default`. The helper does not expose every OneCore/Narrator natural voice. Automatic selection prefers exact locale, then the same language, with the Windows default voice breaking ties. Explicit choices must still exist. The existing normalized rate uses 0.5 as the Windows default and maps to SAPI's integer rate range; the platforms' speech speeds are not acoustically identical.

Listening requires an explicit `listen` command. A session accumulates finalized phrases and replaces the current hypothesis. Recognition chooses one locale per session; automatic bilingual recognition is not promised. Stop returns the last cumulative transcription and invalidates callbacks before calling `RecognizeAsyncCancel` and disposing the recognizer. It does not wait for the user to finish another sentence. The final unfinished phrase may remain a hypothesis. The Electron supervisor's process timeout/kill is a backstop if a native engine hangs during disposal.

Only one listening or speaking session can exist. Synthesis uses one `SpeechSynthesizer` and one `PromptBuilder`, with safe voice/text sections for the mixed-language segments. It emits one `speech-start` and one `speech-end`. Cancellation clears playback and makes late callbacks inert. EOF and shutdown dispose any device resources. The normal supervisor exits an idle helper after two seconds; the standalone helper also exits after 30 seconds idle. There are no continuous audio meters, polling recognition loops, persisted recordings, transcripts, or telemetry.

## Real Windows smoke test

Default invocation is silent and does not access the microphone:

```powershell
node native/windows-speech/smoke.mjs --helper 'C:\path\resources\windows-speech\PairleafSpeech.exe' --locale en-US
```

It checks capabilities, empty stop commands and clean shutdown. A result with `recognitionAvailable:false` is a valid report of system capability, not a device test pass.

Explicit device tests (the first opens the microphone for eight seconds; the second plays audio):

```powershell
node native/windows-speech/smoke.mjs --helper 'C:\path\PairleafSpeech.exe' --locale zh-CN --listen
node native/windows-speech/smoke.mjs --helper 'C:\path\PairleafSpeech.exe' --locale zh-CN --speak
```

The playback test uses Chinese plus `CD 4 positive` / `flox flox` when both zh-CN and en-US SAPI voices are installed, and then tests cancellation. Recognition text is not printed. Independently confirm that Windows' microphone indicator goes off after stop/closing the app, playback stops immediately, permission denial is explained, helper idle exit occurs, and CPU/GPU remain low. Test language/voice absence, unplugged devices and current Windows 11 releases before calling Windows speech production-verified.

## Microsoft references

- [System.Speech recognition and resource disposal](https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.speechrecognitionengine?view=netframework-4.8.1)
- [Immediate recognition cancellation](https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.speechrecognitionengine.recognizeasynccancel?view=netframework-4.8.1)
- [PromptBuilder voice sections](https://learn.microsoft.com/en-us/dotnet/api/system.speech.synthesis.promptbuilder.startvoice?view=netframework-4.8.1)
- [.NET Framework reference assembly builds](https://learn.microsoft.com/en-us/dotnet/framework/migration-guide/reference-assemblies)
- [Framework versions supplied with Windows](https://learn.microsoft.com/en-us/dotnet/framework/install/on-windows-and-server)
- [Windows Speech Recognition deprecation](https://learn.microsoft.com/en-us/windows/whats-new/deprecated-features)
- [WinRT recognition requires MSIX identity and online dictation consent](https://learn.microsoft.com/en-us/windows/apps/develop/input/speech-recognition)

WinRT is not a drop-in fallback for this unpackaged installer/portable application, and its online dictation would change the local speech contract.
