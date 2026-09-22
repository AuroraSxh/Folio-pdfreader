using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Pairleaf.Speech;

internal static class Tests
{
    private static int passed;
    private static void Check(bool value, string message = "Assertion failed") { if (!value) throw new Exception(message); }
    private static void Run(string name, Action test) { test(); passed++; Console.WriteLine("PASS " + name); }
    private static void Invalid(string json)
    {
        try { SpeechCommand.Parse(Encoding.UTF8.GetBytes(json)); }
        catch (SpeechFailure error) { Check(error.Code == "invalid-request"); return; }
        throw new Exception("Expected invalid-request");
    }
    private static SpeechCommand Command(string name, string session = null, string text = null)
    { return new SpeechCommand { Id = "request-" + Guid.NewGuid().ToString("N"), Command = name, SessionId = session, Text = text, Locale = "en-US" }; }
    private static SpeechVoice Voice(string locale, char token, bool preferred = false)
    { return new SpeechVoice { Id = "windows.sapi." + new string(token, 64), Name = "Voice " + token, Locale = locale, Preferred = preferred }; }
    private sealed class Recognition : IRecognition
    {
        internal Action<string, bool> Receive;
        internal Action<SpeechFailure> Failed;
        internal int Cancelled, Disposed;
        public void Start(Action<string, bool> receive, Action<SpeechFailure> failed) { Receive = receive; Failed = failed; }
        public void Cancel() { Cancelled++; }
        public void Dispose() { Disposed++; }
    }
    private sealed class Synthesis : ISynthesis
    {
        internal Action Started;
        internal Action<SpeechFailure> Finished;
        internal Utterance[] Segments;
        internal int Rate, Cancelled, Disposed;
        public void Start(Utterance[] segments, int rate, Action started, Action<SpeechFailure> finished)
        { Segments = segments; Rate = rate; Started = started; Finished = finished; }
        public void Cancel() { Cancelled++; }
        public void Dispose() { Disposed++; }
    }
    private sealed class Platform : ISpeechPlatform
    {
        internal Recognition Recognition;
        internal Synthesis Synthesis;
        internal int ProbeCalls, RecognitionCreated, SynthesisCreated;
        internal bool RecognitionUnavailable, FailSynthesis;
        public Dictionary<string, object> Capabilities(string locale)
        {
            ProbeCalls++;
            return Json.Map("available", !RecognitionUnavailable, "engine", "windows-speech", "locales", new[] { "en-US" }, "voices", Voices().Select(voice => voice.ToJson()).ToArray());
        }
        public SpeechVoice[] Voices() { return new[] { Voice("en-US", 'a', true), Voice("zh-CN", 'b') }; }
        public IRecognition CreateRecognition(string locale)
        {
            RecognitionCreated++;
            if (RecognitionUnavailable) throw new SpeechFailure("recognizer-unavailable", "No engine.");
            return Recognition = new Recognition();
        }
        public ISynthesis CreateSynthesis()
        {
            SynthesisCreated++;
            if (FailSynthesis) throw new Exception("private native diagnostics");
            return Synthesis = new Synthesis();
        }
    }
    private sealed class Fixture
    {
        internal readonly Platform Platform = new Platform();
        internal readonly Queue<Action> Queue = new Queue<Action>();
        internal readonly List<Dictionary<string, object>> Messages = new List<Dictionary<string, object>>();
        internal readonly SpeechController Controller;
        internal int Exits;
        internal Fixture() { Controller = new SpeechController(Platform, Queue.Enqueue, Messages.Add, () => Exits++); }
        internal void Drain() { while (Queue.Count > 0) Queue.Dequeue()(); }
        internal void Send(string name, string session = null, string text = null) { Controller.Handle(Command(name, session, text)); }
        internal Dictionary<string, object>[] Events(string type) { return Messages.Where(message => message.ContainsKey("event") && (string)message["type"] == type).ToArray(); }
    }

