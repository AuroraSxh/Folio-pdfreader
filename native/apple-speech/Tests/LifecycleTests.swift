import Foundation

@MainActor final class FakeRecognizer: Recognizing {
    var text = ""
    var captured = false
    var stopped = false
    var startWait: CheckedContinuation<Void, Never>?
    let receive: (String, Bool) -> Void
    let failure: (SpeechFailure) -> Void
    init(receive: @escaping (String, Bool) -> Void, failure: @escaping (SpeechFailure) -> Void) { self.receive = receive; self.failure = failure }
    func start(allowModelDownload: Bool) async throws {
        await withCheckedContinuation { startWait = $0 }
        try Task.checkCancellation()
        guard !stopped else { throw CancellationError() }; captured = true
    }
    func ready() { startWait?.resume(); startWait = nil }
    func stopCapture() { captured = false; stopped = true }
    func finish() async -> FinishResult { stopCapture(); return FinishResult(text: text) }
    func cancel() async { stopCapture() }
    func send(_ text: String, final: Bool = false) { self.text = text; receive(text, final) }
}
@main struct LifecycleTests {
    @MainActor static func main() async throws {
        var output: [[String: Any]] = [], backends: [FakeRecognizer] = []
        let controller = SpeechController(output: { output.append($0) }, recognizerFactory: { _, receive, failure in let backend = FakeRecognizer(receive: receive, failure: failure); backends.append(backend); return backend })
        func send(_ id: String, _ command: String, _ session: String? = nil) async {
            var value = ["id": id, "command": command]; if let session { value["sessionId"] = session }
            await controller.handle(try! JSONSerialization.data(withJSONObject: value))
        }
        await send("listen-1", "listen", "first")
        precondition(output.first?["ok"] as? Bool == true, "Listen ACK must not wait for permission/model/start")
        await Task.yield()
        while backends.isEmpty { await Task.yield() }
        let first = backends[0]
        await send("busy", "listen", "other"); precondition(output.last?["code"] as? String == "busy")
        await send("stale", "stop-listening", "other"); precondition(output.last?["code"] as? String == "stale-session"); precondition(!first.stopped)
        await send("stop-pending", "stop-listening", "first"); precondition(first.stopped)
        first.ready(); await Task.yield(); precondition(!first.captured, "Late permission/start must never reopen the microphone")
        await send("listen-2", "listen", "second")
        while backends.count < 2 { await Task.yield() }; let second = backends[1]
        second.ready(); await Task.yield()
        while !second.captured { await Task.yield() }
        let previousCount = output.count; first.send("late result from old session", final: true); precondition(output.count == previousCount)
        second.send("完整累计文字")
        await send("stop-2", "stop-listening", "second")
        let final = output[output.count - 2], response = output.last!
        precondition(final["type"] as? String == "final"); precondition(final["sessionId"] as? String == "second"); precondition(final["text"] as? String == "完整累计文字")
        precondition((response["result"] as? [String: Any])?["text"] as? String == "完整累计文字"); precondition(!second.captured)
        let afterStop = output.count; second.send("post-stop event", final: true); precondition(output.count == afterStop)
        await send("listen-3", "listen", "third"); while backends.count < 3 { await Task.yield() }
        let third = backends[2]; third.ready(); await Task.yield(); while !third.captured { await Task.yield() }
        third.failure(SpeechFailure("audio-unavailable", "test route change")); precondition(!third.captured)
        precondition(output.last?["type"] as? String == "error")
        await send("after-error", "stop-listening", "third"); precondition((output.last?["result"] as? [String: Any])?["text"] as? String == "")
        // A single stdin chunk may contain listen then stop. Both must reserve
        // and cancel synchronously before any queued startup task can run.
        controller.accept(try JSONSerialization.data(withJSONObject: ["id": "rapid-listen", "command": "listen", "sessionId": "rapid"]))
        controller.accept(try JSONSerialization.data(withJSONObject: ["id": "rapid-stop", "command": "stop-listening", "sessionId": "rapid"]))
        while !output.contains(where: { $0["id"] as? String == "rapid-stop" }) { await Task.yield() }
        for backend in backends { precondition(!backend.captured) }
        precondition(output.contains(where: { $0["sessionId"] as? String == "rapid" && $0["type"] as? String == "final" }))
        print("PASS: immediate ACK, mutual exclusion, stale stop, pending permission cancellation, late result isolation, flush before stop ACK, fatal error capture release, synchronous batched listen/stop")
    }
}
