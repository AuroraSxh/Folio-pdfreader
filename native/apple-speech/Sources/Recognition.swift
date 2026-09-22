@preconcurrency import Speech
@preconcurrency import AVFoundation
import Foundation
import CoreMedia

struct FinishResult { var text: String; var timedOut = false }
@MainActor protocol Recognizing: AnyObject {
    var text: String { get }
    func start(allowModelDownload: Bool) async throws
    func stopCapture()
    func finish() async -> FinishResult
    func cancel() async
}

func languageTag(_ locale: Locale) -> String { locale.identifier.replacingOccurrences(of: "_", with: "-") }

@MainActor func capabilities(locale identifier: String?) async -> [String: Any] {
    let wanted = Locale(identifier: identifier ?? Locale.current.identifier)
    let voices = AppleSpeechVoices.installed().map(\.json)
    if #available(macOS 26.0, *), SpeechTranscriber.isAvailable {
        let locales = await SpeechTranscriber.supportedLocales
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) else {
            return ["available": false, "engine": "speech-analyzer", "reason": "unsupported-locale", "locales": locales.map(languageTag).sorted(), "voices": voices]
        }
        let module = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        let status = await AssetInventory.status(forModules: [module])
        return ["available": status != .unsupported, "engine": "speech-analyzer", "locales": locales.map(languageTag).sorted(), "voices": voices, "needsModelDownload": status != .installed]
    }
    let locales = SFSpeechRecognizer.supportedLocales().map(languageTag).sorted()
    guard let recognizer = SFSpeechRecognizer(locale: wanted), recognizer.supportsOnDeviceRecognition else {
        return ["available": false, "engine": "unsupported", "reason": "on-device-unavailable", "locales": locales, "voices": voices]
    }
    return ["available": recognizer.isAvailable, "engine": "speech-recognizer", "locales": locales, "voices": voices, "needsModelDownload": false, "reason": recognizer.isAvailable ? "" : "recognizer-unavailable"]
}

@available(macOS 26.0, *)
@MainActor final class AnalyzerRecognition: Recognizing {
    private let locale: Locale
    private let receive: (String, Bool) -> Void
    private let failure: (SpeechFailure) -> Void
    private let capture = AudioCapture()
    private var analyzer: SpeechAnalyzer?
    private var continuation: AsyncStream<AnalyzerInput>.Continuation?
    private var results: Task<Void, Never>?
    private var modelRequest: AssetInstallationRequest?
    private var transcript = TranscriptBuffer()
    private var closed = false
    private var running = false
    var text: String { transcript.text }
    init(locale: Locale, receive: @escaping (String, Bool) -> Void, failure: @escaping (SpeechFailure) -> Void) { self.locale = locale; self.receive = receive; self.failure = failure }

    func start(allowModelDownload: Bool) async throws {
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else { throw SpeechFailure("unsupported-locale", "This language is not supported by Apple on-device transcription.") }
        try checkActive()
        let module = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        let status = await AssetInventory.status(forModules: [module]); try checkActive()
        if status == .unsupported { throw SpeechFailure("unsupported", "Apple on-device transcription is unavailable for this language.") }
        if status != .installed {
            guard allowModelDownload else { throw SpeechFailure("needs-model-download", "The Apple speech model is not installed. Confirm its download before listening.") }
            do {
                if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
                    try checkActive(); modelRequest = request
                    try await withTaskCancellationHandler { try await request.downloadAndInstall() } onCancel: { request.progress.cancel() }
                    modelRequest = nil
                }
                try checkActive()
                guard await AssetInventory.status(forModules: [module]) == .installed else { throw SpeechFailure("model-download-failed", "The Apple speech model is not installed yet.") }
            } catch {
                try checkActive()
                throw SpeechFailure("model-download-failed", "The Apple speech model could not be downloaded. Check the network and free storage, then retry.")
            }
        }
        try checkActive()
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) else { throw SpeechFailure("audio-unavailable", "No compatible speech-analysis audio format is available.") }
        try checkActive()
        let analyzer = SpeechAnalyzer(modules: [module]); self.analyzer = analyzer
        try await analyzer.prepareToAnalyze(in: format); try checkActive()
        try await requestMicrophonePermission(); try checkActive()
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingOldest(64))
        self.continuation = continuation
        results = Task { [weak self] in
            do {
                for try await result in module.results {
                    guard let self else { return }
                    self.transcript.update(start: CMTimeGetSeconds(result.range.start), end: CMTimeGetSeconds(CMTimeRangeGetEnd(result.range)), text: String(result.text.characters), final: result.isFinal)
                    self.receive(self.text, result.isFinal)
                }
            } catch { if let self, !self.closed { self.failure(SpeechFailure("recognition-failed", "Apple speech analysis stopped unexpectedly.")) } }
        }
        try await analyzer.start(inputSequence: stream); try checkActive()
        try capture.start(format: format, receive: { [weak self] buffer in
            guard buffer.frameLength > 0 else { return }
            if case .dropped = continuation.yield(AnalyzerInput(buffer: buffer)) {
                Task { @MainActor in self?.failure(SpeechFailure("recognition-failed", "Speech analysis could not keep up with microphone audio.")) }
            }
        }, failure: { [weak self] in Task { @MainActor in self?.failure(SpeechFailure("audio-unavailable", "The microphone or audio format changed. Start listening again when ready.")) } })
        running = true
    }
    private func checkActive() throws { try Task.checkCancellation(); if closed { throw CancellationError() } }
    func stopCapture() { capture.stop(); continuation?.finish(); continuation = nil; modelRequest?.progress.cancel(); closed = true }
    func finish() async -> FinishResult {
        stopCapture()
        guard running, let analyzer else { await cancel(); return FinishResult(text: text) }
        var timedOut = false
        let watchdog = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
            timedOut = true; self?.results?.cancel(); await analyzer.cancelAndFinishNow()
        }
        do { try await analyzer.finalizeAndFinishThroughEndOfInput() } catch { /* Preserve text already received. */ }
        await results?.value
        watchdog.cancel(); results = nil; self.analyzer = nil; running = false
        return FinishResult(text: text, timedOut: timedOut)
    }
    func cancel() async {
        stopCapture(); results?.cancel()
        if let analyzer { await analyzer.cancelAndFinishNow() }
        results = nil; analyzer = nil; running = false
    }
}

