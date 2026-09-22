using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;

[assembly: AssemblyTitle("Pairleaf Windows Speech")]
[assembly: AssemblyProduct("Pairleaf")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace Pairleaf.Speech
{
    internal static class Program
    {
        [MTAThread]
        private static int Main()
        {
            // No shell, sockets, HTTP, files, telemetry or persisted transcripts.
            // Standard handles are opened explicitly: UTF-8, no console banner.
            var work = new BlockingCollection<Action>();
            var exited = false;
            var lastActivity = DateTime.UtcNow;
            using (var writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true })
            {
                Action<Action> post = action => { if (!work.IsAddingCompleted) { try { work.Add(action); } catch (InvalidOperationException) { } } };
                var controller = new SpeechController(new WindowsSpeechPlatform(), post,
                    message => { try { writer.WriteLine(Json.Write(message)); } catch (IOException) { Environment.Exit(0); } },
                    () => { exited = true; work.CompleteAdding(); });
                var reader = new Thread(() =>
                {
                    try
                    {
                        var framing = new JsonLines();
                        using (var input = Console.OpenStandardInput())
                        {
                            var bytes = new byte[8192]; int count;
                            Action<byte[]> line = value => post(() => { lastActivity = DateTime.UtcNow; controller.Accept(value); });
                            while ((count = input.Read(bytes, 0, bytes.Length)) > 0)
                                framing.Append(bytes, count, line, () => post(() => controller.Reject("", new SpeechFailure("invalid-request", "JSON line exceeds 1 MiB."))));
                            framing.Finish(line);
                        }
                    }
                    catch (IOException) { }
                    finally { post(() => controller.Shutdown()); }
                }) { IsBackground = true, Name = "Pairleaf speech input" };
                reader.Start();
                Console.CancelKeyPress += (sender, args) => { args.Cancel = true; post(() => controller.Shutdown()); };
                // The Electron supervisor normally exits an idle helper after
                // two seconds. This backstop also covers standalone invocation.
                using (var idle = new Timer(state => post(() =>
                {
                    if (!controller.IsBusy && DateTime.UtcNow - lastActivity > TimeSpan.FromSeconds(30)) controller.Shutdown();
                }), null, 5000, 5000))
                {
                    foreach (var action in work.GetConsumingEnumerable())
                    {
                        if (exited) break;
                        try { action(); }
                        catch { controller.Shutdown(); }
                    }
                }
            }
            return 0;
        }
    }
}
