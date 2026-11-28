/**
 * Customise › Defaults and Session settings, their words and pure parts (app/renderer/code/copy-settings.ts,
 * customise-defaults.ts `defaultsFrom`, customise-session.ts `builtinTools` and `sessionOptionsFrom`): a form's empty
 * choice is no default, a session's list of tools leaves MCP servers' tools to their own section, and a turned-off
 * tool is sent once, sorted.
 */
import { describe, expect, it } from "vitest";
import { FOLDERS_LEAD, INSTRUCTIONS_LEAD, instructionsCount, modeNotAllowed, summaryName, toolLabel } from "../../app/renderer/code/copy-settings";
import { defaultsFrom } from "../../app/renderer/code/customise-defaults";
import { builtinTools, sessionOptionsFrom } from "../../app/renderer/code/customise-session";

describe("Customise › Defaults and Session settings", () => {
  it("says what the instructions and extra folders are, in Ember's words", () => {
    expect(INSTRUCTIONS_LEAD).toBe("Copilot reads these in every session of this project, beside the repository's own instruction files. They're yours: Copilot never writes them.");
    expect(FOLDERS_LEAD).toBe("Folders this project's sessions may also work in. Copilot asks before it reads or changes them, as for any folder outside the project.");
    expect(instructionsCount(1234, 20_000)).toBe("1,234 of 20,000 characters");
    expect(modeNotAllowed("Approve all")).toBe("Approve all (not allowed by your organisation)");
    expect(["", "none", "concise", "detailed"].map(summaryName)).toEqual(["Copilot's own", "None", "Short", "Detailed"]);
    expect(toolLabel("bash", "Running command")).toBe("bash (Running command)");
  });

  it("takes an empty choice as no default", () => {
    expect(defaultsFrom({ isolation: "", permissionMode: "assisted", agentMode: "", model: "gpt-5.5", reasoningEffort: "" })).toEqual({ permissionMode: "assisted", model: "gpt-5.5" });
  });

  it("lists a session's built-in tools only, and sends what is off once, sorted", () => {
    expect(builtinTools({ tools: [{ name: "bash", title: "Running command" }, { name: "docs-search", mcpServerName: "docs" }, { title: "no name" }] })).toEqual([{ name: "bash", title: "Running command" }]);
    expect(sessionOptionsFrom({ summary: "", long: true, coauthor: false, off: ["web_fetch", "bash", "web_fetch"] }))
      .toEqual({ contextTier: "long_context", coauthor: false, excludedTools: ["bash", "web_fetch"] });
  });
});
