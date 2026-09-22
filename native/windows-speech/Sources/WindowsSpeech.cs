using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Speech.Recognition;
using System.Speech.Synthesis;
using System.Text;

namespace Pairleaf.Speech
{
    internal sealed class WindowsSpeechPlatform : ISpeechPlatform
    {
        internal static string StableVoiceId(string nativeId)
        {
            using (var hash = SHA256.Create())
                return "windows.sapi." + String.Concat(hash.ComputeHash(Encoding.UTF8.GetBytes(nativeId)).Select(value => value.ToString("x2")));
        }
        public SpeechVoice[] Voices()
        {
            try
            {
                using (var synth = new SpeechSynthesizer())
                {
                    synth.SetOutputToNull();
                    var defaultId = synth.Voice == null ? null : synth.Voice.Id;
                    return synth.GetInstalledVoices().Where(voice => voice.Enabled)
                        .Select(voice => voice.VoiceInfo)
                        .Where(voice => !String.IsNullOrWhiteSpace(voice.Id) && !String.IsNullOrWhiteSpace(voice.Name)
                            && voice.Name.Length <= 160 && !voice.Name.Any(Char.IsControl) && SpeechCommand.ValidLocale(voice.Culture.Name))
                        .Select(voice => new SpeechVoice { Id = StableVoiceId(voice.Id), Name = voice.Name, Locale = voice.Culture.Name, Preferred = voice.Id == defaultId })
                        .GroupBy(voice => voice.Id).Select(group => group.First()).Take(1024).ToArray();
                }
            }
            catch { return new SpeechVoice[0]; }
        }
        private static RecognizerInfo[] Recognizers()
        {
            try { return SpeechRecognitionEngine.InstalledRecognizers().Where(item => SpeechCommand.ValidLocale(item.Culture.Name)).Take(512).ToArray(); }
            catch { return new RecognizerInfo[0]; }
        }
        private static SpeechRecognitionEngine OpenDictation(RecognizerInfo info)
        {
            var engine = new SpeechRecognitionEngine(info);
            try
            {
                // No SetInputToDefaultAudioDevice here: capability checks must
                // load the dictation grammar without taking microphone access.
                engine.SetInputToNull();
                engine.LoadGrammar(new DictationGrammar());
                return engine;
            }
            catch { engine.Dispose(); throw; }
        }
        public Dictionary<string, object> Capabilities(string locale)
        {
            var locales = new List<string>();
            foreach (var info in Recognizers())
            {
                try { using (var engine = OpenDictation(info)) locales.Add(info.Culture.Name); }
                catch { /* A registry token alone does not establish usable dictation. */ }
            }
            var requested = (locale ?? CultureInfo.CurrentUICulture.Name).Replace('_', '-');
            bool available = locales.Any(item => String.Equals(item, requested, StringComparison.OrdinalIgnoreCase));
            var result = Json.Map("available", available, "engine", "windows-speech", "locales", locales.Distinct().ToArray(),
                "voices", Voices().Select(voice => voice.ToJson()).ToArray(), "needsModelDownload", false);
            if (!available) result["reason"] = locales.Count == 0 ? "recognizer-unavailable" : "unsupported-locale";
            return result;
        }
        public IRecognition CreateRecognition(string locale)
        {
            var recognizers = Recognizers();
            if (recognizers.Length == 0) throw new SpeechFailure("recognizer-unavailable", "No local Windows dictation engine is installed.");
            var matching = recognizers.Where(info => String.Equals(info.Culture.Name, locale.Replace('_', '-'), StringComparison.OrdinalIgnoreCase)).ToArray();
            if (matching.Length == 0) throw new SpeechFailure("unsupported-locale", "No local Windows dictation engine supports this language.");
            foreach (var info in matching)
            {
                try { return new WindowsRecognition(OpenDictation(info)); }
                catch { }
            }
            throw new SpeechFailure("recognizer-unavailable", "Windows could not load the local dictation engine.");
        }
        public ISynthesis CreateSynthesis() { return new WindowsSynthesis(); }
    }

