using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;

namespace Pairleaf.Speech
{
    internal sealed class SpeechFailure : Exception
    {
        internal readonly string Code;
        internal SpeechFailure(string code, string message) : base(message) { Code = code; }
    }

    [DataContract]
    internal sealed class SpeechSegment
    {
        [DataMember(Name = "text")] public string Text { get; set; }
        [DataMember(Name = "locale")] public string Locale { get; set; }
        [DataMember(Name = "voiceId")] public string VoiceId { get; set; }
        [DataMember(Name = "pauseAfter")] public double? PauseAfter { get; set; }
    }

    [DataContract]
    internal sealed class SpeechCommand
    {
        [DataMember(Name = "id")] public string Id { get; set; }
        [DataMember(Name = "command")] public string Command { get; set; }
        [DataMember(Name = "sessionId")] public string SessionId { get; set; }
        [DataMember(Name = "locale")] public string Locale { get; set; }
        [DataMember(Name = "text")] public string Text { get; set; }
        [DataMember(Name = "voiceId")] public string VoiceId { get; set; }
        [DataMember(Name = "rate")] public double? Rate { get; set; }
        [DataMember(Name = "allowModelDownload")] public bool? AllowModelDownload { get; set; }
        [DataMember(Name = "segments")] public SpeechSegment[] Segments { get; set; }

        internal static readonly Regex Identifier = new Regex(@"\A[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\z", RegexOptions.CultureInvariant);
        internal static readonly Regex VoiceIdentifier = new Regex(@"\Awindows\.sapi\.[a-f0-9]{64}\z", RegexOptions.CultureInvariant);
        internal static readonly Regex Language = new Regex(@"\A[A-Za-z]{2,8}([-_][A-Za-z0-9]{1,8})*\z", RegexOptions.CultureInvariant);
        internal void Validate()
        {
            if (Id == null || !Identifier.IsMatch(Id)) Invalid();
            if (!new[] { "capabilities", "listen", "stop-listening", "speak", "stop-speaking", "shutdown" }.Contains(Command)) Invalid();
            if (SessionId != null && !Identifier.IsMatch(SessionId)) Invalid();
            if ((Command == "listen" || Command == "speak") && SessionId == null) Invalid();
            if (Locale != null && !ValidLocale(Locale)) Invalid();
            if (VoiceId != null && !VoiceIdentifier.IsMatch(VoiceId)) Invalid();
            if (Rate.HasValue && (!Finite(Rate.Value) || Rate < 0.1 || Rate > 1)) Invalid();
            if (Command != "speak") return;
            if (!ValidText(Text) || Encoding.UTF8.GetByteCount(Text) > 131072) Invalid();
            if (Segments == null) return;
            if (Segments.Length == 0 || Segments.Length > 256) Invalid();
            foreach (var segment in Segments)
            {
                if (segment == null || !ValidText(segment.Text) || !ValidLocale(segment.Locale)) Invalid();
                if (segment.VoiceId != null && !VoiceIdentifier.IsMatch(segment.VoiceId)) Invalid();
                if (segment.PauseAfter.HasValue && (!Finite(segment.PauseAfter.Value) || segment.PauseAfter < 0 || segment.PauseAfter > 0.5)) Invalid();
            }
            if (String.Concat(Segments.Select(segment => segment.Text)) != Text) Invalid();
        }
        internal static bool ValidLocale(string value) { return value != null && value.Length <= 64 && Language.IsMatch(value); }
        internal static bool ValidText(string value) { return !String.IsNullOrWhiteSpace(value) && value.IndexOf('\0') < 0; }
        private static bool Finite(double value) { return !Double.IsNaN(value) && !Double.IsInfinity(value); }
        private static void Invalid() { throw new SpeechFailure("invalid-request", "Invalid speech command."); }
        internal static SpeechCommand Parse(byte[] bytes, bool validate = true)
        {
            if (bytes.Length > JsonLines.Limit) Invalid();
            try
            {
                new UTF8Encoding(false, true).GetString(bytes);
                var quotas = new XmlDictionaryReaderQuotas { MaxDepth = 16, MaxStringContentLength = JsonLines.Limit, MaxArrayLength = 1024 };
                // The framework serializer otherwise coerces numeric IDs and
                // quoted rates. Validate the JSON node types before binding DTOs.
                using (var shapeReader = JsonReaderWriterFactory.CreateJsonReader(bytes, quotas))
                {
                    var document = new XmlDocument { XmlResolver = null };
                    document.Load(shapeReader);
                    CheckObjectTypes(document.DocumentElement, false);
                }
                using (var reader = JsonReaderWriterFactory.CreateJsonReader(bytes, quotas))
                {
                    var serializer = new DataContractJsonSerializer(typeof(SpeechCommand), new DataContractJsonSerializerSettings { MaxItemsInObjectGraph = 4096 });
                    var command = (SpeechCommand)serializer.ReadObject(reader);
                    if (command == null) Invalid();
                    if (validate) command.Validate();
                    return command;
                }
            }
            catch (SpeechFailure) { throw; }
            catch { throw new SpeechFailure("invalid-request", "Expected a valid UTF-8 JSON speech command."); }
        }
        private static void CheckObjectTypes(XmlElement node, bool segment)
        {
            if (node == null || node.GetAttribute("type") != "object") Invalid();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (XmlNode child in node.ChildNodes)
            {
                var element = child as XmlElement;
                if (element == null) continue;
                string name = element.LocalName, type = element.GetAttribute("type"), expected = null;
                if (!seen.Add(name)) Invalid();
                if (new[] { "text", "locale", "voiceId" }.Contains(name)) expected = "string";
                if (!segment && new[] { "id", "command", "sessionId" }.Contains(name)) expected = "string";
                if (name == (segment ? "pauseAfter" : "rate")) expected = "number";
                if (!segment && name == "allowModelDownload") expected = "boolean";
                if (!segment && name == "segments")
                {
                    if (type == "null") continue;
                    if (type != "array") Invalid();
                    foreach (XmlNode item in element.ChildNodes) CheckObjectTypes(item as XmlElement, true);
                    continue;
                }
                if (expected != null && type != expected && type != "null") Invalid();
            }
        }
    }

