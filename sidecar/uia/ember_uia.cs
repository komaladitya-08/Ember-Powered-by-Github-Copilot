// Ember's Windows UI Automation bridge. The wire protocol is in PROTOCOL.md beside this file.
//
// The bridge exposes raw UI Automation facts and actions to Ember's TypeScript sidecar host and decides nothing:
// roles, secrets, labels and element ids are the host's. Its one safety job is never to read a password field's
// value or text. Every app call runs on a worker thread with a deadline, so a hung app costs a "busy" answer and
// never stalls requests for the others.
//
// Windows PowerShell 5.1 compiles this file with Add-Type, which runs the .NET Framework's C# 5 compiler: no string
// interpolation, null-conditional operators, nameof, expression-bodied members or lambdas, auto-property
// initialisers, out variables, tuples, pattern matching or local functions. Only mscorlib, System,
// UIAutomationClient, UIAutomationTypes and WindowsBase are referenced (no System.Core: no LINQ, no HashSet). The
// file stays ASCII because the compiler reads a file without a byte-order mark in the ANSI code page; write any
// other character as \uXXXX. test/unit/uia-files.test.ts checks all of this.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Text;

namespace Ember.Uia
{
  // ---- core begins: nothing between here and "core ends" uses UI Automation or Win32, so this part also builds
  // and runs on its own (the bridge's transport tests drive it with fake methods under .NET on Linux).

  /// <summary>A JSON object whose keys keep their insertion order.</summary>
  internal sealed class JObj
  {
    private readonly List<string> keys = new List<string>();
    private readonly List<object> values = new List<object>();

    internal int Count { get { return keys.Count; } }

    internal string KeyAt(int i) { return keys[i]; }

    internal object ValueAt(int i) { return values[i]; }

    /// <summary>Sets a key (replacing its value in place when it is already there).</summary>
    internal JObj Add(string key, object value)
    {
      int i = keys.IndexOf(key);
      if (i >= 0) values[i] = value;
      else
      {
        keys.Add(key);
        values.Add(value);
      }
      return this;
    }

    internal bool Has(string key) { return keys.IndexOf(key) >= 0; }

    internal object Get(string key)
    {
      int i = keys.IndexOf(key);
      return i < 0 ? null : values[i];
    }
  }

  /// <summary>JSON text that is already serialised (a snapshot taken under a lock).</summary>
  internal sealed class RawJson
  {
    internal readonly string Text;

    internal RawJson(string text) { Text = text; }
  }

  /// <summary>
  /// JSON in and out. Output is ASCII only (everything else is escaped as \uXXXX), so the console code page can never
  /// garble it, and a number that isn't finite is written as null.
  /// </summary>
  internal static class Json
  {
    internal static string Write(object value)
    {
      StringBuilder sb = new StringBuilder(256);
      Append(sb, value, 0);
      return sb.ToString();
    }

    private static void Append(StringBuilder sb, object v, int depth)
    {
      if (depth > 64) throw new InvalidOperationException("the answer is nested too deeply");
      if (v == null) { sb.Append("null"); return; }
      string s = v as string;
      if (s != null) { Quote(sb, s); return; }
      if (v is bool) { sb.Append((bool)v ? "true" : "false"); return; }
      if (v is int || v is long || v is short || v is byte || v is sbyte || v is ushort || v is uint)
      {
        sb.Append(Convert.ToInt64(v, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture));
        return;
      }
      if (v is ulong) { sb.Append(((ulong)v).ToString(CultureInfo.InvariantCulture)); return; }
      if (v is double || v is float || v is decimal)
      {
        double d = Convert.ToDouble(v, CultureInfo.InvariantCulture);
        if (double.IsNaN(d) || double.IsInfinity(d)) sb.Append("null");
        else sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
        return;
      }
      RawJson raw = v as RawJson;
      if (raw != null) { sb.Append(raw.Text); return; }
      JObj o = v as JObj;
      if (o != null)
      {
        sb.Append('{');
        for (int i = 0; i < o.Count; i++)
        {
          if (i > 0) sb.Append(',');
          Quote(sb, o.KeyAt(i));
          sb.Append(':');
          Append(sb, o.ValueAt(i), depth + 1);
        }
        sb.Append('}');
        return;
      }
      IList list = v as IList;
      if (list != null)
      {
        sb.Append('[');
        for (int i = 0; i < list.Count; i++)
        {
          if (i > 0) sb.Append(',');
          Append(sb, list[i], depth + 1);
        }
        sb.Append(']');
        return;
      }
      Quote(sb, Convert.ToString(v, CultureInfo.InvariantCulture));
    }

    internal static void Quote(StringBuilder sb, string s)
    {
      sb.Append('"');
      for (int i = 0; i < s.Length; i++)
      {
        char c = s[i];
        switch (c)
        {
          case '"': sb.Append("\\\""); break;
          case '\\': sb.Append("\\\\"); break;
          case '\n': sb.Append("\\n"); break;
          case '\r': sb.Append("\\r"); break;
          case '\t': sb.Append("\\t"); break;
          default:
            if (c < ' ' || c > '~')
            {
              sb.Append("\\u");
              sb.Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
            }
            else sb.Append(c);
            break;
        }
      }
      sb.Append('"');
    }

    /// <summary>
    /// Parses one JSON value: objects become JObj, arrays List&lt;object&gt;, numbers double. Error messages give
    /// positions only, never the text (a request can carry what the user typed).
    /// </summary>
    internal static object Parse(string text)
    {
      Parser p = new Parser(text);
      p.Space();
      object v = p.Value(0);
      p.Space();
      if (p.Pos != text.Length) throw new FormatException("unexpected text after the value at " + p.Pos);
      return v;
    }

    private sealed class Parser
    {
      private readonly string s;
      internal int Pos;

      internal Parser(string text) { s = text; }

      internal void Space()
      {
        while (Pos < s.Length && (s[Pos] == ' ' || s[Pos] == '\t' || s[Pos] == '\r' || s[Pos] == '\n')) Pos++;
      }

      internal object Value(int depth)
      {
        if (depth > 64) throw new FormatException("nested too deeply at " + Pos);
        if (Pos >= s.Length) throw new FormatException("unexpected end");
        char c = s[Pos];
        if (c == '{') return Obj(depth);
        if (c == '[') return Arr(depth);
        if (c == '"') return Str();
        if (c == 't') { Word("true"); return true; }
        if (c == 'f') { Word("false"); return false; }
        if (c == 'n') { Word("null"); return null; }
        if (c == '-' || (c >= '0' && c <= '9')) return Num();
        throw new FormatException("unexpected character at " + Pos);
      }

      private void Word(string w)
      {
        if (string.CompareOrdinal(s, Pos, w, 0, w.Length) != 0) throw new FormatException("bad literal at " + Pos);
        Pos += w.Length;
      }

      private JObj Obj(int depth)
      {
        JObj o = new JObj();
        Pos++;
        Space();
        if (Pos < s.Length && s[Pos] == '}') { Pos++; return o; }
        while (true)
        {
          Space();
          if (Pos >= s.Length || s[Pos] != '"') throw new FormatException("expected a key at " + Pos);
          string key = Str();
          Space();
          if (Pos >= s.Length || s[Pos] != ':') throw new FormatException("expected ':' at " + Pos);
          Pos++;
          Space();
          o.Add(key, Value(depth + 1));
          Space();
          if (Pos >= s.Length) throw new FormatException("unexpected end in an object");
          if (s[Pos] == ',') { Pos++; continue; }
          if (s[Pos] == '}') { Pos++; return o; }
          throw new FormatException("expected ',' or '}' at " + Pos);
        }
      }

      private List<object> Arr(int depth)
      {
        List<object> a = new List<object>();
        Pos++;
        Space();
        if (Pos < s.Length && s[Pos] == ']') { Pos++; return a; }
        while (true)
        {
          Space();
          a.Add(Value(depth + 1));
          Space();
          if (Pos >= s.Length) throw new FormatException("unexpected end in an array");
          if (s[Pos] == ',') { Pos++; continue; }
          if (s[Pos] == ']') { Pos++; return a; }
          throw new FormatException("expected ',' or ']' at " + Pos);
        }
      }

      private string Str()
      {
        int start = Pos;
        Pos++;
        StringBuilder sb = new StringBuilder();
        while (true)
        {
          if (Pos >= s.Length) throw new FormatException("unterminated string from " + start);
          char c = s[Pos++];
          if (c == '"') return sb.ToString();
          if (c < ' ') throw new FormatException("control character in a string at " + (Pos - 1));
          if (c != '\\') { sb.Append(c); continue; }
          if (Pos >= s.Length) throw new FormatException("unterminated escape at " + (Pos - 1));
          char e = s[Pos++];
          switch (e)
          {
            case '"': sb.Append('"'); break;
            case '\\': sb.Append('\\'); break;
            case '/': sb.Append('/'); break;
            case 'b': sb.Append('\b'); break;
            case 'f': sb.Append('\f'); break;
            case 'n': sb.Append('\n'); break;
            case 'r': sb.Append('\r'); break;
            case 't': sb.Append('\t'); break;
            case 'u':
              int code;
              if (Pos + 4 > s.Length || !int.TryParse(s.Substring(Pos, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out code))
                throw new FormatException("bad \\u escape at " + (Pos - 2));
              sb.Append((char)code);
              Pos += 4;
              break;
            default:
              throw new FormatException("bad escape at " + (Pos - 2));
          }
        }
      }

      private double Num()
      {
        int start = Pos;
        if (s[Pos] == '-') Pos++;
        int digits = Digits();
        if (digits == 0) throw new FormatException("bad number at " + start);
        if (Pos < s.Length && s[Pos] == '.')
        {
          Pos++;
          if (Digits() == 0) throw new FormatException("bad number at " + start);
        }
        if (Pos < s.Length && (s[Pos] == 'e' || s[Pos] == 'E'))
        {
          Pos++;
          if (Pos < s.Length && (s[Pos] == '+' || s[Pos] == '-')) Pos++;
          if (Digits() == 0) throw new FormatException("bad number at " + start);
        }
        double d;
        if (!double.TryParse(s.Substring(start, Pos - start), NumberStyles.Float, CultureInfo.InvariantCulture, out d) || double.IsInfinity(d))
          throw new FormatException("bad number at " + start);
        return d;
      }

      private int Digits()
      {
        int n = 0;
        while (Pos < s.Length && s[Pos] >= '0' && s[Pos] <= '9') { Pos++; n++; }
        return n;
      }
    }
  }

  /// <summary>The fixed wording of errors the host matches on (PROTOCOL.md, "Errors").</summary>
  internal static class Msg
  {
    internal const string Late = "the app did not answer in time";
    internal const string LateAction = "the app did not answer in time (it may still do it)";
    internal const string NotAnswering = "the app is not answering";
    internal const string NoWorker = "too many requests are waiting for apps that do not answer";
    internal const string Gone = "the element is no longer available";
  }

  /// <summary>An error answer: a protocol code, a message, and the process it concerns (0 when none).</summary>
  internal sealed class BridgeError : Exception
  {
    internal readonly string Code;
    internal readonly int Pid;

    internal BridgeError(string code, string message) : this(code, message, 0) { }

    internal BridgeError(string code, string message, int pid) : base(message)
    {
      Code = code;
      Pid = pid;
    }

    internal JObj ToJson()
    {
      JObj e = new JObj().Add("code", Code).Add("message", Message);
      if (Pid > 0) e.Add("pid", Pid);
      return e;
    }
  }

  /// <summary>Reads and checks request parameters.</summary>
  internal static class Args
  {
    internal static BridgeError Bad(string message) { return new BridgeError("bad_request", message); }

