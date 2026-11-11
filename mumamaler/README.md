# Muma Maler

A Dholuo Bible reader with an email-based admin panel. An admin creates books and enters complete chapter bodies. Only enter Bible text you have permission to reproduce; no translation is included or imported.

The interface uses local SVG icons and responsive layouts, with reduced-motion support.

Public draft legal notices are available at `/privacy`, `/terms`, and `/cookies`. Before deployment, have them reviewed for Kenyan requirements and the EU hosting arrangement, confirm actual provider, data flows, backup and log retention, and update the notices if the deployment changes.

## Run

Requires Node.js 22 or newer, npm and an initialized PostgreSQL database. Set
`DATABASE_URL` and a stable `SESSION_SECRET` before starting; use a protected
`.pgpass` file for passwords instead of embedding them in URLs. For an existing
installation, see `../postgres-migration/README.md` for migration.

```sh
npm install
npm start
```

Open http://localhost:3002. Set `PORT` to use another port. Application data
and sessions use PostgreSQL, independently of the other apps. The legacy data
file can be retained as an offline backup and is not opened by the application.

## Create an admin

The initial admin account is not created until you set its password. In Bash:

```sh
read -r -s -p 'Admin password: ' ADMIN_PASSWORD; echo
printf '%s' "$ADMIN_PASSWORD" | npm run create-admin -- michaeldunga1@gmail.com
unset ADMIN_PASSWORD
```

Use an email and password of your choice if creating a different admin. Sign in at `/login`, choose **Admin**, and add books with a unique index and an Old or New Testament assignment. Author and category are optional; entering an existing name reuses its shared database record. Add, edit and delete chapters under each book. Visitors can browse books and chapters without signing in. Deleting a book also deletes all its chapters.

Use the navigation to browse books, authors, categories, or either testament. Author and category directory pages include entries without books. Select a book's author, category or testament to browse the books sharing that attribute.

Public book, chapter, author and category URLs use slugs. Chapter slugs are based on their title, or `chapter-<number>` when no title is available; duplicate slugs receive numeric suffixes. Slugs remain stable when names or existing chapter titles change, except that a chapter's number-based placeholder slug is replaced when its first title is entered. Old numeric public URLs are not redirected. Admin management URLs continue to use internal IDs.

Readers can create an account with an email and password and bookmark whole chapters. Bookmarks appear on the **Profile** and **Bookmarks** pages; use **Edit** to add a private note (up to 5,000 characters) and comma-separated tags (up to 500 characters). They are private to the account and accessible on any device after signing in. Admins can use the same features with their existing accounts. Deleting a chapter also deletes its bookmarks. On upgrade, favourites are converted into bookmarks; an existing bookmark for the same chapter is retained.

Readers can delete their own account from **Profile**, confirming their password. The admin-only **Users** navigation page lists reader and administrator accounts and lets admins delete readers after confirmation. Deletion permanently removes the reader's bookmarks, notes and tags and invalidates their sessions; it does not delete Bible content. Administrator accounts are listed but cannot be deleted through these pages.

Search fields filter the current list as you type: books by name, index, author, category or testament; authors and categories by name (and category description); and chapters by number or title. Bookmarks can be searched by book, chapter number, title, note or tags. Admin book and chapter lists have the same filters. These list filters run in the browser. The separate **Search scripture** form searches chapter bodies across all books and links to matching chapters; it does not search private bookmarks.

The admin dashboard's **View database schema** link shows read-only PostgreSQL
tables, indexes, constraints and triggers. It does not show database records.

Categories have an optional description. The supplied Bible categories are populated in the current database; new databases start empty and do not automatically import them. Admins can continue to create categories by entering a new name on a book form.

To enter a chapter, open a book's **Chapters** page and choose **Add chapter**. Enter a title, number, and the complete chapter body (up to 120,000 characters). The body is stored as entered, including line breaks and any verse numbers; chapter numbers are unique within each book.

On upgrade, existing verse records are combined into chapter bodies in verse-number order, with their numbers retained. Existing chapter titles and book testaments cannot be inferred and are left unset; use the admin panel to fill them in. Back up `data/mumamaler.db` before upgrading.

## Deployment

Set a strong `SESSION_SECRET` and `NODE_ENV=production` when using HTTPS. Behind a local reverse proxy, set `HOST=127.0.0.1` and `TRUST_PROXY=loopback`, and configure the proxy to overwrite forwarded headers. Sessions are stored in PostgreSQL. Back up PostgreSQL regularly and test restores.

## Tests

The PostgreSQL integration test requires `POSTGRES_TEST_URL` for a dedicated
database with permission to create schemas. It creates and removes an isolated
schema:

```sh
POSTGRES_TEST_URL='postgresql://localhost/muma_test' npm run test:postgres
```

The older SQLite-based tests exercise the former runtime and have not yet been
converted; they are not valid tests of the PostgreSQL application.
