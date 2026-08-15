# Documentation Review Policy

This policy extends the common [Review Policy](policy.md) for tracked
documentation, including repository entry points, contributor and operator
guides, product and architecture documents, and review policy.

Unless a document explicitly owns planned or historical material, repository
documentation describes the supported current system. It is not a running
account of how a change was developed.

## Current-State Contract

Write each document so a reader with the current checkout, but no Issue, Pull
Request, commit, or prior-release context, can understand the behavior and
contract it owns.

- State the resulting behavior directly. Do not introduce it through “before
  this change,” “now,” “newly,” or a comparison with an implementation that no
  longer exists.
- Rewrite the affected explanation when behavior changes. Do not retain the old
  explanation and append a correction, exception, or change narrative after it.
- Describe implemented behavior in current-state documents. Planned behavior
  belongs in the roadmap, and change rationale belongs in the Issue, Pull
  Request, commit history, or an explicitly owned design record.
- Use direct, stable terms from the product and implementation. Do not repeat a
  claim in several approximate forms merely to make the text sound safer.

Temporal language is not itself a defect. Keep historical context when an
earlier state still has a present consequence, such as a supported legacy
input, storage migration, deprecation window, compatibility constraint, or
operator upgrade step. State the current consequence and required action; omit
chronology that does not affect current use, maintenance, or review.

## Purpose And Fact Ownership

The directory purposes in the [documentation index](../README.md) define each
document's subject. Within those purposes, every normative fact must have one
owning document.

- Product documents own supported behavior, workflows, and surfaces at their
  declared level. Only the roadmap owns planned product direction.
- Architecture documents own implemented boundaries, state ownership, and
  detailed system contracts.
- Development and operations documents own reproducible procedures for their
  respective audiences.
- Review documents own repository review requirements.

Another document may give the short, perspective-specific consequence needed
to explain its own subject and link to the owner for detail. It must not copy
the owner's complete rule, procedure, exceptions, or lifecycle as defensive
context. If removing a repeated passage loses no information specific to that
document's purpose, remove it or replace it with a link.

Within one document, state an invariant or limitation once in its natural
section. Refer back to that section instead of restating the same rule under
every affected feature. Create a new document only when it has a distinct
subject and ownership boundary; do not create another general description to
avoid deciding where a fact belongs.

## Change Completeness

Documentation review extends beyond the files already present in a diff. When
supported behavior, terminology, or a procedure changes, inspect the semantic
neighborhood across tracked documentation.

Read each affected document as a whole, then search for the affected feature
names and superseded terms, as well as relevant UI labels, routes, APIs,
commands, configuration keys, states, limitations, and entry-point links.
Update or remove every directly affected statement in the same change,
including obsolete examples, headings, and links. A change is not ready while
it leaves a conflicting current-state description or an outdated procedure
elsewhere in the repository.

Do not broaden a focused change into cleanup of unrelated pre-existing
documentation. Record unrelated findings separately when they cannot be fixed
without changing the purpose or risk of the current work.

## Documentation Evidence

Review factual documentation against the source that owns the behavior, not
only against the change description or generated prose.

- Trace product and architecture claims to the implemented UI, API, storage,
  process, or external-service boundary they describe.
- Inspect or run documented commands and procedures at the boundary needed to
  support the claim. Distinguish direct execution from source inspection and
  identify supported environments that remain unverified.
- Keep examples consistent with the current contract. Mark placeholders and
  hypothetical examples explicitly; do not present planned or inferred output
  as observed behavior.
- Check changed links, headings, paths, commands, and names from the reader's
  entry point rather than assuming that a locally valid fragment is reachable.

## Documentation Review Gate

A change that affects documented behavior is not ready when:

- a reader needs the change history to understand the current behavior;
- old and new explanations remain layered in the same document;
- more than one document independently owns the same normative detail;
- the change leaves a directly affected tracked document stale or
  contradictory;
- historical context remains without a present compatibility, migration,
  operational, or review consequence; or
- a factual claim is unsupported by the owning source or the stated
  verification evidence.

Review comments should identify the exact claim, its intended document owner,
the conflicting or stale reference, and the evidence needed to resolve it.
