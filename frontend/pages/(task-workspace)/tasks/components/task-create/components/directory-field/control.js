import {
  completeTypedDirectoryPath,
  directoryPathEditingText,
  matchesTypedName,
  readTypedDirectoryPath,
} from "../../directory-path.js";

// The directory field's control model.
//
// The field is closed, browsing its folder list, or editing a typed path.
// User intent, listing answers, focus leaving, and the chosen directory the
// New Task surface hands down all arrive as events here, and one transition
// function decides which are accepted.
//
// Invariants:
// - Typed text and the highlighted row exist only while editing. A row is
//   named by its key: the folder's path, or `..` for the parent row.
// - A listing answer counts only for the request in flight. Closing forgets
//   that request, so an answer arriving after it is ignored.
// - The chosen directory changes only when a request made to choose a folder
//   is answered. The New Task surface handing back that same directory is not
//   a change of context.

export const DIRECTORY_FIELD_NODE = Object.freeze({
  CLOSED: "closed",
  BROWSING: "browsing",
  EDITING: "editing",
});

export const PARENT_ROW_KEY = "..";

// What a listing request is for once it is answered.
const PURPOSE = Object.freeze({
  SHOW: "show",
  CHOOSE: "choose",
  CHOOSE_AND_CLOSE: "choose-and-close",
});

const { CLOSED, BROWSING, EDITING } = DIRECTORY_FIELD_NODE;

// Every accepted event for each node. An event a node does not list leaves
// the field as it is.
const TRANSITIONS = Object.freeze({
  [CLOSED]: Object.freeze({
    "toggle-list": openBrowsing,
    "toggle-edit": openEditing,
    context: applyContext,
  }),
  [BROWSING]: Object.freeze({
    "toggle-list": close,
    escape: close,
    leave: close,
    "toggle-edit": openEditing,
    "choose-row": chooseRow,
    "listing-loaded": acceptListing,
    "listing-failed": acceptFailure,
    context: applyContext,
    deactivate: close,
  }),
  [EDITING]: Object.freeze({
    "toggle-list": returnToBrowsing,
    "toggle-edit": returnToBrowsing,
    escape: returnToBrowsing,
    "choose-row": chooseRow,
    type: applyTyping,
    complete: completeHighlighted,
    "move-highlight": moveHighlight,
    submit: submitTyped,
    "listing-loaded": acceptListing,
    "listing-failed": acceptFailure,
    leave: close,
    context: applyContext,
    deactivate: close,
  }),
});

export function initialDirectoryFieldState() {
  return {
    node: CLOSED,
    path: "",
    server: {},
    locked: false,
    listing: null,
    request: null,
    generation: 0,
    error: "",
    text: "",
    typed: null,
    highlight: "",
  };
}

// Returns the next state and the effects the field runs: a listing request,
// the chosen directory, or where focus goes.
export function reduceDirectoryField(state, event) {
  const handler = TRANSITIONS[state.node]?.[event?.type];
  return handler ? handler(state, event) : { state, effects: [] };
}

// The rows a listing shows for the current state, in the order they appear.
// `..` comes first except at the root and while a name is being typed. Typed
// text names its own folder, so another folder's listing has no rows for it.
export function directoryFieldRows(state) {
  const listing = state.listing;
  const typed = state.node === EDITING ? state.typed : null;
  if (!listing || typed?.error || (typed && typed.folder !== listing.path)) {
    return [];
  }
  const name = typed?.name ?? "";
  const entries = listing.entries.filter((entry) =>
    matchesTypedName(entry.name, name)
  );
  const parent = listing.path && !name
    ? [{ key: PARENT_ROW_KEY, name: "..", path: parentPath(listing.path), parent: true }]
    : [];
  return [
    ...parent,
    ...sortedEntries(entries).map((entry) => ({ ...entry, key: entry.path })),
  ];
}

function openBrowsing(state) {
  if (state.locked) {
    return unchanged(state);
  }
  return request({ ...state, node: BROWSING, error: "" }, state.path, PURPOSE.SHOW);
}

function openEditing(state) {
  if (state.locked) {
    return unchanged(state);
  }
  const text = directoryPathEditingText(state.path, state.server);
  const next = {
    ...state,
    node: EDITING,
    error: "",
    text,
    typed: readTypedDirectoryPath(text, state.server),
    highlight: "",
  };
  const focus = { type: "focus", target: "input" };
  return state.listing?.path === state.path && !state.request
    ? { state: next, effects: [focus] }
    : request(next, state.path, PURPOSE.SHOW, [focus]);
}

function returnToBrowsing(state) {
  const next = {
    ...state,
    node: BROWSING,
    error: "",
    text: "",
    typed: null,
    highlight: "",
  };
  const focus = { type: "focus", target: "toggle" };
  return state.listing?.path === state.path
    ? { state: { ...next, request: null }, effects: [focus] }
    : request(next, state.path, PURPOSE.SHOW, [focus]);
}

function close(state) {
  return {
    state: {
      ...state,
      node: CLOSED,
      request: null,
      generation: state.generation + 1,
      error: "",
      text: "",
      typed: null,
      highlight: "",
    },
    effects: [],
  };
}

function chooseRow(state, event) {
  const next = state.node === EDITING
    ? { ...state, node: BROWSING, text: "", typed: null, highlight: "" }
    : state;
  return request({ ...next, error: "" }, `${event.path ?? ""}`, PURPOSE.CHOOSE, [
    { type: "focus", target: "toggle" },
  ]);
}

