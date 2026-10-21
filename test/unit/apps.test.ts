import { describe, expect, it } from "vitest";
import { friendlyApp } from "../../app/shared/apps";

describe("friendlyApp", () => {
  it("keeps the familiar names people already know", () => {
    expect(friendlyApp("gnome-control-center")).toBe("Settings");
    expect(friendlyApp("org.gnome.Nautilus")).toBe("Files");
    expect(friendlyApp("org.example.Notes")).toBe("Notes");
    expect(friendlyApp("mousepad")).toBe("Mousepad");
    expect(friendlyApp("Mousepad")).toBe("Mousepad");
    expect(friendlyApp("LibreOffice Writer")).toBe("LibreOffice");
    expect(friendlyApp("libreoffice-writer")).toBe("LibreOffice");
  });

  it("strips a desktop file name before looking the program up", () => {
    expect(friendlyApp("firefox.desktop")).toBe("Firefox");
    expect(friendlyApp("org.gnome.Nautilus.desktop")).toBe("Files");
    expect(friendlyApp("Firefox.DESKTOP")).toBe("Firefox");
  });

  it("takes the last part of a desktop id, however many it has", () => {
    expect(friendlyApp("org.mozilla.firefox")).toBe("Firefox");
    expect(friendlyApp("org.mozilla.Thunderbird")).toBe("Thunderbird");
    expect(friendlyApp("com.github.johnfactotum.Foliate")).toBe("Foliate");
    expect(friendlyApp("io.github.some.App")).toBe("App");
  });

  it("returns nothing for empty or whitespace-only input", () => {
    expect(friendlyApp("")).toBe("");
    expect(friendlyApp("   ")).toBe("");
    expect(friendlyApp("\t\n")).toBe("");
  });

  it("leaves names it doesn't know alone", () => {
    expect(friendlyApp("My App")).toBe("My App");
  });
});
