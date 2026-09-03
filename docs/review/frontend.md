# Frontend Review Policy

This policy extends the common [Review Policy](policy.md) for changes
to browser UI, layout, navigation, styling, and frontend component state.

## Frontend Review

The UI is a work tool, not a marketing site. Review frontend changes for
density, stability, and repeated use.

- Prefer component-level scrolling over global page scrolling.
- Preserve inspectability for long paths, file names, diffs, and code lines.
- Keep important context visible without forcing wide panels.
- Avoid hidden layout shifts during normal review navigation.
- Treat mobile and foldable layouts as first-class review surfaces.
- Check that labels, buttons, and headers do not clip text.
- Use visual evidence when layout or scrolling behavior is affected.

When changing layout, define the visual contract before accepting the
implementation. The contract should describe how the surface uses space, not
only which elements exist.

Examples:

- A control may be content-sized, fill available space, or share space with
  peers; do not leave that behavior implicit.
- Dynamic labels such as paths, branch names, and commit subjects should have
  an explicit growth and clipping rule.
- A desktop or foldable layout may allow wider content than the phone layout.
- A compact panel should not force unrelated controls to stretch just because
  the parent uses grid or flex.
- A loading, refresh, or selection state should not replace stable content
  unless the delay is meaningful.

Before changing layout CSS, state the intended behavior for short content, long
content, constrained width, and extra available width. Review the
implementation against that contract rather than only against the screenshot
that triggered the change.

Controls that represent the same kind of choice should share the same DOM shape
and CSS rules. Do not special-case one peer control unless the visual contract
explicitly requires different behavior.

Prefer browser-native intrinsic layout behavior over hand-computed widths. Use
CSS primitives such as `max-content`, `minmax`, `field-sizing`, and
viewport/container breakpoints before adding JavaScript string-length sizing.
If a hard cap is needed, explain which viewport or neighboring control it
protects.

Do not use JavaScript to decide ordinary layout. Layout sizing, wrapping,
clipping, and space distribution should be expressed in CSS so the browser owns
reflow across content, viewport, font, and platform differences. JavaScript may
set semantic state, user-selected values, or explicit user-controlled
dimensions such as a resizable pane, but it should not measure text, calculate
element widths, or assign layout sizes for normal controls unless CSS cannot
express the behavior. Exceptions should be rare, documented in the change, and
backed by visual checks that cover the affected viewport and content cases.

If a visual fix produces a second related regression, stop incremental
patching. Re-state the layout contract, inspect the DOM and CSS ownership, and
update tests to cover the failing content and viewport cases before making
another fix.

Frontend fixtures should include inconvenient examples, not only normal
labels:

- long file paths and file names
- long branch names, including remote branches
- many changed files or commits
- short content that does not fill the viewer
- narrow foldable and phone widths

## Integrated Review Navigation

Treat review scope, navigator, viewer representation, and selected file as
explicit review state. One intent may update multiple fields when they together
define one semantic result, but must not change otherwise valid state merely to
make a surface non-empty. Keep valid-but-empty combinations explicit and offer
an action when another state is useful.

One integrated review workspace must have one selected-path owner. Reusing
change-tree, file-tree, source, and diff presentation components is preferred.
The active review surface owns their selection, watcher, and request lifetime.

The route owns reloadable semantic review state. Panel width, tree disclosure,
and navigator/viewer scroll belong to the component instance. A cached inactive
review may retain those DOM-local values, but it must release filesystem
watches, pending requests, and other active lifecycle work.

Responsive review tests must cover both list and viewer roles. Desktop and
foldable layouts preserve a usable navigator and viewer simultaneously; phone
layouts show one at a time and expose a semantic file-to-navigator Back action.
Test deep paths, unchanged and deleted files, clean scopes, long refs, large
change sets, appearance extremes, and browser zoom rather than validating only
the default happy path.

The Tasks Detail layout is the outer activation owner. It binds either a Task
or Section subject and owns the shared Integrated Review, Git, and GitHub
sibling surfaces. Conversation belongs to the Task subject; fixed-context New
Task belongs to the Section subject. Integrated Review alone owns Working
Tree/current-Branch selection and its root watch. Git is limited to arbitrary
Compare and bounded Log, while GitHub owns its remote availability and data.