    internal sealed class WindowsRecognition : IRecognition
    {
        private readonly SpeechRecognitionEngine engine;
        private volatile bool stopping;
        private bool disposed;
        internal WindowsRecognition(SpeechRecognitionEngine engine) { this.engine = engine; }
        public void Start(Action<string, bool> receive, Action<SpeechFailure> failed)
        {
            engine.InitialSilenceTimeout = TimeSpan.Zero;
            engine.BabbleTimeout = TimeSpan.Zero;
            engine.EndSilenceTimeout = TimeSpan.FromMilliseconds(450);
            engine.EndSilenceTimeoutAmbiguous = TimeSpan.FromMilliseconds(700);
            engine.SpeechHypothesized += (sender, args) => { if (!stopping && args.Result != null) receive(args.Result.Text, false); };
            engine.SpeechRecognized += (sender, args) => { if (!stopping && args.Result != null) receive(args.Result.Text, true); };
            engine.SpeechRecognitionRejected += (sender, args) => { if (!stopping) receive("", false); };
            engine.RecognizeCompleted += (sender, args) =>
            {
                if (!stopping) failed(new SpeechFailure("recognition-failed", "Windows speech recognition stopped unexpectedly."));
            };
            try { engine.SetInputToDefaultAudioDevice(); }
            catch (UnauthorizedAccessException) { throw new SpeechFailure("microphone-denied", "Windows denied microphone access."); }
            catch (Exception error)
            {
                throw new SpeechFailure(error.HResult == unchecked((int)0x80070005) ? "microphone-denied" : "audio-unavailable", "Windows could not open the microphone.");
            }
            try { engine.RecognizeAsync(RecognizeMode.Multiple); }
            catch { throw new SpeechFailure("recognition-failed", "Windows speech recognition could not start."); }
        }
        public void Cancel()
        {
            if (stopping || disposed) return;
            stopping = true;
            // RecognizeAsyncStop keeps accepting microphone input until a phrase
            // ends. Cancel followed by Dispose releases it without that wait.
            engine.RecognizeAsyncCancel();
        }
        public void Dispose()
        {
            if (disposed) return;
            stopping = true; disposed = true;
            engine.Dispose();
        }
    }

    internal sealed class WindowsSynthesis : ISynthesis
    {
        private readonly SpeechSynthesizer synth = new SpeechSynthesizer();
        private volatile bool stopping;
        private bool disposed;
        public void Start(Utterance[] segments, int rate, Action started, Action<SpeechFailure> finished)
        {
            // Build one prompt, allowing native voice changes within sentences.
            // AppendText escapes text as text; no user/AI SSML is interpreted.
            var prompt = new PromptBuilder(new CultureInfo(segments[0].Voice.Locale));
            foreach (var segment in segments)
            {
                // SAPI selects by voice name. Verify that a disappeared or
                // ambiguous name cannot silently replace an explicit token ID.
                try { synth.SelectVoice(segment.Voice.Name); }
                catch { throw new SpeechFailure("voice-unavailable", "The selected Windows voice is unavailable."); }
                if (WindowsSpeechPlatform.StableVoiceId(synth.Voice.Id) != segment.Voice.Id)
                    throw new SpeechFailure("voice-unavailable", "The selected Windows voice is unavailable.");
                prompt.StartVoice(segment.Voice.Name);
                prompt.AppendText(segment.Text);
                if (segment.Pause > 0) prompt.AppendBreak(TimeSpan.FromSeconds(segment.Pause));
                prompt.EndVoice();
            }
            synth.Rate = rate;
            synth.SpeakStarted += (sender, args) => { if (!stopping) started(); };
            synth.SpeakCompleted += (sender, args) =>
            {
                if (!stopping) finished(args.Error == null && !args.Cancelled ? null : new SpeechFailure("synthesis-failed", "Windows could not complete speech playback."));
            };
            synth.SetOutputToDefaultAudioDevice();
            synth.SpeakAsync(prompt);
        }
        public void Cancel()
        {
            if (stopping || disposed) return;
            stopping = true;
            synth.SpeakAsyncCancelAll();
        }
        public void Dispose()
        {
            if (disposed) return;
            stopping = true; disposed = true;
            synth.Dispose();
        }
    }
}