    /// <summary>A whole number, clamped to [min, max]; the fallback when it is missing or null.</summary>
    internal static int Int(JObj p, string key, int fallback, int min, int max)
    {
      object v = p.Get(key);
      if (v == null) return fallback;
      if (!(v is double)) throw Bad(key + " must be a number");
      double d = (double)v;
      if (d != Math.Floor(d)) throw Bad(key + " must be a whole number");
      if (d < min) return min;
      if (d > max) return max;
      return (int)d;
    }

    internal static int Handle(JObj p, string key)
    {
      object v = p.Get(key);
      if (!(v is double)) throw Bad(key + " must be a handle (a positive whole number)");
      double d = (double)v;
      if (d < 1 || d > int.MaxValue || d != Math.Floor(d)) throw Bad(key + " must be a handle (a positive whole number)");
      return (int)d;
    }

    internal static double Number(JObj p, string key)
    {
      object v = p.Get(key);
      if (!(v is double)) throw Bad(key + " must be a number");
      return (double)v;
    }

    internal static string Text(JObj p, string key)
    {
      string s = p.Get(key) as string;
      if (s == null) throw Bad(key + " must be a string");
      return s;
    }

    internal static bool Flag(JObj p, string key, bool fallback)
    {
      object v = p.Get(key);
      if (v == null) return fallback;
      if (!(v is bool)) throw Bad(key + " must be true or false");
      return (bool)v;
    }

    internal static List<int> Handles(JObj p, string key)
    {
      IList list = p.Get(key) as IList;
      if (list == null) throw Bad(key + " must be a list of handles");
      List<int> handles = new List<int>(list.Count);
      foreach (object v in list)
      {
        if (!(v is double)) throw Bad(key + " must be a list of handles");
        double d = (double)v;
        if (d >= 1 && d <= int.MaxValue && d == Math.Floor(d)) handles.Add((int)d);
      }
      return handles;
    }
  }

  internal delegate object Handler(Call call);

  internal delegate int TargetOf(Call call);

  internal delegate void Delivery(Call call, object result, BridgeError error);

  /// <summary>One entry of the dispatch table.</summary>
  internal sealed class MethodSpec
  {
    /// <summary>Answered on the reader thread at once (no app is asked).</summary>
    internal const int Inline = 0;
    /// <summary>Reads an app on a worker; a timeout marks the target process busy.</summary>
    internal const int Read = 1;
    /// <summary>Acts in an app on a worker; a timeout marks the process busy only if it stops answering.</summary>
    internal const int Act = 2;

    internal readonly string Name;
    internal readonly Handler Run;
    internal readonly TargetOf Target;
    internal readonly int Kind;

    internal MethodSpec(string name, Handler run, TargetOf target, int kind)
    {
      Name = name;
      Run = run;
      Target = target;
      Kind = kind;
    }
  }

  /// <summary>One request in flight, with its deadline and what happens to its answer.</summary>
  internal sealed class Call
  {
    internal readonly object Id;
    internal readonly string Method;
    internal readonly JObj Params;
    internal readonly int Kind;
    internal readonly int DeadlineMs;
    private readonly long started = Stopwatch.GetTimestamp();

    /// <summary>The process the call touches (0 when none or unknown).</summary>
    internal int Pid;
    /// <summary>A window of that process, for the hung-app probe (zero: find one).</summary>
    internal IntPtr Window;
    /// <summary>What the target function resolved (a handle's entry).</summary>
    internal object Target;
    /// <summary>Answers with what the handler has so far when the deadline passes (null: answer busy).</summary>
    internal Func<object> Partial;
    internal Delivery Deliver;
    internal Server Server;
    internal Timer Timer;
    /// <summary>0 while running, 1 once answered (Interlocked).</summary>
    internal int State;
    /// <summary>The deadline passed and the answer went out without the handler: it should stop soon.</summary>
    internal volatile bool Abandoned;

    // Guarded by Gate.
    internal readonly object Gate = new object();
    internal bool Finished;
    internal bool MarkedBusy;
    internal bool AnsweredPartially;
    internal readonly List<int> Registered = new List<int>();

    internal Call(object id, string method, JObj parameters, int kind, int deadlineMs)
    {
      Id = id;
      Method = method;
      Params = parameters;
      Kind = kind;
      DeadlineMs = deadlineMs;
    }

    internal double ElapsedMs { get { return (Stopwatch.GetTimestamp() - started) * 1000.0 / Stopwatch.Frequency; } }

    internal double RemainingMs { get { return DeadlineMs - ElapsedMs; } }

    /// <summary>Notes a handle this call created, so a call that times out without answering can free them.</summary>
    internal void Track(int handle)
    {
      lock (Gate)
      {
        if (!Finished) Registered.Add(handle);
      }
    }
  }

  /// <summary>A handle's element and what is known about it without asking the app.</summary>
  internal sealed class Entry
  {
    internal readonly int Handle;
    internal readonly object Element;
    internal readonly int Pid;
    internal readonly IntPtr Window;
    internal LinkedListNode<int> Node;

    internal Entry(int handle, object element, int pid, IntPtr window)
    {
      Handle = handle;
      Element = element;
      Pid = pid;
      Window = window;
    }
  }

  /// <summary>
  /// Element handles: positive integers, never reused while the bridge runs, evicted least recently used first past
  /// the cap so a host that forgets to release can't grow the bridge without bound.
  /// </summary>
  internal sealed class HandleTable
  {
    private readonly object gate = new object();
    private readonly Dictionary<int, Entry> map = new Dictionary<int, Entry>();
    private readonly LinkedList<int> lru = new LinkedList<int>();
    private readonly int cap;
    private int next;

    internal HandleTable(int cap) { this.cap = cap; }

    internal int Count { get { lock (gate) return map.Count; } }

    internal int Add(object element, int pid, IntPtr window)
    {
      lock (gate)
      {
        do
        {
          next = next == int.MaxValue ? 1 : next + 1;
        } while (map.ContainsKey(next));
        Entry e = new Entry(next, element, pid, window);
        e.Node = lru.AddLast(next);
        map[next] = e;
        while (map.Count > cap)
        {
          int oldest = lru.First.Value;
          lru.RemoveFirst();
          map.Remove(oldest);
        }
        return next;
      }
    }

    /// <summary>The entry, marked as just used; null when the handle is unknown, released or evicted.</summary>
    internal Entry Get(int handle)
    {
      lock (gate)
      {
        Entry e;
        if (!map.TryGetValue(handle, out e)) return null;
        lru.Remove(e.Node);
        lru.AddLast(e.Node);
        return e;
      }
    }

    internal void Remove(int handle)
    {
      lock (gate)
      {
        Entry e;
        if (!map.TryGetValue(handle, out e)) return;
        lru.Remove(e.Node);
        map.Remove(handle);
      }
    }
  }

  /// <summary>
  /// Worker threads (MTA, as UI Automation clients should be), created on demand up to a cap and reused. A worker
  /// stuck in a hung app is simply away until its call returns; the others carry on.
  /// </summary>
  internal sealed class Pool
  {
    private readonly object gate = new object();
    private readonly Stack<Worker> idle = new Stack<Worker>();
    private readonly int max;
    private readonly Action init;
    private int total;

    internal Pool(int max, Action init)
    {
      this.max = max;
      this.init = init;
    }

    internal int Total { get { lock (gate) return total; } }

    internal int Idle { get { lock (gate) return idle.Count; } }

    /// <summary>Runs work on a free worker; false when every worker is busy and the cap is reached.</summary>
    internal bool Start(Action work)
    {
      Worker w;
      lock (gate)
      {
        if (idle.Count > 0) w = idle.Pop();
        else if (total < max)
        {
          total++;
          w = new Worker(this, init, total);
        }
        else return false;
      }
      w.Give(work);
      return true;
    }

    internal void Return(Worker w)
    {
      lock (gate) idle.Push(w);
    }
  }

  internal sealed class Worker
  {
    private readonly Pool pool;
    private readonly Action init;
    private readonly AutoResetEvent wake = new AutoResetEvent(false);
    private Action work;

    internal Worker(Pool pool, Action init, int number)
    {
      this.pool = pool;
      this.init = init;
      Thread t = new Thread(Loop);
      t.IsBackground = true;
      t.Name = "ember-uia-" + number.ToString(CultureInfo.InvariantCulture);
      t.TrySetApartmentState(ApartmentState.MTA);
      t.Start();
    }

    internal void Give(Action next)
    {
      work = next;
      wake.Set();
    }

    private void Loop()
    {
      if (init != null)
      {
        try { init(); }
        catch (Exception) { /* the thread runs with the process's defaults (reported in the ready line) */ }
      }
      while (true)
      {
        wake.WaitOne();
        Action w = work;
        work = null;
        try
        {
          if (w != null) w();
        }
        catch (Exception) { /* Server.Work answers every failure; nothing may end the thread */ }
        pool.Return(this);
      }
    }
  }

  /// <summary>Counts the sub-calls a call waits for (topWindows reads each process on its own worker).</summary>
  internal sealed class Batch
  {
    private readonly object gate = new object();
    private int pending;

    internal void Add() { lock (gate) pending++; }

    internal void Done()
    {
      lock (gate)
      {
        pending--;
        Monitor.PulseAll(gate);
      }
    }

    /// <summary>Waits until every sub-call answered or the call's own deadline is near; true when all answered.</summary>
    internal bool Wait(Call call, double marginMs)
    {
      lock (gate)
      {
        while (pending > 0)
        {
          double left = call.RemainingMs - marginMs;
          if (left <= 0) return false;
          Monitor.Wait(gate, TimeSpan.FromMilliseconds(left));
        }
        return true;
      }
    }
  }

  /// <summary>
  /// The request loop: reads lines on the calling thread, answers cheap methods there, runs everything else on a
  /// worker with a deadline timer, and writes each answer as one ASCII line as soon as it is known.
  /// </summary>
  internal sealed class Server
  {
    internal const int MaxLine = 1 << 20;
    internal const int DefaultDeadlineMs = 800;

    private readonly Dictionary<string, MethodSpec> methods = new Dictionary<string, MethodSpec>(StringComparer.Ordinal);
    private readonly Stream output;
    private readonly object writeGate = new object();
    private readonly object busyGate = new object();
    private readonly Dictionary<int, int> busy = new Dictionary<int, int>();

    internal readonly Pool Pool;
    internal readonly HandleTable Handles;
    /// <summary>Turns an app-side exception into a protocol error (null: "failed" with the exception's type).</summary>
    internal Func<Exception, BridgeError> MapError;
    /// <summary>Has the call's process stopped answering? Asked after an action times out.</summary>
    internal Func<Call, bool> Hung;
    /// <summary>Ends the process when Environment.Exit doesn't within 1.5 s (a worker stuck in a hung app).</summary>
    internal Action<int> HardExit;
    /// <summary>Called on stdin EOF; tests replace it.</summary>
    internal Action<int> Exit;

    internal Server(MethodSpec[] table, Stream output, HandleTable handles, Pool pool)
    {
      foreach (MethodSpec m in table) methods[m.Name] = m;
      this.output = output;
      Handles = handles;
      Pool = pool;
      Exit = ExitProcess;
    }

    /// <summary>Writes the ready line, then serves until stdin closes.</summary>
    internal int Run(TextReader input, JObj ready)
    {
      Write(Json.Write(ready));
      while (true)
      {
        string line;
        try { line = input.ReadLine(); }
        catch (IOException) { line = null; }
        if (line == null)
        {
          Exit(0);
          return 0;
        }
        try { Handle(line); }
        catch (Exception e) { ToOutput(new Call(null, "", new JObj(), MethodSpec.Inline, 0), null, new BridgeError("failed", e.GetType().Name + ": " + e.Message)); }
      }
    }

