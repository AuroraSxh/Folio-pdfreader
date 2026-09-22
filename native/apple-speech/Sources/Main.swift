import AppKit
@preconcurrency import AVFoundation
@preconcurrency import Speech
import Foundation

@MainActor final class SpeechController: NSObject, AVSpeechSynthesizerDelegate {
    final class Listening {
        let id: String
        var backend: (any Recognizing)?
        var startup: Task<Void, Never>?
        var stopTask: Task<FinishResult, Never>?
        var text = ""
        init(id: String) { self.id = id }
    }
    typealias RecognizerFactory = (Locale, @escaping (String, Bool) -> Void, @escaping (SpeechFailure) -> Void) throws -> any Recognizing
    private let output: (([String: Any]) -> Void)?
    private let recognizerFactory: RecognizerFactory?
    override init() { output = nil; recognizerFactory = nil; super.init() }
    init(output: @escaping ([String: Any]) -> Void, recognizerFactory: @escaping RecognizerFactory) {
        self.output = output; self.recognizerFactory = recognizerFactory; super.init()
    }
    private var listening: Listening?
    private var speaking: (id: String, utterance: AVSpeechUtterance)?
    private var synthesizer: AVSpeechSynthesizer?
    private var shuttingDown = false

    private func write(_ value: [String: Any]) {
        if let output { output(value); return }
        guard JSONSerialization.isValidJSONObject(value), let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
        do { try FileHandle.standardOutput.write(contentsOf: bytes + Data([10])) } catch { exit(0) }
    }
    private func reply(_ id: String, _ result: [String: Any] = [:]) { write(["id": id, "ok": true, "result": result]) }
    func reject(_ id: String = "", _ error: SpeechFailure) { write(["id": id, "ok": false, "code": error.code, "error": error.message]) }
    private func event(_ session: String, _ type: String, text: String? = nil, code: String? = nil) {
        var value: [String: Any] = ["event": true, "sessionId": session, "type": type]
        if let text { value["text"] = text }; if let code { value["code"] = code }; write(value)
    }
    // The pipe reader calls accept on DispatchQueue.main in byte-stream order.
    // Reserve/cancel session state synchronously; only long operations suspend.
    func handle(_ data: Data) async { await withCheckedContinuation { completion in accept(data) { completion.resume() } } }
    func accept(_ data: Data, completion: (() -> Void)? = nil) {
        guard !shuttingDown else { completion?(); return }
        let command: SpeechCommand
        do { command = try JSONDecoder().decode(SpeechCommand.self, from: data) }
        catch {
            let id = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["id"] as? String ?? ""
            reject(String(id.prefix(128)), SpeechFailure("invalid-request", "Expected a JSON command with a string id.")); completion?(); return
        }
        do {
            try command.validate()
            switch command.command {
            case "capabilities":
                Task { reply(command.id, await capabilities(locale: command.locale)); completion?() }; return
            case "listen": try listen(command)
            case "stop-listening":
                let stop = try beginStopListening(sessionId: command.sessionId)
                Task {
                    let result = await stop.value
                    var value: [String: Any] = ["text": result.text]
                    if result.timedOut { value["code"] = "finalization-timeout" }
                    reply(command.id, value); completion?()
                }; return
            case "speak": try speak(command)
            case "stop-speaking": try stopSpeaking(sessionId: command.sessionId); reply(command.id)
            case "shutdown": shutdown(id: command.id)
            default: throw SpeechFailure("invalid-request", "Unknown command.")
            }
        } catch let failure as SpeechFailure { reject(command.id, failure) }
        catch { reject(command.id, SpeechFailure("recognition-failed", "The speech command could not complete.")) }
        completion?()
    }
    private func listen(_ command: SpeechCommand) throws {
        guard listening == nil, speaking == nil else { throw SpeechFailure("busy", "Stop the current speech or listening session first.") }
        let session = Listening(id: command.sessionId!); listening = session
        reply(command.id, ["accepted": true, "sessionId": session.id])
        session.startup = Task { [weak self, weak session] in
            guard let self, let session else { return }
            do {
                let locale = Locale(identifier: command.locale ?? Locale.current.identifier)
                let receive: (String, Bool) -> Void = { [weak self, weak session] text, final in
                    guard let self, let session, self.listening === session else { return }
                    guard text.utf8.count <= 200_000 else { self.fail(session, SpeechFailure("recognition-failed", "The transcription is too long. Start a new session.")); return }
                    session.text = text; self.event(session.id, final ? "final" : "partial", text: text)
                }
                let failure: (SpeechFailure) -> Void = { [weak self, weak session] error in if let self, let session { self.fail(session, error) } }
                let backend: any Recognizing
                if let factory = self.recognizerFactory { backend = try factory(locale, receive, failure) }
                else if #available(macOS 26.0, *), SpeechTranscriber.isAvailable { backend = AnalyzerRecognition(locale: locale, receive: receive, failure: failure) }
                else { backend = try LegacyRecognition(locale: locale, receive: receive, failure: failure) }
                guard self.listening === session, !Task.isCancelled else { return }
                session.backend = backend
                try await backend.start(allowModelDownload: command.allowModelDownload == true)
                guard self.listening === session, session.stopTask == nil, !Task.isCancelled else { await backend.cancel(); return }
                self.event(session.id, "listening")
            } catch is CancellationError { /* A stop/shutdown invalidates this session before cancellation. */ }
            catch let error as SpeechFailure { self.fail(session, error) }
            catch { self.fail(session, SpeechFailure("recognition-failed", "Apple on-device recognition could not start.")) }
        }
    }
    private func fail(_ session: Listening, _ error: SpeechFailure) {
        guard listening === session else { return }
        listening = nil; session.startup?.cancel(); session.backend?.stopCapture()
        event(session.id, "error", text: error.message, code: error.code)
        Task { await session.backend?.cancel() }
    }
    private func beginStopListening(sessionId: String?) throws -> Task<FinishResult, Never> {
        guard let session = listening else { return Task { FinishResult(text: "") } }
        if let sessionId, sessionId != session.id { throw SpeechFailure("stale-session", "The listening session has already changed.") }
        if let stop = session.stopTask { return stop }
        session.startup?.cancel(); session.backend?.stopCapture()
        let stop = Task { [weak self] in
            let result = await session.backend?.finish() ?? FinishResult(text: session.text)
            if let self, self.listening === session {
                self.event(session.id, "final", text: result.text, code: result.timedOut ? "finalization-timeout" : nil)
                self.listening = nil
            }
            return result
        }
        session.stopTask = stop
        return stop
    }
    private func speak(_ command: SpeechCommand) throws {
        guard speaking == nil, listening == nil else { throw SpeechFailure("busy", "Stop the current speech or listening session first.") }
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.identifier.hasPrefix("com.apple.") }
        let voice: AVSpeechSynthesisVoice?
        if let id = command.voiceId { voice = voices.first { $0.identifier == id } }
        else {
            let wanted = (command.locale ?? Locale.current.identifier).replacingOccurrences(of: "_", with: "-")
            let selected = AVSpeechSynthesisVoice(language: wanted)
            voice = selected.flatMap { selected in voices.first { $0.identifier == selected.identifier } }
                ?? voices.first { $0.language.caseInsensitiveCompare(wanted) == .orderedSame }
                ?? voices.first { $0.language.split(separator: "-").first == wanted.split(separator: "-").first }
        }
        guard let voice else { throw SpeechFailure("voice-unavailable", "No installed Apple system voice matches this language or voice id.") }
        if synthesizer == nil { let value = AVSpeechSynthesizer(); value.delegate = self; synthesizer = value }
        let utterance = AVSpeechUtterance(string: command.text!); utterance.voice = voice
        utterance.rate = command.rate.map(Float.init) ?? AVSpeechUtteranceDefaultSpeechRate
        speaking = (command.sessionId!, utterance)
        reply(command.id, ["accepted": true, "sessionId": command.sessionId!])
        synthesizer!.speak(utterance)
    }
    private func stopSpeaking(sessionId: String?) throws {
        guard let current = speaking else { return }
        if let sessionId, current.id != sessionId { throw SpeechFailure("stale-session", "The speaking session has already changed.") }
        speaking = nil; synthesizer?.stopSpeaking(at: .immediate)
        event(current.id, "speech-end", code: "cancelled")
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        Task { @MainActor in if let current = self.speaking, current.utterance === utterance { self.event(current.id, "speech-start") } }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in if let current = self.speaking, current.utterance === utterance { self.speaking = nil; self.event(current.id, "speech-end") } }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in if let current = self.speaking, current.utterance === utterance { self.speaking = nil; self.event(current.id, "speech-end", code: "cancelled") } }
    }
    func shutdown(id: String? = nil) {
        guard !shuttingDown else { return }; shuttingDown = true
        let session = listening; listening = nil; session?.startup?.cancel(); session?.backend?.stopCapture()
        speaking = nil; synthesizer?.stopSpeaking(at: .immediate)
        if let id { reply(id) }
        exit(0)
    }
}

