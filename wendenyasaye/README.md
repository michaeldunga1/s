# Wende Nyasaye

A Dholuo hymnal. New databases start empty; admins enter hymn titles, full lyrics, optional song and page numbers, composers and authors using the admin interface. Hymns can share an author; composer credits are stored separately and may contain multiple names. Existing entries without lyrics can be edited without adding lyrics. Numbers should only be entered when known: the reference site's listing order is not assumed to be the hymnal's numbering. Only add lyrics you have permission to reproduce.

The interface uses local SVG icons and responsive layouts, with reduced-motion support; the icon sprite is also cached for offline use.

Public draft legal notices are available at `/privacy`, `/terms`, and `/cookies`. Before deployment, have them reviewed for Kenyan requirements and the EU hosting arrangement, confirm actual provider, data flows, backup and log retention, and update the notices if the deployment changes.

The current local database contains hymn numbers 1–695 from the 1985 English Seventh-day Adventist Hymnal. Numbers 51–695 were imported as titles from the [SDA Hymnal index](https://sdahymns.net/); their composer, lyrics and page number are not supplied. This import is not automatically seeded into new databases.

Hymn pages use unique title-based slugs that stay unchanged when a title is edited. Existing numeric hymn links redirect to their slug URLs; the API still exposes numeric IDs and also includes slugs.

## Run locally

Requires Node.js 22 or newer, npm, and an initialized PostgreSQL database.
Set `DATABASE_URL` to the PostgreSQL connection URL and keep `SESSION_SECRET`
stable across restarts. Supply credentials securely, for example via `.pgpass`.

```sh
npm install
npm start
```

Open http://localhost:3001. Set `PORT` to use another port. Application data
and sessions are stored in PostgreSQL; startup fails if `DATABASE_URL` is unset.

## Admin

Create an admin account using a password supplied through standard input. For example, in Bash:

```sh
read -r -s -p 'Admin password: ' ADMIN_PASSWORD; echo
printf '%s' "$ADMIN_PASSWORD" | npm run create-admin -- admin@example.com
unset ADMIN_PASSWORD
```

Sign in with the email address and select **Admin**. Other users can register with email and save favorites but cannot manage hymns. Existing link-only hymns retain their reference until an admin adds lyrics. Accounts created before email sign-in must have a unique email assigned by the database administrator before they can sign in; their passwords and favorites remain unchanged.

Admins can create, rename and delete categories under **Admin → Manage categories**, and choose multiple categories when adding or editing a hymn. Deleting a category removes its assignments, not its hymns. Everyone can browse by category on the hymn directory or follow categories from hymn pages. Categories are included in the public hymn API and in the cached offline directory.

The **Composers** and **Categories** navigation links open public directories, including categories without hymns. Search either directory by a case-insensitive portion of a name. Composer credits are separated on semicolons; each name links to hymns with that exact credit, ignoring case. Lyric authors link to their own hymn lists. Offline, select a displayed category or credit to filter cached hymns; clear the credit filter to return to the full selection.

The hymn search matches titles, hymn and page numbers, lyrics, authors, composers and category names. It works with category and favorites filters, and the same fields can be searched in the cached offline directory. Online, submit a search to search the full current category; live filtering narrows the currently displayed results.

The initial categories are Praise, Worship, Prayer, Thanksgiving, Christmas, Easter, Faith, Hope, Service and Sabbath. On first migration only, existing hymn titles are matched to conservative category keywords (defined in `categories.js`); ambiguous titles are left uncategorized. These automatic assignments are suggestions, not authoritative classifications, and admins can review or change them. Later edits and new hymns are not automatically categorized, and restarting will not restore removed assignments or categories.

Signed-in users can view their account email and role and change their email on the **Profile** page. Regular users can also permanently delete their own account, favorites and bookmarks there. Both actions require the current password; admin accounts cannot be deleted through these pages. Deletion invalidates all sessions for that account.

On a hymn page, signed-in users can add or remove a bookmark; their bookmarks are listed on Profile and are separate from favorites. Once saved, a bookmark can be edited to add a private note (up to 5,000 characters) and comma-separated tags (up to 500 characters). Edit them from the hymn page or Profile. Bookmarks and their notes and tags require an internet connection and are removed if the hymn or user is deleted. Anyone can share a hymn's page link; supported browsers can use their share menu or copy the link. Admins can edit or delete hymns from their detail pages.

The admin-only **Users** page lists and searches all accounts. Admins can delete regular users after confirmation; this removes their saved favorites and bookmarks and invalidates their sessions. Administrator accounts cannot be deleted there. Cached offline favorites on a deleted user's device remain until they navigate online and the session is invalidated, or browser storage is cleared.

## Offline use

Visit the directory online first and allow the service worker to install. The latest cached hymns, lyrics, authors, categories and the last signed-in user's favorites can then be viewed and searched offline on that device. Favorites are saved to the browser on an online visit; signing out clears them on that device. Signing in and changes to favorites or hymns require an internet connection. Browser storage may be cleared or unavailable, and offline support requires localhost or HTTPS. Avoid using offline favorites on shared devices.

## Deployment

Set a strong `SESSION_SECRET` and `NODE_ENV=production` behind HTTPS. Behind a local reverse proxy, set `HOST=127.0.0.1` and `TRUST_PROXY=loopback`, and configure the proxy to overwrite forwarded headers. Back up the database regularly and test restores. This project does not bundle or license hymn lyrics.

### PostgreSQL migration

The application requires PostgreSQL for application data and sessions;
`SESSION_SECRET` must remain stable across
restarts to preserve sessions. The PostgreSQL database must first be initialized
with the export below; the session table is created on first use. PostgreSQL
support has targeted integration tests. Verify migration, backups, HTTPS, and
production configuration before deployment.
`scripts/export-postgres.js` generates a transactional import
from the current SQLite schema, including accounts and private bookmarks. It
checks source integrity, rejects unknown tables or columns and refuses a
destination whose public schema already contains tables or other relations.
It preserves IDs and resets identity sequences. Because the export contains
private data, never save it to a public location or send it to an untrusted
server. Use a consistent backup and stop writes before a final import.

To validate against an **empty** PostgreSQL database without retaining the
import, set `DB_PATH` to the SQLite source if it is not the default and run:

```sh
set -o pipefail
node scripts/export-postgres.js --dry-run | psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL"
```

The dry run ends with `ROLLBACK`. Connection credentials should be supplied
securely, such as via `.pgpass`, rather than in the command line.

The application and admin command never use SQLite. The legacy migration
exporter and its migration tests still need the SQLite dependency to read old
backups; they are not part of application runtime.

## Tests

The route tests require `POSTGRES_TEST_URL` and create and remove an isolated
schema in that database. Set `POSTGRES_TEST=1` to also run the PostgreSQL
repository and integration tests. The `PGHOST`, `PGPORT`, `PGUSER`, and
`PGDATABASE` variables must point to the same dedicated test database as the
URL, and the account must be allowed to create schemas. The repository and
integration tests are skipped without `POSTGRES_TEST=1`. For example:

```sh
export POSTGRES_TEST_URL='postgresql://localhost/wende_test'
export PGHOST=localhost PGUSER=your_test_user PGDATABASE=wende_test
export POSTGRES_TEST=1
npm test
```
