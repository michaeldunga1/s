# Luo to English Dictionary

A collaborative Luo-to-English translation dictionary with user authentication, role-based permissions, and community-driven features including comments and voting.

Public draft legal notices are available at `/privacy`, `/terms`, and `/cookies`. Before deployment, have them reviewed for Kenyan requirements and the EU hosting arrangement, confirm actual provider, data flows, backup and log retention, and update the notices if the deployment changes.

## Features

### Core
- **Public Dictionary**: Browse Luo words and their English definitions
- **Search**: Search words and definitions from the dictionary page, including without JavaScript.
- **User Authentication**: Register with username, email, and password (hashed with bcrypt)
- **Role-Based Access Control**:
  - **Admin**: Create, edit, and delete words and their definitions; delete any comment; view the read-only database schema from the admin dashboard
  - **User**: Comment on words, vote on other users' comments
  - **Visitor** (logged out): Read-only access
- **User management**: Admins can search all accounts and delete regular users after confirmation. Deletion removes their comments and votes, including votes on their deleted comments; admin accounts are protected.

### Comments & Voting
- **Comments**: Each registered user can post **one new comment per word**
  - Users can edit and delete their own comments
  - Comments limited to 500 characters
  - After deletion, user can post a new comment
- **Voting**: Upvote (👍) or downvote (👎) on comments
  - Users cannot vote on their own comments
  - One vote per user per comment
  - Toggle vote by clicking the same button again; switch by clicking the opposite vote
  - Comments sorted by score (descending), then by date (descending)

### Design
- African-inspired color scheme: warm earth browns, sand tones, and red-ochre accents
- Responsive EJS templates
- Local SVG icons and mobile-friendly layouts
- No external frontend framework (vanilla JavaScript)

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: PostgreSQL
- **Authentication**: bcryptjs for password hashing, express-session with PostgreSQL-backed sessions
- **Templating**: EJS
- **Environment**: dotenv

## Setup

### Prerequisites
- Node.js (v22+)
- npm
- PostgreSQL with an initialized application database

For HTTPS behind a local reverse proxy, set `NODE_ENV=production`, a strong
`SESSION_SECRET`, `HOST=127.0.0.1`, and `TRUST_PROXY=loopback`. Configure the
proxy to overwrite forwarded headers and use HTTPS. Set `DATABASE_URL` and keep
`SESSION_SECRET` stable across restarts. Sessions are stored in PostgreSQL.
An Nginx template for `www.swiftener.com` is in `deploy/nginx-luo2english.conf`.
It redirects HTTP to HTTPS and expects the Let's Encrypt certificate at
`/etc/letsencrypt/live/www.swiftener.com/`.

### Installation

1. **Clone the repository** (or start from scratch)
   ```bash
   cd /home/dunga/s/luo2english
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` to set `DATABASE_URL` and a secure `SESSION_SECRET`. Use a
   protected `.pgpass` file for passwords instead of embedding them in URLs.

4. **Initialize the database**
   The database must be initialized before startup. For an existing installation,
   follow the migration instructions in `../postgres-migration/README.md`.
   Legacy duplicate comments are preserved, but additional comments for the same
   user and word are blocked until the existing comments are removed. The session
   table is created on first use.

5. **Create the first admin user**
   ```bash
   read -r -s -p 'Admin password: ' ADMIN_PASSWORD; echo
   printf '%s' "$ADMIN_PASSWORD" | npm run create-admin -- admin admin@example.com
   unset ADMIN_PASSWORD
   ```

6. **Start the server**
   ```bash
   npm start
   ```
   The app will listen on `http://localhost:3000`

## Database Schema

### users
| Column       | Type    | Constraint |
|--------------|---------|------------|
| id           | INTEGER | PK, AI     |
| username     | TEXT    | UNIQUE, NOT NULL |
| email        | TEXT    | UNIQUE, NOT NULL |
| password_hash| TEXT    | NOT NULL   |
| role         | TEXT    | 'admin' \| 'user', DEFAULT 'user' |
| created_at   | DATETIME| DEFAULT CURRENT_TIMESTAMP |

### words
| Column     | Type    | Constraint |
|------------|---------|------------|
| id         | INTEGER | PK, AI     |
| word       | TEXT    | UNIQUE, NOT NULL |
| definition | TEXT    | NOT NULL, DEFAULT '' |
| created_at | DATETIME| DEFAULT CURRENT_TIMESTAMP |
| updated_at | DATETIME| DEFAULT CURRENT_TIMESTAMP |

### comments
| Column        | Type    | Constraint |
|---------------|---------|------------|
| id            | INTEGER | PK, AI     |
| word_id       | INTEGER | FK (words.id), ON DELETE CASCADE |
| user_id       | INTEGER | FK (users.id), ON DELETE CASCADE |
| body          | TEXT    | NOT NULL (max 500 chars enforced) |
| created_at    | DATETIME| DEFAULT CURRENT_TIMESTAMP |
| updated_at    | DATETIME| DEFAULT CURRENT_TIMESTAMP |
| -             | -       | New comments limited to one per user and word |

### votes
| Column     | Type    | Constraint |
|------------|---------|------------|
| id         | INTEGER | PK, AI     |
| comment_id | INTEGER | FK (comments.id), ON DELETE CASCADE |
| user_id    | INTEGER | FK (users.id), ON DELETE CASCADE |
| value      | INTEGER | 1 \| -1    |
| created_at | DATETIME| DEFAULT CURRENT_TIMESTAMP |
| -          | -       | UNIQUE(user_id, comment_id) |

All foreign keys have corresponding indexes for performance.

## API Routes

