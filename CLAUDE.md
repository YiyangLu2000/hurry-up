See [AGENTS.md](./AGENTS.md).

## Product roadmap

We are in phase 1. Design phase 1's data so phases 2 to 4 don't require
restructuring it, but do not build anything from phases 2 to 4 until asked.

1. **Map (current):** public restrooms and chain fast food, US only.
2. **Ratings:** signed-in users rate a restroom 1 to 5 stars, one rating
   per user per restroom, editable. Everyone sees the average and count.
   - Until real ratings exist, every restroom gets a **sample score**
     between 3.0 and 4.5, derived deterministically from its record id on
     the server (stable, no stored rows). The UI labels it "sample rating".
   - When a restroom has real ratings, the real average replaces the sample.
3. **Reports:** signed-in users can submit a new restroom, or report an
   existing one as under maintenance or staff only. One report per user
   per restroom per type. When three different users agree, the server
   changes the restroom's status: a pending submission becomes active, or
   an existing restroom becomes unavailable. Restrooms are never deleted.
   Counting happens on the server.
   - Status changes do not reach maps that are already open: in SDK 0.39.3
     the server only broadcasts an update to sockets that can read the
     record's *new* value, so a visitor who loses access (active →
     unavailable) is sent nothing and keeps the stale marker until reload.
     Before phase 3 ships, re-subscribe the visible cells periodically
     (and on tab refocus) so status changes reach open maps. Reported to
     DeepSpace as a docs/SDK mismatch (docs: concepts/realtime-sync,
     "Permissions on the wire").
4. **Membership:** a paid subscription through DeepSpace payments. Only
   members can see which restrooms are top rated (5 stars). The gate must
   be enforced by server-side permissions, not hidden in the UI.
   - Scores of 4.0 or below (sample or real) are visible to everyone.
     Above 4.0, non-members see "4+" with a note that members see the
     exact rating; members see the exact score.
   - The exact value above 4.0 must never be sent to a non-member's
     browser. Subscription status is checked live with
     `requireSubscription` on the server (a stored role would go stale on
     cancellation), so scores are served by a server route that redacts
     them per caller rather than by a collection everyone can read.
