// Ember's askpass helper for Win32-OpenSSH (design §5.1.6, L15).
//
// ssh.exe (8.4 or newer, with SSH_ASKPASS_REQUIRE=force) starts this program with CreateProcess and its prompt as the
// argument when it needs a password, a key's passphrase, a code or a new host key's acceptance. The prompt can be the
// server's own text, so this is a compiled program that reads its arguments as data only: never a .cmd (cmd would run
// "&...&" in a prompt) and never Ember.exe (Node or Chromium would read a prompt such as --eval=... as an option).
// It connects to the per-run named pipe in EMBER_ASKPASS_PIPE (only the user's SID may open it), proves itself with
// EMBER_ASKPASS_NONCE, sends {v, nonce, mode, prompt} as one JSON line, and prints the answer Ember sends back
// ({"ok":true,"value64":"<base64>"}) as UTF-8 for ssh. Anything else exits 1, which ssh takes as "cancelled". It logs
// nothing and writes nothing to disk. Ember compiles it at first use with Windows PowerShell 5.1's Add-Type into
// <userData>\ssh\ember-askpass.exe and checks the build's SHA-256 before every use.

using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.RegularExpressions;

public static class EmberAskpass
{
    const int PromptMax = 2048;
    const int AnswerMax = 65536;

    public static int Main(string[] args)
    {
        try
        {
            string pipe = Environment.GetEnvironmentVariable("EMBER_ASKPASS_PIPE") ?? "";
            string nonce = Environment.GetEnvironmentVariable("EMBER_ASKPASS_NONCE") ?? "";
            string hint = Environment.GetEnvironmentVariable("SSH_ASKPASS_PROMPT") ?? "";
            Match name = Regex.Match(pipe, @"^\\\\\.\\pipe\\(ember-askpass-[0-9a-f]{16})$");
            if (!name.Success || !Regex.IsMatch(nonce, "^[0-9a-f]{32}$")) return 1;
            // CreateProcess quoting may split a prompt that starts with a quote: the words are joined back as data.
            string prompt = string.Join(" ", args);
            if (prompt.Length > PromptMax) prompt = prompt.Substring(0, PromptMax);
            string mode = hint == "confirm" ? "confirm" : hint == "none" ? "notify" : "secret";
            using (NamedPipeClientStream client = new NamedPipeClientStream(".", name.Groups[1].Value, PipeDirection.InOut))
            {
                client.Connect(10000);
                string request = "{\"v\":1,\"nonce\":\"" + nonce + "\",\"mode\":\"" + mode + "\",\"prompt\":" + JsonString(prompt) + "}\n";
                byte[] bytes = Encoding.UTF8.GetBytes(request);
                client.Write(bytes, 0, bytes.Length);
                client.Flush();
                string line = ReadLine(client);
                if (line == null) return 1;
                Match ok = Regex.Match(line, "^\\{\"ok\":true,\"value64\":\"([A-Za-z0-9+/]*={0,2})\"\\}$");
                if (!ok.Success) return 1;
                byte[] value = Convert.FromBase64String(ok.Groups[1].Value);
                using (Stream stdout = Console.OpenStandardOutput())
                {
                    stdout.Write(value, 0, value.Length);
                    stdout.WriteByte((byte)'\n');
                    stdout.Flush();
                }
                return 0;
            }
        }
        catch (Exception)
        {
            return 1;
        }
    }

    // A JSON string literal: quotes, backslashes and every control or line-separator character escaped.
    static string JsonString(string s)
    {
        StringBuilder b = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c < 0x20 || c == 0x7f || c == ' ' || c == ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }

    // One line of the answer (without its newline), or null at the end or past AnswerMax bytes.
    static string ReadLine(Stream s)
    {
        MemoryStream line = new MemoryStream();
        for (;;)
        {
            int c = s.ReadByte();
            if (c < 0 || line.Length > AnswerMax) return null;
            if (c == '\n') return Encoding.UTF8.GetString(line.ToArray());
            line.WriteByte((byte)c);
        }
    }
}