### Public
- `GET /` - Home page with word list
- `GET /word/:id` - View word with its definition and comments

### Authentication
- `GET /auth/register` - Registration form
- `POST /auth/register` - Create account
- `GET /auth/login` - Login form
- `POST /auth/login` - Authenticate user
- `GET /auth/logout` - Logout

### Admin
- `GET /admin` - Admin dashboard
- `GET /admin/words` - Manage words
- `GET /admin/words/new` - Add word form
- `POST /admin/words` - Create word
- `GET /admin/words/:id/edit` - Edit word form
- `POST /admin/words/:id` - Update word
- `POST /admin/words/:id/delete` - Delete word
- `GET /admin/words/:word_id/definitions` - Redirect to the word edit form

### Comments & Voting (JSON)
- `POST /comments/:word_id` - Post comment (requires user role)
- `PUT /comments/:id` - Edit comment (own only or admin)
- `DELETE /comments/:id` - Delete comment (own only or admin)
- `POST /comments/:id/vote` - Vote on comment (value: 1 or -1; users only, not on own comments)

## Security

- **Passwords**: Hashed with bcrypt (10 rounds)
- **Sessions**: 7-day expiration, httpOnly cookies, sameSite='strict'
- **XSS**: All user content escaped in EJS templates
- **SQL Injection**: Parameterized queries throughout
- **CSRF**: Express-session SameSite protection
- **Session Regeneration**: On login

## Usage Examples

### Register a new user
1. Navigate to `http://localhost:3000/auth/register`
2. Fill in username (3+ chars), email, and password (8+ chars)
3. Submit

### Login
1. Navigate to `http://localhost:3000/auth/login`
2. Enter username and password
3. Submit

### View dictionary
1. Home page shows all words
2. Click a word to view its definition and comments

### Post a comment (as logged-in user)
1. Go to a word detail page
2. Scroll to a definition
3. Fill in the comment box and click "Post Comment"
4. Only one new comment per user per word is allowed

### Vote on a comment (as logged-in non-admin user)
1. On a word detail page, find a comment
2. Click 👍 to upvote or 👎 to downvote
3. Click the same button again to remove your vote
4. Click the opposite button to switch your vote

### Create an admin user
```bash
read -r -s -p 'Admin password: ' ADMIN_PASSWORD; echo
printf '%s' "$ADMIN_PASSWORD" | npm run create-admin -- myusername myemail@example.com
unset ADMIN_PASSWORD
```

### Manage words (admin only)
1. Login as admin
2. Click "Admin" in the navbar
3. Click "Manage Words"
4. Add or edit a word and its single definition in the same form, or delete it

## Testing

### Automated Test Suite

Run the PostgreSQL integration test against a dedicated database whose user may
create schemas. It creates and removes an isolated schema:

```bash
POSTGRES_TEST_URL='postgresql://localhost/luo_test' npm run test:postgres
```

The older SQLite-based test files exercise the former runtime and have not yet
been converted; they are not valid tests of the PostgreSQL application.

### Manual Testing Checklist

- [ ] Non-admin user blocked from creating words (403 Forbidden)
- [ ] Non-admin user blocked from editing words (403 Forbidden)
- [ ] Non-admin user blocked from deleting words (403 Forbidden)
- [ ] User cannot post a second comment on the same word (409 Conflict)
- [ ] User cannot vote on their own comment (403 Forbidden)
- [ ] Clicking the same vote button removes the vote (toggle)
- [ ] Clicking the opposite vote button switches the vote
- [ ] Logged-out visitor can view words, definitions, and comments
- [ ] Logged-out visitor cannot post comments (redirects to login)
- [ ] Logged-out visitor cannot vote (redirects to login)
- [ ] Admin can delete any comment
- [ ] Comment vote counts update after voting
- [ ] Password is stored as a hash, never as plaintext
- [ ] Session regenerates on login
- [ ] XSS payload in comment escaped (e.g., `<script>alert('xss')</script>`)

## Project Structure

```
luo2english/
├── app.js                  # Express app setup
├── db/
│   ├── postgres.js         # PostgreSQL connection pool
│   └── init.js             # Legacy SQLite migration support only
├── middleware/
│   └── auth.js             # Authentication middleware
├── routes/
│   ├── public.js           # Public routes (home, word detail)
│   ├── auth.js             # Auth routes (register, login, logout)
│   ├── admin.js            # Admin routes (words and definitions)
│   └── comments.js         # Comments & voting API
├── views/
│   ├── index.ejs           # Home page
│   ├── word-detail.ejs     # Word with definition & comments
│   ├── login.ejs           # Login form
│   ├── register.ejs        # Registration form
│   ├── error.ejs           # Error page
│   ├── admin-dashboard.ejs
│   ├── admin-words.ejs
│   └── admin-word-form.ejs
├── public/
│   ├── css/
│   │   └── style.css       # African-inspired color scheme
│   └── js/
│       └── app.js          # Client-side comment & vote handlers
├── scripts/
│   └── create-admin.js     # Admin creation script
├── package.json
├── .env.example
└── db/luo.db               # Legacy data, retained as an offline backup
```

## Notes

- Admins **cannot** post comments or vote (by design)
- Comments are sorted by score (highest first), then by creation date (newest first)
- Session expires after 7 days of inactivity
- Application data and sessions use PostgreSQL; the legacy file is not opened by the app
- All views use server-side rendering with EJS; JavaScript is vanilla and only for dynamic comment/vote actions

## Future Enhancements

- Rate limiting on auth routes (login/register)
- CSRF token middleware
- Search functionality
- Export/import definitions
- User moderation dashboard
- Comment editing history

## License

MIT
