# hurry-up

Find the nearest restroom, fast. A full-screen map of public restrooms, chain
fast food and chain cafés across the US, with walking and driving routes and
1 to 5 star ratings.

Live at **https://hurry-up.app.space**. Built on the
[DeepSpace](https://docs.deep.space) SDK and deployed to Cloudflare Workers.

## Features

- **Map**: restrooms from OpenStreetMap, loaded per 0.02° grid cell as you
  pan. Areas without data are fetched from Overpass on first visit, and
  five metro areas (LA, SF Bay Area, NYC, Chicago, Seattle) are bulk-imported.
- **Your location**: GPS, or a point you set on the map or search for
  (Nominatim). The closest restroom by walking time is selected
  automatically, searching up to 5 km ("Nothing within 5 km" otherwise).
- **Routes**: walking and driving routes (FOSSGIS OSRM), plus Apple Maps and
  Google Maps directions.
- **Filters**: by type (public, restaurant, café) and gender.
- **Ratings**: signed-in users rate a restroom 1 to 5 whole stars, one rating
  each, editable. Until a restroom has ratings it shows a deterministic
  *sample rating* between 3.0 and 4.2.
- **Top-rated restrooms are for members**: restrooms scoring above 4.0 are
  never sent to non-members' browsers. Until paid membership ships (phase 4),
  only admins count as members.

The product roadmap and its decisions live in [CLAUDE.md](./CLAUDE.md).

## How it works

All app data lives in one DeepSpace record room (a Durable Object with
SQLite). Every restroom write happens on the server; clients only read.

| Collection | Who can read | Contents |
|---|---|---|
| `restrooms` | non-admins: rows with `visibility = 'public'`; admins: all | name, position, kind, gender, wheelchair access, status, `cellKey`, `visibility` |
| `restroom_scores` | nobody (server only) | sample score, rating count and sum, effective score |
| `restroom_ratings` | each user, their own rows | one row per user per restroom |
| `restroom_areas` | nobody (server only) | which grid cells were fetched or imported |

**Visibility** is computed by the server whenever a restroom's status or score
changes (`src/server/restroom-scores.ts`):
- `public`: active, score 4.0 or below.
- `premium`: active, score above 4.0.
- `hidden`: unavailable or pending.

Scores never go on the restroom row.

Server endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /api/actions/rateRestroom` | the only way to rate; validates stars and that the caller can see the restroom |
| `POST /api/restrooms/scores` | scores, only for restrooms the caller can see |
| `POST /api/restrooms/premium` | premium restrooms for the requested cells; members only (401/403 otherwise) |
| `POST /api/restrooms/seed`, `/seed-around` | fill grid cells from Overpass (live seeding) |

Open maps re-subscribe their cells every 2 minutes and on tab refocus. In SDK
0.39.3 the server sends nothing to a socket that loses read access to a row,
so this is how a restroom that became premium or unavailable leaves maps that
are already open.

### Code map

```
worker.ts                      Worker routes and Durable Object wiring
src/schemas/                   collections and their read/write rules
src/actions/rate-restroom.ts   rating action
src/server/restroom-scores.ts  scores, visibility, recompute loop, backfill
src/server/score-routes.ts     scores and premium routes
src/server/membership.ts       hasMembership / who can see what
src/server/restroom-*.ts       live seeding, bulk writes, admin CLI tools
src/lib/                       geo grid, OSM mapping, routing, geocoding, scores
src/pages/(app)/home.tsx       the map page
src/components/                cell loading, rating panel, location control
scripts/                       OSM import and score backfill (run locally)
```

## Development

Requires Node 22.15+, 24 or 26 and npm 11.6+.

```sh
npm install
npx deepspace auth login        # once
npx deepspace dev start         # http://localhost:5173
```

Checks:

```sh
npm run validate                # type-check + unit tests (vitest)
npx deepspace test run all      # Playwright suites against a local server
```

- The two-user collab tests need two test accounts
  (`npx deepspace test accounts list --usable`).
- `tests/ratings.spec.ts` needs one test account, and leaves one restroom in
  its test cell rated as premium on each run.

## Data and admin tools

Admin-only tools are exposed to the DeepSpace CLI (your login must be the
app's admin):

```sh
npx deepspace agent tools hurry-up --json
```

| Tool | Purpose |
|---|---|
| `restrooms_import` | import Overpass elements as restrooms (creates only new ids) |
| `restrooms_mark_covered` | mark grid cells as covered by the import |
| `restrooms_set_status` | set a restroom active, unavailable or pending (recomputes visibility) |
| `restrooms_list_cells` | list cells that hold restrooms (paged) |
| `restrooms_backfill_scores` | set sample scores and visibility per cell (bounded work per call) |
| `restrooms_backfill_cellkey` | one-time: set `cellKey` on old rows |

Scripts that drive them:

```sh
# Bulk import from OpenStreetMap (count, fetch to data/osm/, then upload)
node scripts/import-osm.mjs count
node scripts/import-osm.mjs fetch  [--metros la,sf] [--layer cafe]
node scripts/import-osm.mjs upload --app hurry-up [--metros la,sf] [--layer cafe]

# Sample scores + visibility for every restroom (safe to re-run)
node scripts/backfill-scores.mjs --app hurry-up
```

- Use `--app http://localhost:5173` to run either script against local dev.
- Each backfill call stays within a budget of record calls because Cloudflare
  limits subrequests per Worker invocation, and local dev does not enforce
  that limit.
- A full backfill of about 19k restrooms takes about 12 minutes in
  production. A re-run that finds everything already set takes about
  2 minutes.

## Deploying

```sh
npx deepspace deploy
```

- The app's source of truth is GitHub (`yiyanglu2000/hurry-up`), and
  `deploy` ships the current checkout as it is.
- Pushing or merging does not deploy.
- `npx deepspace releases` lists releases.
- `npx deepspace rollback <release-id>` rolls one back.
- `npx deepspace logs --since 15m` shows worker logs.

When a change adds a field that a read rule depends on, ship it in two
releases:
1. Add the field and start writing it.
2. Backfill existing rows.
3. Switch the rule.

Switching first hides every row that lacks the field.

## Data sources and attribution

- Restrooms: © OpenStreetMap contributors (ODbL), via Overpass.
- Map tiles: OpenFreeMap.
- Routing: FOSSGIS OSRM.
- Place search: Nominatim.

Each service's usage policy is noted where it is called: `src/lib/routing.ts`,
`src/lib/geocode.ts`, and `scripts/import-osm.mjs` for Overpass.
