import Foundation

@main struct ProtocolTests {
    static func main() throws {
        var transcript = TranscriptBuffer()
        transcript.update(start: 0, end: 1, text: "Hello wor", final: false)
        transcript.update(start: 0, end: 1.3, text: "Hello world.", final: true)
        transcript.update(start: 1.3, end: 2.5, text: "A paper result.", final: true)
        precondition(transcript.text == "Hello world. A paper result.")
        transcript.update(start: 2.5, end: 3, text: "初步", final: false)
        transcript.update(start: 2.5, end: 4, text: "初步发现。", final: true)
        precondition(transcript.text == "Hello world. A paper result.初步发现。")
        transcript.update(start: 4, end: 5, text: "补充证据", final: true)
        precondition(transcript.text.hasSuffix("初步发现。补充证据"))
        transcript.update(start: .nan, end: 5, text: "Invalid", final: true)
        precondition(!transcript.text.contains("Invalid"))
        transcript.update(start: 0, end: 2.5, text: "Revised first two phrases.", final: true)
        precondition(transcript.text.hasPrefix("Revised first two phrases.")); precondition(!transcript.text.contains("Hello"))
        var lines = JSONLines(), decoded: [Data] = []
        let input = Data("{\"id\":\"中文\",\"command\":\"capabilities\"}\r\n{\"id\":\"two\",\"command\":\"shutdown\"}\n".utf8)
        for byte in input { for row in lines.append(Data([byte])) { decoded.append(try row.get()) } }
        precondition(decoded.count == 2)
        let decodedCommand = try JSONDecoder().decode(SpeechCommand.self, from: decoded[0]); precondition(decodedCommand.id == "中文")
        precondition(lines.finish() == nil)
        let overflow = lines.append(Data(repeating: 65, count: JSONLines.limit + 20))
        precondition(overflow.count == 1)
        if case .failure(let error) = overflow[0] { precondition(error.code == "invalid-request") } else { preconditionFailure() }
        precondition(lines.append(Data("still discarded\n".utf8)).isEmpty)
        precondition(lines.append(Data("{}\n".utf8)).count == 1)
        for json in ["{\"id\":\"x\",\"command\":\"listen\"}", "{\"id\":\"x\",\"command\":\"speak\",\"sessionId\":\"s\",\"text\":\"\"}", "{\"id\":\"x\",\"command\":\"speak\",\"sessionId\":\"s\",\"text\":\"abc\",\"rate\":2}", "{\"id\":\"x\",\"command\":\"unknown\"}"] {
            let command = try JSONDecoder().decode(SpeechCommand.self, from: Data(json.utf8))
            do { try command.validate(); preconditionFailure("Invalid command accepted") } catch let error as SpeechFailure { precondition(error.code == "invalid-request") }
        }
        let valid = try JSONDecoder().decode(SpeechCommand.self, from: Data("{\"id\":\"x\",\"command\":\"speak\",\"sessionId\":\"s\",\"text\":\"你好\",\"rate\":0.5}".utf8))
        try valid.validate()
        print("PASS: cumulative revisions, Chinese/English boundaries, range replacement, split UTF-8/CRLF, bounded lines, command validation")
    }
}
