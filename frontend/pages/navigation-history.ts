import {
  type ParsedRoute,
  parentRoute,
  ROUTE_RELATION,
  routeAscentSteps,
  routeEquals,
  routeRelation,
  routeTab,
} from "../navigation-routes.js";

export const NAVIGATION_HISTORY_ACTION = {
  PUSH: "push",
  REPLACE: "replace",
  TRAVERSE: "traverse",
  NONE: "none",
};

const WORKSPACE_TABS = ["tasks", "notes", "settings"] as const;

type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

// One entry the browser history should hold: its route, whether it is pushed,
// replaces the current entry, rewinds, or leaves the history alone, how many
// entries a rewind goes back, and how many entries under it are its ancestors.
export interface HistoryEntry {
  route: ParsedRoute | null | undefined;
  action: string;
  steps: number;
  descentRun: number;
}

// What a history entry records: where each tab stood, and how many entries
// under the current one are its ancestors.
export interface NavigationSnapshot {
  tabs: Record<WorkspaceTab, ParsedRoute | null>;
  descentRun: number;
}

// The browser keeps one history list while the workspace presents three bottom
// tabs. This decides what each route request does to that list so browser Back
// only visits places worth returning to: reaching a screen below the current
// one adds an entry, moving between screens at the same place replaces the
// current entry, and leaving a screen rewinds instead of adding another.
//
// Only each tab's last route is kept. The screens under it are its declared
// parent chain, so a tab reopens at the depth it was left at and that chain is
// written back beneath it rather than stored per tab.
//
// Every resolver answers with the entries the history should hold, in the order
// they are written, so a request that needs several is not a special case.
export class NavigationHistory {
  private tabs: Record<WorkspaceTab, ParsedRoute | null>;
  private descentRun: number;

  constructor() {
    this.tabs = emptyTabs();
    // How many entries immediately before the current one are the current
    // route's ancestors, in order. Rewinding is only safe within that run.
    this.descentRun = 0;
  }

  // What to do with the browser history for an ordinary route request.
  resolve(
    currentRoute: ParsedRoute | null | undefined,
    route: ParsedRoute | null | undefined,
  ): HistoryEntry[] {
    if (!route) {
      return [noChange(route, this.descentRun)];
    }

    if (!currentRoute) {
      return [entryStep(route, 0, true)];
    }

    if (routeEquals(currentRoute, route)) {
      return [noChange(route, this.descentRun)];
    }

    switch (routeRelation(currentRoute, route)) {
      case ROUTE_RELATION.DESCEND:
        return [entryStep(route, this.descentRun + 1, false)];
      // Landing deep in another tab is an arrival there, whether the request
      // chose the tab or named one of its screens, so that tab's own screens
      // go in beneath the route.
      case ROUTE_RELATION.TAB:
        return this.resolveEntry(currentRoute, route, false);
      case ROUTE_RELATION.ASCEND:
        return [this.ascent(currentRoute, route)];
      default:
        return [this.swap(currentRoute, route)];
    }
  }

  // A native link is the browser's own navigation, so its entry already
  // exists. Following one inside a tab is a step in that tab's flow: only the
  // record is missing, and the screen it was followed from stays under it.
  // Crossing into another tab is an arrival, so that tab's own screens go in
  // beneath the route instead.
  resolveFollowedLink(
    beneath: ParsedRoute | null | undefined,
    route: ParsedRoute,
  ): HistoryEntry[] {
    if (beneath && routeTab(beneath) !== routeTab(route)) {
      return this.resolveEntry(beneath, route, true);
    }

    const descended =
      beneath && routeRelation(beneath, route) === ROUTE_RELATION.DESCEND;
    return [entryStep(route, descended ? this.descentRun + 1 : 0, true)];
  }

