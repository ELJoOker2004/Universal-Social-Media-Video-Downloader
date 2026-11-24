using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

internal static class NativeHostLauncher
{
    private static bool CopyFrame(Stream source, Stream destination, int maximumLength)
    {
        byte[] header = new byte[4];
        int headerRead = source.Read(header, 0, header.Length);
        if (headerRead == 0) return false;
        while (headerRead < header.Length)
        {
            int count = source.Read(header, headerRead, header.Length - headerRead);
            if (count == 0) throw new EndOfStreamException("Incomplete native message header.");
            headerRead += count;
        }

        int remaining = BitConverter.ToInt32(header, 0);
        if (remaining < 1 || remaining > maximumLength)
            throw new InvalidDataException("Invalid native message length.");

        destination.Write(header, 0, header.Length);
        byte[] buffer = new byte[Math.Min(8192, remaining)];
        while (remaining > 0)
        {
            int count = source.Read(buffer, 0, Math.Min(buffer.Length, remaining));
            if (count == 0) throw new EndOfStreamException("Incomplete native message body.");
            destination.Write(buffer, 0, count);
            remaining -= count;
        }
        destination.Flush();
        return true;
    }

    private static int Main()
    {
        try
        {
            string script = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "host.ps1");
            if (!File.Exists(script) || script.IndexOf('"') >= 0)
                throw new InvalidOperationException("The native host script is missing or has an invalid path.");

            string powershell = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.System),
                @"WindowsPowerShell\v1.0\powershell.exe");
            var start = new ProcessStartInfo(powershell,
                "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\"");
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;

            using (Process child = Process.Start(start))
            {
                var input = new Thread(() =>
                {
                    try
                    {
                        Stream browserInput = Console.OpenStandardInput();
                        Stream hostInput = child.StandardInput.BaseStream;
                        while (CopyFrame(browserInput, hostInput, 65536)) { }
                        child.StandardInput.Close();
                    }
                    catch (IOException) { }
                    catch (ObjectDisposedException) { }
                });
                input.IsBackground = true;
                input.Start();

                var errors = new Thread(() =>
                {
                    try { child.StandardError.BaseStream.CopyTo(Console.OpenStandardError()); }
                    catch (IOException) { }
                    catch (ObjectDisposedException) { }
                });
                errors.IsBackground = true;
                errors.Start();

                Stream hostOutput = child.StandardOutput.BaseStream;
                Stream browserOutput = Console.OpenStandardOutput();
                while (CopyFrame(hostOutput, browserOutput, 1048576)) { }
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
