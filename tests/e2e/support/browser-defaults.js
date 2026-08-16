import { installTaskSseControllerInBrowser } from "./task-sse-fixture.js";

export function mockCodexStatus(overrides = {}) {
  return {
    readiness: {
      state: "ready",
      blocksTaskOperations: false,
      reasonCode: "ready",
      diagnosticMessage: "Codex is ready for Task operations.",
      minimumSupportedVersion: "0.147.0",
      detectedExecutable: {
        path: "/Users/example/.local/bin/codex",
        version: "0.147.0",
      },
      managedExecutable: {
        path: "/Users/example/.codex/packages/standalone/current/codex",
        version: "0.147.0",
      },
      runningAppServerVersion: "0.147.0",
    },
    account: {
      accountType: "chatgpt",
      email: "user@example.com",
      planType: "pro",
    },
    rateLimits: {
      rateLimitResetCredits: {
        availableCount: 3,
      },
      rateLimits: {
        primary: {
          usedPercent: 83,
          resetsAt: 1914709200,
          windowDurationMins: 300,
        },
        secondary: {
          usedPercent: 31,
          resetsAt: 1915243200,
          windowDurationMins: 10080,
        },
      },
    },
    usage: {
      summary: {
        lifetimeTokens: 1234567,
      },
    },
    appServer: {
      userAgent: "Codex Desktop/0.142.3",
      codexHome: "/Users/example/.codex",
      platformFamily: "unix",
      platformOs: "macos",
    },
    daemon: {
      status: "alreadyRunning",
      backend: "pid",
      pid: 4271,
      managedCodexPath: "/Users/example/.codex/packages/standalone/current/codex",
      managedCodexVersion: "0.147.0",
      socketPath: "/Users/example/.codex/app-server-control/app-server-control.sock",
      cliVersion: "0.147.0",
      appServerVersion: "0.147.0",
    },
    diagnostics: {
      processGeneration: 1,
      processConnected: true,
      threadSessions: {
        trackedSessions: 0,
        subscribedSessions: 0,
      },
    },
    ...overrides,
  };
}

export async function installBrowserDefaults(page) {
  await page.addInitScript(installTaskSseControllerInBrowser);
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(mockCodexStatus()),
    }),
  );

  await page.route(/\/api\/codex\/permissions(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        defaultMode: "approveForMe",
        options: [
          {
            mode: "askForApproval",
            label: "Ask for approval",
            description: "Ask before crossing the workspace boundary.",
            allowed: true,
            dangerous: false,
          },
          {
            mode: "approveForMe",
            label: "Approve for me",
            description: "Review eligible requests automatically.",
            allowed: true,
            dangerous: false,
          },
          {
            mode: "fullAccess",
            label: "Full access",
            description: "Run without sandbox restrictions.",
            allowed: true,
            dangerous: true,
          },
        ],
      }),
    }),
  );

  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [], nextCursor: null }),
    }),
  );

  await installExternalModuleDefaults(page);
}