@MainActor final class LegacyRecognition: Recognizing {
    private let recognizer: SFSpeechRecognizer
    private let receive: (String, Bool) -> Void
    private let failure: (SpeechFailure) -> Void
    private let capture = AudioCapture()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var closed = false
    private var completed = false
    private var finishWait: CheckedContinuation<Void, Never>?
    private(set) var text = ""
    init(locale: Locale, receive: @escaping (String, Bool) -> Void, failure: @escaping (SpeechFailure) -> Void) throws {
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.supportsOnDeviceRecognition else { throw SpeechFailure("unsupported", "On-device recognition is unavailable on this Mac for this language. Cloud recognition is disabled.") }
        self.recognizer = recognizer; self.receive = receive; self.failure = failure
    }
    func start(allowModelDownload: Bool) async throws {
        let permission = await withCheckedContinuation { continuation in SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) } }
        try checkActive()
        guard permission == .authorized else { throw SpeechFailure("speech-permission-denied", "Speech Recognition permission was not granted. Check System Settings > Privacy & Security.") }
        try await requestMicrophonePermission(); try checkActive()
        guard recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else { throw SpeechFailure("unsupported", "The Apple recognizer is not available for on-device use. No audio was sent to a cloud service.") }
        let request = SFSpeechAudioBufferRecognitionRequest(); request.shouldReportPartialResults = true; request.requiresOnDeviceRecognition = true; request.taskHint = .dictation
        self.request = request
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self, !self.completed else { return }
                if let result {
                    self.text = result.bestTranscription.formattedString
                    self.receive(self.text, result.isFinal)
                    if result.isFinal { self.completed = true; self.capture.stop(); self.resumeFinish() }
                }
                if error != nil {
                    self.completed = true; self.capture.stop(); self.resumeFinish()
                    if !self.closed { self.failure(SpeechFailure("recognition-failed", "Apple on-device speech recognition stopped. Start a new listening session to retry.")) }
                }
            }
        }
        try capture.start(receive: { request.append($0) }, failure: { [weak self] in Task { @MainActor in self?.failure(SpeechFailure("audio-unavailable", "The microphone changed or became unavailable.")) } })
    }
    private func checkActive() throws { try Task.checkCancellation(); if closed { throw CancellationError() } }
    func stopCapture() { capture.stop(); request?.endAudio(); closed = true }
    private func resumeFinish() { let wait = finishWait; finishWait = nil; wait?.resume() }
    func finish() async -> FinishResult {
        stopCapture()
        guard task != nil, !completed else { return FinishResult(text: text) }
        task?.finish()
        var timedOut = false
        let watchdog = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
            timedOut = true; self?.completed = true; self?.task?.cancel(); self?.resumeFinish()
        }
        await withCheckedContinuation { continuation in if completed { continuation.resume() } else { finishWait = continuation } }
        watchdog.cancel(); task = nil; request = nil
        return FinishResult(text: text, timedOut: timedOut)
    }
    func cancel() async { stopCapture(); completed = true; task?.cancel(); task = nil; request = nil; resumeFinish() }
}
