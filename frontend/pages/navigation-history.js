import {
  ROUTE_RELATION,
  parentRoute,
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

const WORKSPACE_TABS = ["tasks", "notes", "settings"];

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
  constructor() {
    this.tabs = emptyTabs();
    // How many entries immediately before the current one are the current
    // route's ancestors, in order. Rewinding is only safe within that run.
    this.descentRun = 0;
  }

  // What to do with the browser history for an ordinary route request.
  resolve(currentRoute, route) {
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
  resolveFollowedLink(beneath, route) {
    if (beneath && routeTab(beneath) !== routeTab(route)) {
      return this.resolveEntry(beneath, route, true);
    }

    const descended = beneath &&
      routeRelation(beneath, route) === ROUTE_RELATION.DESCEND;
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
  resolveEntry(beneath, route, takesCurrentEntry) {
    const chain = [];
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
  resolveCorrection(currentRoute, route) {
    return [this.swap(currentRoute, route)];
  }

  // Moves the remembered routes onto an entry the caller has written.
  commit(entry) {
    if (!entry?.route || entry.action === NAVIGATION_HISTORY_ACTION.NONE) {
      return;
    }

    this.tabs[routeTab(entry.route)] = entry.route;
    this.descentRun = entry.descentRun;
  }

  // Where a bottom tab reopens. A tab that has not been visited opens the
  // route its owner supplies.
  routeForTab(tab, fallbackRoute) {
    return this.tabs[tab] ?? fallbackRoute ?? null;
  }

  snapshot() {
    return { tabs: { ...this.tabs }, descentRun: this.descentRun };
  }

  restore(snapshot) {
    const tabs = emptyTabs();
    for (const tab of WORKSPACE_TABS) {
      tabs[tab] = snapshot?.tabs?.[tab] ?? null;
    }
    this.tabs = tabs;
    this.descentRun = Number.isInteger(snapshot?.descentRun) && snapshot.descentRun > 0
      ? snapshot.descentRun
      : 0;
  }

  ascent(currentRoute, route) {
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

  swap(currentRoute, route) {
    return entryStep(
      route,
      keepsParent(currentRoute, route) ? this.descentRun : 0,
      true,
    );
  }
}

// Entries before the current one stay valid only while the replacement sits
// under the same screen the replaced route did.
function keepsParent(currentRoute, route) {
  const before = parentRoute(currentRoute);
  const after = parentRoute(route);
  if (!before || !after) {
    return !before && !after;
  }

  return routeEquals(before, after);
}

function entryStep(route, descentRun, takesCurrentEntry) {
  return {
    route,
    action: takesCurrentEntry
      ? NAVIGATION_HISTORY_ACTION.REPLACE
      : NAVIGATION_HISTORY_ACTION.PUSH,
    steps: 0,
    descentRun,
  };
}

function noChange(route, descentRun) {
  return { route, action: NAVIGATION_HISTORY_ACTION.NONE, steps: 0, descentRun };
}

function emptyTabs() {
  return { tasks: null, notes: null, settings: null };
}