Review state is cached by explicit subject identity, not by whichever subject
is currently visible. Same-subject surface switches may retain safe DOM-local
state, while an identity change must hard-rebind external data. A hidden child
has no active lifetime: deactivation invalidates requests and releases watchers
or timers, and reactivation reconciles canonical data before treating retained
DOM as current. Keep inactive caches bounded.

## Web Components And CSS

Caffold currently uses internal Web Components rendered in Light DOM. This
keeps browser behavior, debugging, Playwright tests, shared theme variables,
and small frontend modules straightforward. It also means CSS is still one
global cascade.

Light DOM is the default until a component has a clear reason to isolate styles
with Shadow DOM. Good reasons include reusable leaf widgets, third-party-like
components, or a component whose styles cannot reasonably share the app
cascade.

### Native disclosure and modal surfaces

Prefer browser-native interaction state when it matches the product contract.
Use the HTML Popover API for lightweight, dismissible metadata or contextual
panels. `popover="auto"` with `popovertarget` is the default when light dismiss
and one-open-auto-popover behavior are appropriate.

Use `<dialog>` for modal work or an explicit confirm/cancel decision, not as a
generic details panel. A custom overlay is justified only when native focus,
dismissal, anchoring, or modality cannot express the required behavior. Review
keyboard access, focus return, Escape/light-dismiss behavior, and compact mobile
placement at the same boundary as the visual change.

### Frontend Module Boundaries

