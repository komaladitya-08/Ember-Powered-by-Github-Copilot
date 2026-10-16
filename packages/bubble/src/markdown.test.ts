import { describe, it, expect } from "vitest";
import { plainMarkdown, plainStream } from "./markdown";

describe("plainMarkdown and plainStream", () => {
  const both = (s: string) => [plainMarkdown(s), plainStream(s)];

  it("drops markdown markers", () => {
    expect(both("**Steps:**\n1. Open `Settings`\n2. Click **Background**\n- Pick an image now & enjoy"))
      .toEqual(Array(2).fill("Steps:\n1. Open Settings\n2. Click Background\n• Pick an image now & enjoy"));
    expect(both("## Heading\nsome *soft* words and _more_.")).toEqual(Array(2).fill("Heading\nsome soft words and more."));
    expect(both("See [the docs](https://example.com/x).")).toEqual(Array(2).fill("See the docs (https://example.com/x)."));
    expect(both("**bold *and* more**, ***both*** and it's __important__.")).toEqual(Array(2).fill("bold and more, both and it's important."));
    expect(both("Intro\n\n## Steps\n* one\n* two")).toEqual(Array(2).fill("Intro\n\nSteps\n• one\n• two"));
  });

  it("leaves arithmetic, names and paths alone", () => {
    for (const t of [
      "12 * 7 * 3 = 252", "5 * 2 = 10, and 3 * 4 = 12", "2 * 3 = 6", "5*3", "5**2 = 25 and 3**2 = 9", "a*b*c",
      "__init__.py", "edit src/__main__.py now", "file_name.txt and my_var", "snake_case_name", "Hi Ana, thanks!",
    ]) expect(both(t), t).toEqual([t, t]);
  });

  it("never touches code but its backticks", () => {
    expect(both("Run `rm *.tmp` then `ls -l`.")).toEqual(Array(2).fill("Run rm *.tmp then ls -l."));
    const block = "```python\ndef f(*args, **kwargs):\n    # **not** a heading\n```\nthen *done*";
    expect(both(block)).toEqual(Array(2).fill("def f(*args, **kwargs):\n    # **not** a heading\n\nthen done"));
    // A list marker after inline code mid-line is not a bullet.
    expect(both("text `code` - more")).toEqual(Array(2).fill("text code - more"));
  });

  it("while streaming, also drops markers whose other half hasn't arrived", () => {
    expect(plainStream("Here: **Ste")).toBe("Here: Ste");
    expect(plainStream("Here: **Steps:*")).toBe("Here: Steps:");
    expect(plainStream("Open `Sett")).toBe("Open Sett");
    expect(plainStream("```bash\nls -l")).toBe("ls -l");
    // Finished text keeps what turned out not to be markdown.
    expect(plainMarkdown("Here: **Ste")).toBe("Here: **Ste");
  });

  it("while streaming, keeps a lone marker that can't open emphasis (globs, file names, paths)", () => {
    for (const t of [
      "Rename every *.md", "Match **/*.ts", "Match src/**/*.ts", "C:\\Users\\_temp", "Open ./_build", "a *b and *.md", "5 * 2", "Files: *",
    ]) expect(plainStream(t), t).toBe(t);
    // A marker a word starts right after still opens emphasis.
    expect(plainStream("Then **2 GB")).toBe("Then 2 GB");
    expect(plainStream("some _more")).toBe("some more");
    expect(plainStream("Click **“Sa")).toBe("Click “Sa");
  });
});