function applyTyping(state, event) {
  const text = `${event.text ?? ""}`;
  const typed = readTypedDirectoryPath(text, state.server);
  const next = { ...state, text, typed, error: typed.error ?? "" };
  if (typed.error) {
    return { state: { ...next, highlight: "" }, effects: [] };
  }
  if (state.listing?.path === typed.folder) {
    return {
      state: { ...next, request: null, highlight: firstMatch(next) },
      effects: [],
    };
  }
  if (state.request?.purpose === PURPOSE.SHOW && state.request.path === typed.folder) {
    return { state: { ...next, highlight: "" }, effects: [] };
  }
  return request({ ...next, highlight: "" }, typed.folder, PURPOSE.SHOW);
}

function completeHighlighted(state) {
  const row = directoryFieldRows(state).find((candidate) =>
    candidate.key === state.highlight
  );
  if (!row) {
    return unchanged(state);
  }
  const text = row.parent
    ? directoryPathEditingText(row.path, state.server)
    : completeTypedDirectoryPath(state.text, row.name);
  return applyTyping(state, { text });
}

function moveHighlight(state, event) {
  const rows = directoryFieldRows(state);
  if (rows.length === 0) {
    return unchanged(state);
  }
  const index = rows.findIndex((row) => row.key === state.highlight);
  const step = Number(event.delta) < 0 ? -1 : 1;
  const nextIndex = index < 0
    ? 0
    : Math.min(rows.length - 1, Math.max(0, index + step));
  return { state: { ...state, highlight: rows[nextIndex].key }, effects: [] };
}

function submitTyped(state) {
  const highlighted = directoryFieldRows(state).find((row) =>
    row.key === state.highlight
  );
  if (highlighted) {
    return request({ ...state, error: "" }, highlighted.path, PURPOSE.CHOOSE_AND_CLOSE);
  }
  if (state.typed?.error) {
    return { state: { ...state, error: state.typed.error }, effects: [] };
  }
  const { folder, name } = state.typed ?? { folder: state.path, name: "" };
  const target = name ? [folder, name].filter(Boolean).join("/") : folder;
  return request({ ...state, error: "" }, target, PURPOSE.CHOOSE_AND_CLOSE);
}

function acceptListing(state, event) {
  if (!isCurrent(state, event)) {
    return unchanged(state);
  }
  const { purpose } = state.request;
  const directory = event.directory;
  const listing = {
    path: `${directory?.path ?? ""}`,
    entries: listedFolders(directory),
  };
  const next = { ...state, listing, request: null, error: "" };
  if (purpose === PURPOSE.SHOW) {
    return {
      state: state.node === EDITING
        ? { ...next, highlight: firstMatch(next) }
        : next,
      effects: [],
    };
  }
  const chosen = { ...next, path: listing.path };
  if (purpose === PURPOSE.CHOOSE) {
    return {
      state: chosen,
      effects: [{ type: "choose", path: listing.path, returnFocus: false }],
    };
  }
  const closed = close(chosen).state;
  return {
    state: closed,
    effects: [{ type: "choose", path: listing.path, returnFocus: true }],
  };
}

function acceptFailure(state, event) {
  if (!isCurrent(state, event)) {
    return unchanged(state);
  }
  return {
    state: {
      ...state,
      request: null,
      error: `${event.message ?? ""}` || "Unable to open this folder.",
    },
    effects: [],
  };
}

function applyContext(state, event) {
  const path = `${event.path ?? ""}`;
  const next = {
    ...state,
    path,
    server: event.server ?? {},
    locked: Boolean(event.locked),
  };
  const changed = path !== state.path ||
    `${next.server.root ?? ""}` !== `${state.server.root ?? ""}`;
  if (state.node !== CLOSED && (changed || next.locked)) {
    return close(next);
  }
  return { state: next, effects: [] };
}

function request(state, path, purpose, effects = []) {
  const generation = state.generation + 1;
  return {
    state: { ...state, generation, request: { generation, path, purpose } },
    effects: [...effects, { type: "request", generation, path }],
  };
}

function isCurrent(state, event) {
  return Boolean(state.request) && state.request.generation === event.generation;
}

function firstMatch(state) {
  if (!state.typed?.name) {
    return "";
  }
  return directoryFieldRows(state).find((row) => !row.parent)?.key ?? "";
}

function listedFolders(directory) {
  return (directory?.entries ?? [])
    .filter((entry) => entry.kind === "directory" && entry.supported !== false)
    .map((entry) => ({
      name: `${entry.name ?? ""}`,
      path: `${entry.path ?? ""}`,
      isSymlink: Boolean(entry.isSymlink),
      git: entry.git ?? null,
      gitIgnored: Boolean(entry.gitIgnored),
    }));
}

// Normal folders by name, then hidden ones, as the list draws them.
function sortedEntries(entries) {
  return [...entries].sort((left, right) => {
    const leftHidden = left.name.startsWith(".");
    const rightHidden = right.name.startsWith(".");
    if (leftHidden !== rightHidden) {
      return leftHidden ? 1 : -1;
    }
    return left.name.toLocaleLowerCase().localeCompare(right.name.toLocaleLowerCase());
  });
}

function parentPath(path) {
  return path.split("/").filter(Boolean).slice(0, -1).join("/");
}

function unchanged(state) {
  return { state, effects: [] };
}