Apply the common [Source Module Ownership](policy.md#source-module-ownership)
rules when deciding whether frontend implementation remains private to its
current owner or moves to a shared boundary.

When one frontend module grows beyond a single file, use an adjacent same-stem
directory: `name.js` and `name/` form one ownership boundary. `name.js` is the
primary public entry point for non-visual behavior. `name/` contains the
module's private implementation. Routed `page.js` and `layout.js` files are
ownership entry points rather than private implementation. The only other
conventionally visible paths below a boundary are Web Component entry points
directly under its `components/` namespace, as defined below. `index.js` has no
special role in this convention. A same-stem private implementation directory
must not contain `page.js` or `layout.js`.

Apply import rules at the ownership boundary rather than by counting directory
levels:

- Production modules outside the boundary import only entry points visible at
  that boundary. They consume non-visual behavior through explicit named
  exports from `name.js`. An owner that mounts a component exposed by that
  boundary may instead import its immediate component entry point through
  `name/components/component.js`. Consumers must not traverse any other
  private implementation paths or use `export *` barrels.
- `name.js` may import modules it directly owns under `name/` and entry points
  visible at that boundary. Directly owned modules may import each other and
  visible entry points of nested or separate boundaries. They must not traverse
  a nested boundary's private implementation, and no module under `name/` may
  import its own `name.js` entry point. The static production import graph must
  remain acyclic.
- Apply the same rule recursively when an internal module expands. For example,
  `name/child.js` and `name/child/` form a nested ownership boundary whose
  implementation must not import `name/child.js`.

When expansion makes an implementation module need a declaration currently in
`name.js`, move that declaration to the implementation module that owns it and
have `name.js` import and, when required by outside consumers, re-export it.
Alternatively, pass parent-owned runtime state through a constructor, snapshot,
or method. Do not retain a parent-child import cycle or create a generically
named shared module without a concrete ownership role.

Focused Node unit tests live beside their owning frontend module with the same
stem: `name.js` is tested by `name.test.js`. A test for an internal module
may import that module directly at its owning boundary, but it does not justify
re-exporting the internal API from `name.js`. Colocated `*.test.js` files
must remain outside the production static import graph, JavaScript ownership
scans, Rust static assets, and the service-worker cache. Global stylesheet and
static-asset manifests may enumerate production internal paths because they are
build inventories rather than runtime feature consumers.

### Component Ownership And Lifecycles

A routed `page.js` or `layout.js` may define and register exactly the custom
element that represents that page or layout owner. Every other Web Component
entry point must live directly under the nearest owner's `components/`
directory, and every such entry point must define or register a custom element.
Page and layout owners import child component entry points; they must not define
or register those child elements themselves. Production modules in every other
location, including a component's same-stem private directory, must not define
or register custom elements.

A Web Component owns its DOM, focus or interaction state, markup, and any
scoped CSS. Its path makes the registration-bearing module distinguishable at
an import site from the feature's non-visual API and private implementation.
Non-Web-Component leaf UI remains private implementation of its owner. Do not
use `components/` as a general bucket for models, request lifecycles, DOM
helpers, or other non-visual feature implementation.

An outside owner that mounts a Web Component imports
`name/components/component.js` directly so registration and DOM ownership stay
visible. Consumers that only use feature state or emit intent use `name.js`.
This direct component import does not make the rest of `name/` public.

Component visibility is relative to the nearest ownership boundary and follows
the same same-stem rule recursively. For example:

```text
name.js
name/
  components/
    parent.js
    sibling.js
    parent/
      model.js
      components/
        child.js
```

`name/components/parent.js` and `name/components/sibling.js` are component
entry points visible at the `name` ownership boundary.
`name/components/parent/` is the private same-stem implementation of
`parent.js`. Its nested `components/child.js` is therefore visible only within
the `parent.js` and `parent/` ownership boundary. `parent.js` and modules under
`parent/` may import it; `sibling.js` and modules outside the parent boundary
must not. If sibling owners need that child, move it to the nearest common
owner's namespace, such as `name/components/child.js`. An immediate child of a
`components/` directory declares both Web Component kind and visibility at
that level; the directory never makes the whole subtree externally importable.

A component extraction is a state-ownership change, not only a markup move.
Move the component's state, every writer, subscription/timer/watcher cleanup,
DOM, scoped CSS, and regression tests together. The previous container must not
retain a second writer or lifecycle owner after the extraction.

Use snapshots and public methods for parent-to-child data flow. Use intent
events for actions that cross upward. UI-local state such as drafts, focus,
scroll anchors, disclosure, picker state, and review selection belongs in the
leaf component that renders and restores it. External mutations and canonical
domain reconciliation remain with the component that owns that API boundary.
A leaf must not reach sideways to mutate sibling state.

Stateful children should be mounted once and shown or hidden. Do not let a
container rerender destroy child DOM and then depend on capture-and-restore
code for drafts, focus, scroll, selection, subscriptions, timers, or watchers.
If a container patches its own Light DOM, preserve stateful child elements by
identity and interact with them only through their public component boundary.

### Keyboard Action Ownership

When a document- or workspace-level keyboard mode exposes actions owned by
multiple components, the component that owns the existing control and
activation path must provide its keyboard action through an explicit public
component contract. That provider supplies the action's stable semantic
identity, accessible meaning, current actionability, and existing click, focus,
or intent path. An ancestor must not infer keyboard actions by scanning generic
interactive DOM, attaching markers outside the owner, or reaching through a
child's Light DOM to reconstruct them.

A container may provide actions for controls it owns, select its active direct
child providers, and combine their scopes through the shared composition
contract. It may add only the context and geometry, scroll, topology, or
invalidation dependencies that it owns. It must not enumerate descendant
action kinds or reimplement scope composition field by field.

The central keyboard mode owns supported-action policy, key allocation,
ordering, and conflict validation; component providers do not assign global
keys. A temporary key must not silently invoke a different action from the one
presented when the interaction began. Activation must reuse the existing
component action rather than becoming a second navigation or mutation owner.
If a session can partially revalidate, each action provider must declare the
exact retained owner that forms its minimum invalidation group. Observer roots
may request revalidation, but the central mode must not infer action ownership
from mutated DOM or retarget a surviving key to a new control.

Keyboard input has one interaction owner at a time. The keyboard mode must
define eligible entry, accepted keys, ownership transfer or exit, and cleanup.
Editable controls and active text composition own character input, including
composition-time `Escape`. Competing handlers must not act on the same input or
rely on propagation order to decide ownership.

Review modifier, repeat, key normalization, and non-Latin input-source behavior
at the same boundary; report unperformed real input-source checks as unverified.
Keep provider and native activation tests with the component, scope-composition
tests with the container, central policy tests with the keyboard mode, and the
complete input-to-action handoff in the owning browser spec.

### Coordinated Lifecycle Control

For every lifecycle-owning frontend owner, review initial connection,
activation or context changes, deactivation, owned identity changes, and
disconnection. Every asynchronous response needs a generation, token, or
identity check appropriate to its own request lifetime. Canceling one request
must not accidentally invalidate an unrelated request.

When the common policy requires an explicit control model, normalize raw
external observations into events with meaning inside the owning boundary
before they enter that model. One transition authority owns the control node;
adapters, effects, and presentation code must not assign it directly. Keep
request identities, counters, deadlines, and diagnostic context as control data
unless they independently change which transitions are allowed.

The coordinator's graph contains only the mutually exclusive control phases it
owns. Domain state and state owned by requests, transports, or child owners
remain orthogonal and are consumed through their public contracts. A
coordinator may sequence effects across those owners, but it must not absorb
their state machines or multiply independent state axes into a Cartesian
product.

Presentation is derived unless it independently changes allowed transitions or
effects. Presentation owners render a published snapshot and emit intent; they
do not add display-only nodes or mutate the control graph.

Apply the existing same-stem module boundary when the control model needs
private implementation files; do not split a small model merely to satisfy a
file-name pattern. Present nodes and invariants before the complete transition
table, then the event reduction and supporting details. The public entry point
exports consumer contracts, not private nodes, internal events, edges, or
presentation selectors.

Focused tests must reach every control node and allowed edge. They must also
cover critical rejected transitions, stale completions, and every interruption
or terminal path declared by the graph. Boundary tests remain responsible for
the real adapters and effects; unit coverage of a transition function does not
prove that its external observations or side effects are wired correctly.

### Incremental DOM updates

Caffold's frontend direction favors browser-owned, long-lived DOM over adding
a React-style virtual tree or a generic keyed reconciliation layer. This is a
preference for new work and for paths already being changed, not a requirement
to rewrite every existing `render()` method before an adjacent improvement can
land.

Where the component already owns stable elements, prefer applying the domain
change directly to the smallest affected DOM surface. A title change can update
text, a status change can update its status presentation, and an ordering
change can move the existing row. Equivalent canonical snapshots should
ideally be DOM no-ops. Preserve node identity when it carries animation, focus,
selection, scroll, disclosure, media, or custom-element lifecycle continuity.

Initial mounting and meaningful structural transitions may still render a
larger subtree when that remains the clearest implementation. Improve broad
render paths incrementally as related behavior is touched; do not turn a local
identity fix into a new rendering framework or an unrelated rewrite. If direct
patching would become brittle, prefer a clearer component ownership boundary or
a deliberately scoped rerender over accumulating hidden DOM assumptions.

Do not add a global store merely to coordinate an extraction. Independent API
or revision projections must remain independent unless the external source
provides one shared ordering contract. For example, a task-list revision must
not reject a task-detail snapshot, and a detail revision must not advance the
list baseline.

Because nested custom elements are still normal descendants in Light DOM,
container selectors must be narrow.

Preferred patterns:

```css
caffold-task-git-layout {
  & > .task-git-workspace {
    display: grid;
  }

  & .task-git-title > h2 {
    font-weight: 600;
  }
}

caffold-git-log-list-page {
  & .log-entry {
    display: grid;
  }
}
```

Avoid broad container selectors that can enter child components:

```css
caffold-task-workspace h2 {
  font-weight: 600;
}

caffold-app-shell button {
  font-size: 0.9rem;
}
```

Use these rules when reviewing CSS:

- Group a component's internal selectors under its custom-element owner with
  native CSS nesting. Keep nesting shallow, preserve source order across media
  queries and owner-specific overrides, and do not combine or reorder selectors
  merely to make the nesting tree smaller.
- Keep global document rules and keyframes flat when nesting would not express
  component ownership.
- Container components should style their own chrome and direct layout
  children.
- A container may style a child custom-element host for placement, sizing, and
  visibility, but selectors that cross into that child's descendants belong in
  the child component's stylesheet.
- Prefer `>` for container layout selectors.
- Use component-local classes for internal chrome.
- Avoid raw tag selectors from shell or container components.
- Cross-component overrides must be narrow and intentional.
- New component selectors must be scoped below that custom element, and
  overlapping broad container selectors must be removed when ownership moves.
- Register new JavaScript and CSS assets in the stylesheet entrypoint, service
  worker cache, Rust static asset table, and static asset tests in the same
  change.
- If a selector looks convenient because it is broad, review it with suspicion.

### Appearance Ownership

Choose a sizing owner by the meaning of the content, not by the component or
screen where it happens to render:

- Interface owns UI typography, controls, rows, icons, spacing, and touch
  targets.
- Conversation owns readable task and long-form review prose, including the
  Composer textarea.
- Code owns source, diff, command/tool output, and inline or fenced code.

Mixed components must consume more than one axis when their content has more
than one meaning. For example, Composer controls are Interface while its
textarea is Conversation; an approval card combines Conversation prose, Code
command text, and Interface actions. Metadata, status, disclosure labels,
loading/retry actions, and errors stay Interface even when placed inside a
conversation.

Do not add a fixed font, row, or control size that bypasses the existing
appearance axis. Pixel values remain valid for borders, breakpoints, image
dimensions, and deliberate content bounds; the review question is whether the
value represents user-scalable Interface, Conversation, or Code content.

Choose Interface control tiers by action role rather than feature. Page-level,
application-wide, and primary actions use the regular control tier;
contextual-toolbar and inline secondary actions use the compact tier. A
component-specific selector must not silently make an equivalent Task,
Integrated Review, Git, or GitHub action larger. Regression coverage should
compare the role group, not merely assert whichever token each selector already
uses.

Review target size and label size independently. A primary or page-level action
can retain a regular hit target while using the shared Interface action text
scale. Do not let menu items, breadcrumbs, or text-bearing toolbar controls
inherit root body text merely because their height belongs to a regular tier.

Shared appearance tokens do not grant shared selector ownership. Define root
tokens centrally, but consume them inside the component that owns the DOM. When
a stateful range applies live changes, patch its value and preview without
rerendering the parent and replacing the focused range element.

## Browser Test Ownership

Browser regression tests follow the same ownership boundaries as the product.
Place a test with the surface whose behavior would need to change if the test
failed. App Shell, Task Detail, Integrated Review, Git, GitHub, and Settings
coverage should not accumulate in one integration spec merely because those
surfaces can be reached from the same browser session.

Keep independently failing behaviors in independent tests. One test may cover
the complete lifecycle of one route or component contract, but it should not
serially walk unrelated modes to save fixture setup. Retain only a small
cross-owner smoke test when switching between owners is itself the behavior
under review.

Support modules may own API stubs, transport controls, fixture data, request
counters, and deterministic delay gates. User actions, URL transitions, DOM
assertions, and visual assertions should remain visible in the owning spec.
Do not replace a large test with a page-object language that hides the
interaction and expected behavior reviewers need to inspect.

Browser tests must be deterministic in every supported project and under
normal parallel execution. Review must reject a test whose result depends on
retries, repeated execution, or favorable scheduler timing; those are test
defects, not evidence that the behavior is covered.

Each browser test must declare its minimum viewport coverage with the native
Playwright tags `@desktop`, `@foldable`, `@phone`, or `@all-viewports`. Multiple
project tags are valid when exactly those projects own the behavior. Review
should reject both untagged tests and `@all-viewports` coverage that does not
exercise a viewport-dependent production path or observable result.

When an expected result depends on the order of independently delivered events
or asynchronous completions, the test must gate the exact boundary the
assertion needs. A test that releases one request and expects a newer request
must await the newer request starting; an unrelated DOM update is not proof
that it has started. Prefer a test-local deferred promise or an assertion that
polls the owned signal. A fixed delay or an immediate request-counter read is
not an acceptable substitute for that ordering contract.

Browser fixtures must be isolated by test:

- Use test-local mutable state and unique filesystem paths.
- Clean up files, watches, timers, and subscriptions created by the test.
- Do not depend on execution order or a shared mutable fixture that requires
  serial execution.
- Run the affected specs with normal parallel workers. When changing fixture
  boundaries or suspected shared state, also run them with one worker and
  require the same result.

When product ownership moves, move its regression spec and support fixtures in
the same change. Prefer ownership and failure boundaries over arbitrary
line-count limits: a long fixture containing one coherent wire contract can be
valid, while a short test that combines unrelated owners is not.

Tasks Detail Git and GitHub behavior belongs in focused specs below
`frontend/tests/e2e/tasks/`. App Shell coverage should assert only application-lifetime
coordination and route/asset boundaries. Task and Section behavior must be
exercised through fixtures owned by their Tasks surface.

## Frontend Verification

For frontend layout or review-surface changes:

- run Playwright in desktop, foldable, and phone projects
- inspect screenshots when visual behavior is the point of the change
- test clipping, scrolling, and selection stability directly
- include edge-case fixture values that exercise the layout contract
- distinguish code changes from what the browser is actually serving

For CSS changes, tests should catch behavior, not just element presence:

- matching header heights where panels align
- no clipped header text
- preserved scroll positions where navigation should not move the viewport
- stable visual structure across supported viewport widths

When a local server is used for manual review, verify that the served assets
include the intended change and say when a browser refresh is required. A
passing unit or Playwright assertion does not prove that the currently open
browser tab has the latest CSS or JavaScript.
