using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

namespace Pairleaf.Speech
{
    internal sealed class SpeechVoice
    {
        internal string Id, Name, Locale;
        internal bool Preferred;
        internal Dictionary<string, object> ToJson() { return Json.Map("id", Id, "name", Name, "language", Locale, "quality", "default"); }
    }
    internal static class VoiceSelection
    {
        internal static SpeechVoice Select(IEnumerable<SpeechVoice> source, string locale, string id)
        {
            var voices = source.ToArray();
            if (id != null)
            {
                var selected = voices.FirstOrDefault(voice => voice.Id == id);
                if (selected == null) throw new SpeechFailure("voice-unavailable", "The selected Windows voice is unavailable.");
                return selected;
            }
            var normalized = locale.Replace('_', '-');
            var exact = voices.Where(voice => String.Equals(voice.Locale, normalized, StringComparison.OrdinalIgnoreCase));
            var candidates = exact.Any() ? exact : voices.Where(voice => String.Equals(voice.Locale.Split('-')[0], normalized.Split('-')[0], StringComparison.OrdinalIgnoreCase));
            var result = candidates.OrderByDescending(voice => voice.Preferred).ThenBy(voice => voice.Id, StringComparer.Ordinal).FirstOrDefault();
            if (result == null) throw new SpeechFailure("voice-unavailable", "No installed Windows voice supports this language.");
            return result;
        }
        // Match the existing normalized rate: 0.5 is the native Windows default.
        internal static int Rate(double? rate) { return rate.HasValue ? (int)Math.Round((rate.Value - 0.5) * 20, MidpointRounding.AwayFromZero) : 0; }
    }
    internal sealed class Utterance
    {
        internal string Text;
        internal SpeechVoice Voice;
        internal double Pause;
    }
    internal interface IRecognition : IDisposable
    {
        void Start(Action<string, bool> receive, Action<SpeechFailure> failed);
        void Cancel();
    }
    internal interface ISynthesis : IDisposable
    {
        void Start(Utterance[] segments, int rate, Action started, Action<SpeechFailure> finished);
        void Cancel();
    }
    internal interface ISpeechPlatform
    {
        Dictionary<string, object> Capabilities(string locale);
        SpeechVoice[] Voices();
        IRecognition CreateRecognition(string locale);
        ISynthesis CreateSynthesis();
    }
    internal sealed class Transcript
    {
        private string committed = "", hypothesis = "";
        internal string Text { get { return Join(committed, hypothesis); } }
        internal string Update(string text, bool final)
        {
            if (text == null || text.IndexOf('\0') >= 0) throw new SpeechFailure("recognition-failed", "Invalid transcription.");
            if (final) { committed = Join(committed, text.Trim()); hypothesis = ""; }
            else hypothesis = text.Trim();
            if (Encoding.UTF8.GetByteCount(Text) > 131072) throw new SpeechFailure("recognition-failed", "The transcription is too long. Start a new session.");
            return Text;
        }
        private static string Join(string first, string second)
        {
            if (first.Length == 0) return second;
            if (second.Length == 0) return first;
            char last = first[first.Length - 1], next = second[0];
            // Windows supplies phrase text. Preserve CJK adjacency and add a
            // space only where a new Latin/number phrase needs a word boundary.
            bool space = last < 128 && next < 128 && Char.IsLetterOrDigit(next) && !Char.IsWhiteSpace(last);
            return first + (space ? " " : "") + second;
        }
    }

