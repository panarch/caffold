function mockCodexStatus(overrides = {}) {
  return {
    available: true,
    codexCliAvailable: true,
    appServerAvailable: true,
    message: null,
    account: {
      accountType: "chatgpt",
      email: "user@example.com",
      planType: "pro",
    },
    requiresOpenaiAuth: true,
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
    ...overrides,
  };
}

export async function installBrowserDefaults(page) {
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
          export const marked = {
            parse(source) {
              const escaped = escapeHtml(source);
              const blocks = escaped.split(/\\n{2,}/);
              return blocks.map((block) => {
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
                if (lines.every((line) => line.startsWith("- "))) {
                  return '<ul>' + lines.map((line) => '<li>' + inline(line.slice(2)) + '</li>').join("") + '</ul>';
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
        export const File = [["path", { d: "M6 3h8l4 4v14H6z" }]];
        export const FileArchive = File;
        export const FileCode = [["path", { d: "M4 4h16v16H4z" }], ["path", { d: "m10 9-3 3 3 3" }], ["path", { d: "m14 9 3 3-3 3" }]];
        export const FileCog = File;
        export const FileDiff = FileCode;
        export const FileImage = File;
        export const FileJson = FileCode;
        export const FileQuestion = File;
        export const FileTerminal = FileCode;
        export const FileText = [["path", { d: "M6 3h12v18H6z" }], ["path", { d: "M9 8h6" }], ["path", { d: "M9 12h6" }]];
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
        export const Folder = [["path", { d: "M3 6h7l2 2h9v10H3z" }]];
        export const FolderGit2 = Folder;
        export const FolderOpen = Folder;
        export const FolderSymlink = Folder;
        export const GitCompare = [["circle", { cx: "18", cy: "18", r: "3" }], ["circle", { cx: "6", cy: "6", r: "3" }], ["path", { d: "M13 6h3a2 2 0 0 1 2 2v7" }], ["path", { d: "M6 9v7a2 2 0 0 0 2 2h3" }]];
        export const GitBranch = [["line", { x1: "6", x2: "6", y1: "3", y2: "15" }], ["circle", { cx: "18", cy: "6", r: "3" }], ["circle", { cx: "6", cy: "18", r: "3" }], ["path", { d: "M18 9a9 9 0 0 1-9 9" }]];
        export const GitPullRequest = [["circle", { cx: "18", cy: "18", r: "3" }], ["circle", { cx: "6", cy: "6", r: "3" }], ["path", { d: "M6 9v12" }], ["path", { d: "M18 15V5" }], ["path", { d: "M18 5h-5" }]];
        export const ArrowLeft = [
          ["path", { d: "m12 19-7-7 7-7" }],
          ["path", { d: "M19 12H5" }],
        ];
        export const History = [["path", { d: "M3 12a9 9 0 1 0 3-6.7" }], ["path", { d: "M3 3v6h6" }], ["path", { d: "M12 7v5l3 2" }]];
        export const Info = [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "M12 16v-4" }], ["path", { d: "M12 8h.01" }]];
        export const ImageOff = [["line", { x1: "2", x2: "22", y1: "2", y2: "22" }], ["path", { d: "M10.4 10.4 3 17.8V5a2 2 0 0 1 2-2h12.8" }], ["path", { d: "m14 14 1-1 6 6" }], ["path", { d: "M21 15V5a2 2 0 0 0-2-2h-1" }]];
        export const LoaderCircle = [["path", { d: "M21 12a9 9 0 1 1-6.2-8.6" }]];
        export const Mic = [["path", { d: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" }], ["path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }], ["path", { d: "M12 19v3" }]];
        export const ListTodo = [["rect", { x: "3", y: "5", width: "6", height: "6", rx: "1" }], ["path", { d: "M13 7h8" }], ["path", { d: "M13 15h8" }], ["path", { d: "m4 16 2 2 4-4" }]];
        export const Database = [["ellipse", { cx: "12", cy: "5", rx: "8", ry: "3" }], ["path", { d: "M4 5v10c0 1.7 3.6 3 8 3s8-1.3 8-3V5" }]];
        export const Link = [["path", { d: "M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" }]];
        export const Lock = [["rect", { x: "5", y: "10", width: "14", height: "10", rx: "2" }], ["path", { d: "M8 10V7a4 4 0 0 1 8 0v3" }]];
        export const PanelTopOpen = [["rect", { x: "3", y: "4", width: "18", height: "16", rx: "2" }], ["path", { d: "M3 9h18" }]];
        export const Pencil = [["path", { d: "M17 3a2.8 2.8 0 0 1 4 4L7 21H3v-4z" }]];
        export const Plus = [["path", { d: "M12 5v14" }], ["path", { d: "M5 12h14" }]];
        export const RefreshCw = [["path", { d: "M20 6v5h-5" }], ["path", { d: "M4 18v-5h5" }], ["path", { d: "M18.4 9A7 7 0 0 0 6 6.6L4 9" }], ["path", { d: "M5.6 15A7 7 0 0 0 18 17.4l2-2.4" }]];
        export const Settings = [["path", { d: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" }], ["path", { d: "M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.09.38.3.73.6 1 .3.27.68.4 1.1.4H21v4h-.09a1.7 1.7 0 0 0-1.51.6Z" }]];
        export const Shield = [["path", { d: "M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3z" }]];
        export const ArrowUp = [["path", { d: "m5 12 7-7 7 7" }], ["path", { d: "M12 19V5" }]];
        export const Square = [["rect", { x: "5", y: "5", width: "14", height: "14", rx: "1" }]];
        export const TriangleAlert = [["path", { d: "M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" }], ["path", { d: "M12 9v4" }], ["path", { d: "M12 17h.01" }]];
        export const Trash2 = [["path", { d: "M3 6h18" }], ["path", { d: "M8 6V4h8v2" }], ["path", { d: "M19 6l-1 15H6L5 6" }]];
        export const X = [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]];
        export function createElement(iconNode, attrs = {}) {
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          const baseAttrs = {
            xmlns: "http://www.w3.org/2000/svg",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
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
