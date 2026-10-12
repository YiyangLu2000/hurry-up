See [AGENTS.md](./AGENTS.md).

## Product roadmap

We are in phase 2. Design each phase's data so later phases don't require
restructuring it, but do not build anything from later phases until asked.

1. **Map (done):** public restrooms and chain fast food, US only.
2. **Ratings (current):** signed-in users rate a restroom 1 to 5 whole
   stars, one rating per user per restroom, editable. Writes go through a
   server action; individual ratings are readable only by their author.
   - Until real ratings exist, every restroom has a **sample score**
     between 3.0 and 4.2, derived deterministically from its record id and
     stored on the server. The UI labels it "sample rating".
   - When a restroom has real ratings, the real average replaces the sample.
   - The server keeps count and average per restroom in a server-only
     collection, updated in the same action as the rating.
   - **Visibility** is a stored field on each restroom, computed only by
     the server whenever status or score changes (score rounded to 0.1):
     `'public'` (active, score 4.0 or below), `'premium'` (active, score
     above 4.0), `'hidden'` (unavailable or pending). The collection's read
     rule lets non-admins read only `'public'` rows, so a `'premium'` row is
     never sent to a non-member's browser. Scores never go on the restroom
     row; they are served by a route that only answers for restrooms the
     caller can see.
   - **Premium restrooms:** a server route returns the `'premium'` restrooms
     for requested cells, guarded by `hasMembership(user)`. Until phase 4,
     `hasMembership` is true only for admins (the app owner). "Membership"
     means a paying user and is unrelated to the DeepSpace `member` role.
   - Open maps re-subscribe their visible cells periodically and on tab
     refocus, because in SDK 0.39.3 the server only broadcasts an update to
     sockets that can read the record's *new* value: a visitor who loses
     access (public → premium, or active → unavailable) is sent nothing
     and would keep the stale marker until reload. Reported to DeepSpace as
     a docs/SDK mismatch (docs: concepts/realtime-sync, "Permissions on the
     wire").
3. **Reports:** signed-in users can submit a new restroom, or report an
   existing one as under maintenance or staff only. One report per user
   per restroom per type. When three different users agree, the server
   changes the restroom's status: a pending submission becomes active, or
   an existing restroom becomes unavailable. Restrooms are never deleted.
   Counting happens on the server, and every status change recomputes
   visibility.
   - Status changes reach open maps through the phase 2 re-subscribe; no
     extra work is needed for that.
   - A submitter sees their own pending submission through the owner half
     of the `'published'` read rule. Store the submitter in a
     `submittedBy` column declared as the collection's `ownerField`, and
     clear it when the submission becomes active; otherwise a non-member
     submitter would keep reading their restroom as its owner after it
     becomes `'premium'`.
4. **Membership:** a paid subscription through DeepSpace payments. Only
   members see top-rated (`'premium'`) restrooms; non-members do not see
   them at all (not on the map, not in search, routes or auto-select), and
   get a note that top-rated restrooms are for members. The gate must be
   enforced by server-side permissions, not hidden in the UI.
   - Change `hasMembership` to check the subscription live with
     `requireSubscription` on the server (a stored role would go stale on
     cancellation). That is why premium restrooms come from a server route
     rather than a collection read rule.
   - Scores are exact for every restroom the caller can see.
