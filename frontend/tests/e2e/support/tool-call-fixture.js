// Tool call payloads as the backend sends them for each agent: the agent's own
// name for the tool, a server only when the agent reports one apart from the
// name, the input as the agent gave it, and what came back in pieces.
const longRead = Array.from(
  { length: 40 },
  (_, line) => `${String(line + 1).padStart(4)}\t// line ${line + 1} of conversation.rs`,
).join("\n");

export const TOOL_CALLS = {
  codexMcp: {
    name: "create_note",
    server: "caffold",
    status: "completed",
    durationMs: 1_840,
    input: {
      name: "Release notes",
      directoryId: "0964088d-c9ba-4e55-8dbf-ceebbedf130c",
      content: "# 출시 노트\n\n- 툴콜의 입력과 결과를 보여 준다",
    },
    result: [
      { type: "text", text: '{"noteId":"n-1","contentVersion":1}' },
      { type: "json", value: { noteId: "n-1", contentVersion: 1 } },
    ],
  },
  claudeMcp: {
    name: "mcp__caffold__create_note",
    server: null,
    status: "completed",
    durationMs: null,
    input: { name: "Release notes", content: "# Release notes" },
    result: [{ type: "text", text: '{"noteId":"n-1","contentVersion":1}' }],
  },
  grokRunning: {
    name: "caffold__create_note_directory",
    server: null,
    status: "inProgress",
    durationMs: null,
    input: { name: "Grok" },
    result: [],
  },
  grokFinished: {
    name: "caffold__create_note_directory",
    server: "caffold",
    status: "completed",
    durationMs: null,
    input: { name: "Grok" },
    result: [{ type: "text", text: '{"directoryId":"d-1"}' }],
  },
  antigravityMcp: {
    name: "rename_current_task",
    server: "caffold",
    status: "completed",
    durationMs: 300,
    input: { name: "툴콜 상세 보기" },
    result: [
      {
        type: "text",
        text: "Renamed the current Caffold task to `툴콜 상세 보기`.",
      },
    ],
  },
  claudeRead: {
    name: "Read",
    server: null,
    status: "completed",
    durationMs: null,
    input: { file_path: "/repo/caffold/src/agent/conversation.rs" },
    result: [{ type: "text", text: longRead }],
  },
  claudeToolSearch: {
    name: "ToolSearch",
    server: null,
    status: "completed",
    durationMs: null,
    input: { query: "caffold notes", max_results: 2 },
    result: [
      {
        type: "json",
        value: { type: "tool_reference", tool_name: "mcp__caffold__list_notes" },
      },
      {
        type: "json",
        value: { type: "tool_reference", tool_name: "mcp__caffold__read_note" },
      },
    ],
  },
  claudeScreenshot: {
    name: "Read",
    server: null,
    status: "completed",
    durationMs: null,
    input: { file_path: "/tmp/screenshots/conversation-phone.png" },
    result: [
      { type: "binary", mediaType: "image/png" },
      { type: "binary", mediaType: null },
    ],
  },
  failed: {
    name: "mcp__caffold__read_note",
    server: null,
    status: "failed",
    durationMs: null,
    input: { noteId: "missing" },
    result: [{ type: "text", text: "No Note has the id missing." }],
  },
  noInput: {
    name: "list_notes",
    server: "caffold",
    status: "completed",
    durationMs: 120,
    input: null,
    result: [{ type: "text", text: '{"directories":[],"notes":[]}' }],
  },
  antigravityViewFile: {
    name: "view_file",
    server: null,
    status: "completed",
    durationMs: 40,
    input: { AbsolutePath: "/repo/README.md", toolSummary: "Read README" },
    result: [{ type: "text", text: "# Caffold\n\nScaffolding for agent work." }],
  },
  // How a search reads after Antigravity rebuilds its conversation from the
  // native record, which keeps the search's arguments but not its result text.
  antigravitySearchReloaded: {
    name: "search_web",
    server: null,
    status: "completed",
    durationMs: 2_100,
    input: {
      query: "Antigravity ACP tool call",
      toolAction: "Searching the web",
      toolSummary: "Search ACP",
    },
    result: [],
  },
  longName: {
    name: "mcp__an_extremely_long_server_name_for_testing__an_extremely_long_tool_name_that_keeps_going",
    server: "an-extremely-long-server-name-for-testing",
    status: "completed",
    durationMs: 65_000,
    input: {
      filters: Array.from({ length: 6 }, (_, index) => ({
        field: `field_${index}`,
        values: ["alpha", "beta", "gamma", "delta"],
        nested: { depth: index, note: "한글 인자도 그대로 보인다" },
      })),
    },
    result: [{ type: "text", text: "ok" }],
  },
};

export const OTHER_WORK = {
  compaction: { name: "Compacting context", status: "completed" },
  codexWebSearch: { name: "Web search", status: "completed" },
};
