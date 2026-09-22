# Folio Apple speech helper

The signed accessory application provides JSONL over stdin/stdout. Its executable is
`dist-electron/apple-speech/Folio Speech.app/Contents/MacOS/FolioSpeech`. It has no windows, Dock icon, status item, idle polling, automatic microphone start, or transcript logging. Speech is handled by Apple frameworks; no DeepSeek key enters this process.

## Build and package

Import `scripts/build-apple-speech.mjs` from the development/build entry point, or run it with Node. It is a no-op outside macOS. Building requires Swift 6.2 and the macOS 26 SDK; the universal arm64/x86_64 helper targets macOS 13. Source, SDK and compiler fingerprints skip unchanged rebuilds. Both architectures and the existing signature are verified before a cached output is reused.

Copy the `apple-speech` directory into the Mac application's Resources using `mac.extraResources`; exclude it from generic app files/Windows packaging. Launch the executable directly using argument arrays, with piped stdin/stdout. Include microphone and Speech usage descriptions on the parent application too, because macOS can attribute consent to the responsible parent process. The helper supplies its own descriptions in English and Simplified Chinese. Its ad-hoc signature enables hardened runtime with the audio-input entitlement. Release signing must preserve that entitlement.

## Protocol

Commands have a string `id` and `command`: `capabilities`, `listen`, `stop-listening`, `speak`, `stop-speaking`, `shutdown`. Optional fields are `sessionId`, `locale`, `text`, `voiceId`, `rate`, `segments`, and `allowModelDownload`. JSONL input is bounded to 1 MiB. `listen` and `speak` require a nonempty session id. Recognition and playback are mutually exclusive; a new session must stop the previous one. Native rate is 0.1–1.0, default 0.5. Voice ids must match installed Apple `com.apple.*` voices.

`speak` may contain 1–256 `segments`: `{text,locale,voiceId?,pauseAfter?}`. Their combined text must exactly match the required top-level `text`, use at most 128 KiB of UTF-8, and contain no NUL characters. Every segment needs nonblank text and a language tag; a pause is 0–0.5 seconds. A segment's own `voiceId` selects its voice; an omitted id selects that segment's language automatically. The top-level `voiceId` is used only by the legacy single-text command without segments.

Replies are `{id,ok:true,result}` or `{id,ok:false,error,code}`. Asynchronous events contain `{event:true,sessionId,type,text?,code?}`. Events are `listening`, `partial`, `final`, `speech-start`, `speech-end`, `error`.

- `capabilities` is read-only and accepts a locale. It returns `{available,engine,locales,voices,needsModelDownload?,reason?}`. Each installed voice has `{id,name,language,quality}`, with quality `default`, `enhanced`, or `premium`. `available` means the device/engine supports the locale, not that microphone consent or a model is ready. Language identifiers use BCP47 hyphens.
- `listen` acknowledges immediately after reserving the session. `listening` is emitted only after setup and microphone start. Preparation/model failures arrive as session `error` events.
- Both `partial` and `final` carry the **entire cumulative transcript**. A finalized analyzer phrase does not restart or automatically stop the microphone; the frontend decides when a turn ends.
- `stop-listening` synchronously cancels pending setup and removes the audio tap/stops the engine. It then allows up to three seconds for final transcription, emits `final`, and acknowledges `{text}`. A timed-out flush also adds `code:"finalization-timeout"` while preserving text already received. Wrong session ids never cancel another session. Idle stops return `{text:""}`.
- `speak` uses one synthesizer to queue all utterances in the session. It reports one `speech-start` and one final `speech-end`, not an end between segments. `stop-speaking` without a session id cancels the entire queue immediately. Duplicate and late events from cancelled sessions are ignored.
- `shutdown` releases audio resources, replies, then exits. Parent pipe EOF or SIGTERM also exits and releases resources.

Command admission is synchronous on the main dispatch queue in pipe order. Potentially slow capabilities and finalization work suspend separately; a quick listen/stop pair cannot reorder and reopen the microphone.

Automatic reading selects the highest installed quality for the requested locale, then another voice in the same language if needed. Equal quality voices favor Apple's system default instead of arbitrary identifier order. On macOS 14+, novelty voices are excluded when a normal voice exists. Explicit voice ids are always respected; a removed voice produces `voice-unavailable` instead of silently choosing another. This does not download voices or request Personal Voice access. Apple defines the [voice quality tiers](https://developer.apple.com/documentation/avfaudio/avspeechsynthesisvoicequality) and provides [utterance delay controls](https://developer.apple.com/documentation/avfaudio/avspeechutterance/postutterancedelay); tier labels do not guarantee subjective naturalness.

## Engines and consent

On supported macOS 26+ hardware, `SpeechAnalyzer`/`SpeechTranscriber` performs local recognition. The helper checks asset status without installing anything. A missing model produces `needs-model-download`; only `listen` with `allowModelDownload:true` requests its installation. Once ready, only microphone permission is requested. Models are system-managed and may be shared by applications; readiness is checked for the actual helper identity and progressive transcription configuration.

On older or unsupported hardware, `SFSpeechRecognizer` is enabled only if `supportsOnDeviceRecognition` is true. Every request sets `requiresOnDeviceRecognition=true`; cloud fallback is never enabled. This compatibility engine asks the Speech permission as well as microphone permission. If local recognition is unavailable, capabilities explains that instead of claiming universal offline support. Stopping during a permission prompt invalidates the session, so a later permission response cannot start recording.

Official references: [SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer), [AssetInventory](https://developer.apple.com/documentation/speech/assetinventory), [on-device compatibility](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition), [permission differences](https://developer.apple.com/documentation/speech/asking-permission-to-use-speech-recognition), [audio-input entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input).

## Verification without recording or playback

Run `node native/apple-speech/Tests/run.mjs`. It compiles Swift tests for Unicode JSON framing, bounded segments, cumulative transcript revisions, quality/accent/novelty voice selection, queue-wide start/end, session exclusion, cancellation during setup and playback, stale callbacks, flush-before-ACK and ordered command admission. Synthesis lifecycle tests use an injected driver and never play audio. The runner also starts the actual signed helper for read-only capabilities and safe invalid/stop/shutdown commands.

For actual Apple TTS → audio file → Apple STT:

```sh
node native/apple-speech/smoke.mjs --locale zh-CN --timeout 180
node native/apple-speech/smoke.mjs --mixed --timeout 45
```

It synthesizes a fixed test sentence to a temporary CAF file via `AVSpeechSynthesizer.write`; it never calls speaker playback or opens a microphone. It uses the same signed helper and progressive transcription preset as production. Missing models produce a clear skip after the file-synthesis check. An explicitly authorized model installation can be tested with `--allow-model-download`; that flag is never implicit. The tool has a bounded timeout and handles SIGINT/SIGTERM by cancelling installation/analysis. Temporary audio is deleted on completion.

`--mixed` queues a fixed Chinese sentence containing `macrophage` and `RNA sequencing` as complete English segments, with zero added pauses at language boundaries. One synthesizer writes temporary audio files and reports each selected voice/quality. It checks actual Apple synthesis without requesting recognition models or making a naturalness claim; listening tests remain separate.

On the development Mac (macOS 26.2), the Chinese test passed with exact text after punctuation normalization. The same helper then reported Chinese models ready; English remained uninstalled and its recognition test was skipped, while its file synthesis passed. Reports and `/usr/bin/time -l` measurements are in `test-results/voice-native`. Those measurements describe this file test and the helper process only; they exclude Apple's system speech processes and are not continuous microphone performance measurements. Interactive microphone consent/recognition and macOS 13 compatibility still require separate runtime validation.
