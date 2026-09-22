import Foundation

struct SpeechSegment: Decodable {
    let text: String
    let locale: String
    var voiceId: String?
    var pauseAfter: Double?
    func validate() throws {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !text.contains("\0"), locale.utf8.count <= 64,
              locale.range(of: "^[A-Za-z]{2,8}([-_][A-Za-z0-9]{1,8})*$", options: .regularExpression) != nil else {
            throw SpeechFailure("invalid-request", "Speech segments need text and a valid locale.")
        }
        if let voiceId, voiceId.isEmpty || voiceId.utf8.count > 256 || voiceId.contains("\0") { throw SpeechFailure("invalid-request", "Invalid segment voice id.") }
        if let pauseAfter, !pauseAfter.isFinite || !(0...0.5).contains(pauseAfter) { throw SpeechFailure("invalid-request", "Speech pauses must be between 0 and 0.5 seconds.") }
    }
}

struct SpeechCommand: Decodable {
    let id: String
    let command: String
    var sessionId: String?
    var locale: String?
    var text: String?
    var voiceId: String?
    var rate: Double?
    var allowModelDownload: Bool?
    var segments: [SpeechSegment]?

    func validate() throws {
        guard !id.isEmpty, id.utf8.count <= 128 else { throw SpeechFailure("invalid-request", "A short request id is required.") }
        guard ["capabilities", "listen", "stop-listening", "speak", "stop-speaking", "shutdown"].contains(command) else { throw SpeechFailure("invalid-request", "Unknown command.") }
        if let locale, locale.utf8.count > 64 { throw SpeechFailure("invalid-request", "Invalid locale.") }
        if let sessionId, sessionId.isEmpty || sessionId.utf8.count > 128 { throw SpeechFailure("invalid-request", "Invalid session id.") }
        if command == "listen" || command == "speak", sessionId == nil { throw SpeechFailure("invalid-request", "A session id is required.") }
        if command == "speak" {
            guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !text.contains("\0"), text.utf8.count <= 200_000 else { throw SpeechFailure("invalid-request", "Speech text must contain 1 to 200,000 UTF-8 bytes without NUL characters.") }
            if let rate, !rate.isFinite || !(0.1...1).contains(rate) { throw SpeechFailure("invalid-request", "Speech rate must be between 0.1 and 1.0.") }
            if let voiceId, voiceId.utf8.count > 256 { throw SpeechFailure("invalid-request", "Invalid voice id.") }
            if let segments {
                guard !segments.isEmpty, segments.count <= 256, segments.map(\.text).joined() == text,
                      segments.reduce(0, { $0 + $1.text.utf8.count }) <= 131_072 else {
                    throw SpeechFailure("invalid-request", "Use 1 to 256 speech segments and at most 128 KiB of segment text.")
                }
                try segments.forEach { try $0.validate() }
            }
        }
    }
}

struct SpeechFailure: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

/** SpeechAnalyzer results describe ranges, not a cumulative transcript. A revised
 * volatile range replaces its previous text; finalized ranges remain in order. */
struct TranscriptBuffer {
    struct Segment { let start: Double; let end: Double; let text: String; let final: Bool }
    private(set) var segments: [Segment] = []
    mutating func update(start: Double, end: Double, text: String, final: Bool) {
        guard start.isFinite, end.isFinite, end >= start else { return }
        segments.removeAll { segment in
            abs(segment.start - start) < 0.000_001 || (segment.start < end && segment.end > start)
        }
        segments.append(Segment(start: start, end: end, text: text, final: final))
        segments.sort { $0.start < $1.start }
    }
    var text: String {
        var result = ""
        for segment in segments {
            let next = segment.text
            if let last = result.last, let first = next.first,
               !last.isWhitespace, !first.isWhitespace,
               last.isASCII, first.isASCII, first.isLetter,
               last.isLetter || last.isNumber || ".!?;:".contains(last) { result += " " }
            result += next
        }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/** Bounded JSONL framing. A large malformed line is discarded once, not allowed
 * to grow until the parent closes stdin. CRLF and split UTF-8 are supported. */
struct JSONLines {
    static let limit = 1_048_576
    private var buffer = Data()
    private var discarding = false
    mutating func append(_ data: Data) -> [Result<Data, SpeechFailure>] {
        var output: [Result<Data, SpeechFailure>] = []
        for byte in data {
            if byte == 10 {
                if !discarding && !buffer.isEmpty { output.append(.success(buffer)) }
                buffer.removeAll(keepingCapacity: true); discarding = false
            } else if !discarding {
                if buffer.count >= Self.limit {
                    buffer.removeAll(keepingCapacity: true); discarding = true
                    output.append(.failure(SpeechFailure("invalid-request", "JSON line exceeds 1 MiB.")))
                } else { buffer.append(byte) }
            }
        }
        return output
    }
    mutating func finish() -> Data? {
        defer { buffer.removeAll(); discarding = false }
        return !discarding && !buffer.isEmpty ? buffer : nil
    }
}
