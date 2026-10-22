/*
  Ember Bench (macOS): the small AppKit window Ember's macOS accessibility tests drive (the sidecar host's AX provider,
  through test/integration/ax-sidecar-darwin.test.ts). A JavaScript for Automation script run by osascript, so its
  window's process is "osascript" and nothing needs compiling. It logs every change as one JSON line, as
  win_bench.ps1 does on Windows, so a test sees what its actions did without reading the screen; a password's text
  never reaches the log, only its length.

  Usage:
    osascript -l JavaScript test/fixtures/mac_bench.js <log file> [seconds, default 600; 0: never on its own]
  The bench stops when its window closes, when the seconds elapse, or when the process that started it goes away.

  Controls (accessibility labels, top to bottom): Name (text field, a "Name" label beside it as its title element),
  Password (secure text field, a "Password" label likewise), Remember me (check box), Theme (pop-up: Light, Dark,
  System), Volume (slider 0-100, at 50), Notes (text view in a scroll view), Rows (a 200-row table, "Row 1" to
  "Row 200", in a scroll view), Save (push button).

  Log lines (UTF-8, one object per line):
    {"event":"ready","pid":N,"window":N,"title":"Ember Bench (macOS)","actions":true,"frame":{rect}}
      "window" is the CGWindowID (NSWindow windowNumber); "frame" is in points from the top left of the main display
      (the space AX and the window list use); "actions" is false when JXA's ObjC.registerSubclass didn't work, so
      Save's target-action (the "click" line) can't be heard.
    {"event":"text","control":"Name","length":N}         (also Password and Notes)
    {"event":"toggle","control":"Remember me","checked":true}
    {"event":"select","control":"Theme","value":"Dark"}  (also Rows: "Row 5")
    {"event":"value","control":"Volume","value":N}
    {"event":"click","control":"Save"}
    {"event":"error","message":"..."}
    {"event":"exit","why":"..."}
  Changes are found by looking at every control every 50 ms, whatever made them (AX sets a value without the
  notifications a user's typing sends); clicks come from Save's action.

  The event loop is the script's own (nextEventMatchingMask, which also serves AX requests), so the bench needs no
  timers and no -[NSApplication run]; only Save's target needs a registered subclass.
*/
/* global ObjC, $ */

ObjC.import("Cocoa");

const WIDTH = 480;
const HEIGHT = 610;
const TITLE = "Ember Bench (macOS)";
/** NSEventMaskAny is every bit of an NSUInteger, which a JavaScript number can't hold: every bit up to 2^53. */
const EVENT_MASK = Number.MAX_SAFE_INTEGER;
const UTF8 = 4;

/**
 * JXA calls an Objective-C method that takes no arguments when it is read as a property (`win.center`): this names
 * such a read as the call it is.
 */
function call(_result) {}

/** Appends one JSON line to the log (never a password's text: only lengths are logged for it). */
function logger(path) {
  $.NSFileManager.defaultManager.createFileAtPathContentsAttributes(path, $(), $());
  const handle = $.NSFileHandle.fileHandleForWritingAtPath(path);
  return line => {
    try {
      call(handle.seekToEndOfFile);
      handle.writeData($(JSON.stringify(line) + "\n").dataUsingEncoding(UTF8));
    } catch {
      // The log can't be written: the test times out on its own.
    }
  };
}

/** A rectangle given from the top left of the window's content (y down) as Cocoa's (y up). */
function rect(x, y, width, height) {
  return $.NSMakeRect(x, HEIGHT - y - height, width, height);
}

/** A string an AppKit call returned, as JavaScript's ("" for nil). */
function js(s) {
  try {
    return s && typeof s.js === "string" ? s.js : String(ObjC.unwrap(s) ?? "");
  } catch {
    return ""; // not a string after all
  }
}

