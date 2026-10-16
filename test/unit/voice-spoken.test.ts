/** What Ember says out loud for an answer: the words, not the Markdown, code or addresses. */

import { describe, expect, it } from "vitest";
import { spokenText } from "../../app/voice/spoken";

describe("spokenText", () => {
  it.each([
    ["Run this:\n\n```bash\nsudo dnf install foo\n```\n\nThen restart.", "Run this:\n(code shown in the bubble)\nThen restart."],
    ["Still streaming:\n```\nsome code", "Still streaming:\n(code shown in the bubble)"],
    ["See [the docs](https://example.com/docs) or https://github.com/k2-fsa/sherpa-onnx/releases.", "See the docs or github.com."],
    ["Open www.redhat.com, then click **Login**.", "Open redhat.com, then click Login."],
    ["Use `ls -la` to list *all* files.", "Use ls -la to list all files."],
    ["## Steps\n- First\n- Second\n\n1. One\n2. Two", "Steps\nFirst\nSecond\n1. One\n2. Two"],
    ["| App | Size |\n|---|---|\n| Files | 2 MB |\nThat's all.", "(table shown in the bubble)\nThat's all."],
    ["> Quoted\n\n---\n\nEnd ~~old~~ new", "Quoted\nEnd old new"],
    ["snake_case_name and 2*3*4 stay", "snake_case_name and 2*3*4 stay"],
  ])("%j", (markdown, said) => expect(spokenText(markdown)).toBe(said));
});
