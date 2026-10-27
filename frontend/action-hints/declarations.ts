import {
  type ActionHintControlKind,
  type ActionHintScope,
  type ActionHintTarget,
  buttonActionHintTarget,
  disclosureActionHintTarget,
  hasActionHintLayoutBox,
  linkActionHintLabel,
  linkActionHintTarget,
  radioActionHintTarget,
  rangeActionHintTarget,
  reorderHandleActionHintTarget,
  selectActionHintTarget,
  separatorActionHintTarget,
  switchActionHintTarget,
  textboxActionHintTarget,
} from "../action-hint-scope.js";
import {
  type DeclaredElement,
  ElementDeclarations,
} from "../element-declarations.js";
import { elementAndShadowRoot } from "../shadow-roots.js";
import type { ActionFor } from "./model.js";

// One target as its owner's template declares it, on the control itself. A
// link may leave its label out and be named from what it shows and where it
// goes.
export type ActionHintDeclaration<Kind extends ActionHintControlKind> =
  DeclarationFields<Kind> &
    (Kind extends "link" ? { label?: string } : { label: string });

interface DeclarationFields<Kind extends ActionHintControlKind> {
  // Its name within the owner. The scope id the parent passes goes in front.
  id: string;
  // What it does. Left out, the parent names it as it pulls: the action it
  // passes for `role`, or else its `actionId`.
  action?: ActionFor<Kind>;
  role?: string;
  // Whether the person can use it now. Left out, they can.
  when?: boolean;
  // The control it acts on when that is not the element it sits on, such as
  // the host itself, which no template draws. The badge stays on the element.
  control?: () => HTMLElement | null | undefined;
  // Where its badge goes when that is not the element it sits on. A range or
  // a reorder handle always carries its own.
  anchor?: Kind extends "range" | "reorder-handle"
    ? never
    : () => HTMLElement | null | undefined;
  // A narrower owner than the component, so a change there retires only
  // its own targets.
  owner?: () => Element | null | undefined;
  // Clip roots beyond the ones the parent passes.
  clipRoots?: () => Array<Element | null | undefined>;
  badgeAtEnd?: Kind extends "button" ? boolean : never;
}

export interface ActionHintPull {
  scopeId?: string;
  actionId?: string;
  actions?: Readonly<Record<string, string | undefined>>;
  clipRoots?: Element[];
  // The owner's modal or popover to read. Left out, the targets outside
  // them.
  contextRoot?: Element | null;
}

export type DeclaredActionHint = {
  [Kind in ActionHintControlKind]: {
    kind: Kind;
    declaration: ActionHintDeclaration<Kind>;
  };
}[ActionHintControlKind];

/**
 * The Action Hints one component declares in its template.
 *
 * Each declaration rides on the control it describes and leaves with it.
 * `scope()` reads what the last draw declared; keyboard navigation pulls once
 * drawing has settled.
 */
export class ActionHints {
  private readonly owner: Element;
  private readonly clipRoots: () => Array<Element | null | undefined>;
  private readonly declarations: ElementDeclarations<DeclaredActionHint>;

  // `clipRoots` clips every target the owner declares, such as the owner and
  // the scrollport they all sit in.
  constructor(
    owner: Element,
    {
      clipRoots = () => [],
    }: { clipRoots?: () => Array<Element | null | undefined> } = {},
  ) {
    this.owner = owner;
    this.clipRoots = clipRoots;
    this.declarations = new ElementDeclarations(owner);
  }

  button(declaration: ActionHintDeclaration<"button">) {
    return this.declarations.on({ kind: "button", declaration });
  }

  link(declaration: ActionHintDeclaration<"link">) {
    return this.declarations.on({ kind: "link", declaration });
  }

  disclosure(declaration: ActionHintDeclaration<"disclosure">) {
    return this.declarations.on({ kind: "disclosure", declaration });
  }

  radio(declaration: ActionHintDeclaration<"radio">) {
    return this.declarations.on({ kind: "radio", declaration });
  }

  switch(declaration: ActionHintDeclaration<"switch">) {
    return this.declarations.on({ kind: "switch", declaration });
  }

  textbox(declaration: ActionHintDeclaration<"textbox">) {
    return this.declarations.on({ kind: "textbox", declaration });
  }

