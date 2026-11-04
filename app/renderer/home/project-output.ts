/** Readable project prose and fenced code; model text never becomes HTML or an executable link. */
import { projectAnswerParts } from "./project-copy";

export function renderProjectAnswer(root: HTMLElement, answer: string, copy: (text: string) => void): void {
  root.replaceChildren(...projectAnswerParts(answer).map(part => {
    if (part.kind === "text") {
      const text = document.createElement("p");
      text.textContent = part.text;
      return text;
    }
    const block = document.createElement("div");
    block.className = "project-code";
    const header = document.createElement("div");
    header.className = "project-code-header";
    const label = document.createElement("span");
    label.textContent = part.language ? `${part.language} code` : "Code";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn quiet small";
    button.textContent = "Copy code";
    button.addEventListener("click", () => copy(part.text));
    header.append(label, button);
    const pre = document.createElement("pre");
    pre.tabIndex = 0;
    pre.setAttribute("aria-label", label.textContent);
    const code = document.createElement("code");
    code.textContent = part.text;
    pre.append(code);
    block.append(header, pre);
    return block;
  }));
}
