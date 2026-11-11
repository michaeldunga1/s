# PostgreSQL data migration preparation

The applications still require SQLite and cannot yet run against PostgreSQL.
These exporters are preparation only; do not import production data until the
application, authentication, sessions and deployment have been adapted and
tested against PostgreSQL.

The exporters read current SQLite schemas and emit a transactional PostgreSQL
schema and data import. They validate source integrity and foreign keys, reject
unknown tables or columns and nonempty destinations, preserve IDs and data,
check row counts and advance identity sequences. The Luo export preserves
historical duplicate comments and installs a trigger preventing new duplicates.
The source is opened read-only within a consistent read transaction. The target
must be a dedicated empty database with no application writes during import.
Freeze writes and take a verified backup before the eventual final import.

Generated SQL includes passwords (as hashes) and private data. Do not save it
in public or shared locations. Use encrypted transport and secure credentials,
such as a protected `.pgpass` file, not a password on a command line.

For an empty database, validate without retaining changes:

```bash
set -o pipefail
node postgres-migration/export.js luo2english --dry-run | psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL"
node postgres-migration/export.js mumamaler --dry-run | psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL"
```

Use the correct separate PostgreSQL database for each command. `DB_PATH` selects
a non-default SQLite source. Dry runs end in `ROLLBACK`. Wende has its own
exporter documented in its README.

Tests: `node --test postgres-migration/export.test.js`.
