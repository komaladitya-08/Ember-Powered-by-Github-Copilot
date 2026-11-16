// Fixed host-built diagnostic only; never a model tool or a production startup hook.
using System;
using System.IO;
using System.Text;

public class StartupHook
{
    private static string state;

    public static void Initialize()
    {
        // Diagnostics must not replace the original startup failure with an exception of their own.
        try
        {
            state = Environment.GetEnvironmentVariable("EMBER_LPAC_STATE");
            if (String.IsNullOrEmpty(state)) return;
            AppDomain.CurrentDomain.UnhandledException += OnUnhandled;
            TryWrite("startup-hook.json", "{\"installed\":true}");
        }
        catch { }
    }

    private static void OnUnhandled(object sender, UnhandledExceptionEventArgs args)
    {
        try
        {
            Exception exception = args.ExceptionObject as Exception;
            string text = "IsTerminating: " + args.IsTerminating + "\n"
                + (exception == null ? "Unhandled exception object was not an Exception." : exception.ToString());
            if (text.Length > 6000) text = text.Substring(0, 6000) + "\n[startup exception truncated]";
            TryWrite("startup-exception.txt", text);
        }
        catch { }
    }

    private static void TryWrite(string name, string text)
    {
        try { File.WriteAllText(Path.Combine(state, name), text, new UTF8Encoding(false)); }
        catch { }
    }
}