    private void Handle(string line)
    {
      if (line.Length > MaxLine) { Refuse(null, "the request is longer than 1 MiB"); return; }
      if (line.Trim().Length == 0) return;
      JObj req;
      try { req = Json.Parse(line) as JObj; }
      catch (FormatException e) { Refuse(null, "the request is not JSON: " + e.Message); return; }
      if (req == null) { Refuse(null, "the request is not a JSON object"); return; }
      object id = req.Get("id");
      if (!(id is double) && !(id is string)) id = null;
      string name = req.Get("method") as string;
      if (name == null) { Refuse(id, "the request has no method"); return; }
      object raw = req.Get("params");
      JObj p = raw as JObj;
      if (raw != null && p == null) { Refuse(id, "params must be an object"); return; }
      if (p == null) p = new JObj();
      MethodSpec spec;
      if (!methods.TryGetValue(name, out spec)) { Refuse(id, "unknown method: " + (name.Length > 64 ? name.Substring(0, 64) : name)); return; }
      int deadline;
      try { deadline = Args.Int(p, "deadlineMs", DefaultDeadlineMs, 50, 4000); }
      catch (BridgeError e) { Refuse(id, e.Message); return; }
      Call c = new Call(id, name, p, spec.Kind, deadline);
      c.Server = this;
      c.Deliver = ToOutput;
      try
      {
        if (spec.Target != null) c.Pid = spec.Target(c);
        if (c.Pid > 0 && IsBusy(c.Pid)) throw new BridgeError("busy", Msg.NotAnswering, c.Pid);
        if (spec.Kind == MethodSpec.Inline)
        {
          object result = spec.Run(c);
          c.State = 1;
          ToOutput(c, result, null);
          return;
        }
      }
      catch (BridgeError e) { c.State = 1; ToOutput(c, null, e); return; }
      catch (Exception e) { c.State = 1; ToOutput(c, null, Map(e, c)); return; }
      Start(c, spec.Run);
    }

    private void Refuse(object id, string message)
    {
      ToOutput(new Call(id, "", new JObj(), MethodSpec.Inline, 0), null, Args.Bad(message));
    }

    /// <summary>Runs a call on a worker; its answer is delivered by the worker or by the deadline, whichever is first.</summary>
    internal void Start(Call c, Handler run)
    {
      c.Timer = new Timer(OnDeadline, c, Math.Max(1, (int)Math.Ceiling(c.RemainingMs)), Timeout.Infinite);
      if (Pool.Start(delegate { Work(c, run); })) return;
      if (Interlocked.CompareExchange(ref c.State, 1, 0) != 0) return;
      c.Timer.Dispose();
      lock (c.Gate) c.Finished = true;
      c.Deliver(c, null, new BridgeError("busy", Msg.NoWorker, c.Pid));
    }

    /// <summary>
    /// Runs part of a call (one process's windows) on its own worker with its own deadline, delivering into a batch
    /// instead of stdout. A process already marked busy is answered at once.
    /// </summary>
    internal void Sub(Call parent, int pid, IntPtr window, double deadlineMs, Handler run, Batch batch, Action<object, BridgeError> done)
    {
      Call s = new Call(parent.Id, parent.Method, parent.Params, MethodSpec.Read, (int)Math.Floor(deadlineMs));
      s.Server = this;
      s.Pid = pid;
      s.Window = window;
      if ((pid > 0 && IsBusy(pid)) || deadlineMs < 1)
      {
        done(null, new BridgeError("busy", deadlineMs < 1 ? Msg.Late : Msg.NotAnswering, pid));
        return;
      }
      s.Deliver = delegate (Call call, object result, BridgeError error)
      {
        try { done(result, error); }
        finally { batch.Done(); }
      };
      batch.Add();
      Start(s, run);
    }

    private void Work(Call c, Handler run)
    {
      object result = null;
      BridgeError error = null;
      try { result = run(c); }
      catch (BridgeError e) { error = e; }
      catch (Exception e) { error = Map(e, c); }
      if (Interlocked.CompareExchange(ref c.State, 1, 0) == 0)
      {
        c.Timer.Dispose();
        try { c.Deliver(c, result, error); }
        catch (Exception) { /* stdout is gone: the reader sees EOF next and exits */ }
      }
      lock (c.Gate)
      {
        c.Finished = true;
        if (c.MarkedBusy) Unmark(c.Pid);
        // A call that timed out with a plain "busy" sent none of its handles: free them.
        if (c.Abandoned && !c.AnsweredPartially) foreach (int h in c.Registered) Handles.Remove(h);
        c.Registered.Clear();
      }
    }

    private void OnDeadline(object state)
    {
      Call c = (Call)state;
      try
      {
        if (Interlocked.CompareExchange(ref c.State, 1, 0) != 0) return;
        object partial = null;
        lock (c.Gate)
        {
          c.Abandoned = true;
          if (c.Partial != null)
          {
            try { partial = c.Partial(); }
            catch (Exception) { partial = null; }
          }
          c.AnsweredPartially = partial != null;
          // A read that timed out marks its process before the answer goes out, so a request sent right after the
          // answer can't start another call into the same hung app.
          if (c.Kind != MethodSpec.Act) MarkBusy(c);
        }
        if (partial != null) c.Deliver(c, partial, null);
        else c.Deliver(c, null, new BridgeError("busy", c.Kind == MethodSpec.Act ? Msg.LateAction : Msg.Late, c.Pid));
        // An action may be waiting on a modal dialog it opened while the app still answers: then it isn't busy.
        // Probing takes up to 300 ms, so it happens after the answer.
        if (c.Kind == MethodSpec.Act && c.Pid > 0 && Hung != null && Hung(c))
        {
          lock (c.Gate) MarkBusy(c);
        }
      }
      catch (Exception) { /* an exception in a timer callback would end the process */ }
    }

    // Callers hold c.Gate.
    private void MarkBusy(Call c)
    {
      if (c.Pid <= 0 || c.Finished || c.MarkedBusy) return;
      c.MarkedBusy = true;
      Mark(c.Pid);
    }

    private BridgeError Map(Exception e, Call c)
    {
      BridgeError b = MapError != null ? MapError(e) : null;
      if (b == null) b = new BridgeError("failed", e.GetType().Name + ": " + e.Message);
      if (b.Pid == 0 && c.Pid > 0) b = new BridgeError(b.Code, b.Message, c.Pid);
      return b;
    }

    private void Mark(int pid)
    {
      lock (busyGate)
      {
        int n;
        busy.TryGetValue(pid, out n);
        busy[pid] = n + 1;
      }
    }

    private void Unmark(int pid)
    {
      lock (busyGate)
      {
        int n;
        if (!busy.TryGetValue(pid, out n)) return;
        if (n <= 1) busy.Remove(pid);
        else busy[pid] = n - 1;
      }
    }

    internal bool IsBusy(int pid)
    {
      lock (busyGate) return busy.ContainsKey(pid);
    }

    internal List<object> BusyPids()
    {
      List<object> pids = new List<object>();
      lock (busyGate)
      {
        foreach (int pid in busy.Keys) pids.Add(pid);
      }
      return pids;
    }

    private void ToOutput(Call c, object result, BridgeError error)
    {
      JObj answer = new JObj().Add("id", c.Id);
      if (error != null) answer.Add("error", error.ToJson());
      else answer.Add("result", result);
      string text;
      try { text = Json.Write(answer); }
      catch (Exception e)
      {
        BridgeError failed = new BridgeError("failed", "the answer could not be written: " + e.Message, c.Pid);
        text = Json.Write(new JObj().Add("id", c.Id).Add("error", failed.ToJson()));
      }
      Write(text);
    }

    private void Write(string line)
    {
      byte[] bytes = Encoding.ASCII.GetBytes(line + "\n");
      lock (writeGate)
      {
        try
        {
          output.Write(bytes, 0, bytes.Length);
          output.Flush();
        }
        catch (IOException) { Exit(0); }
        catch (ObjectDisposedException) { Exit(0); }
      }
    }

    private void ExitProcess(int code)
    {
      Thread backstop = new Thread(delegate ()
      {
        Thread.Sleep(1500);
        try
        {
          if (HardExit != null) HardExit(code);
          else Process.GetCurrentProcess().Kill();
        }
        catch (Exception) { /* nothing else can end it */ }
      });
      backstop.IsBackground = true;
      backstop.Start();
      Environment.Exit(code);
    }
  }

  // ---- core ends

  /// <summary>The entry point that ember_uia.ps1 calls: <c>[Ember.Uia.Bridge]::Run()</c>.</summary>
  public static class Bridge
  {
    /// <summary>The protocol version (PROTOCOL.md).</summary>
    public const int Version = 1;

