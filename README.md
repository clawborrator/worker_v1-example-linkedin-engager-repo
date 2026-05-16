# worker_v1-example-linkedin-engager-repo

Playbook and Playwright wrapper for the autonomous LinkedIn
engager.

Cloned by the sibling deployment repo
([worker_v1-example-linkedin-engager-worker](https://github.com/clawborrator/worker_v1-example-linkedin-engager-worker))
on container boot. You do not run anything here directly. This
repo IS the agent's instructions and tools.

## What's here

```
CLAUDE.md                   the agent's playbook (cron-driven,
                            one cycle per turn, more conservative
                            than the Reddit engager: 8h cadence,
                            one comment per cycle max, higher
                            "interesting" bar, no emoji, no buzz
                            vocabulary, no em / en dashes)
specialists/linkedin.js     Playwright wrapper: auth-check,
                            scroll-feed, read-post, comment-post,
                            reply-comment
package.json                declares playwright as a local dep
                            for defense-in-depth on older
                            worker_v1-playwright tags
data/posted/                audit log; one JSON file per cycle,
                            committed by the agent on every run
```

## What the agent does each cycle

Every 8 hours, the engager:

1. Verifies its LinkedIn cookies still log it in
2. Scrolls the home feed, fetches ~15 posts
3. Picks ONE post worth engaging with (high bar, or skips the
   cycle if nothing meets it)
4. Reads the post and its top ~60 comments
5. Picks ONE target: either a top-level comment under the post,
   or a reply to one specific comment in the thread (or skips
   the comment phase if neither earns its place)
6. Drafts and posts the comment via Playwright
7. Commits an audit JSON to `data/posted/<timestamp>.json`
8. Notifies `@clauderemote` (or the operator-configured peer)
   with a past-tense one-sentence summary
9. Returns. Cron fires the next cycle in 8 hours.

## DOM target

LinkedIn does not have a legacy stable-DOM URL like
old.reddit.com. The engager runs against the modern React-SPA
www.linkedin.com. Selectors are centralized in
`specialists/linkedin.js` under the `SELECTORS` object, leaning
on stable signals where possible:

- URN attributes (`data-id="urn:li:activity:..."`) are stable
- `aria-label` attributes are stable (accessibility-driven)
- `role` attributes are stable (semantic)
- `data-test-id` attributes are stable when present
- CSS classes are hashed and break monthly. Avoid.

## Updating selectors when LinkedIn changes the DOM

The engager's failure path includes `comment_form_not_found` as
a typed error. When a cycle reports this in `@clauderemote`,
that is the signal to:

1. Open www.linkedin.com in a browser
2. Use devtools to find the new selector
3. Patch `SELECTORS` in `specialists/linkedin.js`
4. `git push`

The container picks up the new wrapper on its next cycle without
needing a rebuild. The repo is re-cloned fresh into
`/workspace/repo` on each `docker compose up`.

## Audit log

Every cycle commits a record:

```json
{
  "ts": "2026-05-16T08:00:00Z",
  "post": {
    "urn": "urn:li:activity:7263...",
    "post_url": "https://www.linkedin.com/feed/update/...",
    "author": "Some Person",
    "topic_summary": "..."
  },
  "comment_posted": {
    "target": "post",
    "target_author": "Some Person",
    "target_url": "https://www.linkedin.com/feed/update/...",
    "comment_url": null,
    "comment_text": "..."
  },
  "skip_reason": null
}
```

Skipped cycles record `{ts, skip_reason}` so the timeline is
gap-free.

`comment_url` is null for LinkedIn (the platform does not
surface a stable permalink in the DOM after a post submit). The
audit's `target_url` is the trail back to the conversation.

## Risk envelope

See the deployment repo's README for the full risk discussion.
Short version: LinkedIn anti-bot is meaningfully more aggressive
than Reddit's, cookies expire faster, and the engager posts
under the operator's real professional identity. Use a secondary
account, not your primary.

## See also

- `../worker_v1-example-linkedin-engager-worker/` for the
  docker-compose deployment and the operator-facing setup README
  (capturing cookies, minting a clawborrator token, GitHub PAT,
  etc.)
- `../worker_v1-example-reddit-engager-repo/` for the sibling
  pattern on Reddit. The two CLAUDE.md files read in parallel
  highlight the surface-specific deltas (cadence, bar, voice,
  reply count cap).
- `../worker_v1-playwright/` for the image
