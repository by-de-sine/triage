# GitLab

Your pending todos, the merge requests and issues that are yours, and
optionally the open issues of projects you name. Off until a token
resolves.

## What it reads

- **The inbox:** `GET /todos?state=pending` — a mention, a review or
  approval request, an assignment, a failed pipeline. Each todo names its
  target and why.
- **What todos never say:** the merge requests you authored, review or are
  assigned to, and the issues assigned to or filed by you, updated since
  the last poll. (GitLab raises no todo for an ordinary comment on your own
  merge request.)
- **Open issues as state** (optional): the open issues of
  `TRIAGE_GITLAB_ISSUES`, read whole and reconciled exactly as
  [GitHub's](github.md#what-it-reads) are.

For each thread that moved, the discussions are read and turned into the
same events GitHub emits: a note is a `comment` (a `review_comment` when it
is on the diff, carrying the note it answers), and the system notes for an
approval, a review request, a merge or a close become `review`,
`review_request` and `state`. Events are keyed `gitlab:note:<id>` and
`gitlab:todo:<id>`.

Keys are `group/project!n` for a merge request and `group/project#n` for
an issue.

## Rules

The same thread rules as GitHub — see the
[table on the GitHub page](github.md#rules). On GitLab,
`reply_to_my_review_comment` is a reply in a discussion you opened on the
diff, and `new_pull_request` is a merge request.

## Done

Marks the todo that brought the item done
(`POST /todos/:id/mark_as_done`). A thread that arrived without a todo
says `no todo on the item`. If GitLab refuses, the item is still done
locally and the reason is on the action row.

## Configuration

| Variable | Default | |
|---|---|---|
| `TRIAGE_GITLAB` | unset | `on` · `off` · `fake`, as `TRIAGE_GITHUB`; `fake` is `test/fake-gitlab.js` |
| `GITLAB_TOKEN` | what `glab auth token` holds | a personal access token with `read_api`, plus `api` if Done should mark the todo done. No `glab` on the box reads as no token |
| `GITLAB_USER` | `GET /user` | who you are on GitLab. Items are filed under the GitHub login when GitHub is on, else this |
| `TRIAGE_GITLAB_URL` | `https://gitlab.com` | the instance; the API is `/api/v4` under it |
| `TRIAGE_GITLAB_ISSUES` | — | projects whose open issues are read as state, `group/project` comma-separated (paths may nest; a URL is accepted) |

Switching which forge comes first on an existing store changes the `user`
new items are filed under and leaves old rows under the old name.

```bash
node bin/replay.js group/project!12
```
