import Foundation

@MainActor final class FakeSynthesizer: SpeechSynthesizing {
    var plans: [SpeechUtterancePlan] = []
    var receive: ((SpeechSynthesisEvent, Int) -> Void)?
    var stopped = false
    func start(_ plans: [SpeechUtterancePlan], receive: @escaping (SpeechSynthesisEvent, Int) -> Void) throws { self.plans = plans; self.receive = receive }
    func stop() { stopped = true } // Preserve callback to simulate delayed native delegates.
    func emit(_ event: SpeechSynthesisEvent, _ index: Int) { receive?(event, index) }
}

@main struct SynthesisTests {
    @MainActor static func main() async throws {
        let voices = [
            SpeechVoice(id: "cn-normal", name: "CN", language: "zh-CN", quality: "default"),
            SpeechVoice(id: "cn-enhanced", name: "CN Enhanced", language: "zh-CN", quality: "enhanced"),
            SpeechVoice(id: "cn-premium", name: "CN Premium", language: "zh-CN", quality: "premium"),
            SpeechVoice(id: "aa-us-other", name: "US Other", language: "en-US", quality: "default"),
            SpeechVoice(id: "us-normal", name: "US", language: "en-US", quality: "default", systemPreferred: true),
            SpeechVoice(id: "gb-premium", name: "GB", language: "en-GB", quality: "premium"),
            SpeechVoice(id: "us-novelty", name: "Novelty", language: "en-US", quality: "premium", novelty: true)
        ]
        let automaticChinese = try AppleSpeechVoices.select(voices, locale: "zh_CN", voiceId: nil)
        let automaticUS = try AppleSpeechVoices.select(voices, locale: "en-US", voiceId: nil)
        let automaticFallback = try AppleSpeechVoices.select(voices, locale: "en-AU", voiceId: nil)
        let explicitChinese = try AppleSpeechVoices.select(voices, locale: "zh-CN", voiceId: "cn-normal")
        let explicitNovelty = try AppleSpeechVoices.select(voices, locale: "en-US", voiceId: "us-novelty")
        precondition(automaticChinese.id == "cn-premium")
        precondition(automaticUS.id == "us-normal", "Keep accent, avoid novelty, and prefer system choice among equal quality voices")
        precondition(automaticFallback.id == "gb-premium", "Fallback language still ranks quality")
        precondition(explicitChinese.id == "cn-normal", "Respect explicit preference")
        precondition(explicitNovelty.id == "us-novelty", "Explicit novelty selection is allowed")
        for (locale, voiceId) in [("fr-FR", nil as String?), ("zh-CN", "removed-voice")] {
            do { _ = try AppleSpeechVoices.select(voices, locale: locale, voiceId: voiceId); preconditionFailure("Missing voice must fail") }
            catch let error as SpeechFailure { precondition(error.code == "voice-unavailable") }
        }
        var output: [[String: Any]] = [], drivers: [FakeSynthesizer] = []
        let controller = SpeechController(output: { output.append($0) }, synthesizerFactory: { let driver = FakeSynthesizer(); drivers.append(driver); return driver }, voiceProvider: { voices })
        func send(_ id: String, _ command: String, _ session: String, _ fields: [String: Any] = [:]) async {
            var value = fields; value["id"] = id; value["command"] = command; value["sessionId"] = session
            await controller.handle(try! JSONSerialization.data(withJSONObject: value))
        }
        let fields: [String: Any] = ["text": "中文。English sentence.继续。", "rate": 0.45, "segments": [
            ["text": "中文。", "locale": "zh-CN", "voiceId": "cn-enhanced", "pauseAfter": 0.08],
            ["text": "English sentence.", "locale": "en-US", "pauseAfter": 0.12],
            ["text": "继续。", "locale": "zh-CN"]
        ]]
        await send("one", "speak", "one", fields)
        precondition(output.last?["ok"] as? Bool == true); precondition(drivers.count == 1)
        let first = drivers[0]
        precondition(first.plans.map(\.voiceId) == ["cn-enhanced", "us-normal", "cn-premium"])
        precondition(first.plans.allSatisfy { $0.rate == 0.45 }); precondition(first.plans.map(\.pauseAfter) == [0.08, 0.12, 0])
        await send("busy", "listen", "listen"); precondition(output.last?["code"] as? String == "busy")
        first.emit(.start, 0); first.emit(.finish, 0); first.emit(.start, 1); first.emit(.finish, 1)
        precondition(output.filter { $0["type"] as? String == "speech-start" }.count == 1)
        precondition(!output.contains { $0["type"] as? String == "speech-end" }, "Keep session alive between utterances")
        first.emit(.finish, 1); first.emit(.finish, 77)
        precondition(!output.contains { $0["type"] as? String == "speech-end" }, "Duplicate and unknown callbacks must not advance queue")
        first.emit(.start, 2); first.emit(.finish, 2); first.emit(.finish, 2)
        precondition(output.filter { $0["type"] as? String == "speech-end" }.count == 1)
        await send("two", "speak", "two", fields); let second = drivers[1]
        await send("stale", "stop-speaking", "one"); precondition(output.last?["code"] as? String == "stale-session"); precondition(!second.stopped)
        second.emit(.start, 0)
        await send("stop", "stop-speaking", "two"); precondition(second.stopped)
        precondition(output.filter { $0["sessionId"] as? String == "two" && $0["type"] as? String == "speech-end" && $0["code"] as? String == "cancelled" }.count == 1)
        await send("three", "speak", "three", fields); let third = drivers[2]
        let count = output.count
        second.emit(.cancel, 0); second.emit(.finish, 1); second.emit(.start, 2); first.emit(.finish, 2)
        precondition(output.count == count, "Old queue callbacks cannot affect replacement session")
        third.emit(.start, 0); third.emit(.cancel, 0); third.emit(.cancel, 1)
        precondition(third.stopped); precondition(output.filter { $0["sessionId"] as? String == "three" && $0["type"] as? String == "speech-end" }.count == 1)
        await send("missing", "speak", "missing", ["text": "hello", "voiceId": "removed"])
        precondition(output.last?["code"] as? String == "voice-unavailable"); precondition(drivers.count == 3, "Validate every voice before creating a synthesizer")
        await send("legacy", "speak", "legacy", ["text": "hello", "locale": "en-US"])
        precondition(drivers.last?.plans.count == 1)
        await send("cleanup", "stop-speaking", "legacy")
        print("PASS: quality/accent/novelty selection, explicit voice preference, queue-wide start/end, duplicate callbacks, busy/stale stops, cancelled queue isolation, legacy speak")
    }
}