  // What the history needs for a route that arrived from outside a route
  // request: an address the browser loaded, a notification opening its Task,
  // or a link into another tab. None of those is a move from where the person
  // was, so the screens the route sits under go in beneath it and Back walks
  // up them instead of leaving the application or returning to whatever the
  // arrival interrupted. Each entry carries the record it should restore, so
  // the caller writes them in order.
  //
  // `beneath` is the route the entry under this arrival holds, and screens it
  // already covers are not written again. `takesCurrentEntry` says the browser
  // has already put the route in an entry, which the chain grows from instead
  // of adding one more.
  resolveEntry(
    beneath: ParsedRoute | null | undefined,
    route: ParsedRoute,
    takesCurrentEntry: boolean,
  ): HistoryEntry[] {
    const chain: ParsedRoute[] = [];
    for (let above = parentRoute(route); above; above = parentRoute(above)) {
      chain.unshift(above);
    }
    chain.push(route);

    const held = beneath
      ? chain.findIndex((step) => routeEquals(step, beneath))
      : -1;
    const under = held < 0 ? 0 : this.descentRun + 1;
    return (held < 0 ? chain : chain.slice(held + 1)).map((step, index) =>
      entryStep(step, under + index, takesCurrentEntry && index === 0),
    );
  }

  // Canonicalizing a URL or replacing an unreachable subject refines where the
  // person already is, so it never adds an entry.
  resolveCorrection(
    currentRoute: ParsedRoute | null | undefined,
    route: ParsedRoute,
  ): HistoryEntry[] {
    return [this.swap(currentRoute, route)];
  }

  // Moves the remembered routes onto an entry the caller has written.
  commit(entry: HistoryEntry | null | undefined) {
    if (!entry?.route || entry.action === NAVIGATION_HISTORY_ACTION.NONE) {
      return;
    }

    this.tabs[routeTab(entry.route)] = entry.route;
    this.descentRun = entry.descentRun;
  }

  // Where a bottom tab reopens. A tab that has not been visited opens the
  // route its owner supplies.
  routeForTab(tab: unknown, fallbackRoute?: ParsedRoute | null) {
    return this.tabs[tab as WorkspaceTab] ?? fallbackRoute ?? null;
  }

  snapshot(): NavigationSnapshot {
    return { tabs: { ...this.tabs }, descentRun: this.descentRun };
  }

  restore(snapshot: Partial<NavigationSnapshot> | null | undefined) {
    const tabs = emptyTabs();
    for (const tab of WORKSPACE_TABS) {
      tabs[tab] = snapshot?.tabs?.[tab] ?? null;
    }
    this.tabs = tabs;
    const descentRun = snapshot?.descentRun;
    this.descentRun =
      typeof descentRun === "number" &&
      Number.isInteger(descentRun) &&
      descentRun > 0
        ? descentRun
        : 0;
  }

  private ascent(
    currentRoute: ParsedRoute | null | undefined,
    route: ParsedRoute,
  ): HistoryEntry {
    const steps = routeAscentSteps(currentRoute, route);
    if (steps !== null && steps <= this.descentRun) {
      return {
        route,
        action: NAVIGATION_HISTORY_ACTION.TRAVERSE,
        steps,
        descentRun: this.descentRun - steps,
      };
    }

    return entryStep(route, 0, true);
  }

  private swap(
    currentRoute: ParsedRoute | null | undefined,
    route: ParsedRoute,
  ) {
    return entryStep(
      route,
      keepsParent(currentRoute, route) ? this.descentRun : 0,
      true,
    );
  }
}

// Entries before the current one stay valid only while the replacement sits
// under the same screen the replaced route did.
function keepsParent(
  currentRoute: ParsedRoute | null | undefined,
  route: ParsedRoute,
) {
  const before = parentRoute(currentRoute);
  const after = parentRoute(route);
  if (!before || !after) {
    return !before && !after;
  }

  return routeEquals(before, after);
}

function entryStep(
  route: ParsedRoute,
  descentRun: number,
  takesCurrentEntry: boolean,
): HistoryEntry {
  return {
    route,
    action: takesCurrentEntry
      ? NAVIGATION_HISTORY_ACTION.REPLACE
      : NAVIGATION_HISTORY_ACTION.PUSH,
    steps: 0,
    descentRun,
  };
}

function noChange(
  route: ParsedRoute | null | undefined,
  descentRun: number,
): HistoryEntry {
  return {
    route,
    action: NAVIGATION_HISTORY_ACTION.NONE,
    steps: 0,
    descentRun,
  };
}

function emptyTabs(): Record<WorkspaceTab, ParsedRoute | null> {
  return { tasks: null, notes: null, settings: null };
}
