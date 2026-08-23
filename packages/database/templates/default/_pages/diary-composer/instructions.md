# Diary composer

Compose dated diary notes from activity already reconciled into knowledge. This workflow
controls how changed evidence is gathered, assigned to days and checkpointed. The global
knowledge guide returned by `begin_knowledge_session` controls every knowledge mutation.

## Contract

- Before the first knowledge mutation, call `begin_knowledge_session` once, read the returned
  guide completely, and reuse its `knowledge_session_receipt` for the session. Reload it only
  after context loss, in a new session, or when a mutation reports a stale receipt.
- Read this automation's configured state document before listing changes. Under the
  automation's control documents, mutate only that state document.
- Run independently from every other automation and treat the fixed knowledge-change window
  as the entire input.
- Diary notes, hubs and companion notes are ordinary private knowledge pages. Do not require
  a folder, category, path pattern, `intro` page or timeline.
- Preserve owner-authored and uncertain material exactly. Never expose bare operational
  cursors or document ids as prose, or put scan logs or run reports in a diary page; stable
  document links are expected.

## State machine

### 1. Initialize the run

Read the state document. When its checkpoint is `_none_`, omit `cursor`; otherwise copy the
opaque value exactly.

### 2. Freeze the change window

Call `list_document_changes` with that cursor and no `limit`. When `has_more` is true, call it
again with `next_page_token` as `page_token` and no cursor. Continue until `has_more` is false.

The first call fixes the window. Changes committed during this run remain after the returned
`next_cursor` for the next scheduled run. Do not restart or widen the window.

### 3. Load exact changed evidence

Ignore this automation's configured instruction and state document ids. Also ignore a change
whose subject is itself an existing diary note, companion or diary hub as new life activity;
such a page may still be read later as diary context. Automation maintenance is not an event
in the owner's life.

For every other non-deleted row, call `compare_document_revisions` once with its exact
`document_id`, `previous_revision_number` and `revision_number`. Use the returned metadata changes and exact
`before` and `after` Markdown fragments as the complete new evidence. Do not calculate
another diff.

- A null `previous_revision_number` presents the document as newly available baseline evidence;
  activity dates still come only from its content.
- When `comparison.complete` is false, use the returned comparison from
  `actual_from_version` through `to_version` and do not infer pruned changes.
- On `DOCUMENT_DELTA_UNAVAILABLE`, record the error and do not reconstruct the delta from the
  current document.
- Compare an archived row as above, but treat archival itself only as withdrawal of a current
  page. For a deleted row, use its tombstone without inventing a missing delta. In either case,
  locate existing diary passages that linked the removed page and reconcile one only when
  retained evidence shows exactly what support was withdrawn. Withdrawal proves no opposite
  claim.

Call `read_document` only when a changed fragment needs current context to identify its subject,
relationship, activity date or useful document link. Unchanged current prose is context,
never new activity evidence.

### 4. Derive the affected days

Select only changed fragments that establish something the owner did, experienced, decided
or learned and supply a reliable activity date. A timeline delta has no special privilege;
it is one candidate among any changed page whose fragment supplies both the activity and its
date.

- For every qualifying activity, copy the activity date from its supporting changed fragment
  and assign it only to that calendar day. Without that date, mark no day as affected and
  report the unresolved activity.
- `changed_at`, creation time, commit time and this run's date never supply or replace an
  activity date.
- Maintenance edits, link repairs and durable facts do not become activity merely because a
  page changed.
- A one-word correction contributes only its corrected meaning, not the surrounding page.
- There is no recency cutoff: historical activity newly received today still affects only
  its historical day.

Group deltas that describe the same meeting, exchange, decision or movement into one
activity with all useful document links. Shared date alone does not join unrelated
activities. When a correction changes an activity date, mark both the formerly supported day
and the corrected day as affected.

A window may legitimately affect no diary day.

### 5. Gather context for each affected day

For each affected date:

- **a.** Search page titles, summaries and bodies for the exact date in its common textual
  forms. Read the best existing diary-day candidate, its outbound links and its backlinks. If
  a diary hub links a day, follow that route; do not infer a missing day from a path.
- **b.** Follow links from the day to any companion notes. A companion is ordinary knowledge
  whose material is independently useful, never a required view.
- **c.** Use `list_document_revisions` only as far as needed to distinguish composer-owned passages
  from owner additions. Treat uncertain authorship as the owner's.
- **d.** Read a changed knowledge page only when its delta does not provide enough context to
  understand the relationship or choose the destination link. Do not mine unchanged facts
  to repeat.
- **e.** Search earlier diary notes by the involved subjects and follow existing continuity
  links to find the latest useful account for an arc that genuinely continues.

Reading an earlier day supplies evidence for a continuity link; it does not require one.
Repeated mention and chronological adjacency are not continuity.

### 6. Reconcile each affected day

For each affected date:

- **a.** Select across the day's changed activities as a whole. Include the most important
  things the owner did, experienced, decided or learned and the consequences or open loops
  that make the day intelligible. A changed page is a candidate, not a quota; routine,
  low-consequence, maintenance and duplicate views may remain only on their knowledge pages.
- **b.** Reuse the established diary page for that date when one exists. Otherwise create one
  ordinary atomic page whose title and prose identify the full date. Do not create directory
  scaffolding, an index or a timeline merely to hold it.
- **c.** Write connected prose, not a digest of changed pages. Represent one real activity
  once with its useful links. Explain relationships only when evidence supports them; keep
  activities that merely share a date in separate passages rather than inventing a cause,
  mood or theme.
- **d.** Include a thought, feeling or first-person position only when the owner expressed it.
  Link the most specific useful source or knowledge documents, and repeat their details only
  when the day's transition or consequence needs them.
- **e.** When an activity genuinely resumes, follows from or changes the meaning of an earlier
  one, link the latest useful diary account in the sentence explaining that continuity.
  Never edit an earlier day merely to add a forward link.
- **f.** Integrate only support changed in this window. On replay, converge rather than
  append. Change only composer-owned passages; preserve every owner-written passage exactly,
  including its position and structure. Treat uncertain authorship as the owner's.
- **g.** When new evidence changes the day's relative significance, condense or remove the
  composer's lower-significance prose instead of accumulating every activity. Archive only a
  composer-created companion whose useful material moved elsewhere.

A useful diary hub or monthly reflection may link these ordinary pages, but neither is an
automatic digest or exhaustive index. Update one only when this window makes its curated
account stale.

If any diary or state mutation fails, keep the old checkpoint, stop and report the error.
Replay reuses any page already created.

### 7. Save the checkpoint and report

After every intended diary mutation succeeds, replace the state body with exactly:

    # Diary composer state

    **Checkpoint:** `<next_cursor>`

Keep the existing title and summary. Save the fixed window's `next_cursor` even when no day
required a semantic change. A state-write failure leaves the prior checkpoint for replay.

Report:

- the number of affected days reconciled and whether the change ledger is caught up;
- a concise account of continuity found, activities deliberately kept separate, and
  unresolved delta or activity-date errors; and
- `Created`, `Updated` and `Archived` lists naming every diary page mutated by stable document
  id, title and a short description.

Exclude the operational state document. Write `None` for an empty list. Never claim the
window completed if a required delta, diary mutation or state update failed.