    /// <summary>
    /// Sets Per-Monitor-V2 DPI awareness, writes the ready line and serves requests from stdin until it closes, then
    /// exits the process with code 0. Returns 1 when it can't start (after writing a fatal line).
    /// </summary>
    public static int Run()
    {
      Stream stdout;
      try { stdout = Console.OpenStandardOutput(); }
      catch (Exception) { return 1; }
      try
      {
        // Before anything touches UI Automation: a DPI-unaware client gets virtualised (scaled) bounds.
        string dpi = Dpi.Setup();
        HandleTable handles = new HandleTable(20000);
        Pool pool = new Pool(64, Dpi.ThreadInit);
        Server server = new Server(Methods.Table(), stdout, handles, pool);
        server.MapError = Faults.Map;
        server.Hung = Win.IsHung;
        server.HardExit = Win.Terminate;
        Methods.Init(server, dpi);
        TextReader stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, false), false, 1 << 16);
        return server.Run(stdin, new JObj().Add("ready", true).Add("version", Version).Add("dpi", dpi));
      }
      catch (Exception e)
      {
        byte[] line = Encoding.ASCII.GetBytes(Json.Write(new JObj().Add("fatal", e.GetType().Name + ": " + e.Message)) + "\n");
        try
        {
          stdout.Write(line, 0, line.Length);
          stdout.Flush();
        }
        catch (Exception) { /* nobody is listening */ }
        return 1;
      }
    }
  }

  /// <summary>Win32 imports. Every one is safe against hung apps: none sends a message except SendMessageTimeoutW.</summary>
  internal static class Native
  {
    [StructLayout(LayoutKind.Sequential)]
    internal struct Box
    {
      public int Left;
      public int Top;
      public int Right;
      public int Bottom;
    }

    [DllImport("user32.dll")]
    internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    internal static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetThreadDpiAwarenessContext();

    [DllImport("user32.dll")]
    internal static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);

    [DllImport("user32.dll")]
    internal static extern int GetAwarenessFromDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    internal static extern bool IsProcessDPIAware();

    [DllImport("shcore.dll")]
    internal static extern int SetProcessDpiAwareness(int value);

    [DllImport("shcore.dll")]
    internal static extern int GetProcessDpiAwareness(IntPtr process, out int value);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetTopWindow(IntPtr parent);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetWindow(IntPtr hwnd, uint command);

    [DllImport("user32.dll")]
    internal static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    internal static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

    // For another process's window GetWindowTextW returns the stored caption without sending WM_GETTEXT.
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int max);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetClassNameW(IntPtr hwnd, StringBuilder name, int max);

    [DllImport("user32.dll")]
    internal static extern bool GetWindowRect(IntPtr hwnd, out Box rect);

    [DllImport("user32.dll")]
    internal static extern int GetWindowLongW(IntPtr hwnd, int index);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    internal static extern IntPtr GetDesktopWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string className, string title);

    [DllImport("user32.dll")]
    internal static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint message, IntPtr w, IntPtr l, uint flags, uint timeoutMs, out IntPtr result);

    [DllImport("dwmapi.dll")]
    internal static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

    [DllImport("kernel32.dll")]
    internal static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    internal static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref int size);

    [DllImport("kernel32.dll")]
    internal static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    internal static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll")]
    internal static extern bool TerminateProcess(IntPtr process, uint code);
  }

  /// <summary>
  /// DPI awareness. Per-Monitor-V2 for the whole process when Windows allows it; when the process already has an
  /// awareness (from powershell.exe's manifest), each worker thread sets it for itself instead.
  /// </summary>
  internal static class Dpi
  {
    private static readonly IntPtr PerMonitorV2 = new IntPtr(-4);
    private static readonly IntPtr PerMonitor = new IntPtr(-3);
    private static bool processWideV2;

    internal static string Setup()
    {
      try { processWideV2 = Native.SetProcessDpiAwarenessContext(PerMonitorV2); }
      catch (EntryPointNotFoundException) { processWideV2 = false; }
      if (!processWideV2)
      {
        // Windows 10 before 1703 has no DPI awareness contexts for processes: per-monitor (v1) is the best there.
        try { Native.SetProcessDpiAwareness(2); }
        catch (EntryPointNotFoundException) { /* Windows 8 or older */ }
        catch (DllNotFoundException) { /* Windows 8 or older */ }
      }
      ThreadInit();
      return Describe();
    }

    /// <summary>Runs first on every worker thread (and the reader thread, so the ready line reports what they get).</summary>
    internal static void ThreadInit()
    {
      if (processWideV2) return;
      try
      {
        if (Native.SetThreadDpiAwarenessContext(PerMonitorV2) == IntPtr.Zero) Native.SetThreadDpiAwarenessContext(PerMonitor);
      }
      catch (EntryPointNotFoundException) { /* before Windows 10 1607: the process-wide setting is all there is */ }
    }

    private static string Describe()
    {
      try
      {
        IntPtr context = Native.GetThreadDpiAwarenessContext();
        if (Native.AreDpiAwarenessContextsEqual(context, PerMonitorV2)) return "per-monitor-v2";
        return Name(Native.GetAwarenessFromDpiAwarenessContext(context));
      }
      catch (EntryPointNotFoundException) { /* before Windows 10 1607: ask the process instead */ }
      try
      {
        int awareness;
        if (Native.GetProcessDpiAwareness(IntPtr.Zero, out awareness) == 0) return Name(awareness);
      }
      catch (EntryPointNotFoundException) { /* Windows 8 or older */ }
      catch (DllNotFoundException) { /* Windows 8 or older */ }
      try { return Native.IsProcessDPIAware() ? "system" : "unaware"; }
      catch (EntryPointNotFoundException) { return "unaware"; }
    }

    private static string Name(int awareness)
    {
      if (awareness == 2) return "per-monitor";
      if (awareness == 1) return "system";
      return "unaware";
    }
  }

  /// <summary>Win32 facts about top-level windows and processes, none of which can block on a hung app.</summary>
  internal static class Win
  {
    private const uint GwHwndNext = 2;
    private const uint GwOwner = 4;
    private const int GwlExStyle = -20;
    private const int WsExTopmost = 0x8;
    private const int WsExTransparent = 0x20;
    private const int DwmwaCloaked = 14;
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint SmtoAbortIfHung = 0x2;

    /// <summary>Every top-level window, front-most first (GetTopWindow/GetWindow: no callbacks, no messages).</summary>
    internal static List<IntPtr> TopLevel()
    {
      List<IntPtr> windows = new List<IntPtr>();
      IntPtr h = Native.GetTopWindow(IntPtr.Zero);
      // The z-order can change under the walk; the cap stops a cycle.
      while (h != IntPtr.Zero && windows.Count < 20000)
      {
        windows.Add(h);
        h = Native.GetWindow(h, GwHwndNext);
      }
      return windows;
    }

    internal static int PidOf(IntPtr hwnd)
    {
      uint pid;
      Native.GetWindowThreadProcessId(hwnd, out pid);
      return (int)pid;
    }

    internal static bool Visible(IntPtr hwnd) { return Native.IsWindowVisible(hwnd); }

    /// <summary>Cloaked by DWM: on another virtual desktop, or a suspended UWP frame. Nobody can see it.</summary>
    internal static bool Cloaked(IntPtr hwnd)
    {
      try
      {
        int cloaked;
        return Native.DwmGetWindowAttribute(hwnd, DwmwaCloaked, out cloaked, 4) == 0 && cloaked != 0;
      }
      catch (DllNotFoundException) { return false; }
      catch (EntryPointNotFoundException) { return false; }
    }

    internal static string Title(IntPtr hwnd)
    {
      StringBuilder sb = new StringBuilder(1024);
      int n = Native.GetWindowTextW(hwnd, sb, sb.Capacity);
      return n > 0 ? sb.ToString(0, Math.Min(n, sb.Length)) : "";
    }

    internal static string ClassName(IntPtr hwnd)
    {
      StringBuilder sb = new StringBuilder(256);
      int n = Native.GetClassNameW(hwnd, sb, sb.Capacity);
      return n > 0 ? sb.ToString(0, Math.Min(n, sb.Length)) : "";
    }

    /// <summary>GetWindowRect as RawNode bounds (null when it fails or has no area).</summary>
    internal static JObj Rect(IntPtr hwnd)
    {
      Native.Box r;
      if (!Native.GetWindowRect(hwnd, out r) || r.Right <= r.Left || r.Bottom <= r.Top) return null;
      return new JObj().Add("x", r.Left).Add("y", r.Top).Add("width", r.Right - r.Left).Add("height", r.Bottom - r.Top);
    }

    internal static bool Topmost(IntPtr hwnd) { return (Native.GetWindowLongW(hwnd, GwlExStyle) & WsExTopmost) != 0; }

    internal static IntPtr Owner(IntPtr hwnd) { return Native.GetWindow(hwnd, GwOwner); }

    internal static IntPtr Foreground() { return Native.GetForegroundWindow(); }

    /// <summary>
    /// The front-most visible top-level window whose rectangle holds the point, skipping click-through windows (like
    /// Ember's overlay). Unlike WindowFromPoint it also finds a disabled window (one with a modal dialog open), and it
    /// sends no message at all.
    /// </summary>
    internal static IntPtr RootAt(double x, double y)
    {
      if (double.IsNaN(x) || double.IsNaN(y) || Math.Abs(x) > 1e6 || Math.Abs(y) > 1e6) return IntPtr.Zero;
      int px = (int)Math.Floor(x);
      int py = (int)Math.Floor(y);
      foreach (IntPtr h in TopLevel())
      {
        if (!Native.IsWindowVisible(h) || (Native.GetWindowLongW(h, GwlExStyle) & WsExTransparent) != 0) continue;
        Native.Box r;
        if (!Native.GetWindowRect(h, out r) || px < r.Left || px >= r.Right || py < r.Top || py >= r.Bottom) continue;
        if (!Cloaked(h)) return h;
      }
      return IntPtr.Zero;
    }

    internal static long Number(IntPtr hwnd) { return hwnd.ToInt64(); }

    /// <summary>
    /// The program's file name without ".exe", as Windows reports it ("notepad", "WINWORD"): the same rule as
    /// wmClass in app/main/platform/types.ts. Empty when the process is gone.
    /// </summary>
    internal static string Program(int pid)
    {
      string path = null;
      IntPtr process = Native.OpenProcess(ProcessQueryLimitedInformation, false, pid);
      if (process != IntPtr.Zero)
      {
        try
        {
          StringBuilder sb = new StringBuilder(1024);
          int size = sb.Capacity;
          if (Native.QueryFullProcessImageNameW(process, 0, sb, ref size)) path = sb.ToString(0, Math.Min(size, sb.Length));
        }
        finally { Native.CloseHandle(process); }
      }
      if (string.IsNullOrEmpty(path))
      {
        try
        {
          using (Process p = Process.GetProcessById(pid)) return p.ProcessName;
        }
        catch (Exception) { return ""; }
      }
      return ProgramName(path);
    }

    internal static string ProgramName(string path)
    {
      int slash = Math.Max(path.LastIndexOf('\\'), path.LastIndexOf('/'));
      string file = slash >= 0 ? path.Substring(slash + 1) : path;
      if (file.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) file = file.Substring(0, file.Length - 4);
      return file;
    }

    /// <summary>For an ApplicationFrameHost frame: the process of the UWP app it hosts (0 when it has none).</summary>
    internal static int Hosted(IntPtr frame, int framePid)
    {
      IntPtr child = IntPtr.Zero;
      for (int i = 0; i < 16; i++)
      {
        child = Native.FindWindowExW(frame, child, "Windows.UI.Core.CoreWindow", null);
        if (child == IntPtr.Zero) return 0;
        int pid = PidOf(child);
        if (pid != 0 && pid != framePid) return pid;
      }
      return 0;
    }

    /// <summary>Asked after an action timed out: does the process still answer window messages?</summary>
    internal static bool IsHung(Call c)
    {
      IntPtr h = c.Window;
      if (h == IntPtr.Zero || PidOf(h) != c.Pid) h = AnyWindowOf(c.Pid);
      if (h == IntPtr.Zero) return false;
      IntPtr result;
      return Native.SendMessageTimeoutW(h, 0, IntPtr.Zero, IntPtr.Zero, SmtoAbortIfHung, 300, out result) == IntPtr.Zero;
    }

    internal static IntPtr AnyWindowOf(int pid)
    {
      foreach (IntPtr h in TopLevel())
      {
        if (Native.IsWindowVisible(h) && PidOf(h) == pid) return h;
      }
      return IntPtr.Zero;
    }

    internal static void Terminate(int code) { Native.TerminateProcess(Native.GetCurrentProcess(), (uint)code); }
  }

  /// <summary>Turns UI Automation and COM exceptions into protocol errors.</summary>
  internal static class Faults
  {
    internal const int UiaElementNotAvailable = unchecked((int)0x80040201);
    internal const int UiaTimeout = unchecked((int)0x80131505);
    internal const int AccessDenied = unchecked((int)0x80070005);

    internal static BridgeError Map(Exception e)
    {
      if (e is ElementNotAvailableException) return new BridgeError("gone", Msg.Gone);
      if (e is TimeoutException) return new BridgeError("busy", Msg.Late);
      if (e is UnauthorizedAccessException) return new BridgeError("denied", "access denied (the app may run as administrator)");
      COMException com = e as COMException;
      if (com != null)
      {
        if (com.ErrorCode == UiaElementNotAvailable) return new BridgeError("gone", Msg.Gone);
        if (com.ErrorCode == UiaTimeout) return new BridgeError("busy", Msg.Late);
        if (com.ErrorCode == AccessDenied) return new BridgeError("denied", "access denied (the app may run as administrator)");
      }
      return null;
    }
  }

  /// <summary>What a request wants read besides the cached properties.</summary>
  internal sealed class Want
  {
    internal readonly bool Values;
    internal readonly bool Legacy;

    internal Want(bool values, bool legacy)
    {
      Values = values;
      Legacy = legacy;
    }
  }

  /// <summary>The cache request every read uses, and RawNode building from what it fetched.</summary>
  internal static class Props
  {
    internal const int TextCap = 2000;
    /// <summary>parent/depth value that leaves both fields out of a node.</summary>
    internal const int NoTree = int.MinValue;

    // ValuePattern.ValueProperty is deliberately missing: a password field's value must never be fetched, so values
    // are read one by one after IsPassword says false.
    private static readonly AutomationProperty[] All = new AutomationProperty[]
    {
      AutomationElement.ControlTypeProperty,
      AutomationElement.LocalizedControlTypeProperty,
      AutomationElement.NameProperty,
      AutomationElement.AutomationIdProperty,
      AutomationElement.ClassNameProperty,
      AutomationElement.FrameworkIdProperty,
      AutomationElement.IsPasswordProperty,
      AutomationElement.IsEnabledProperty,
      AutomationElement.IsOffscreenProperty,
      AutomationElement.HasKeyboardFocusProperty,
      AutomationElement.IsKeyboardFocusableProperty,
      AutomationElement.IsControlElementProperty,
      AutomationElement.BoundingRectangleProperty,
      AutomationElement.ProcessIdProperty,
      AutomationElement.NativeWindowHandleProperty,
      AutomationElement.RuntimeIdProperty,
      AutomationElement.LabeledByProperty,
      AutomationElement.HelpTextProperty,
      AutomationElement.ItemStatusProperty,
      AutomationElement.AcceleratorKeyProperty,
      AutomationElement.AccessKeyProperty,
      AutomationElement.IsInvokePatternAvailableProperty,
      AutomationElement.IsTogglePatternAvailableProperty,
      AutomationElement.IsValuePatternAvailableProperty,
      AutomationElement.IsRangeValuePatternAvailableProperty,
      AutomationElement.IsExpandCollapsePatternAvailableProperty,
      AutomationElement.IsSelectionItemPatternAvailableProperty,
      AutomationElement.IsSelectionPatternAvailableProperty,
      AutomationElement.IsWindowPatternAvailableProperty,
      AutomationElement.IsGridPatternAvailableProperty,
      AutomationElement.IsGridItemPatternAvailableProperty,
      AutomationElement.IsTablePatternAvailableProperty,
      AutomationElement.IsTextPatternAvailableProperty,
      AutomationElement.IsScrollItemPatternAvailableProperty,
      TogglePattern.ToggleStateProperty,
      ValuePattern.IsReadOnlyProperty,
      RangeValuePattern.ValueProperty,
      RangeValuePattern.MinimumProperty,
      RangeValuePattern.MaximumProperty,
      RangeValuePattern.IsReadOnlyProperty,
      RangeValuePattern.SmallChangeProperty,
      ExpandCollapsePattern.ExpandCollapseStateProperty,
      SelectionItemPattern.IsSelectedProperty,
      SelectionPattern.CanSelectMultipleProperty,
      SelectionPattern.IsSelectionRequiredProperty,
      WindowPattern.IsModalProperty,
      WindowPattern.WindowVisualStateProperty,
      WindowPattern.WindowInteractionStateProperty,
      GridPattern.RowCountProperty,
      GridPattern.ColumnCountProperty,
      GridItemPattern.RowProperty,
      GridItemPattern.ColumnProperty,
    };

    /// <summary>
    /// A cache request for every RawNode property in the control view. With children, every element found also
    /// brings its children, so one call reads two levels.
    /// </summary>
    internal static CacheRequest Request(bool children)
    {
      CacheRequest r = new CacheRequest();
      r.AutomationElementMode = AutomationElementMode.Full;
      r.TreeFilter = Automation.ControlViewCondition;
      r.TreeScope = children ? TreeScope.Element | TreeScope.Children : TreeScope.Element;
      foreach (AutomationProperty p in All) r.Add(p);
      return r;
    }

    /// <summary>
    /// An element's children in the control view with every RawNode property cached; with twoLevels, each child also
    /// brings its own children (one call for two levels). A provider that refuses that is asked for one level.
    /// </summary>
    internal static AutomationElementCollection FindChildren(AutomationElement el, bool twoLevels)
    {
      if (twoLevels)
      {
        try
        {
          using (Request(true).Activate()) return el.FindAll(TreeScope.Children, Condition.TrueCondition);
        }
        catch (ElementNotAvailableException) { throw; }
        catch (TimeoutException) { throw; }
        catch (Exception) { /* asked again below for one level, which every provider supports */ }
      }
      using (Request(false).Activate()) return el.FindAll(TreeScope.Children, Condition.TrueCondition);
    }

    /// <summary>The element with its properties cached (some ways of getting an element ignore the active request).</summary>
    internal static AutomationElement Ensure(AutomationElement el, CacheRequest request)
    {
      try
      {
        el.GetCachedPropertyValue(AutomationElement.RuntimeIdProperty);
        return el;
      }
      catch (InvalidOperationException) { return el.GetUpdatedCache(request); }
    }

    /// <summary>A cached property, or null when it wasn't fetched or the provider failed.</summary>
    internal static object Get(AutomationElement el, AutomationProperty p)
    {
      try { return el.GetCachedPropertyValue(p); }
      catch (InvalidOperationException) { return null; }
      catch (ArgumentException) { return null; }
      catch (COMException) { return null; }
    }

    internal static bool? Flag(AutomationElement el, AutomationProperty p)
    {
      object v = Get(el, p);
      if (v is bool) return (bool)v;
      return null;
    }

    internal static bool Has(AutomationElement el, AutomationProperty p) { return Flag(el, p) == true; }

    internal static string Clip(string s) { return s != null && s.Length > TextCap ? s.Substring(0, TextCap) : s; }

    internal static int Pid(AutomationElement el)
    {
      object v = Get(el, AutomationElement.ProcessIdProperty);
      return v is int ? (int)v : 0;
    }

    internal static IntPtr Hwnd(AutomationElement el)
    {
      object v = Get(el, AutomationElement.NativeWindowHandleProperty);
      return v is int ? new IntPtr((int)v) : IntPtr.Zero;
    }

    /// <summary>Offscreen with no area: left out of snapshots together with its subtree.</summary>
    internal static bool Skipped(AutomationElement el)
    {
      return Flag(el, AutomationElement.IsOffscreenProperty) == true && !HasArea(el);
    }

    internal static bool HasArea(AutomationElement el)
    {
      object v = Get(el, AutomationElement.BoundingRectangleProperty);
      if (!(v is Rect)) return false;
      Rect r = (Rect)v;
      return !r.IsEmpty && r.Width > 0 && r.Height > 0 && !double.IsInfinity(r.Width) && !double.IsInfinity(r.Height);
    }

    internal static object Bounds(Rect r)
    {
      if (r.IsEmpty || double.IsNaN(r.X) || double.IsNaN(r.Y) || double.IsInfinity(r.X) || double.IsInfinity(r.Y) || double.IsInfinity(r.Width) || double.IsInfinity(r.Height))
        return null;
      return new JObj().Add("x", r.X).Add("y", r.Y).Add("width", r.Width).Add("height", r.Height);
    }

    internal static string ShortName(ControlType type)
    {
      string s = type.ProgrammaticName ?? "";
      return s.StartsWith("ControlType.", StringComparison.Ordinal) ? s.Substring(12) : s;
    }

    private static void AddText(JObj n, string key, AutomationElement el, AutomationProperty p)
    {
      string s = Get(el, p) as string;
      if (!string.IsNullOrEmpty(s)) n.Add(key, Clip(s));
    }

    private static void AddFlag(JObj n, string key, AutomationElement el, AutomationProperty p)
    {
      bool? b = Flag(el, p);
      if (b.HasValue) n.Add(key, b.Value);
    }

    /// <summary>A RawNode from an element's cached properties (PROTOCOL.md, "RawNode").</summary>
    internal static JObj Node(AutomationElement el, int handle, int parent, int depth, Want want)
    {
      JObj n = new JObj().Add("h", handle);
      if (parent != NoTree && depth != NoTree)
      {
        n.Add("parent", parent);
        n.Add("depth", depth);
      }
      ControlType type = Get(el, AutomationElement.ControlTypeProperty) as ControlType;
      if (type != null) n.Add("controlType", ShortName(type));
      else
      {
        int id = Legacy.ControlTypeId(el);
        string name = Legacy.ControlTypeName(id);
        if (name != null) n.Add("controlType", name);
        else if (id > 0) n.Add("controlTypeId", id);
      }
      AddText(n, "localizedControlType", el, AutomationElement.LocalizedControlTypeProperty);
      AddText(n, "name", el, AutomationElement.NameProperty);
      AddText(n, "automationId", el, AutomationElement.AutomationIdProperty);
      AddText(n, "className", el, AutomationElement.ClassNameProperty);
      AddText(n, "frameworkId", el, AutomationElement.FrameworkIdProperty);
      bool? password = Flag(el, AutomationElement.IsPasswordProperty);
      if (password.HasValue) n.Add("isPassword", password.Value);
      AddFlag(n, "isEnabled", el, AutomationElement.IsEnabledProperty);
      AddFlag(n, "isOffscreen", el, AutomationElement.IsOffscreenProperty);
      AddFlag(n, "hasKeyboardFocus", el, AutomationElement.HasKeyboardFocusProperty);
      AddFlag(n, "isKeyboardFocusable", el, AutomationElement.IsKeyboardFocusableProperty);
      AddFlag(n, "isControlElement", el, AutomationElement.IsControlElementProperty);
      object bounds = Get(el, AutomationElement.BoundingRectangleProperty);
      if (bounds is Rect) n.Add("bounds", Bounds((Rect)bounds));
      int pid = Pid(el);
      if (pid > 0) n.Add("pid", pid);
      IntPtr hwnd = Hwnd(el);
      if (hwnd != IntPtr.Zero) n.Add("hwnd", Win.Number(hwnd));
      int[] runtimeId = Get(el, AutomationElement.RuntimeIdProperty) as int[];
      if (runtimeId != null && runtimeId.Length > 0) n.Add("runtimeId", JoinIds(runtimeId));
      AutomationElement label = Get(el, AutomationElement.LabeledByProperty) as AutomationElement;
      if (label != null)
      {
        try
        {
          string name = label.Current.Name;
          if (!string.IsNullOrEmpty(name)) n.Add("labeledBy", Clip(name));
        }
        catch (Exception) { /* the label went away or doesn't answer: it is optional */ }
      }
      AddText(n, "helpText", el, AutomationElement.HelpTextProperty);
      AddText(n, "itemStatus", el, AutomationElement.ItemStatusProperty);
      AddText(n, "acceleratorKey", el, AutomationElement.AcceleratorKeyProperty);
      AddText(n, "accessKey", el, AutomationElement.AccessKeyProperty);
      n.Add("patterns", Patterns(el, n, password, type, want));
      return n;
    }

    internal static string JoinIds(int[] ids)
    {
      StringBuilder sb = new StringBuilder();
      for (int i = 0; i < ids.Length; i++)
      {
        if (i > 0) sb.Append('.');
        sb.Append(ids[i].ToString(CultureInfo.InvariantCulture));
      }
      return sb.ToString();
    }

    private static JObj Patterns(AutomationElement el, JObj node, bool? password, ControlType type, Want want)
    {
      JObj p = new JObj();
      if (Has(el, AutomationElement.IsInvokePatternAvailableProperty)) p.Add("invoke", true);
      if (Has(el, AutomationElement.IsTogglePatternAvailableProperty))
      {
        object state = Get(el, TogglePattern.ToggleStateProperty);
        if (state is ToggleState) p.Add("toggle", state.ToString());
      }
      if (Has(el, AutomationElement.IsValuePatternAvailableProperty))
      {
        JObj v = new JObj();
        if (want.Values && password == false) ReadValue(el, node, type, v);
        AddFlag(v, "readOnly", el, ValuePattern.IsReadOnlyProperty);
        p.Add("value", v);
      }
      if (Has(el, AutomationElement.IsRangeValuePatternAvailableProperty))
      {
        JObj r = new JObj();
        AddNumber(r, "value", el, RangeValuePattern.ValueProperty);
        AddNumber(r, "min", el, RangeValuePattern.MinimumProperty);
        AddNumber(r, "max", el, RangeValuePattern.MaximumProperty);
        AddFlag(r, "readOnly", el, RangeValuePattern.IsReadOnlyProperty);
        AddNumber(r, "smallChange", el, RangeValuePattern.SmallChangeProperty);
        p.Add("range", r);
      }
      if (Has(el, AutomationElement.IsExpandCollapsePatternAvailableProperty))
      {
        object state = Get(el, ExpandCollapsePattern.ExpandCollapseStateProperty);
        if (state is ExpandCollapseState) p.Add("expand", state.ToString());
      }
      if (Has(el, AutomationElement.IsSelectionItemPatternAvailableProperty))
      {
        JObj s = new JObj();
        AddFlag(s, "selected", el, SelectionItemPattern.IsSelectedProperty);
        p.Add("selectionItem", s);
      }
      if (Has(el, AutomationElement.IsSelectionPatternAvailableProperty))
      {
        JObj s = new JObj();
        AddFlag(s, "multiple", el, SelectionPattern.CanSelectMultipleProperty);
        AddFlag(s, "required", el, SelectionPattern.IsSelectionRequiredProperty);
        p.Add("selection", s);
      }
      if (Has(el, AutomationElement.IsWindowPatternAvailableProperty))
      {
        JObj w = new JObj();
        AddFlag(w, "modal", el, WindowPattern.IsModalProperty);
        object state = Get(el, WindowPattern.WindowVisualStateProperty);
        if (state is WindowVisualState) w.Add("state", state.ToString());
        object interaction = Get(el, WindowPattern.WindowInteractionStateProperty);
        if (interaction is WindowInteractionState) w.Add("interaction", interaction.ToString());
        p.Add("window", w);
      }
      if (Has(el, AutomationElement.IsGridPatternAvailableProperty))
      {
        JObj g = new JObj();
        AddNumber(g, "rows", el, GridPattern.RowCountProperty);
        AddNumber(g, "columns", el, GridPattern.ColumnCountProperty);
        p.Add("grid", g);
      }
      if (Has(el, AutomationElement.IsGridItemPatternAvailableProperty))
      {
        JObj g = new JObj();
        AddNumber(g, "row", el, GridItemPattern.RowProperty);
        AddNumber(g, "column", el, GridItemPattern.ColumnProperty);
        p.Add("gridItem", g);
      }
      if (Has(el, AutomationElement.IsTablePatternAvailableProperty)) p.Add("table", true);
      if (Has(el, AutomationElement.IsTextPatternAvailableProperty)) p.Add("text", true);
      if (Has(el, AutomationElement.IsScrollItemPatternAvailableProperty)) p.Add("scrollItem", true);
      if (want.Legacy)
      {
        try
        {
          JObj legacy = Legacy.Info(el);
          if (legacy != null) p.Add("legacy", legacy);
        }
        catch (ElementNotAvailableException) { node.Add("gone", true); }
        catch (Exception) { /* optional: left out */ }
      }
      return p;
    }

    private static void AddNumber(JObj o, string key, AutomationElement el, AutomationProperty p)
    {
      object v = Get(el, p);
      if (v is double || v is int) o.Add(key, v);
    }

    // The value of a field IsPassword says isn't a password field, asked for on its own (never in a batch). An Edit
    // whose MSAA state is "protected" is treated as a password field too.
    private static void ReadValue(AutomationElement el, JObj node, ControlType type, JObj into)
    {
      try
      {
        if (type == ControlType.Edit && Legacy.IsProtected(el)) return;
        string s = el.GetCurrentPropertyValue(ValuePattern.ValueProperty, true) as string;
        if (s == null) return;
        if (s.Length > TextCap)
        {
          into.Add("value", s.Substring(0, TextCap));
          into.Add("truncated", true);
        }
        else into.Add("value", s);
      }
      catch (ElementNotAvailableException) { node.Add("gone", true); }
      catch (Exception) { /* a provider that fails to give its value: the field is just left out */ }
    }

    /// <summary>
    /// Is this a password field? Read fresh. When IsPassword can't be read, the answer is yes: never read text that
    /// might be a password.
    /// </summary>
    internal static bool IsSecret(AutomationElement el)
    {
      object password;
      object type;
      try
      {
        password = el.GetCurrentPropertyValue(AutomationElement.IsPasswordProperty);
        type = el.GetCurrentPropertyValue(AutomationElement.ControlTypeProperty);
      }
      catch (ElementNotAvailableException) { throw; }
      catch (Exception) { return true; }
      if (!(password is bool) || (bool)password) return true;
      ControlType control = type as ControlType;
      return control == ControlType.Edit && Legacy.IsProtected(el);
    }
  }

  /// <summary>
  /// LegacyIAccessible, which UIA's .NET client has no types for: read through UIAutomationCore's documented flat
  /// API (UiaGetPropertyValue, UiaGetPatternProvider) on the node the .NET element wraps. When that node can't be
  /// reached, the legacy facts are simply missing.
  /// </summary>
  internal static class Legacy
  {
    private const int ControlTypePropertyId = 30003;
    private const int AvailablePropertyId = 30090;
    private const int RolePropertyId = 30095;
    private const int StatePropertyId = 30096;
    private const int DefaultActionPropertyId = 30100;
    private const int PatternId = 10018;
    private const int StateProtected = 0x20000000;

    // The .NET Framework's AutomationElement keeps its UIAutomationCore node in an internal property (older builds: a
    // private field). The framework is frozen, but look both up and give up quietly if neither is there.
    private static readonly PropertyInfo RawNodeProperty = typeof(AutomationElement).GetProperty("RawNode", BindingFlags.Instance | BindingFlags.NonPublic);
    private static readonly FieldInfo NodeField = typeof(AutomationElement).GetField("_hnode", BindingFlags.Instance | BindingFlags.NonPublic);

    [DllImport("UIAutomationCore.dll")]
    private static extern int UiaGetPropertyValue(SafeHandle node, int propertyId, [MarshalAs(UnmanagedType.Struct)] out object value);

    [DllImport("UIAutomationCore.dll")]
    private static extern int UiaGetPatternProvider(SafeHandle node, int patternId, out IntPtr pattern);

    [DllImport("UIAutomationCore.dll")]
    private static extern bool UiaPatternRelease(IntPtr pattern);

    [DllImport("UIAutomationCore.dll")]
    private static extern int LegacyIAccessiblePattern_DoDefaultAction(IntPtr pattern);

    private static SafeHandle NodeOf(AutomationElement el)
    {
      try
      {
        object v = null;
        if (RawNodeProperty != null) v = RawNodeProperty.GetValue(el, null);
        if (v == null && NodeField != null) v = NodeField.GetValue(el);
        SafeHandle node = v as SafeHandle;
        return node != null && !node.IsInvalid && !node.IsClosed ? node : null;
      }
      catch (Exception) { return null; }
    }

    private static object Read(AutomationElement el, int propertyId)
    {
      SafeHandle node = NodeOf(el);
      if (node == null) return null;
      object v;
      int hr;
      try { hr = UiaGetPropertyValue(node, propertyId, out v); }
      catch (DllNotFoundException) { return null; }
      catch (EntryPointNotFoundException) { return null; }
      GC.KeepAlive(el);
      if (hr == Faults.UiaElementNotAvailable) throw new ElementNotAvailableException();
      if (hr < 0) return null;
      // Anything else (an empty variant, or UIA's "not supported" object) means the element hasn't got it.
      if (v is int || v is string || v is bool) return v;
      return null;
    }

    internal static int ControlTypeId(AutomationElement el)
    {
      try
      {
        object v = Read(el, ControlTypePropertyId);
        return v is int ? (int)v : 0;
      }
      catch (Exception) { return 0; }
    }

    /// <summary>Control types newer than the .NET client (Windows 8): their names, as UIA documents them.</summary>
    internal static string ControlTypeName(int id)
    {
      if (id == 50039) return "SemanticZoom";
      if (id == 50040) return "AppBar";
      return null;
    }

    internal static JObj Info(AutomationElement el)
    {
      object available = Read(el, AvailablePropertyId);
      if (!(available is bool) || !(bool)available) return null;
      JObj j = new JObj();
      object role = Read(el, RolePropertyId);
      if (role is int) j.Add("role", role);
      object state = Read(el, StatePropertyId);
      if (state is int) j.Add("state", state);
      string action = Read(el, DefaultActionPropertyId) as string;
      if (!string.IsNullOrEmpty(action)) j.Add("defaultAction", Props.Clip(action));
      return j.Count > 0 ? j : null;
    }

    internal static bool IsProtected(AutomationElement el)
    {
      object state = Read(el, StatePropertyId);
      return state is int && ((int)state & StateProtected) != 0;
    }

    internal static void DoDefaultAction(AutomationElement el)
    {
      SafeHandle node = NodeOf(el);
      if (node == null) throw new BridgeError("failed", "unsupported:legacyDefaultAction");
      IntPtr pattern;
      int hr;
      try { hr = UiaGetPatternProvider(node, PatternId, out pattern); }
      catch (EntryPointNotFoundException) { throw new BridgeError("failed", "unsupported:legacyDefaultAction"); }
      GC.KeepAlive(el);
      Check(hr);
      if (pattern == IntPtr.Zero) throw new BridgeError("failed", "unsupported:legacyDefaultAction");
      try { Check(LegacyIAccessiblePattern_DoDefaultAction(pattern)); }
      finally { UiaPatternRelease(pattern); }
    }

    private static void Check(int hr)
    {
      if (hr >= 0) return;
      if (hr == Faults.UiaElementNotAvailable) throw new ElementNotAvailableException();
      if (hr == Faults.UiaTimeout) throw new TimeoutException();
      if (hr == Faults.AccessDenied) throw new UnauthorizedAccessException();
      throw new BridgeError("failed", "COMException: HRESULT 0x" + hr.ToString("x8", CultureInfo.InvariantCulture));
    }
  }

  /// <summary>
  /// A snapshot's walk: pre-order over the control view, two levels per call, stopping at its budgets. Nodes are
  /// added under a lock so the deadline can answer with what is there so far.
  /// </summary>
  internal sealed class Walk
  {
    private readonly Call call;
    private readonly Want want;
    private readonly int maxDepth;
    private readonly int maxNodes;
    private readonly int maxChildren;
    private readonly IntPtr window;
    private readonly double marginMs;
    private readonly object gate = new object();
    private readonly List<object> nodes = new List<object>();
    private bool cutNodes;
    private bool cutDepth;
    private bool cutTime;
    private bool stop;

    internal Walk(Call call, Want want, int maxDepth, int maxNodes, int maxChildren, IntPtr window)
    {
      this.call = call;
      this.want = want;
      this.maxDepth = maxDepth;
      this.maxNodes = maxNodes;
      this.maxChildren = maxChildren;
      this.window = window;
      // Stop early enough to answer before the deadline answers for us.
      marginMs = Math.Min(100, call.DeadlineMs / 5.0);
    }

    internal void Run(AutomationElement root) { Visit(root, -1, 0); }

    /// <summary>The answer with what was read so far (the deadline's answer: busy, cut short by time).</summary>
    internal object Partial()
    {
      lock (gate) return new RawJson(Json.Write(Shape(true)));
    }

    internal object Answer()
    {
      lock (gate) return Shape(false);
    }

    private JObj Shape(bool late)
    {
      List<object> cut = new List<object>();
      if (cutNodes) cut.Add("nodes");
      if (cutDepth) cut.Add("depth");
      if (cutTime || late) cut.Add("time");
      return new JObj().Add("nodes", nodes).Add("truncated", cut.Count > 0).Add("cut", cut).Add("busy", late);
    }

    private void Cut(ref bool flag)
    {
      lock (gate) flag = true;
    }

    private bool OutOfTime()
    {
      if (!call.Abandoned && call.RemainingMs > marginMs) return false;
      Cut(ref cutTime);
      stop = true;
      return true;
    }

    private void Visit(AutomationElement el, int parent, int depth)
    {
      if (stop) return;
      int count;
      lock (gate) count = nodes.Count;
      if (count >= maxNodes)
      {
        Cut(ref cutNodes);
        stop = true;
        return;
      }
      if (OutOfTime()) return;
      int handle = Methods.Register(call, el, window);
      JObj node = Props.Node(el, handle, parent, depth, want);
      int index;
      lock (gate)
      {
        index = nodes.Count;
        nodes.Add(node);
      }
      if (node.Has("gone")) return;
      if (depth >= maxDepth)
      {
        if (HasListedChild(el)) Cut(ref cutDepth);
        return;
      }
      List<AutomationElement> kids = Children(el, node);
      if (kids == null) return;
      foreach (AutomationElement kid in kids)
      {
        Visit(kid, index, depth + 1);
        if (stop) return;
      }
    }

    // Below maxDepth: is there anything a deeper read would list? One level is enough to tell.
    private bool HasListedChild(AutomationElement el)
    {
      AutomationElementCollection found;
      try { found = el.CachedChildren; }
      catch (InvalidOperationException) { found = null; }
      if (found == null)
      {
        if (OutOfTime()) return false;
        try { found = Props.FindChildren(el, false); }
        catch (Exception) { return false; }
      }
      foreach (AutomationElement kid in found)
      {
        if (!Props.Skipped(kid)) return true;
      }
      return false;
    }

    // The children to visit: the ones that came with the element (two levels per call), or found now; without the
    // offscreen ones that have no area, and at most maxChildren (on-screen ones first, in their order).
    private List<AutomationElement> Children(AutomationElement el, JObj node)
    {
      AutomationElementCollection found = null;
      try { found = el.CachedChildren; }
      catch (InvalidOperationException) { found = null; }
      if (found == null)
      {
        if (OutOfTime()) return null;
        try { found = Props.FindChildren(el, true); }
        catch (ElementNotAvailableException)
        {
          lock (gate) node.Add("gone", true);
          return null;
        }
        catch (Exception)
        {
          lock (gate) node.Add("childrenFailed", true);
          return null;
        }
      }
      List<AutomationElement> kids = new List<AutomationElement>(found.Count);
      foreach (AutomationElement kid in found)
      {
        if (!Props.Skipped(kid)) kids.Add(kid);
      }
      if (kids.Count <= maxChildren) return kids;
      bool[] keep = new bool[kids.Count];
      int kept = 0;
      for (int i = 0; i < kids.Count && kept < maxChildren; i++)
      {
        if (Props.Flag(kids[i], AutomationElement.IsOffscreenProperty) == true) continue;
        keep[i] = true;
        kept++;
      }
      for (int i = 0; i < kids.Count && kept < maxChildren; i++)
      {
        if (keep[i]) continue;
        keep[i] = true;
        kept++;
      }
      List<AutomationElement> chosen = new List<AutomationElement>(kept);
      for (int i = 0; i < kids.Count; i++)
      {
        if (keep[i]) chosen.Add(kids[i]);
      }
      lock (gate)
      {
        node.Add("childCount", kids.Count);
        node.Add("childrenCut", true);
        cutNodes = true;
      }
      return chosen;
    }
  }

  /// <summary>The dispatch table and the methods (PROTOCOL.md, "Methods").</summary>
  internal static class Methods
  {
    private static Server server;
    private static string dpi = "unaware";

    internal static void Init(Server s, string awareness)
    {
      server = s;
      dpi = awareness;
    }

    // test/unit/uia-files.test.ts checks these names against the methods PROTOCOL.md documents.
    internal static MethodSpec[] Table()
    {
      return new MethodSpec[]
      {
        new MethodSpec("ping", Ping, null, MethodSpec.Inline),
        new MethodSpec("status", Status, null, MethodSpec.Inline),
        new MethodSpec("release", Release, null, MethodSpec.Inline),
        new MethodSpec("topWindows", TopWindows, null, MethodSpec.Read),
        new MethodSpec("snapshot", Snapshot, SnapshotTarget, MethodSpec.Read),
        new MethodSpec("element", Element, HandleTarget, MethodSpec.Read),
        new MethodSpec("elementsAt", ElementsAt, PointTarget, MethodSpec.Read),
        new MethodSpec("focused", Focused, ForegroundTarget, MethodSpec.Read),
        new MethodSpec("children", Children, HandleTarget, MethodSpec.Read),
        new MethodSpec("perform", Perform, HandleTarget, MethodSpec.Act),
        new MethodSpec("textInfo", TextInfo, HandleTarget, MethodSpec.Read),
      };
    }

    /// <summary>Gives an element a new handle, owned by its own process (or the call's when it can't tell).</summary>
    internal static int Register(Call c, AutomationElement el, IntPtr window)
    {
      int pid = Props.Pid(el);
      if (pid == 0) pid = c.Pid;
      int handle = server.Handles.Add(el, pid, window);
      c.Track(handle);
      return handle;
    }

    private static Want WantOf(JObj p, bool legacy)
    {
      return new Want(Args.Flag(p, "values", true), Args.Flag(p, "legacy", legacy));
    }

    private static bool IsDesktop(AutomationElement el, IntPtr desktop)
    {
      return desktop != IntPtr.Zero && Props.Hwnd(el) == desktop;
    }

    // ---- targets: run on the reader thread, so only the handle table and Win32 calls that can't block.

    private static int HandleTarget(Call c)
    {
      int handle = Args.Handle(c.Params, "handle");
      Entry e = server.Handles.Get(handle);
      if (e == null) throw new BridgeError("gone", "unknown handle " + handle.ToString(CultureInfo.InvariantCulture) + " (released, evicted or never given)");
      c.Target = e;
      c.Window = e.Window;
      return e.Pid;
    }

    private static int SnapshotTarget(Call c)
    {
      JObj p = c.Params;
      if (p.Get("handle") != null) return HandleTarget(c);
      if (p.Get("hwnd") != null)
      {
        double hwnd = Args.Number(p, "hwnd");
        if (hwnd <= 0 || hwnd != Math.Floor(hwnd) || hwnd > long.MaxValue) throw Args.Bad("hwnd must be a window handle");
        c.Window = new IntPtr((long)hwnd);
        int pid = Win.PidOf(c.Window);
        if (pid == 0) throw new BridgeError("gone", "there is no such window");
        return pid;
      }
      if (p.Get("pid") != null)
      {
        int pid = Args.Int(p, "pid", 0, 0, int.MaxValue);
        Args.Text(p, "name");
        return pid;
      }
      throw Args.Bad("snapshot needs a handle, an hwnd, or a pid and a name");
    }

    private static int PointTarget(Call c)
    {
      double x = Args.Number(c.Params, "x");
      double y = Args.Number(c.Params, "y");
      c.Window = Win.RootAt(x, y);
      return c.Window == IntPtr.Zero ? 0 : Win.PidOf(c.Window);
    }

    private static int ForegroundTarget(Call c)
    {
      c.Window = Win.Foreground();
      return c.Window == IntPtr.Zero ? 0 : Win.PidOf(c.Window);
    }

    // ---- inline methods

    private static object Ping(Call c) { return new JObj().Add("version", Bridge.Version); }

    private static object Status(Call c)
    {
      return new JObj()
        .Add("version", Bridge.Version)
        .Add("dpi", dpi)
        .Add("handles", server.Handles.Count)
        .Add("busyPids", server.BusyPids())
        .Add("workers", server.Pool.Total)
        .Add("idleWorkers", server.Pool.Idle)
        .Add("clr", Environment.Version.ToString())
        .Add("os", Environment.OSVersion.VersionString);
    }

    private static object Release(Call c)
    {
      foreach (int h in Args.Handles(c.Params, "handles")) server.Handles.Remove(h);
      return new JObj();
    }

    // ---- topWindows

    private sealed class Listed
    {
      internal IntPtr Hwnd;
      internal int Pid;
      internal JObj Rect;
    }

    private sealed class Group
    {
      internal readonly List<Listed> Windows = new List<Listed>();
      internal readonly object Gate = new object();
      internal bool Done;
      internal Dictionary<long, JObj> Found;
    }

    private static object TopWindows(Call c)
    {
      int only = Args.Int(c.Params, "pid", 0, 0, int.MaxValue);
      List<IntPtr> all = Win.TopLevel();
      IntPtr foreground = Win.Foreground();
      List<Listed> listed = new List<Listed>();
      Dictionary<int, Group> groups = new Dictionary<int, Group>();
      List<int> order = new List<int>();
      for (int z = 0; z < all.Count; z++)
      {
        IntPtr h = all[z];
        if (!Win.Visible(h) || Win.Cloaked(h)) continue;
        JObj rect = Win.Rect(h);
        if (rect == null) continue;
        int pid = Win.PidOf(h);
        if (pid == 0 || (only > 0 && pid != only)) continue;
        Listed w = new Listed();
        w.Hwnd = h;
        w.Pid = pid;
        w.Rect = rect;
        listed.Add(w);
        Group g;
        if (!groups.TryGetValue(pid, out g))
        {
          g = new Group();
          groups[pid] = g;
          order.Add(pid);
        }
        g.Windows.Add(w);
      }
      // Each process is read on its own worker, so one that doesn't answer costs only its own windows.
      Batch batch = new Batch();
      double subDeadline = c.RemainingMs - 60;
      foreach (int pid in order)
      {
        Group g = groups[pid];
        Group captured = g;
        server.Sub(c, pid, g.Windows[0].Hwnd, subDeadline, delegate (Call s) { return ReadWindows(s, captured); }, batch, delegate (object result, BridgeError error)
        {
          lock (captured.Gate)
          {
            captured.Done = true;
            captured.Found = error == null ? result as Dictionary<long, JObj> : null;
          }
        });
      }
      batch.Wait(c, 20);
      Dictionary<int, string> programs = new Dictionary<int, string>();
      List<object> windows = new List<object>();
      int z2 = 0;
      foreach (Listed w in listed)
      {
        Group g = groups[w.Pid];
        Dictionary<long, JObj> found;
        bool done;
        lock (g.Gate)
        {
          done = g.Done;
          found = g.Found;
        }
        JObj entry = null;
        bool busy = !done || found == null;
        if (!busy)
        {
          // Not there: not a control element, or it closed meanwhile. There but null: it failed to answer.
          if (!found.TryGetValue(Win.Number(w.Hwnd), out entry)) continue;
          busy = entry == null;
        }
        if (busy)
        {
          entry = new JObj().Add("name", Win.Title(w.Hwnd)).Add("className", Win.ClassName(w.Hwnd)).Add("bounds", w.Rect);
        }
        AddWindowFacts(entry, w, foreground, programs, z2++);
        if (busy) entry.Add("busy", true);
        windows.Add(entry);
      }
      return new JObj().Add("windows", windows);
    }

    private static Dictionary<long, JObj> ReadWindows(Call s, Group g)
    {
      Dictionary<long, JObj> found = new Dictionary<long, JObj>();
      CacheRequest request = Props.Request(false);
      Want want = new Want(false, false);
      using (request.Activate())
      {
        foreach (Listed w in g.Windows)
        {
          if (s.Abandoned) break;
          long key = Win.Number(w.Hwnd);
          AutomationElement el;
          try { el = Props.Ensure(AutomationElement.FromHandle(w.Hwnd), request); }
          catch (ElementNotAvailableException) { continue; }
          catch (ArgumentException) { continue; }
          catch (InvalidOperationException) { continue; }
          catch (TimeoutException) { throw; }
          catch (Exception)
          {
            // This window failed (a provider error): list it from Win32 facts, and read the process's others.
            found[key] = null;
            continue;
          }
          if (Props.Flag(el, AutomationElement.IsControlElementProperty) == false) continue;
          int handle = Register(s, el, w.Hwnd);
          found[key] = Props.Node(el, handle, Props.NoTree, Props.NoTree, want);
        }
      }
      return found;
    }

    private static void AddWindowFacts(JObj entry, Listed w, IntPtr foreground, Dictionary<int, string> programs, int z)
    {
      entry.Add("hwnd", Win.Number(w.Hwnd));
      entry.Add("pid", w.Pid);
      string program;
      if (!programs.TryGetValue(w.Pid, out program))
      {
        program = Win.Program(w.Pid);
        programs[w.Pid] = program;
      }
      if (string.Equals(program, "ApplicationFrameHost", StringComparison.OrdinalIgnoreCase))
      {
        int hosted = Win.Hosted(w.Hwnd, w.Pid);
        if (hosted > 0)
        {
          string app;
          if (!programs.TryGetValue(hosted, out app))
          {
            app = Win.Program(hosted);
            programs[hosted] = app;
          }
          entry.Add("hostedPid", hosted);
          if (app.Length > 0) program = app;
        }
      }
      entry.Add("processName", program);
      IntPtr owner = Win.Owner(w.Hwnd);
      if (owner != IntPtr.Zero) entry.Add("owner", Win.Number(owner));
      JObj patterns = entry.Get("patterns") as JObj;
      JObj window = patterns != null ? patterns.Get("window") as JObj : null;
      if (window != null)
      {
        if (window.Has("modal")) entry.Add("isModal", window.Get("modal"));
        if (window.Has("state")) entry.Add("windowState", window.Get("state"));
      }
      entry.Add("isTopmost", Win.Topmost(w.Hwnd));
      entry.Add("focused", w.Hwnd == foreground);
      entry.Add("z", z);
    }

    // ---- snapshot

    private static object Snapshot(Call c)
    {
      JObj p = c.Params;
      int maxDepth = Args.Int(p, "maxDepth", 64, 0, 256);
      int maxNodes = Args.Int(p, "maxNodes", 400, 1, 20000);
      int maxChildren = Args.Int(p, "maxChildren", 200, 1, 20000);
      Want want = WantOf(p, false);
      CacheRequest request = Props.Request(false);
      AutomationElement root;
      using (request.Activate()) root = SnapshotRoot(c, request);
      IntPtr window = c.Window != IntPtr.Zero ? c.Window : Props.Hwnd(root);
      Walk walk = new Walk(c, want, maxDepth, maxNodes, maxChildren, window);
      c.Partial = walk.Partial;
      walk.Run(root);
      return walk.Answer();
    }

    private static AutomationElement SnapshotRoot(Call c, CacheRequest request)
    {
      Entry e = c.Target as Entry;
      if (e != null)
      {
        try { return ((AutomationElement)e.Element).GetUpdatedCache(request); }
        catch (ElementNotAvailableException)
        {
          server.Handles.Remove(e.Handle);
          throw;
        }
      }
      if (c.Params.Get("hwnd") != null)
      {
        try { return Props.Ensure(AutomationElement.FromHandle(c.Window), request); }
        catch (ArgumentException) { throw new BridgeError("gone", "there is no such window", c.Pid); }
      }
      string name = Args.Text(c.Params, "name");
      AutomationElement byTitle = null;
      foreach (IntPtr h in Win.TopLevel())
      {
        if (Win.PidOf(h) != c.Pid || !Win.Visible(h) || Win.Cloaked(h)) continue;
        AutomationElement el;
        try { el = Props.Ensure(AutomationElement.FromHandle(h), request); }
        catch (ElementNotAvailableException) { continue; }
        catch (ArgumentException) { continue; }
        if (string.Equals(Props.Get(el, AutomationElement.NameProperty) as string, name, StringComparison.Ordinal))
        {
          c.Window = h;
          return el;
        }
        if (byTitle == null && string.Equals(Win.Title(h), name, StringComparison.Ordinal))
        {
          byTitle = el;
          c.Window = h;
        }
      }
      if (byTitle != null) return byTitle;
      throw new BridgeError("gone", "no window of that process has that name", c.Pid);
    }

    // ---- element, elementsAt, focused, children

    private static object Element(Call c)
    {
      Entry e = (Entry)c.Target;
      AutomationElement fresh;
      try { fresh = ((AutomationElement)e.Element).GetUpdatedCache(Props.Request(false)); }
      catch (ElementNotAvailableException)
      {
        server.Handles.Remove(e.Handle);
        throw;
      }
      return Props.Node(fresh, e.Handle, Props.NoTree, Props.NoTree, WantOf(c.Params, true));
    }

    private static object ElementsAt(Call c)
    {
      double x = Args.Number(c.Params, "x");
      double y = Args.Number(c.Params, "y");
      Want want = WantOf(c.Params, false);
      CacheRequest request = Props.Request(false);
      List<object> result = new List<object>();
      using (request.Activate())
      {
        AutomationElement el = AutomationElement.FromPoint(new Point(x, y));
        if (el == null) return result;
        el = Props.Ensure(el, request);
        if (Props.Flag(el, AutomationElement.IsControlElementProperty) == false)
        {
          el = TreeWalker.ControlViewWalker.Normalize(el, request);
          if (el == null) return result;
        }
        IntPtr desktop = Native.GetDesktopWindow();
        List<AutomationElement> chain = new List<AutomationElement>();
        AutomationElement current = el;
        while (current != null && chain.Count < 64 && !c.Abandoned)
        {
          if (IsDesktop(current, desktop)) break;
          chain.Add(current);
          current = TreeWalker.ControlViewWalker.GetParent(current, request);
        }
        chain.Reverse();
        IntPtr window = chain.Count > 0 ? Props.Hwnd(chain[0]) : IntPtr.Zero;
        if (window == IntPtr.Zero) window = c.Window;
        for (int i = 0; i < chain.Count; i++)
        {
          int handle = Register(c, chain[i], window);
          result.Add(Props.Node(chain[i], handle, i - 1, i, want));
        }
      }
      return result;
    }

    private static object Focused(Call c)
    {
      Want want = WantOf(c.Params, false);
      CacheRequest request = Props.Request(false);
      JObj result = new JObj().Add("element", null).Add("window", null).Add("hwnd", null);
      using (request.Activate())
      {
        AutomationElement focused = AutomationElement.FocusedElement;
        if (focused == null) return result;
        focused = Props.Ensure(focused, request);
        IntPtr desktop = Native.GetDesktopWindow();
        if (IsDesktop(focused, desktop)) return result;
        AutomationElement top = focused;
        for (int i = 0; i < 64 && !c.Abandoned; i++)
        {
          AutomationElement parent = TreeWalker.ControlViewWalker.GetParent(top, request);
          if (parent == null || IsDesktop(parent, desktop)) break;
          top = parent;
        }
        IntPtr hwnd = Props.Hwnd(top);
        int elementHandle = Register(c, focused, hwnd != IntPtr.Zero ? hwnd : c.Window);
        int windowHandle = Register(c, top, hwnd != IntPtr.Zero ? hwnd : c.Window);
        result.Add("element", Props.Node(focused, elementHandle, Props.NoTree, Props.NoTree, want));
        result.Add("window", windowHandle);
        if (hwnd != IntPtr.Zero) result.Add("hwnd", Win.Number(hwnd));
      }
      return result;
    }

    private static object Children(Call c)
    {
      Entry e = (Entry)c.Target;
      int max = Args.Int(c.Params, "max", 200, 1, 10000);
      Want want = WantOf(c.Params, false);
      AutomationElementCollection found = Props.FindChildren((AutomationElement)e.Element, false);
      List<object> result = new List<object>();
      foreach (AutomationElement kid in found)
      {
        if (result.Count >= max || c.Abandoned) break;
        int handle = Register(c, kid, e.Window);
        result.Add(Props.Node(kid, handle, Props.NoTree, Props.NoTree, want));
      }
      return result;
    }

    // ---- perform

    private static object Pattern(AutomationElement el, AutomationPattern pattern, string op)
    {
      object p;
      if (!el.TryGetCurrentPattern(pattern, out p) || p == null) throw new BridgeError("failed", "unsupported:" + op);
      return p;
    }

    private static object Perform(Call c)
    {
      Entry e = (Entry)c.Target;
      AutomationElement el = (AutomationElement)e.Element;
      string op = Args.Text(c.Params, "op");
      switch (op)
      {
        case "invoke": ((InvokePattern)Pattern(el, InvokePattern.Pattern, op)).Invoke(); break;
        case "toggle": ((TogglePattern)Pattern(el, TogglePattern.Pattern, op)).Toggle(); break;
        case "select": ((SelectionItemPattern)Pattern(el, SelectionItemPattern.Pattern, op)).Select(); break;
        case "addToSelection": ((SelectionItemPattern)Pattern(el, SelectionItemPattern.Pattern, op)).AddToSelection(); break;
        case "removeFromSelection": ((SelectionItemPattern)Pattern(el, SelectionItemPattern.Pattern, op)).RemoveFromSelection(); break;
        case "expand": ((ExpandCollapsePattern)Pattern(el, ExpandCollapsePattern.Pattern, op)).Expand(); break;
        case "collapse": ((ExpandCollapsePattern)Pattern(el, ExpandCollapsePattern.Pattern, op)).Collapse(); break;
        case "setValue":
          {
            string value = Args.Text(c.Params, "value");
            if (Props.IsSecret(el)) throw new BridgeError("denied", "this is a password field", e.Pid);
            ((ValuePattern)Pattern(el, ValuePattern.Pattern, op)).SetValue(value);
            break;
          }
        case "setRange":
          {
            double value = Args.Number(c.Params, "value");
            ((RangeValuePattern)Pattern(el, RangeValuePattern.Pattern, op)).SetValue(value);
            break;
          }
        case "focus": el.SetFocus(); break;
        case "scrollIntoView": ((ScrollItemPattern)Pattern(el, ScrollItemPattern.Pattern, op)).ScrollIntoView(); break;
        case "legacyDefaultAction": Legacy.DoDefaultAction(el); break;
        default: throw Args.Bad("unknown op: " + (op.Length > 32 ? op.Substring(0, 32) : op));
      }
      return new JObj().Add("ok", true);
    }

    // ---- textInfo

    private static string Cut(string s, int max, ref bool truncated)
    {
      if (s == null) return "";
      if (s.Length <= max) return s;
      truncated = true;
      return s.Substring(0, max);
    }

    private static object TextInfo(Call c)
    {
      Entry e = (Entry)c.Target;
      AutomationElement el = (AutomationElement)e.Element;
      int max = Args.Int(c.Params, "maxChars", Props.TextCap, 1, 100000);
      if (Props.IsSecret(el)) return new JObj().Add("secret", true);
      object pattern;
      JObj r = new JObj();
      if (el.TryGetCurrentPattern(TextPattern.Pattern, out pattern) && pattern != null)
      {
        TextPattern text = (TextPattern)pattern;
        TextPatternRange document = text.DocumentRange;
        bool truncated = false;
        r.Add("source", "text").Add("text", Cut(document.GetText(max + 1), max, ref truncated));
        if (truncated) r.Add("truncated", true);
        TextPatternRange[] selection;
        try { selection = text.GetSelection(); }
        catch (InvalidOperationException) { selection = null; }
        if (selection != null && selection.Length > 0)
        {
          StringBuilder selected = new StringBuilder();
          foreach (TextPatternRange range in selection)
          {
            if (selected.Length > max) break;
            selected.Append(range.GetText(max + 1 - selected.Length));
          }
          bool cut = false;
          r.Add("selection", Cut(selected.ToString(), max, ref cut));
          if (selection.Length == 1)
          {
            TextPatternRange before = document.Clone();
            before.MoveEndpointByRange(TextPatternRangeEndpoint.End, selection[0], TextPatternRangeEndpoint.Start);
            string head = before.GetText(max + 1);
            if (head.Length <= max)
            {
              r.Add("caret", head.Length);
              string own = selection[0].GetText(max + 1);
              if (own.Length <= max) r.Add("selectionLength", own.Length);
            }
            r.Add("caretAtEnd", selection[0].CompareEndpoints(TextPatternRangeEndpoint.End, document, TextPatternRangeEndpoint.End) >= 0);
          }
        }
        return r;
      }
      if (el.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) && pattern != null)
      {
        string value = el.GetCurrentPropertyValue(ValuePattern.ValueProperty) as string;
        bool truncated = false;
        r.Add("source", "value").Add("text", Cut(value, max, ref truncated));
        if (truncated) r.Add("truncated", true);
      }
      return r;
    }
  }
}