/** A Cocoa screen rectangle (from the bottom left of the main display) in points from its top left. */
function topLeft(r) {
  const main = $.NSScreen.screens.objectAtIndex(0).frame;
  return { x: r.origin.x, y: main.size.height - r.origin.y - r.size.height, width: r.size.width, height: r.size.height };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- osascript calls run() with the command line's arguments
function run(argv) {
  const log = logger(String(argv[0] || "/tmp/ember-mac-bench.jsonl"));
  const seconds = argv.length > 1 ? Number(argv[1]) : 600;
  try {
    bench(log, seconds);
  } catch (e) {
    log({ event: "error", message: String(e) });
    log({ event: "exit", why: "error" });
  }
}

function bench(log, seconds) {
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(0); // NSApplicationActivationPolicyRegular: a window that can come to the front
  call(app.finishLaunching);

  // Save's action, where JXA can register a subclass (the bench works without it, saying so in its ready line).
  let target = null;
  try {
    ObjC.registerSubclass({
      name: "EmberBenchTarget",
      superclass: "NSObject",
      methods: {
        "saveClicked:": {
          types: ["void", ["id"]],
          implementation: function () {
            log({ event: "click", control: "Save" });
          },
        },
      },
    });
    target = $.EmberBenchTarget.alloc.init;
  } catch (e) {
    log({ event: "error", message: `no target-action: ${String(e)}` });
  }

  // Titled (1) | closable (2) | miniaturizable (4), buffered (2).
  const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0, 0, WIDTH, HEIGHT), 1 | 2 | 4, 2, false);
  win.title = TITLE;
  win.releasedWhenClosed = false;
  const view = win.contentView;
  const add = control => {
    view.addSubview(control);
    return control;
  };
  const label = (text, y) => {
    const l = $.NSTextField.labelWithString(text);
    l.frame = rect(20, y + 2, 90, 20);
    return add(l);
  };

  const nameLabel = label("Name", 18);
  const name = add($.NSTextField.alloc.initWithFrame(rect(120, 18, 320, 24)));
  name.setAccessibilityLabel("Name");
  name.setAccessibilityTitleUIElement(nameLabel);

  const passwordLabel = label("Password", 54);
  const password = add($.NSSecureTextField.alloc.initWithFrame(rect(120, 54, 320, 24)));
  password.setAccessibilityLabel("Password");
  password.setAccessibilityTitleUIElement(passwordLabel);

  const remember = add($.NSButton.alloc.initWithFrame(rect(120, 90, 200, 22)));
  remember.setButtonType(3); // NSButtonTypeSwitch: a check box
  remember.title = "Remember me";

  label("Theme", 122);
  const theme = add($.NSPopUpButton.alloc.initWithFramePullsDown(rect(120, 120, 180, 26), false));
  theme.addItemsWithTitles($(["Light", "Dark", "System"]));
  theme.setAccessibilityLabel("Theme");

  label("Volume", 160);
  const volume = add($.NSSlider.alloc.initWithFrame(rect(120, 160, 240, 24)));
  volume.minValue = 0;
  volume.maxValue = 100;
  volume.doubleValue = 50;
  volume.setAccessibilityLabel("Volume");

  label("Notes", 196);
  const notesScroll = add($.NSScrollView.alloc.initWithFrame(rect(120, 196, 320, 70)));
  const notes = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0, 0, 320, 70));
  notes.string = "First line\nSecond line";
  notes.setAccessibilityLabel("Notes");
  notesScroll.documentView = notes;
  notesScroll.hasVerticalScroller = true;

  label("Rows", 278);
  const rows = $.NSMutableArray.array;
  for (let i = 1; i <= 200; i++) rows.addObject($.NSDictionary.dictionaryWithObjectForKey(`Row ${i}`, "name"));
  const content = $.NSArrayController.alloc.initWithContent(rows);
  const tableScroll = add($.NSScrollView.alloc.initWithFrame(rect(120, 278, 320, 260)));
  const table = $.NSTableView.alloc.initWithFrame($.NSMakeRect(0, 0, 320, 260));
  const column = $.NSTableColumn.alloc.initWithIdentifier("name");
  column.width = 290;
  column.editable = false;
  table.addTableColumn(column);
  table.headerView = $();
  column.bindToObjectWithKeyPathOptions("value", content, "arrangedObjects.name", $());
  table.setAccessibilityLabel("Rows");
  tableScroll.documentView = table;
  tableScroll.hasVerticalScroller = true;

  const save = add($.NSButton.alloc.initWithFrame(rect(120, 556, 100, 32)));
  save.title = "Save";
  save.bezelStyle = 1; // NSBezelStyleRounded: a push button
  if (target) {
    save.target = target;
    save.action = "saveClicked:";
  }

  call(win.center);
  win.makeKeyAndOrderFront($());
  app.activateIgnoringOtherApps(true);

  /** What every control holds now (the password's length only). */
  const look = () => ({
    Name: js(name.stringValue).length,
    Password: js(password.stringValue).length,
    Notes: js(notes.string).length,
    "Remember me": Number(remember.state) === 1,
    Theme: js(theme.titleOfSelectedItem),
    Volume: Math.round(Number(volume.doubleValue)),
    Rows: Number(table.selectedRow) >= 0 ? `Row ${Number(table.selectedRow) + 1}` : "",
  });
  /** The log line for a control whose state changed. */
  const lineFor = (control, value) => {
    if (control === "Name" || control === "Password" || control === "Notes") return { event: "text", control, length: value };
    if (control === "Remember me") return { event: "toggle", control, checked: value };
    if (control === "Volume") return { event: "value", control, value };
    return { event: "select", control, value };
  };

  let getppid = null;
  try {
    ObjC.bindFunction("getppid", ["int", []]);
    getppid = () => Number($.getppid());
  } catch {
    // Can't tell: the seconds and the window still end it.
  }
  const parent = getppid ? getppid() : 0;
  const until = seconds > 0 ? Date.now() + seconds * 1000 : Infinity;
  const pump = ms => {
    const event = app.nextEventMatchingMaskUntilDateInModeDequeue(EVENT_MASK, $.NSDate.dateWithTimeIntervalSinceNow(ms / 1000), "kCFRunLoopDefaultMode", true);
    if (event && !(typeof event.isNil === "function" && event.isNil())) app.sendEvent(event);
  };

  // Shown and settled before the ready line: the window list and AX know the window by then.
  for (let i = 0; i < 10; i++) pump(20);
  let last = look();
  log({ event: "ready", pid: Number($.NSProcessInfo.processInfo.processIdentifier), window: Number(win.windowNumber), title: TITLE, actions: !!target, frame: topLeft(win.frame) });

  let why = "";
  while (!why) {
    pump(50);
    try {
      const now = look();
      for (const control of Object.keys(now)) {
        if (now[control] !== last[control]) log(lineFor(control, now[control]));
      }
      last = now;
    } catch (e) {
      log({ event: "error", message: String(e) });
    }
    if (!win.isVisible) why = "closed";
    else if (Date.now() >= until) why = "time";
    else if (getppid && parent > 1 && getppid() !== parent) why = "orphaned";
  }
  log({ event: "exit", why });
}