    private static void Main()
    {
        Run("backward-compatible commands and bounded mixed-language segments", () =>
        {
            var simple = SpeechCommand.Parse(Encoding.UTF8.GetBytes("{\"id\":\"1\",\"command\":\"speak\",\"sessionId\":\"s\",\"locale\":\"en-US\",\"text\":\"hello\"}"));
            Check(simple.Segments == null);
            var mixed = Command("speak", "mixed", "中文 CD 4 positive");
            mixed.Segments = new[] { new SpeechSegment { Text = "中文 ", Locale = "zh-CN" }, new SpeechSegment { Text = "CD 4 positive", Locale = "en-US", PauseAfter = 0.5 } };
            mixed.Validate();
            mixed.Segments[1].Text = "different";
            try { mixed.Validate(); throw new Exception("Expected mismatch rejection"); } catch (SpeechFailure) { }
        });
        Run("invalid session, voice, rate, NUL and command fail closed", () =>
        {
            Invalid("{\"id\":\"1\",\"command\":\"listen\",\"sessionId\":\"../x\"}");
            Invalid("{\"id\":\"1\",\"command\":\"launch\"}");
            Invalid("{\"id\":\"1\",\"command\":\"speak\",\"sessionId\":\"x\",\"text\":\"a\\u0000b\"}");
            Invalid("{\"id\":\"1\",\"command\":\"speak\",\"sessionId\":\"x\",\"text\":\"hello\",\"rate\":1.01}");
            Invalid("{\"id\":\"1\",\"command\":\"speak\",\"sessionId\":\"x\",\"text\":\"hello\",\"voiceId\":\"C:/arbitrary\"}");
            Invalid("{\"id\":\"1\",\"command\":\"listen\",\"sessionId\":\"x\",\"locale\":\"zh-CN;run\"}");
            Invalid("{\"id\":1,\"command\":\"capabilities\"}");
            Invalid("{\"id\":\"1\\n\",\"command\":\"capabilities\"}");
            Invalid("{\"id\":\"1\",\"command\":\"speak\",\"sessionId\":\"x\",\"text\":\"hello\",\"rate\":\"0.5\"}");
            Invalid("{\"id\":\"1\",\"command\":\"capabilities\"}{\"id\":\"2\",\"command\":\"shutdown\"}");
            try { SpeechCommand.Parse(new byte[] { 123, 255, 125 }); throw new Exception("Invalid UTF-8 accepted"); } catch (SpeechFailure) { }
        });
        Run("segment count, aggregate bytes and pause limits", () =>
        {
            foreach (var command in new[] {
                new SpeechCommand { Id="a",Command="speak",SessionId="s",Text=new string('x',131073) },
                new SpeechCommand { Id="a",Command="speak",SessionId="s",Text=new string('x',257),Segments=Enumerable.Range(0,257).Select(_=>new SpeechSegment{Text="x",Locale="en-US"}).ToArray() },
                new SpeechCommand { Id="a",Command="speak",SessionId="s",Text="x",Segments=new[]{new SpeechSegment{Text="x",Locale="en-US",PauseAfter=0.51}} }
            }) { try { command.Validate(); throw new Exception("Limit accepted"); } catch (SpeechFailure) { } }
        });
        Run("JSONL preserves split UTF-8/CRLF and recovers after one oversized-line error", () =>
        {
            var framing = new JsonLines(); var lines = new List<byte[]>(); int overflows = 0;
            var bytes = Encoding.UTF8.GetBytes("{\"id\":\"a\",\"command\":\"capabilities\",\"text\":\"中\"}\r\n");
            foreach (byte value in bytes) framing.Append(new[] { value }, 1, lines.Add, () => overflows++);
            Check(lines.Count == 1 && SpeechCommand.Parse(lines[0]).Text == "中");
            framing.Append(new byte[JsonLines.Limit + 40], JsonLines.Limit + 40, lines.Add, () => overflows++);
            framing.Append(new byte[] { 10 }, 1, lines.Add, () => overflows++);
            var next = Encoding.UTF8.GetBytes("{\"id\":\"b\",\"command\":\"shutdown\"}");
            framing.Append(next, next.Length, lines.Add, () => overflows++); framing.Finish(lines.Add);
            Check(overflows == 1 && lines.Count == 2 && SpeechCommand.Parse(lines[1]).Id == "b");
        });
        Run("voice selection honors exact locale, system default and explicit identifier", () =>
        {
            var us = Voice("en-US", 'a'); var usDefault = Voice("en-US", 'b', true); var gb = Voice("en-GB", 'c', true);
            Check(VoiceSelection.Select(new[] { us, gb, usDefault }, "en-US", null) == usDefault);
            Check(VoiceSelection.Select(new[] { us, gb }, "en-GB", null) == gb);
            Check(VoiceSelection.Select(new[] { us, usDefault }, "en-US", us.Id) == us);
            try { VoiceSelection.Select(new[] { us }, "zh-CN", null); throw new Exception("Wrong language fallback"); } catch (SpeechFailure error) { Check(error.Code == "voice-unavailable"); }
            try { VoiceSelection.Select(new[] { us }, "en-US", gb.Id); throw new Exception("Missing explicit voice overridden"); } catch (SpeechFailure error) { Check(error.Code == "voice-unavailable"); }
            Check(VoiceSelection.Rate(null) == 0 && VoiceSelection.Rate(0.5) == 0 && VoiceSelection.Rate(0.1) == -8 && VoiceSelection.Rate(1) == 10);
        });
        Run("capabilities alone never creates a listening or speaking session", () =>
        {
            var f = new Fixture(); f.Send("capabilities"); f.Drain();
            Check(f.Platform.ProbeCalls == 1 && f.Platform.RecognitionCreated == 0 && f.Platform.SynthesisCreated == 0 && !f.Controller.IsBusy);
            f.Platform.RecognitionUnavailable = true; f.Send("capabilities");
            var result = (Dictionary<string, object>)f.Messages.Last()["result"];
            Check(!(bool)result["available"] && ((Dictionary<string, object>[])result["voices"]).Length == 2);
        });
        Run("stop before queued listening startup never opens a device", () =>
        {
            var f = new Fixture(); f.Send("listen", "a"); f.Send("stop-listening", "a"); f.Drain();
            Check(f.Platform.RecognitionCreated == 0 && !f.Controller.IsBusy && f.Events("listening").Length == 0);
        });
        Run("hypothesis revision and final phrases form one cumulative transcript", () =>
        {
            var f = new Fixture(); f.Send("listen", "a"); f.Drain();
            var driver = f.Platform.Recognition;
            driver.Receive("Hello wor", false); driver.Receive("Hello world", false); driver.Receive("Hello world", true); driver.Receive("Next", false); f.Drain();
            Check((string)f.Events("partial").Last()["text"] == "Hello world Next");
            f.Send("stop-listening", "a");
            Check((string)((Dictionary<string, object>)f.Messages.Last()["result"])["text"] == "Hello world Next");
            Check(driver.Cancelled == 1 && driver.Disposed == 1 && !f.Controller.IsBusy);
            int count = f.Messages.Count; driver.Receive("late private text", true); driver.Failed(new SpeechFailure("recognition-failed", "late")); f.Drain();
            Check(f.Messages.Count == count);
            var cjk = new Transcript(); cjk.Update("论文", true); Check(cjk.Update("结论", true) == "论文结论");
        });
        Run("stale stop cannot cancel another session and a busy start is rejected", () =>
        {
            var f = new Fixture(); f.Send("listen", "a"); f.Drain(); f.Send("stop-listening", "old");
            Check((string)f.Messages.Last()["code"] == "stale-session" && f.Platform.Recognition.Cancelled == 0);
            f.Send("speak", "b", "hello"); Check((string)f.Messages.Last()["code"] == "busy");
            f.Send("stop-listening", "a"); f.Send("listen", "b"); f.Drain();
            Check(f.Platform.RecognitionCreated == 2);
        });
        Run("missing recognizer returns session error without leaving a busy session", () =>
        {
            var f = new Fixture(); f.Platform.RecognitionUnavailable = true; f.Send("listen", "a"); f.Drain();
            Check(f.Events("error").Length == 1 && (string)f.Events("error")[0]["code"] == "recognizer-unavailable" && !f.Controller.IsBusy);
            Check(f.Events("listening").Length == 0);
        });
        Run("one synthesis session preserves mixed segments and emits one start/end", () =>
        {
            var f = new Fixture(); var command = Command("speak", "s", "中文 <voice> CD 4 positive");
            command.Segments = new[] { new SpeechSegment { Text = "中文 ", Locale = "zh-CN" }, new SpeechSegment { Text = "<voice> CD 4 positive", Locale = "en-US" } };
            f.Controller.Handle(command); var synth = f.Platform.Synthesis;
            Check(synth.Segments.Length == 2 && synth.Segments[1].Text == "<voice> CD 4 positive" && synth.Segments[0].Voice.Locale == "zh-CN");
            synth.Started(); synth.Started(); f.Drain(); Check(f.Events("speech-start").Length == 1);
            synth.Finished(null); synth.Finished(null); f.Drain();
            Check(f.Events("speech-end").Length == 1 && synth.Disposed == 1 && !f.Controller.IsBusy);
        });
        Run("speech cancellation invalidates queued callbacks before next playback", () =>
        {
            var f = new Fixture(); f.Send("speak", "a", "first"); var old = f.Platform.Synthesis;
            old.Started(); f.Send("stop-speaking", "a"); f.Send("speak", "b", "next"); old.Finished(null); f.Drain();
            Check(f.Events("speech-start").Length == 0 && f.Events("speech-end").Length == 1 && f.Controller.IsBusy);
            Check((string)f.Events("speech-end")[0]["code"] == "cancelled" && old.Cancelled == 1 && old.Disposed == 1);
            f.Platform.Synthesis.Started(); f.Platform.Synthesis.Finished(null); f.Drain(); Check(f.Events("speech-end").Length == 2);
        });
        Run("synthesis construction failure receives one sanitized command rejection", () =>
        {
            var f = new Fixture(); f.Platform.FailSynthesis = true; f.Send("speak", "a", "hello");
            Check(f.Messages.Count == 1 && (string)f.Messages[0]["code"] == "synthesis-failed" && !f.Controller.IsBusy);
            Check(!Json.Write(f.Messages).Contains("private native"));
        });
        Run("shutdown releases microphone and forbids subsequent or delayed activity", () =>
        {
            var f = new Fixture(); f.Send("listen", "a"); f.Drain(); var driver = f.Platform.Recognition;
            f.Controller.Shutdown(); driver.Receive("late", true); f.Send("listen", "b"); f.Drain();
            Check(f.Exits == 1 && driver.Cancelled == 1 && driver.Disposed == 1 && f.Platform.RecognitionCreated == 1 && !f.Controller.IsBusy);
            var speech = new Fixture(); speech.Send("speak", "a", "hello"); var synth = speech.Platform.Synthesis; speech.Controller.Shutdown();
            Check(synth.Cancelled == 1 && synth.Disposed == 1);
        });
        Run("valid request id survives validation failure and JSON output stays escaped", () =>
        {
            var f = new Fixture(); f.Controller.Accept(Encoding.UTF8.GetBytes("{\"id\":\"keep-id\",\"command\":\"speak\",\"sessionId\":\"s\",\"text\":\"hello\",\"rate\":2}"));
            Check((string)f.Messages[0]["id"] == "keep-id" && (string)f.Messages[0]["code"] == "invalid-request");
            var output = Json.Write(Json.Map("text", "a\n\"b\\c中🙂"));
            Check(output == "{\"text\":\"a\\u000a\\\"b\\\\c中\\ud83d\\ude42\"}");
        });
        Console.WriteLine(passed + " Windows speech protocol/lifecycle tests passed (fake audio only).");
    }
}
