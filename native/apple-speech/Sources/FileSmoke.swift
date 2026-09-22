import AppKit
@preconcurrency import AVFoundation
@preconcurrency import Speech
import Foundation
import CoreMedia

/** Explicit, file-only integration test. No microphone, speaker playback, or
 * legacy recognizer permissions. Downloads require --allow-model-download. */
@available(macOS 26.0, *)
@MainActor final class FileSmoke {
    private let synth = AVSpeechSynthesizer()
    private var installation: AssetInstallationRequestBox?
    private var analyzerBox: AnalyzerBox?
    func cancel() {
        installation?.cancel(); synth.stopSpeaking(at: .immediate)
        if #available(macOS 26.0, *), let analyzer = analyzerBox?.value { Task { await analyzer.cancelAndFinishNow() } }
    }
    func runMixed() async throws -> [String: Any] {
        let voices = AppleSpeechVoices.installed()
        let segments = [SpeechSegment(text: "这篇论文中的 ", locale: "zh-CN", pauseAfter: 0),
                        SpeechSegment(text: "macrophage", locale: "en-US", pauseAfter: 0),
                        SpeechSegment(text: " 通过 ", locale: "zh-CN", pauseAfter: 0),
                        SpeechSegment(text: "RNA sequencing", locale: "en-US", pauseAfter: 0),
                        SpeechSegment(text: " 进行分析。另一个例子是 ", locale: "zh-CN", pauseAfter: 0),
                        SpeechSegment(text: "CD 4 positive", locale: "en-US", pauseAfter: 0),
                        SpeechSegment(text: " 细胞，以及基因型 ", locale: "zh-CN", pauseAfter: 0),
                        SpeechSegment(text: "flox flox", locale: "en-US", pauseAfter: 0),
                        SpeechSegment(text: " 小鼠。", locale: "zh-CN", pauseAfter: 0)]
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("folio-speech-mixed-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        var jobs: [(file: URL, segment: SpeechSegment, voice: SpeechVoice, task: Task<Void, Error>)] = []
        for (index, segment) in segments.enumerated() {
            let selected = try AppleSpeechVoices.select(voices, locale: segment.locale, voiceId: segment.voiceId)
            guard let voice = AVSpeechSynthesisVoice(identifier: selected.id) else { throw AppleSpeechVoices.unavailable() }
            let file = folder.appendingPathComponent("segment-\(index).caf"), writer: AudioFileWriter
            writer = AudioFileWriter(url: file)
            let utterance = AVSpeechUtterance(string: segment.text); utterance.voice = voice
            utterance.rate = AVSpeechUtteranceDefaultSpeechRate; utterance.postUtteranceDelay = segment.pauseAfter ?? 0
            let task = Task { @MainActor in
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    writer.completion = continuation; synth.write(utterance) { writer.receive($0) }
                }
            }
            jobs.append((file, segment, selected, task))
        }
        var results: [[String: Any]] = []
        for job in jobs {
            try await job.task.value
            let size = try FileManager.default.attributesOfItem(atPath: job.file.path)[.size] as? NSNumber
            guard (size?.intValue ?? 0) > 1000 else { throw SpeechFailure("synthesis-failed", "Mixed-language synthesis produced no usable audio.") }
            results.append(["text": job.segment.text, "locale": job.segment.locale, "voiceId": job.voice.id, "quality": job.voice.quality, "audioBytes": size ?? 0])
        }
        return ["status": "passed", "test": "mixed-language-file-synthesis", "segments": results, "microphoneUsed": false, "speakerUsed": false, "modelDownload": false]
    }
    func run(locale identifier: String, allowDownload: Bool) async throws -> [String: Any] {
        guard #available(macOS 26.0, *), SpeechTranscriber.isAvailable else { return ["status": "skipped", "reason": "speech-analyzer-unavailable"] }
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: identifier)) else { return ["status": "skipped", "reason": "unsupported-locale"] }
        let text = identifier.hasPrefix("zh") ? "这篇论文的主要结论是什么。" : "What is the main conclusion of this paper?"
        let selected = try AppleSpeechVoices.select(AppleSpeechVoices.installed(), locale: identifier, voiceId: nil)
        guard let voice = AVSpeechSynthesisVoice(identifier: selected.id) else { throw AppleSpeechVoices.unavailable() }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("folio-speech-smoke-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("synthetic.caf")
        let writer = AudioFileWriter(url: file)
        let utterance = AVSpeechUtterance(string: text); utterance.voice = voice; utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        try await withCheckedThrowingContinuation { continuation in
            writer.completion = continuation
            synth.write(utterance) { writer.receive($0) }
        }
        let size = try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber
        guard (size?.intValue ?? 0) > 1000 else { throw SpeechFailure("synthesis-failed", "Apple speech synthesis produced no usable audio.") }
        let module = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        let status = await AssetInventory.status(forModules: [module])
        if status != .installed {
            guard allowDownload else { return ["status": "skipped", "reason": "needs-model-download", "tts": "passed", "audioBytes": size ?? 0, "locale": identifier] }
            guard status != .unsupported else { throw SpeechFailure("unsupported", "Apple does not support this speech model on the device.") }
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
                installation = AssetInstallationRequestBox(request)
                try await withTaskCancellationHandler { try await request.downloadAndInstall() } onCancel: { request.progress.cancel() }
                installation = nil
            }
            guard await AssetInventory.status(forModules: [module]) == .installed else { throw SpeechFailure("model-download-failed", "Model is still not installed after the download request completed.") }
        }
        let analyzer = SpeechAnalyzer(modules: [module]); analyzerBox = AnalyzerBox(analyzer)
        let resultTask = Task { () throws -> String in
            var transcript = TranscriptBuffer()
            for try await result in module.results {
                transcript.update(start: CMTimeGetSeconds(result.range.start), end: CMTimeGetSeconds(CMTimeRangeGetEnd(result.range)), text: String(result.text.characters), final: result.isFinal)
            }
            return transcript.text
        }
        let audio = try AVAudioFile(forReading: file)
        try await analyzer.start(inputAudioFile: audio, finishAfterFile: true)
        let transcript = try await resultTask.value
        analyzerBox = nil
        let normalized = transcript.lowercased().filter { $0.isLetter || $0.isNumber }
        let expected = text.lowercased().filter { $0.isLetter || $0.isNumber }
        return ["status": normalized == expected ? "passed" : "text-mismatch", "locale": identifier, "tts": "passed", "stt": normalized == expected ? "passed" : "text-mismatch", "expected": text, "transcript": transcript, "audioBytes": size ?? 0, "modelInstalled": true, "microphoneUsed": false, "speakerUsed": false]
    }
}
// Keep new SDK objects out of stored-property availability on older systems.
@available(macOS 26.0, *) private final class AnalyzerBox { let value: SpeechAnalyzer; init(_ value: SpeechAnalyzer) { self.value = value } }
@available(macOS 26.0, *) private final class AssetInstallationRequestBox { let value: AssetInstallationRequest; init(_ value: AssetInstallationRequest) { self.value = value }; func cancel() { value.progress.cancel() } }
private final class AudioFileWriter: @unchecked Sendable {
    let url: URL
    let lock = NSLock()
    var completion: CheckedContinuation<Void, Error>?
    var file: AVAudioFile?
    init(url: URL) { self.url = url }
    func receive(_ buffer: AVAudioBuffer) {
        lock.lock(); defer { lock.unlock() }
        guard completion != nil else { return }
        guard let pcm = buffer as? AVAudioPCMBuffer else { let result = completion; completion = nil; result?.resume(throwing: SpeechFailure("synthesis-failed", "Expected PCM audio from Apple synthesis.")); return }
        if pcm.frameLength == 0 { file = nil; let result = completion; completion = nil; result?.resume(); return }
        do { if file == nil { file = try AVAudioFile(forWriting: url, settings: pcm.format.settings) }; try file?.write(from: pcm) }
        catch { file = nil; let result = completion; completion = nil; result?.resume(throwing: error) }
    }
}
enum NativeSmokeTool {
    @MainActor static func run() {
        guard #available(macOS 26.0, *) else { print("{\"status\":\"skipped\",\"reason\":\"macOS26-required-for-file-smoke\"}"); exit(0) }
        _ = NSApplication.shared.setActivationPolicy(.accessory)
        let args = Array(CommandLine.arguments.dropFirst())
        let localeIndex = args.firstIndex(of: "--locale")
        let locale = localeIndex.flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } ?? "zh-CN"
        let timeoutIndex = args.firstIndex(of: "--timeout")
        let timeout = timeoutIndex.flatMap { $0 + 1 < args.count ? Double(args[$0 + 1]) : nil } ?? 180
        let smoke = FileSmoke(), start = Date()
        let task = Task { @MainActor in
            do {
                var result: [String: Any]
                if args.contains("--mixed") { result = try await smoke.runMixed() }
                else { result = try await smoke.run(locale: locale, allowDownload: args.contains("--allow-model-download")) }
                result["elapsedSeconds"] = Date().timeIntervalSince(start)
                print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!); exit(result["status"] as? String == "text-mismatch" ? 1 : 0)
            } catch {
                let failure = error as? SpeechFailure
                let result: [String: Any] = ["status": "failed", "code": failure?.code ?? "native-error", "error": failure?.message ?? String(describing: error), "elapsedSeconds": Date().timeIntervalSince(start)]
                print(String(data: try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!); exit(1)
            }
        }
        let timer = Task { @MainActor in
            try? await Task.sleep(for: .seconds(max(5, min(timeout, 600))))
            smoke.cancel(); task.cancel(); print("{\"status\":\"failed\",\"code\":\"timeout\",\"microphoneUsed\":false,\"speakerUsed\":false}"); exit(124)
        }
        signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN)
        let interruption = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        let cancel = { smoke.cancel(); task.cancel(); timer.cancel(); print("{\"status\":\"cancelled\"}"); exit(130) }
        interruption.setEventHandler(handler: cancel); termination.setEventHandler(handler: cancel); interruption.resume(); termination.resume()
        withExtendedLifetime((interruption, termination)) { RunLoop.main.run() }
    }
}
