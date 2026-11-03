export const MCP_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** The pinned runtime replaces dots with hyphens and limits the whole model-facing name to 64 characters. */
export function modelToolName(server: string, tool: string): string {
  return `${server}-${tool.replaceAll(".", "-")}`.slice(0, 64);
}

export function clashingToolNames(server: string, tools: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const clashes = new Set<string>();
  for (const tool of tools) {
    if (!MCP_TOOL_NAME.test(tool)) continue;
    const name = modelToolName(server, tool);
    if (seen.has(name)) clashes.add(name);
    seen.add(name);
  }
  return clashes;
}