export async function installExternalModuleDefaults(page) {
  await page.route("https://esm.sh/**", (route) => {
    if (route.request().url() === "https://esm.sh/marked@15.0.12") {
      return route.fulfill({
        contentType: "text/javascript",
        body: `
          const escapeHtml = (value) => value
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;");
          const inline = (value) => value
            .replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>")
            .replace(/\\x60([^\\x60]+)\\x60/g, "<code>$1</code>")
            .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
          const unorderedItem = (line) => {
            const content = line.slice(2);
            const task = content.match(/^\\[([ xX])\\] (.*)$/);
            if (!task) {
              return '<li>' + inline(content) + '</li>';
            }
            const checked = task[1].toLowerCase() === "x" ? " checked" : "";
            return '<li><input type="checkbox" disabled' + checked + '> ' + inline(task[2]) + '</li>';
          };
          export const marked = {
            parse(source) {
              const blocks = source.split(/\\n{2,}/);
              return blocks.map((sourceBlock) => {
                if (sourceBlock.trimStart().startsWith("<")) {
                  return sourceBlock;
                }
                const block = escapeHtml(sourceBlock);
                if (block.startsWith("\\x60\\x60\\x60")) {
                  const lines = block.split("\\n");
                  return '<pre><code>' + lines.slice(1, -1).join("\\n") + '</code></pre>';
                }
                const heading = block.match(/^(#{1,6}) (.+)$/);
                if (heading) {
                  const level = heading[1].length;
                  return '<h' + level + '>' + inline(heading[2]) + '</h' + level + '>';
                }
                const lines = block.split("\\n");
                const ordered = lines.map((line) => line.match(/^([0-9]{1,9})[.)] (.+)$/));
                if (ordered.every(Boolean)) {
                  const start = ordered[0][1];
                  const startAttribute = start === "1" ? "" : ' start="' + start + '"';
                  return '<ol' + startAttribute + '>' + ordered.map((item) => '<li>' + inline(item[2]) + '</li>').join("") + '</ol>';
                }
                if (
                  lines.length > 1 &&
                  lines[0].startsWith("- ") &&
                  lines.slice(1).every((line) => line.startsWith("  - "))
                ) {
                  const nested = lines.slice(1).map((line) => unorderedItem(line.slice(2))).join("");
                  return '<ul><li>' + inline(lines[0].slice(2)) + '<ul>' + nested + '</ul></li></ul>';
                }
                if (lines.every((line) => line.startsWith("- "))) {
                  return '<ul>' + lines.map(unorderedItem).join("") + '</ul>';
                }
                if (lines.length >= 2 && lines[0].startsWith("|") && lines[1].includes("---")) {
                  const cells = (line) => line.split("|").slice(1, -1).map((cell) => cell.trim());
                  const header = cells(lines[0]);
                  const rows = lines.slice(2).map(cells);
                  return '<table><thead><tr>' + header.map((cell) => '<th>' + inline(cell) + '</th>').join("") + '</tr></thead><tbody>' + rows.map((row) => '<tr>' + row.map((cell) => '<td>' + inline(cell) + '</td>').join("") + '</tr>').join("") + '</tbody></table>';
                }
                return '<p>' + inline(lines.join(" ")) + '</p>';
              }).join("");
            },
          };
        `,
      });
    }

    if (route.request().url() !== "https://esm.sh/lucide@1.22.0") {
      return route.abort();
    }

    return route.fulfill({
      contentType: "text/javascript",
      body: `
        export const File = [
          ["path", { d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" }],
          ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5" }],
        ];
        export const ArchiveRestore = [
          ["rect", { width: "20", height: "5", x: "2", y: "3", rx: "1" }],
          ["path", { d: "M4 8v11a2 2 0 0 0 2 2h2" }],
          ["path", { d: "M20 8v11a2 2 0 0 1-2 2h-2" }],
          ["path", { d: "m9 15 3-3 3 3" }],
          ["path", { d: "M12 12v9" }],
        ];
        export const Archive = [["rect", { width: "20", height: "5", x: "2", y: "3", rx: "1" }], ["path", { d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" }], ["path", { d: "M10 12h4" }]];
        export const Bell = [["path", { d: "M10.3 21a1.9 1.9 0 0 0 3.4 0" }], ["path", { d: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" }]];
        export const FileArchive = File;
        export const FileCode = [
          ["path", { d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" }],
          ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5" }],
          ["path", { d: "M10 12.5 8 15l2 2.5" }],
          ["path", { d: "m14 12.5 2 2.5-2 2.5" }],
        ];
        export const FileCog = File;
        export const FileDiff = FileCode;
        export const FileImage = File;
        export const FileJson = FileCode;
        export const FileQuestion = File;
        export const FileTerminal = FileCode;
        export const FileText = [
          ["path", { d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" }],
          ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5" }],
          ["path", { d: "M10 9H8" }],
          ["path", { d: "M16 13H8" }],
          ["path", { d: "M16 17H8" }],
        ];
        export const CircleAlert = [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "M12 8v4" }], ["path", { d: "M12 16h.01" }]];
        export const CircleCheck = [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "m8 12 2.5 2.5L16 9" }]];
        export const CircleDot = [["circle", { cx: "12", cy: "12", r: "10" }], ["circle", { cx: "12", cy: "12", r: "2" }]];
        export const CircleSlash = [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "m5 5 14 14" }]];
        export const Circle = [["circle", { cx: "12", cy: "12", r: "10" }]];
        export const Check = [["path", { d: "m20 6-11 11-5-5" }]];
        export const ChevronDown = [["path", { d: "m6 9 6 6 6-6" }]];
        export const ChevronFirst = [["path", { d: "m17 18-6-6 6-6" }], ["path", { d: "M7 6v12" }]];
        export const ChevronLast = [["path", { d: "m7 18 6-6-6-6" }], ["path", { d: "M17 6v12" }]];
        export const ChevronLeft = [["path", { d: "m15 18-6-6 6-6" }]];
        export const ChevronRight = [["path", { d: "m9 18 6-6-6-6" }]];
        export const Folder = [["path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }]];
        export const FolderGit2 = [
          ["path", { d: "M18 19a5 5 0 0 1-5-5v8" }],
          ["path", { d: "M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5" }],
          ["circle", { cx: "13", cy: "12", r: "2" }],
          ["circle", { cx: "20", cy: "19", r: "2" }],
        ];
        export const FolderOpen = [["path", { d: "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" }]];
        export const FolderSymlink = Folder;
        export const GitCompare = [["circle", { cx: "18", cy: "18", r: "3" }], ["circle", { cx: "6", cy: "6", r: "3" }], ["path", { d: "M13 6h3a2 2 0 0 1 2 2v7" }], ["path", { d: "M6 9v7a2 2 0 0 0 2 2h3" }]];
        export const GitBranch = [["path", { d: "M15 6a9 9 0 0 0-9 9V3" }], ["circle", { cx: "18", cy: "6", r: "3" }], ["circle", { cx: "6", cy: "18", r: "3" }]];
        export const GitPullRequest = [["circle", { cx: "18", cy: "18", r: "3" }], ["circle", { cx: "6", cy: "6", r: "3" }], ["path", { d: "M6 9v12" }], ["path", { d: "M18 15V5" }], ["path", { d: "M18 5h-5" }]];
        export const ArrowDownUp = [["path", { d: "m3 16 4 4 4-4" }], ["path", { d: "M7 20V4" }], ["path", { d: "m21 8-4-4-4 4" }], ["path", { d: "M17 4v16" }]];
        export const Grip = [["circle", { cx: "5", cy: "5", r: "1" }], ["circle", { cx: "12", cy: "5", r: "1" }], ["circle", { cx: "19", cy: "5", r: "1" }], ["circle", { cx: "5", cy: "12", r: "1" }], ["circle", { cx: "12", cy: "12", r: "1" }], ["circle", { cx: "19", cy: "12", r: "1" }], ["circle", { cx: "5", cy: "19", r: "1" }], ["circle", { cx: "12", cy: "19", r: "1" }], ["circle", { cx: "19", cy: "19", r: "1" }]];
        export const ArrowLeft = [
          ["path", { d: "m12 19-7-7 7-7" }],
          ["path", { d: "M19 12H5" }],
        ];
        export const History = [["path", { d: "M3 12a9 9 0 1 0 3-6.7" }], ["path", { d: "M3 3v6h6" }], ["path", { d: "M12 7v5l3 2" }]];
        export const Info = [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "M12 16v-4" }], ["path", { d: "M12 8h.01" }]];
        export const ImageOff = [["line", { x1: "2", x2: "22", y1: "2", y2: "22" }], ["path", { d: "M10.4 10.4 3 17.8V5a2 2 0 0 1 2-2h12.8" }], ["path", { d: "m14 14 1-1 6 6" }], ["path", { d: "M21 15V5a2 2 0 0 0-2-2h-1" }]];
        export const LoaderCircle = [["path", { d: "M21 12a9 9 0 1 1-6.2-8.6" }]];
        export const Mic = [["path", { d: "M12 19v3" }], ["path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }], ["rect", { x: "9", y: "2", width: "6", height: "13", rx: "3" }]];
        export const ListTodo = [["path", { d: "M13 5h8" }], ["path", { d: "M13 12h8" }], ["path", { d: "M13 19h8" }], ["path", { d: "m3 17 2 2 4-4" }], ["rect", { x: "3", y: "4", width: "6", height: "6", rx: "1" }]];
        export const Database = [["ellipse", { cx: "12", cy: "5", rx: "8", ry: "3" }], ["path", { d: "M4 5v10c0 1.7 3.6 3 8 3s8-1.3 8-3V5" }]];
        export const Link = [["path", { d: "M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" }]];
        export const Lock = [["rect", { x: "5", y: "10", width: "14", height: "10", rx: "2" }], ["path", { d: "M8 10V7a4 4 0 0 1 8 0v3" }]];
        export const PanelTopOpen = [["rect", { x: "3", y: "4", width: "18", height: "16", rx: "2" }], ["path", { d: "M3 9h18" }]];
        export const Pencil = [["path", { d: "M17 3a2.8 2.8 0 0 1 4 4L7 21H3v-4z" }]];
        export const Plus = [["path", { d: "M12 5v14" }], ["path", { d: "M5 12h14" }]];
        export const RefreshCw = [["path", { d: "M20 6v5h-5" }], ["path", { d: "M4 18v-5h5" }], ["path", { d: "M18.4 9A7 7 0 0 0 6 6.6L4 9" }], ["path", { d: "M5.6 15A7 7 0 0 0 18 17.4l2-2.4" }]];
        export const RotateCcw = [["path", { d: "M3 12a9 9 0 1 0 3-6.7" }], ["path", { d: "M3 3v6h6" }]];
        export const Settings = [["path", { d: "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" }], ["circle", { cx: "12", cy: "12", r: "3" }]];
        export const Shield = [["path", { d: "M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3z" }]];
        export const ArrowUp = [["path", { d: "m5 12 7-7 7 7" }], ["path", { d: "M12 19V5" }]];
        export const Square = [["rect", { x: "5", y: "5", width: "14", height: "14", rx: "1" }]];
        export const TriangleAlert = [["path", { d: "M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" }], ["path", { d: "M12 9v4" }], ["path", { d: "M12 17h.01" }]];
        export const Trash2 = [["path", { d: "M3 6h18" }], ["path", { d: "M8 6V4h8v2" }], ["path", { d: "M19 6l-1 15H6L5 6" }]];
        export const X = [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]];
        export const Zap = [["path", { d: "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" }]];
        export function createElement(iconNode, attrs = {}) {
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          const baseAttrs = {
            xmlns: "http://www.w3.org/2000/svg",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            "stroke-width": "2",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            ...attrs,
          };
          for (const [name, value] of Object.entries(baseAttrs)) {
            svg.setAttribute(name, String(value));
          }
          for (const [tag, childAttrs] of iconNode) {
            const child = document.createElementNS("http://www.w3.org/2000/svg", tag);
            for (const [name, value] of Object.entries(childAttrs)) {
              child.setAttribute(name, String(value));
            }
            svg.appendChild(child);
          }
          return svg;
        }
      `,
    });
  });
}