    // Framing consumes bytes rather than ReadLine, so an untrusted line cannot
    // grow without a bound. Oversized lines cause one error and drain to newline.
    internal sealed class JsonLines
    {
        internal const int Limit = 1048576;
        private readonly MemoryStream buffer = new MemoryStream();
        private bool discarding;
        internal void Append(byte[] bytes, int count, Action<byte[]> line, Action overflow)
        {
            for (int i = 0; i < count; i++)
            {
                if (bytes[i] == 10)
                {
                    if (!discarding && buffer.Length > 0) line(buffer.ToArray());
                    buffer.SetLength(0); discarding = false;
                }
                else if (!discarding)
                {
                    if (buffer.Length >= Limit) { buffer.SetLength(0); discarding = true; overflow(); }
                    else buffer.WriteByte(bytes[i]);
                }
            }
        }
        internal void Finish(Action<byte[]> line)
        {
            if (!discarding && buffer.Length > 0) line(buffer.ToArray());
            buffer.SetLength(0); discarding = false;
        }
    }

    internal static class Json
    {
        internal static Dictionary<string, object> Map(params object[] pairs)
        {
            var value = new Dictionary<string, object>();
            for (int i = 0; i < pairs.Length; i += 2) value.Add((string)pairs[i], pairs[i + 1]);
            return value;
        }
        internal static string Write(object value)
        {
            if (value == null) return "null";
            if (value is string) return Quote((string)value);
            if (value is bool) return (bool)value ? "true" : "false";
            var dictionary = value as IDictionary<string, object>;
            if (dictionary != null) return "{" + String.Join(",", dictionary.Select(item => Quote(item.Key) + ":" + Write(item.Value))) + "}";
            var list = value as IEnumerable;
            if (list != null) return "[" + String.Join(",", list.Cast<object>().Select(Write)) + "]";
            if (value is int || value is long || value is double) return Convert.ToString(value, CultureInfo.InvariantCulture);
            throw new InvalidOperationException("Unsupported JSON value.");
        }
        private static string Quote(string text)
        {
            var result = new StringBuilder("\"");
            foreach (char ch in text)
            {
                if (ch == '"' || ch == '\\') result.Append('\\').Append(ch);
                else if (ch < 32 || Char.IsSurrogate(ch)) result.Append("\\u").Append(((int)ch).ToString("x4"));
                else result.Append(ch);
            }
            return result.Append('"').ToString();
        }
    }
}
