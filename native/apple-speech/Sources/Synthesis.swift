@preconcurrency import AVFoundation
import Foundation

struct SpeechVoice {
    let id: String
    let name: String
    let language: String
    let quality: String
    var novelty = false
    var systemPreferred = false
    var qualityRank: Int { quality == "premium" ? 3 : quality == "enhanced" ? 2 : 1 }
    var json: [String: String] { ["id": id, "name": name, "language": language, "quality": quality] }
}

enum AppleSpeechVoices {
    static func installed() -> [SpeechVoice] {
        let installed = AVSpeechSynthesisVoice.speechVoices().filter { $0.identifier.hasPrefix("com.apple.") }
        let preferred = Set(Set(installed.map(\.language)).compactMap { AVSpeechSynthesisVoice(language: $0)?.identifier })
        return installed.map { voice in
            let quality: String
            switch voice.quality { case .premium: quality = "premium"; case .enhanced: quality = "enhanced"; default: quality = "default" }
            let novelty: Bool
            if #available(macOS 14.0, *) { novelty = voice.voiceTraits.contains(.isNoveltyVoice) } else { novelty = false }
            return SpeechVoice(id: voice.identifier, name: voice.name, language: normalized(voice.language), quality: quality, novelty: novelty, systemPreferred: preferred.contains(voice.identifier))
        }
    }
    static func normalized(_ language: String) -> String { language.replacingOccurrences(of: "_", with: "-") }
    static func select(_ voices: [SpeechVoice], locale: String, voiceId: String?) throws -> SpeechVoice {
        if let voiceId {
            guard let selected = voices.first(where: { $0.id == voiceId }) else { throw unavailable() }
            return selected
        }
        let wanted = normalized(locale).lowercased(), language = wanted.split(separator: "-").first
        let candidates = voices.filter { normalized($0.language).lowercased().split(separator: "-").first == language }
        // Avoid novelty voices when a normal voice exists, then prefer the
        // requested regional accent before quality. A downloaded voice never
        // changes an explicitly selected voice id.
        let normal = candidates.filter { !$0.novelty }
        let eligible = normal.isEmpty ? candidates : normal
        let exact = eligible.filter { normalized($0.language).lowercased() == wanted }
        let ranked = (exact.isEmpty ? eligible : exact).sorted {
            if $0.qualityRank != $1.qualityRank { return $0.qualityRank > $1.qualityRank }
            if $0.systemPreferred != $1.systemPreferred { return $0.systemPreferred }
            return $0.id < $1.id
        }
        guard let selected = ranked.first else { throw unavailable() }
        return selected
    }
    static func unavailable() -> SpeechFailure { SpeechFailure("voice-unavailable", "No installed Apple system voice matches this language or voice id.") }
}

struct SpeechUtterancePlan {
    let text: String
    let voiceId: String
    let rate: Float
    let pauseAfter: Double
}

enum SpeechSynthesisEvent { case start, finish, cancel }
@MainActor protocol SpeechSynthesizing: AnyObject {
    func start(_ plans: [SpeechUtterancePlan], receive: @escaping (SpeechSynthesisEvent, Int) -> Void) throws
    func stop()
}

/** A fresh driver belongs to one session. The same synthesizer queues all its
 * utterances; its delegate only reports indices belonging to this queue. */
@MainActor final class AppleSpeechSynthesizer: NSObject, SpeechSynthesizing, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private var utterances: [AVSpeechUtterance] = []
    private var receive: ((SpeechSynthesisEvent, Int) -> Void)?
    override init() { super.init(); synthesizer.delegate = self }
    func start(_ plans: [SpeechUtterancePlan], receive: @escaping (SpeechSynthesisEvent, Int) -> Void) throws {
        let queue = try plans.map { plan -> AVSpeechUtterance in
            guard let voice = AVSpeechSynthesisVoice(identifier: plan.voiceId) else { throw AppleSpeechVoices.unavailable() }
            let utterance = AVSpeechUtterance(string: plan.text)
            utterance.voice = voice; utterance.rate = plan.rate
            utterance.preUtteranceDelay = 0; utterance.postUtteranceDelay = plan.pauseAfter
            return utterance
        }
        utterances = queue; self.receive = receive
        for utterance in queue { synthesizer.speak(utterance) }
    }
    func stop() {
        receive = nil; utterances.removeAll()
        synthesizer.stopSpeaking(at: .immediate)
    }
    private func report(_ event: SpeechSynthesisEvent, utterance: AVSpeechUtterance) {
        guard let index = utterances.firstIndex(where: { $0 === utterance }) else { return }
        receive?(event, index)
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        Task { @MainActor in self.report(.start, utterance: utterance) }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.report(.finish, utterance: utterance) }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.report(.cancel, utterance: utterance) }
    }
}
