import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/experimental/windows-uv-spawn-file-version.py", import.meta.url));
const selectedPython = process.env.EMBER_UV_SPAWN_PYTHON;
const required = process.env.CI === "true" || selectedPython !== undefined;
const python = process.platform === "win32" ? selectedPython ?? "python" : "python3";
const available = spawnSync(python, ["-I", "-B", "--version"], { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] }).status === 0;
if (required && !available) throw new Error("The required fixed-reader suite could not start its trusted Python interpreter.");
const directories: string[] = [];
const temp = () => { const value = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ember-file-version-unit-")); directories.push(value); return value; };
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

// Imported helpers alone receive mocks. The production CLI has no injected API/DLL/pin/fixture switches.
const fixture = String.raw`
import ast,ctypes,hashlib,importlib.util,json,os,pathlib,re,struct,sys
spec=importlib.util.spec_from_file_location("fixed_version",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
c=json.loads(sys.argv[2]);root=pathlib.Path(sys.argv[3]);calls=[]
def forbidden(*args,**kwargs):raise Exception("private DLL load")
ctypes.WinDLL=forbidden
class MockApi:
 def get_size(self,name):return c.get("size",16384)
 def fill(self,name,size,buffer):
  self.buffer=buffer;self.base=ctypes.addressof(buffer);self.offsets={};self.units={}
  words=c.get("words",[19,44,35211,0]);fixed=[c.get("signature",m.SIGNATURE),c.get("structure",65536),(words[0]<<16)|words[1],(words[2]<<16)|words[3]]+[0]*9
  if size>=52:ctypes.memmove(self.base,struct.pack("<13I",*fixed),52)
  pairs=c.get("pairs",[[0x0409,0x04b0]]);translation=b"".join(struct.pack("<HH",*pair) for pair in pairs)
  if 64+len(translation)<=size:ctypes.memmove(self.base+64,translation,len(translation))
  self.translation=translation;offset=(64+len(translation)+19)//4*4
  strings=c.get("strings",{"040904B0":"19.44.35211.0"})
  for key,text in strings.items():
   data=bytes.fromhex(c.get("raw",{}).get(key,"")) if key in c.get("raw",{}) else (text+"\0").encode("utf-16le")
   self.offsets[key]=offset;self.units[key]=len(data)//2
   if offset+len(data)<=size:ctypes.memmove(self.base+offset,data,len(data))
   offset=(offset+len(data)+3)//4*4
  if c.get("mutate"):pathlib.Path(name).write_bytes(b"public changed identity")
  return c.get("filled",True)
 def query(self,buffer,name):
  calls.append(name)
  if c.get("queryThrows"):raise Exception("private API path")
  if name=="\\":key="root";value=(True,self.base,c.get("rootLength",52))
  elif name=="\\VarFileInfo\\Translation":
   key="translation";value=(False,0,0) if c.get("noTranslation") else (True,self.base+64,c.get("translationLength",len(self.translation)))
  else:
   match=re.fullmatch(r"\\\\StringFileInfo\\\\([0-9A-F]{8})\\\\FileVersion",name)
   if match is None:m._fail(12)
   key=match.group(1)
   if key not in self.offsets:return(False,0,0)
   value=(True,self.base+self.offsets[key],c.get("stringUnits",{}).get(key,self.units[key]))
  if key in c.get("missing",[]):return(False,0,0)
  pointer=c.get("pointer",{}).get(key)
  if pointer=="before":value=(True,self.base-2,value[2])
  elif pointer=="after":value=(True,self.base+ctypes.sizeof(buffer),value[2])
  elif pointer=="unaligned":value=(True,value[1]+1,value[2])
  elif pointer=="lastbyte":value=(True,self.base+ctypes.sizeof(buffer)-1,value[2])
  return value
try:
 if c.get("mode")=="fixture":
  data=m.fixture_pe("1.2.3.0",(1,2,3,0),(0x041104B0,0x040904B0),((0x040c,0x04b0),(0x0411,0x04b0)))
  pe=struct.unpack_from("<I",data,60)[0];optional=pe+24;section=optional+240
  print(json.dumps({"ok":True,"bytes":len(data),"sha256":hashlib.sha256(data).hexdigest(),"entry":struct.unpack_from("<I",data,optional+16)[0],"code":struct.unpack_from("<I",data,optional+4)[0],"imports":struct.unpack_from("<II",data,optional+120),"sectionFlags":struct.unpack_from("<I",data,section+36)[0],"resourceType":struct.unpack_from("<I",data,512+16)[0],"resourceId":struct.unpack_from("<I",data,512+40)[0],"resourceLanguage":struct.unpack_from("<I",data,512+64)[0]}))
 elif c.get("mode")=="syntax":
  source=pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
  try:ast.parse(source,feature_version=(3,6))
  except TypeError:ast.parse(source)
  print(json.dumps({"ok":True,"forbidden":any(value in source for value in ["file_digest(","removeprefix(","GetLastError(","LoadLibrary("])}))
 elif c.get("mode")=="declaredSize":
  buffer=ctypes.create_string_buffer(16384);api=MockApi();api.fill("public",16384,buffer);copies=[]
  def no_copy(*args):copies.append(True);raise Exception("private copy must not occur")
  ctypes.string_at=no_copy
  try:m.parse_version_block(api,buffer,c["declaredSize"]);print(json.dumps({"ok":True,"copies":len(copies)}))
  except m.VersionRefusal as error:print(json.dumps({"ok":False,"stage":error.args[0],"copies":len(copies)}))
 elif c.get("mode")=="adapter":
  loads=[]
  class Fn:pass
  class Library:
   GetFileVersionInfoSizeW=Fn();GetFileVersionInfoW=Fn();VerQueryValueW=Fn()
  def load(name,**kwargs):loads.append(kwargs);return Library()
  ctypes.WinDLL=load;m._validated_path=lambda *args,**kwargs:"ordinary-public-identity"
  sizes={ctypes.c_void_p:8,ctypes.c_wchar:2,ctypes.c_uint32:4,ctypes.c_int:4}
  types={"pointer":ctypes.c_void_p,"wchar":ctypes.c_wchar,"dword":ctypes.c_uint32,"bool":ctypes.c_int}
  if c.get("badABI") in types:sizes[types[c["badABI"]]]=1
  original_sizeof=ctypes.sizeof;ctypes.sizeof=lambda value:sizes[value] if value in sizes else original_sizeof(value)
  old_name=os.name
  try:
   os.name="nt";api=m.WindowsVersionApi("public-root")
   checks=[api.size_fn.argtypes==[ctypes.c_wchar_p,ctypes.POINTER(ctypes.c_uint32)],api.size_fn.restype is ctypes.c_uint32,
    api.info_fn.argtypes==[ctypes.c_wchar_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p],api.info_fn.restype is ctypes.c_int,
    api.query_fn.argtypes==[ctypes.c_void_p,ctypes.c_wchar_p,ctypes.POINTER(ctypes.c_void_p),ctypes.POINTER(ctypes.c_uint32)],api.query_fn.restype is ctypes.c_int]
   print(json.dumps({"ok":True,"loads":loads,"prototypes":all(checks)}))
  except m.VersionRefusal as error:print(json.dumps({"ok":False,"stage":error.args[0],"loads":loads}))
  finally:os.name=old_name;ctypes.sizeof=original_sizeof
 elif c.get("mode")=="order":
  events=[]
  m._validated_path=lambda *args,**kwargs:None
  class Api:
   def __init__(self,system_root):events.append("adapter")
   def check_identity(self):events.append("identity")
  m.WindowsVersionApi=Api
  def gate(api):
   events.append("fixture")
   if c.get("gateFail"):m._fail(6)
  m.ordinary_fixture_gate=gate
  def read(name,api):events.append(os.path.basename(name));return("19.44.35211.0",0x040904B0)
  m.read_file_version=read
  old_name=os.name
  try:
   os.name="nt";value=m.run(["--compiler",str(root/"cl.exe"),"--linker",str(root/"link.exe")])
   print(json.dumps({"ok":True,"value":value,"events":events}))
  except m.VersionRefusal as error:print(json.dumps({"ok":False,"stage":error.args[0],"events":events}))
  finally:os.name=old_name
 else:
  file=root/"public-version-file.bin";file.write_bytes(b"public")
  if c.get("alias"):
   target=root/"alias.bin";target.symlink_to(file);file=target
  if c.get("hardlink"):
   target=root/"hardlink.bin";os.link(file,target);file=target
  value=m.read_file_version(str(file),MockApi())
  print(json.dumps({"ok":True,"literal":value[0],"winner":value[1],"queries":len(calls)}))
except m.VersionRefusal as error:print(json.dumps({"ok":False,"stage":error.args[0],"queries":len(calls)}))
`;
function run(config: object = {}) {
  const root = temp(), result = spawnSync(python, ["-I", "-B", "-c", fixture, script, JSON.stringify(config), root], { encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true });
  expect(result.status === 0 && result.stderr.length === 0, "The pure fixed-reader fixture must return only its closed JSON.").toBe(true);
  return JSON.parse(result.stdout) as { ok: boolean; stage?: number; literal?: string; winner?: number; queries?: number; events?: string[]; value?: object; [key: string]: unknown };
}
const test = it.skipIf(!available);

test("reads the exact first-translation literal, keeping numeric fields separate", () => {
  expect(run()).toMatchObject({ ok: true, literal: "19.44.35211.0", winner: 0x040904B0 });
  expect(run({ noTranslation: true, strings: { "040904B0": "19.44.35211.0", "040904E4": "19.44.35211.0" } })).toMatchObject({ ok: true, winner: 0x040904E4 });
});

test("uses exact Framework fallback order and never substitutes a later declared translation", () => {
  const pairs = [[0x040c, 0x04b0], [0x0411, 0x04b0]];
  expect(run({ pairs, strings: { "041104B0": "19.44.35211.0" } })).toMatchObject({ ok: false, stage: 13 });
  expect(run({ pairs, strings: { "041104B0": "19.44.35211.0", "040904B0": "19.44.35211.0", "040904E4": "19.44.35211.0" } })).toMatchObject({ ok: true, winner: 0x040904B0 });
  expect(run({ pairs, strings: { "040904B0": "", "040904E4": "19.44.35211.0", "04090000": "19.44.35211.0" } })).toMatchObject({ ok: true, winner: 0x040904E4 });
  expect(run({ pairs, strings: { "04090000": "19.44.35211.0" } })).toMatchObject({ ok: true, winner: 0x04090000 });
});

test("models signed WORD arithmetic rather than unsigned language/codepage concatenation", () => {
  const pairs = [[0x0409, 65001]];
  expect(run({ pairs, strings: { "0409FDE9": "19.44.35211.0" } })).toMatchObject({ ok: false, stage: 13 });
  expect(run({ pairs, strings: { "0408FDE9": "19.44.35211.0", "0409FDE9": "19.44.35211.0" } })).toMatchObject({ ok: true, winner: 0x0408FDE9 });
});

test("preserves three or four original components and rejects numeric/literal disagreement", () => {
  expect(run({ words: [1, 2, 3, 0], strings: { "040904B0": "1.2.3" } })).toMatchObject({ ok: true, literal: "1.2.3" });
  expect(run({ words: [1, 2, 3, 4], strings: { "040904B0": "1.2.3" } })).toMatchObject({ ok: false, stage: 13 });
  expect(run({ words: [1, 2, 3, 0], strings: { "040904B0": "01.2.3.0" } })).toMatchObject({ ok: true, literal: "01.2.3.0" });
  for (const strings of [{ "040904B0": "01.2.3.0", "040904E4": "1.2.3.0" }, { "040904B0": "1.2.3", "040904E4": "1.2.3.0" },
    { "040904B0": "1.2.4.0" }, { "040904B0": "1.2.3.0-private" }, { "040904B0": "1.2.3.0\n" }, { "040904B0": "1.2" }]) {
    expect(run({ words: [1, 2, 3, 0], strings })).toMatchObject({ ok: false, stage: 13 });
  }
});

test.each([0, -1, 1.5, 1024 * 1024 + 1])("refuses invalid API buffer size %s before filling", size => {
  expect(run({ size })).toMatchObject({ ok: false, stage: 8, queries: 0 });
});

test.each([false, 1])("requires a successful typed API fill result: %s", filled => {
  expect(run({ filled })).toMatchObject({ ok: false, stage: 9 });
});

test("requires the exact fixed root structure/signature and bounded translation pairs", () => {
  for (const config of [{ rootLength: 51 }, { rootLength: 53 }, { signature: 0 }, { structure: 0 }, { missing: ["root"] }]) expect(run(config)).toMatchObject({ ok: false, stage: 10 });
  for (const translationLength of [0, 2, 5, 1028]) expect(run({ translationLength })).toMatchObject({ ok: false, stage: 11 });
  expect(run({ pairs: Array.from({ length: 256 }, () => [0x0409, 0x04b0]) })).toMatchObject({ ok: true });
  expect(run({ pairs: Array.from({ length: 257 }, () => [0x0409, 0x04b0]) })).toMatchObject({ ok: false, stage: 11 });
});

test.each(["before", "after", "unaligned", "lastbyte"])("refuses invalid root, translation or string pointers before copying: %s", pointer => {
  for (const [key, stage] of [["root", 10], ["translation", 11], ["040904B0", 12]] as const) expect(run({ pointer: { [key]: pointer } })).toMatchObject({ ok: false, stage });
});

test("checks the declared ownership range against the actual ctypes allocation before any memory copy", () => {
  for (const declaredSize of [16380, 16388]) expect(run({ mode: "declaredSize", declaredSize })).toEqual({ ok: false, stage: 10, copies: 0 });
});

test.each([0, 29, 52, 13, 27])("distinguishes UTF16 characters from bytes and refuses an invalid character length: %s", units => {
  expect(run({ stringUnits: { "040904B0": units } })).toMatchObject({ ok: false, stage: 12 });
});

test.each(["31002e0032002e003300", "310000002e0032000000", "00d80000"])("requires a complete bounded UTF16 string and terminal NUL: %s", raw => {
  expect(run({ raw: { "040904B0": raw } })).toMatchObject({ ok: false, stage: 12 });
});

test("refuses API exceptions and changed file identity without exposing the underlying exception", () => {
  expect(run({ queryThrows: true })).toMatchObject({ ok: false, stage: 10 }); expect(run({ mutate: true })).toMatchObject({ ok: false, stage: 14 });
  expect(run({ hardlink: true })).toMatchObject({ ok: false, stage: 7 });
});

it.skipIf(!available || process.platform === "win32")("refuses file aliases instead of following them", () => {
  expect(run({ alias: true })).toMatchObject({ ok: false, stage: 7 });
});

test("constructs only a tiny public resource-only PE with no executable section, entrypoint or imports", () => {
  expect(run({ mode: "fixture" })).toMatchObject({ ok: true, entry: 0, code: 0, imports: [0, 0], sectionFlags: 0x40000040, resourceType: 16, resourceId: 1, resourceLanguage: 0x0409 });
  const value = run({ mode: "fixture" }); expect(Number(value.bytes)).toBeLessThanOrEqual(2048); expect(value.sha256).toMatch(/^[a-f0-9]{64}$/);
});

test("binds only the fixed wide Windows prototypes with System32 search and refuses an incompatible ABI before DLL loading", () => {
  expect(run({ mode: "adapter" })).toEqual({ ok: true, loads: [{ winmode: 0x800 }], prototypes: true });
  for (const badABI of ["pointer", "wchar", "dword", "bool"]) expect(run({ mode: "adapter", badABI })).toEqual({ ok: false, stage: 4, loads: [] });
});

test("runs the ordinary resource fixture gate before either tool metadata read and never continues after fixture refusal", () => {
  expect(run({ mode: "order" })).toMatchObject({ ok: true, events: ["adapter", "fixture", "cl.exe", "link.exe", "identity"], value: { compilerVersion: "19.44.35211.0", linkerVersion: "19.44.35211.0" } });
  expect(run({ mode: "order", gateFail: true })).toMatchObject({ ok: false, stage: 6, events: ["adapter", "fixture"] });
});

test("keeps the reader source Python3.6-compatible and avoids error queries or arbitrary library loading", () => {
  expect(run({ mode: "syntax" })).toEqual({ ok: true, forbidden: false });
});

test("emits exact closed CLI failures with fixed status and no traceback or private paths", () => {
  for (const args of [[], ["--unknown", "private-owner"], ["--compiler", "C:\\private-owner\\cl.exe", "--linker", "C:\\private-owner\\link.exe"]]) {
    if (process.platform === "win32" && args.length === 4) continue;
    const result = spawnSync(python, ["-I", "-B", script, ...args], { encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true });
    const expectedStage = args.length === 4 ? 2 : 1;
    expect(result.status === 1 && result.stderr.length === 0, "The reader refusal must be fixed status and closed stdout only.").toBe(true);
    const newline = process.platform === "win32" ? "\r\n" : "\n";
    expect(result.stdout === JSON.stringify({ schema: 1, status: "failed", stage: expectedStage }) + newline, "The reader must emit only its exact closed failure schema.").toBe(true);
  }
});
