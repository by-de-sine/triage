# One notification per GitHub review request

## Cause and acceptance

The GitHub source synthesizes a new review_request from each notification
updated_at while a review is pending. The event key changes on ordinary PR
updates, so the pipeline treats the same request as new and sends again.

Use actual GitHub review_requested event IDs. One request must produce one
message across updates, coalescing windows, and restarts. An explicit later
request must produce another message. Existing requests must not replay on
upgrade. Production and its credentials remain untouched until the owner merges.

## Implementation plan

- In sources/github.js, read fully paginated issue events for pull requests
  where the current user is a pending reviewer. Normalize review_requested
  events for that user using their IDs, created_at, and actual requester.
  Do not infer events from the notification reason or its timestamp.
- Keep the change inside the source contract. Store a review_requests_since
  boundary on each thread cursor. New threads use null. Legacy threads use
  their previous updated_at, so requests previously observed are not replayed.
  Preserve that boundary across later polls, including unchanged threads.
  Read all request events newer than this fixed boundary on every changed
  thread; the existing persistent event uniqueness handles deduplication.
- A failed or incomplete event read must leave the thread cursor unchanged
  for retry. Never fall back to synthesized review requests.
- Extend fake GitHub fixtures and demo with actual request events. Add tests
  for updates, restart, a later request, migration, unrelated reviewers,
  requester attribution, timestamps, pagination, and failed reads.
- Update source and interrupt documentation with the identity and rollout
  behavior. Run the full suite in UTC and America/Vancouver, and run an
  isolated fake-source instance with Slack disabled.
- Commit and validate locally, push once, open a ready PR, request Sinetheta,
  address CodeRabbit findings per round, and leave a final review summary.

## Risks and review questions

The event endpoint adds reads for changed PRs where review is pending.
Pagination must be complete before advancing the cursor. A legacy timestamp
boundary should suppress old requests without swallowing requests created
after the last successful old-source read. The existing age guard applies
to actual request timestamps. Existing held synthetic notifications could
still flush once after deployment; review whether this needs automatic
cleanup without adding source-specific behavior to shared delivery code.

## Evidence and review

A throwaway harness against the original source changed only notification
updated_at and observed a second review_request. Its assertion failed with
1 !== 0. Live history also contained repeated review_requested deliveries
for by-de-sine/agent-skills#12.

Plan review and final validation are recorded below before PR handoff.

Independent plan review approved the source-only approach. Required changes:
preserve a null boundary with Object.hasOwn; preserve inbox Last-Modified on
failed/incomplete reads; assert real webhook counts across a persisted-store
restart. An already queued legacy synthetic notification may still flush
once. Legacy records cannot reliably distinguish a duplicate from a genuine
re-request, so deleting those rows could discard a legitimate request. The
fix will not regenerate old requests. Verify request age and requester
attribution through delivery as well as in source output.

## Validation

- Regression before implementation: the webhook test failed with
  `no duplicate after 11 minutes`, observing two posts instead of one.
- After implementation: all 24 GitHub-source tests pass, including the
  persistent-store restart and cursor-loss delivery regression, a later
  request, fixed legacy baseline, full pagination, incomplete-read retry,
  real request timestamp, and actual requester attribution.
- `TZ=UTC npm test` and `TZ=America/Vancouver npm test`: each has 317
  passing tests, zero failures, and one optional Slack SDK test skipped
  because dependencies are not installed in this worktree. CI exercises
  the SDK separately in its install job.
- Isolated instance: fake GitHub only, separate review.db, Slack off,
  listening on 127.0.0.1:3314. Health is ok with no failing sources.
- `git diff --check` passes. No production configuration or data changed.

## Implementation review

Independent review approved deduplication, migration, persistent delivery
counts, pagination, and retry handling. No blocking findings remain.

The reviewer reproduced an adjacent existing pipeline limitation: when an
old request and a recent ordinary human comment first arrive in the same
batch, delivery can use the comment's timestamp for the age guard. This
change preserves shared trigger selection. Correcting evidence selection
would widen the rule/pipeline contract and is outside once-per-request
deduplication. The source retains actual request timestamps; the documented
age behavior is qualified by which event triggers delivery.

## CodeRabbit round one

Review 6015269540 identified two valid edge cases. Each is fixed in its
own commit, then validated and pushed together:

- Incomplete inbox reads must not evict expired thread boundaries. A
  regression after a stop longer than thirty days reproduced the loss.
- A capped request-event read must not block comments or reviews forever.
  The source will persist a next-page URL and resume after twenty pages.
  It can append request events already read because the store deduplicates
  their IDs. While pages remain, it keeps the old thread timestamp and
  inbox Last-Modified. Comments and reviews still flow on every poll.
  On completion it clears continuation state and commits the timestamp.

An independent plan review approved this source-owned continuation design.
The former test that rejected all partial batches must change to assert
partial ingestion and retained checkpoints, because blocking the whole
thread on a page cap is the second reviewed defect.

Round-one fixes passed independent implementation review. The source suite
now has 26 passing tests. Full UTC and Vancouver suites each have 319
passing tests, zero failures, and the same one optional SDK skip. The
new long-history regression proved that direct mentions are delivered
while scanning, a disk restart preserves continuation state, repeated
continuation failures preserve progress, and the eventual request sends
once despite later updates. Diff whitespace checks pass.
