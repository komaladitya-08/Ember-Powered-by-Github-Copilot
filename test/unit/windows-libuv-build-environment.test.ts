import { expect, it } from "vitest";
// @ts-expect-error -- fixed trusted-host JavaScript build environment
import { windowsLibuvBuildEnvironment } from "../../scripts/experimental/build-windows-libuv-probe.mjs";

const directories = { temporary: "D:\\fresh\\temporary", profile: "D:\\fresh\\profile", local: "D:\\fresh\\profile\\Local", roaming: "D:\\fresh\\profile\\Roaming" };
it("keeps only explicit host metadata and fresh build locations, excluding every ambient compiler selector or secret", () => {
  const env = windowsLibuvBuildEnvironment({ SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", ProgramFiles: "C:\\Program Files", PATH: "C:\\private-toolchain",
    CL: "/FIprivate.h", _CL_: "/DPRIVATE", LINK: "/private", _LINK_: "/private", CFLAGS: "private", CXXFLAGS: "private", CPPFLAGS: "private", LDFLAGS: "private",
    CMAKE_TOOLCHAIN_FILE: "private.cmake", CMAKE_GENERATOR: "private", CC: "private", CXX: "private", INCLUDE: "private", LIB: "private", LIBPATH: "private",
    MSBuildSDKsPath: "private", GH_TOKEN: "private", NODE_OPTIONS: "private", PYTHONPATH: "private", APPDATA: "C:\\private-profile" }, directories);
  expect(env.PATH).toBe("C:\\Windows\\System32;C:\\Windows;C:\\Program Files\\CMake\\bin");
  expect(env.USERPROFILE).toBe(directories.profile); expect(env.APPDATA).toBe(directories.roaming); expect(env.TEMP).toBe(directories.temporary);
  expect(JSON.stringify(env)).not.toMatch(/private|CL|LINK|CFLAGS|LIBPATH|TOKEN|PYTHON|MSBuild/);
});
it("refuses conflicting Windows environment aliases and nonlocal build profiles", () => {
  expect(() => windowsLibuvBuildEnvironment({ SystemRoot: "C:\\Windows", SYSTEMROOT: "D:\\other" }, directories)).toThrow();
  expect(() => windowsLibuvBuildEnvironment({ SystemRoot: "C:\\Windows" }, { ...directories, profile: "\\\\server\\share" })).toThrow();
});