  select(declaration: ActionHintDeclaration<"select">) {
    return this.declarations.on({ kind: "select", declaration });
  }

  range(declaration: ActionHintDeclaration<"range">) {
    return this.declarations.on({ kind: "range", declaration });
  }

  separator(declaration: ActionHintDeclaration<"separator">) {
    return this.declarations.on({ kind: "separator", declaration });
  }

  reorderHandle(declaration: ActionHintDeclaration<"reorder-handle">) {
    return this.declarations.on({ kind: "reorder-handle", declaration });
  }

  scope(pull: ActionHintPull = {}): ActionHintScope {
    const clipRoots = this.clipRoots().filter((root) => root != null);
    return declaredActionHintScope(
      this.owner,
      this.declarations.list(pull.contextRoot),
      { ...pull, clipRoots: [...clipRoots, ...(pull.clipRoots ?? [])] },
    );
  }
}

// The scope an owner's declarations make for one pull. A target's clip roots
// are where it can scroll out of view, so their scrolling revalidates. A
// change inside a declaration's owner revalidates too, so declarations that
// all name narrower owners leave the rest of the component unwatched.
export function declaredActionHintScope(
  owner: Element,
  declarations: readonly DeclaredElement<DeclaredActionHint>[],
  pull: ActionHintPull,
): ActionHintScope {
  const targets: ActionHintTarget[] = [];
  const scrollRoots = new Set<Element>();
  const mutationRoots = new Set<Node>();
  for (const entry of declarations) {
    const watched = entry.value.declaration.owner?.() ?? owner;
    for (const root of elementAndShadowRoot(watched)) {
      mutationRoots.add(root);
    }
    const ownClipRoots = (entry.value.declaration.clipRoots?.() ?? []).filter(
      (root): root is Element => root != null,
    );
    const target = declaredTarget(owner, entry, pull, ownClipRoots);
    if (
      target &&
      !isDisabled(target.control) &&
      hasActionHintLayoutBox(target.anchor)
    ) {
      targets.push(target);
      for (const root of target.clipRoots) {
        scrollRoots.add(root);
      }
    }
  }
  return {
    blocked: false,
    targets,
    mutationRoots: mutationRoots.size
      ? [...mutationRoots]
      : elementAndShadowRoot(owner),
    scrollRoots: [...scrollRoots],
  };
}

function declaredTarget(
  owner: Element,
  {
    element,
    value: { kind, declaration },
  }: DeclaredElement<DeclaredActionHint>,
  pull: ActionHintPull,
  ownClipRoots: Element[],
): ActionHintTarget | null {
  if (declaration.when === false) {
    return null;
  }
  const actionId =
    declaration.action ??
    (declaration.role === undefined
      ? pull.actionId
      : pull.actions?.[declaration.role]);
  if (!actionId) {
    return null;
  }
  const control = declaration.control
    ? declaration.control()
    : (element as HTMLElement);
  if (!control) {
    return null;
  }
  const label = declaration.label ?? linkActionHintLabel(control);
  if (!label) {
    return null;
  }
  const target = {
    id: pull.scopeId ? `${pull.scopeId}:${declaration.id}` : declaration.id,
    actionId,
    label,
    invalidationOwner: declaration.owner?.() ?? owner,
    control,
    anchor: declaration.anchor?.() ?? element,
    clipRoots: [...(pull.clipRoots ?? []), ...ownClipRoots],
  };
  switch (kind) {
    case "button":
      return buttonActionHintTarget({
        ...target,
        badgeAtEnd: declaration.badgeAtEnd,
      });
    case "link":
      return linkActionHintTarget(target);
    case "disclosure":
      return disclosureActionHintTarget(target);
    case "radio":
      return radioActionHintTarget(target);
    case "switch":
      return switchActionHintTarget(target);
    case "textbox":
      return textboxActionHintTarget(target);
    case "select":
      return selectActionHintTarget(target);
    case "range":
      return rangeActionHintTarget(target);
    case "separator":
      return separatorActionHintTarget(target);
    case "reorder-handle":
      return reorderHandleActionHintTarget(target);
  }
}

function isDisabled(control: Element) {
  return Boolean((control as { disabled?: boolean }).disabled);
}