    // All state transitions run on one dispatcher. Native callbacks post back to
    // it, and identity guards reject callbacks from a disposed/replaced session.
    internal sealed class SpeechController
    {
        private sealed class Listening
        {
            internal string Id;
            internal IRecognition Driver;
            internal readonly Transcript Transcript = new Transcript();
        }
        private sealed class Speaking
        {
            internal string Id;
            internal ISynthesis Driver;
            internal bool Started;
        }
        private readonly ISpeechPlatform platform;
        private readonly Action<Action> post;
        private readonly Action<Dictionary<string, object>> output;
        private readonly Action exit;
        private Listening listening;
        private Speaking speaking;
        private bool closed;
        internal bool IsBusy { get { return listening != null || speaking != null; } }
        internal SpeechController(ISpeechPlatform platform, Action<Action> post, Action<Dictionary<string, object>> output, Action exit)
        { this.platform = platform; this.post = post; this.output = output; this.exit = exit; }
        private void Reply(string id, Dictionary<string, object> result = null) { output(Json.Map("id", id, "ok", true, "result", result ?? Json.Map())); }
        internal void Reject(string id, SpeechFailure error) { output(Json.Map("id", id, "ok", false, "code", error.Code, "error", error.Message)); }
        private void Event(string id, string type, string text = null, string code = null)
        {
            var value = Json.Map("event", true, "sessionId", id, "type", type);
            if (text != null) value["text"] = text;
            if (code != null) value["code"] = code;
            output(value);
        }
        internal void Accept(byte[] bytes)
        {
            if (closed) return;
            SpeechCommand command;
            try { command = SpeechCommand.Parse(bytes, false); }
            catch (SpeechFailure error) { Reject("", error); return; }
            Handle(command);
        }
        internal void Handle(SpeechCommand command)
        {
            if (closed) return;
            try
            {
                command.Validate();
                switch (command.Command)
                {
                    case "capabilities": Reply(command.Id, platform.Capabilities(command.Locale)); break;
                    case "listen": Listen(command); break;
                    case "stop-listening": StopListening(command); break;
                    case "speak": Speak(command); break;
                    case "stop-speaking": StopSpeaking(command); break;
                    case "shutdown": Shutdown(command.Id); break;
                }
            }
            catch (SpeechFailure error) { Reject(command.Id != null && SpeechCommand.Identifier.IsMatch(command.Id) ? command.Id : "", error); }
            catch { Reject(command.Id != null && SpeechCommand.Identifier.IsMatch(command.Id) ? command.Id : "", new SpeechFailure("recognition-failed", "The Windows speech command could not complete.")); }
        }
        private void RequireIdle() { if (IsBusy) throw new SpeechFailure("busy", "Stop the current listening or speaking session first."); }
        private static void Match(string requested, string actual)
        { if (requested != null && requested != actual) throw new SpeechFailure("stale-session", "The speech session has already changed."); }
        private void Listen(SpeechCommand command)
        {
            RequireIdle();
            var session = new Listening { Id = command.SessionId };
            listening = session;
            Reply(command.Id, Json.Map("accepted", true, "sessionId", session.Id));
            post(() =>
            {
                if (closed || listening != session) return;
                try
                {
                    session.Driver = platform.CreateRecognition(command.Locale ?? CultureInfo.CurrentUICulture.Name);
                    session.Driver.Start((text, final) => post(() =>
                    {
                        if (listening != session || closed) return;
                        try { Event(session.Id, final ? "final" : "partial", session.Transcript.Update(text, final)); }
                        catch (SpeechFailure error) { Fail(session, error); }
                    }), error => post(() => Fail(session, error)));
                    Event(session.Id, "listening");
                }
                catch (SpeechFailure error) { Fail(session, error); }
                catch { Fail(session, new SpeechFailure("recognition-failed", "Windows speech recognition could not start.")); }
            });
        }
        private static void Release(IRecognition driver)
        {
            if (driver == null) return;
            try { driver.Cancel(); } catch { }
            try { driver.Dispose(); } catch { }
        }
        private static void Release(ISynthesis driver)
        {
            if (driver == null) return;
            try { driver.Cancel(); } catch { }
            try { driver.Dispose(); } catch { }
        }
        private void Fail(Listening session, SpeechFailure error)
        {
            if (listening != session || closed) return;
            listening = null; Release(session.Driver);
            Event(session.Id, "error", code: error.Code);
        }
        private void StopListening(SpeechCommand command)
        {
            var session = listening;
            if (session == null) { Reply(command.Id, Json.Map("text", "")); return; }
            Match(command.SessionId, session.Id);
            listening = null; // Invalidate before native cancellation/disposal.
            Release(session.Driver);
            string text = session.Transcript.Text;
            Event(session.Id, "final", text);
            Reply(command.Id, Json.Map("text", text));
        }
        private void Speak(SpeechCommand command)
        {
            RequireIdle();
            var voices = platform.Voices();
            var segments = command.Segments ?? new[] { new SpeechSegment { Text = command.Text, Locale = command.Locale ?? CultureInfo.CurrentUICulture.Name, VoiceId = command.VoiceId } };
            var plans = segments.Select(segment => new Utterance { Text = segment.Text, Voice = VoiceSelection.Select(voices, segment.Locale, segment.VoiceId), Pause = segment.PauseAfter ?? 0 }).ToArray();
            var session = new Speaking { Id = command.SessionId };
            speaking = session;
            bool acknowledged = false;
            try
            {
                session.Driver = platform.CreateSynthesis();
                // The reply precedes all queued callbacks, including a tiny prompt.
                Reply(command.Id, Json.Map("accepted", true, "sessionId", session.Id));
                acknowledged = true;
                session.Driver.Start(plans, VoiceSelection.Rate(command.Rate), () => post(() =>
                {
                    if (closed || speaking != session || session.Started) return;
                    session.Started = true; Event(session.Id, "speech-start");
                }), error => post(() =>
                {
                    if (closed || speaking != session) return;
                    speaking = null; Release(session.Driver);
                    if (error == null) Event(session.Id, "speech-end");
                    else Event(session.Id, "error", code: error.Code);
                }));
            }
            catch (SpeechFailure error)
            {
                speaking = null; Release(session.Driver);
                if (acknowledged) Event(session.Id, "error", code: error.Code); else throw;
            }
            catch
            {
                speaking = null; Release(session.Driver);
                if (acknowledged) Event(session.Id, "error", code: "synthesis-failed");
                else throw new SpeechFailure("synthesis-failed", "Windows could not create the speech synthesizer.");
            }
        }
        private void StopSpeaking(SpeechCommand command)
        {
            var session = speaking;
            if (session != null)
            {
                Match(command.SessionId, session.Id);
                speaking = null; Release(session.Driver);
                Event(session.Id, "speech-end", code: "cancelled");
            }
            Reply(command.Id);
        }
        internal void Shutdown(string id = null)
        {
            if (closed) return;
            closed = true;
            var oldListening = listening; var oldSpeaking = speaking;
            listening = null; speaking = null;
            Release(oldListening == null ? null : oldListening.Driver);
            Release(oldSpeaking == null ? null : oldSpeaking.Driver);
            if (id != null) Reply(id);
            exit();
        }
    }
}