#if !FOLIO_SPEECH_TESTS
@main struct FolioSpeech {
    @MainActor static func main() {
        if CommandLine.arguments.contains("--file-smoke") { NativeSmokeTool.run(); return }
        signal(SIGPIPE, SIG_IGN)
        // An accessory app provides proper TCC bundle identity, without a Dock
        // icon, status item, window, activation, or automatic microphone access.
        _ = NSApplication.shared.setActivationPolicy(.accessory)
        let controller = SpeechController()
        signal(SIGTERM, SIG_IGN)
        let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termination.setEventHandler { controller.shutdown() }; termination.resume()
        DispatchQueue.global(qos: .userInitiated).async {
            var lines = JSONLines()
            var bytes = [UInt8](repeating: 0, count: 8192)
                while true {
                    let count = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
                    if count < 0 && errno == EINTR { continue }
                    if count <= 0 { break }
                    let data = Data(bytes.prefix(count))
                    for line in lines.append(data) {
                        switch line {
                        case .success(let bytes): DispatchQueue.main.async { controller.accept(bytes) }
                        case .failure(let error): DispatchQueue.main.async { controller.reject("", error) }
                        }
                    }
                }
                if let tail = lines.finish() { DispatchQueue.main.async { controller.accept(tail) } }
            // Parent pipe closed. Never keep a microphone alive after EOF.
            DispatchQueue.main.async { controller.shutdown() }
        }
        withExtendedLifetime(termination) { RunLoop.main.run() }
    }
}

#endif
