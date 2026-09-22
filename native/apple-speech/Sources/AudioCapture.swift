@preconcurrency import AVFoundation
import Foundation

/** Used only after the user's explicit listen command and microphone consent.
 * It never retries or restarts after a device change. */
@MainActor final class AudioCapture {
    private var engine: AVAudioEngine?
    private var tapInstalled = false
    private var observer: NSObjectProtocol?
    func start(format target: AVAudioFormat? = nil, receive: @escaping @Sendable (AVAudioPCMBuffer) -> Void, failure: @escaping @Sendable () -> Void) throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let source = input.outputFormat(forBus: 0)
        guard source.sampleRate > 0, source.channelCount > 0 else { throw SpeechFailure("audio-unavailable", "No usable microphone input is available.") }
        let converter = try target.map { try AudioConverter(source: source, target: $0) }
        self.engine = engine
        observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { _ in failure() }
        input.installTap(onBus: 0, bufferSize: 2048, format: source) { buffer, _ in
            do { receive(try converter?.convert(buffer) ?? buffer) } catch { failure() }
        }
        tapInstalled = true
        engine.prepare()
        do { try engine.start() } catch { stop(); throw SpeechFailure("audio-unavailable", "The microphone audio engine could not start.") }
    }
    func stop() {
        if let observer { NotificationCenter.default.removeObserver(observer); self.observer = nil }
        guard let engine else { return }
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        engine.stop(); engine.reset(); self.engine = nil
    }
}

/** Converter state is confined to the audio tap's serial delivery queue. The
 * returned buffer is owned by the analyzer stream, never the engine's reused tap. */
private final class AudioConverter: @unchecked Sendable {
    let target: AVAudioFormat
    let converter: AVAudioConverter
    init(source: AVAudioFormat, target: AVAudioFormat) throws {
        self.target = target
        guard let converter = AVAudioConverter(from: source, to: target) else { throw SpeechFailure("audio-unavailable", "The microphone format cannot be converted for recognition.") }
        converter.primeMethod = .none; self.converter = converter
    }
    func convert(_ input: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
        let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * target.sampleRate / input.format.sampleRate)) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { throw SpeechFailure("audio-unavailable", "Could not allocate an audio buffer.") }
        var provided = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, state in
            if provided { state.pointee = .noDataNow; return nil }
            provided = true; state.pointee = .haveData; return input
        }
        if status == .error || error != nil { throw SpeechFailure("audio-unavailable", "Audio format conversion failed.") }
        return output
    }
}

@MainActor func requestMicrophonePermission() async throws {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return
    case .notDetermined:
        let allowed = await AVCaptureDevice.requestAccess(for: .audio)
        try Task.checkCancellation()
        if !allowed { throw SpeechFailure("microphone-denied", "Microphone access was not granted. Enable it in System Settings > Privacy & Security.") }
    default: throw SpeechFailure("microphone-denied", "Microphone access is disabled in System Settings > Privacy & Security.")
    }
}
