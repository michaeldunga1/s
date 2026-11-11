# Implementation Plan: Luo2English Dictionary Enhancement

## Overview
Extending the existing Luo2English Node.js/Express app with public registration, role-based permissions, per-definition comments, and comment voting.

## Files Changed/Added

### Configuration
- ✅ **package.json** (modified) - Added npm scripts for start and create-admin
- ✅ **.env.example** (new) - Environment configuration template

### Database
- ✅ **db/init.js** (new) - Database initialization with full schema including:
  - Enhanced `users` table with `role` and `created_at`
  - `comments` table with UNIQUE constraint on (user_id, definition_id)
  - `votes` table with UNIQUE constraint on (user_id, comment_id)
  - All foreign keys with ON DELETE CASCADE
  - Performance indexes on all FK columns

### Middleware
- ✅ **middleware/auth.js** (new) - Authentication and authorization:
  - `requireAuth` - Redirect to login if not authenticated
  - `requireAdmin` - Check for admin role
  - `attachUser` - Make user info available to templates

### Routes
- ✅ **routes/public.js** (new) - Public-facing routes:
  - `GET /` - Home page with word list
  - `GET /word/:id` - View word with definitions and comments with vote counts
  
- ✅ **routes/auth.js** (new) - Authentication routes:
  - `GET/POST /auth/register` - Public registration
  - `GET/POST /auth/login` - Login with session regeneration
  - `GET /auth/logout` - Logout
  - Server-side validation for username, email, password
  - Bcrypt hashing for passwords
  - Unique constraint enforcement with friendly errors

- ✅ **routes/admin.js** (new) - Admin-only CRUD:
  - Dashboard with stats
  - Word management (list, create, edit, delete)
  - Definition management (list, create, edit, delete)
  - Admin middleware enforcement on every write route

- ✅ **routes/comments.js** (new) - JSON API for comments and votes:
  - `POST /comments/:definition_id` - Create comment (1 per user per definition)
  - `PUT /comments/:id` - Edit comment (own only or admin)
  - `DELETE /comments/:id` - Delete comment (own only or admin)
  - `POST /comments/:id/vote` - Vote on comment (±1, no self-voting, toggle/switch logic)
  - All responses JSON; error messages user-friendly

### Views
- ✅ **views/index.ejs** - Home page with word grid
- ✅ **views/word-detail.ejs** - Word details with definitions, comments, and voting:
  - Comments sorted by score then date
  - Vote display with score
  - "Login to Comment" message for visitors
  - "Admins cannot comment" message for admins
  - Edit/delete buttons for own comments
  - Vote buttons for non-admin users (not on own comments)

- ✅ **views/login.ejs** - Login form with error handling
- ✅ **views/register.ejs** - Registration form with validation help text

- ✅ **views/error.ejs** - Error page

- ✅ **views/admin-dashboard.ejs** - Admin dashboard with stats
- ✅ **views/admin-words.ejs** - Word management table
- ✅ **views/admin-word-form.ejs** - Add/edit word form
- ✅ **views/admin-definitions.ejs** - Definition list for a word
- ✅ **views/admin-definition-form.ejs** - Add/edit definition form

### Styling
- ✅ **public/css/style.css** - African-inspired color scheme:
  - Primary: Warm earth brown (#D4A574)
  - Secondary: Light sand (#E8D4B8)
  - Accent: Red-ochre (#C9453A)
  - Success: Muted green (#7A9A4A)
  - Responsive grid layouts
  - Card-based design

### JavaScript
- ✅ **public/js/app.js** - Client-side helpers:
  - `postComment()` - POST new comment
  - `editComment()` - PUT to update comment
  - `deleteComment()` - DELETE comment with confirmation
  - `vote()` - POST vote (toggle/switch logic handled server-side)
  - `toggleEditMode()` - Show/hide edit form
  - All via fetch API, no framework

### Scripts
- ✅ **scripts/create-admin.js** - Create admin user:
  - Usage: `node scripts/create-admin.js <username> <email> <password>`
  - Validates password length
  - Checks for duplicate username/email
  - Bcrypt hashing
  - Friendly error messages

### Documentation
- ✅ **README.md** - Comprehensive setup and usage guide:
  - Feature overview
  - Tech stack
  - Installation steps
  - Database schema documentation
  - API route reference
  - Security notes
  - Project structure
  - Testing checklist
  - Usage examples

- ✅ **IMPLEMENTATION_PLAN.md** (this file)

## Data Model Implementation

### Schema Additions
All implemented in `db/init.js`:

1. **users** - Enhanced with:
   ```sql
   role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user'))
   created_at DATETIME DEFAULT CURRENT_TIMESTAMP
   ```

2. **comments** - New table:
   ```sql
   id, definition_id (FK), user_id (FK), body, created_at, updated_at
   UNIQUE(user_id, definition_id)
   ```

3. **votes** - New table:
   ```sql
   id, comment_id (FK), user_id (FK), value (1 or -1), created_at
   UNIQUE(user_id, comment_id)
   ```

### Indexes
All foreign key columns indexed for performance:
- `definitions(word_id)`
- `comments(definition_id)`
- `comments(user_id)`
- `votes(comment_id)`
- `votes(user_id)`

## Key Implementation Details

### Authentication
- ✅ Session-based with express-session
- ✅ 7-day expiration, httpOnly, sameSite='strict'
- ✅ Session regeneration on login for security
- ✅ Bcrypt with 10 rounds for passwords
- ✅ Username and email unique constraints in DB

### Authorization
- ✅ Admin-only middleware on all write routes (not just UI buttons)
- ✅ User role enforcement on comment/vote routes
- ✅ Friendly error messages for access denied

### Comments
- ✅ Max 500 characters enforced in validation
- ✅ UNIQUE constraint prevents duplicate comments per user per definition
- ✅ User can edit/delete own; admin can delete any
- ✅ After deletion, user can post new comment
- ✅ Cascading delete on user/definition removal

### Voting
- ✅ Non-admin users only
- ✅ One vote per user per comment (UNIQUE constraint)
- ✅ No self-voting enforcement
- ✅ Toggle: clicking same vote removes it
- ✅ Switch: clicking opposite vote changes it
- ✅ Score calculated as SUM(vote.value) per comment
- ✅ Comments sorted by score DESC, then created_at DESC

### XSS Prevention
- ✅ All user content (username, comments, etc.) escaped in EJS templates
- ✅ No innerHTML or unsanitized injection points

### SQL Injection Prevention
- ✅ Parameterized queries throughout
- ✅ better-sqlite3 prepared statements

### Admin Creation
- ✅ Non-interactive script: `node scripts/create-admin.js <user> <email> <pass>`
- ✅ Can also be set via env var at startup (future enhancement)
- ✅ No public registration path to admin role

## Testing Checklist

See **TESTING.md** for detailed manual test cases covering:
- Non-admin blocked from word writes
- Second comment rejection
- Self-vote rejection
- Vote toggle and switch
- Logged-out read-only access

## Constraints Met

- ✅ No rewrite of existing patterns (built on Express conventions)
- ✅ Same tech stack (Node.js, Express, SQLite, EJS, bcryptjs)
- ✅ African-inspired color scheme preserved/extended
- ✅ All XSS vectors addressed
- ✅ All parameterized queries
- ✅ Comment length capped at 500 chars
- ✅ Only admins can create/edit/delete words and definitions
- ✅ Admins can delete any comment
- ✅ Admins cannot comment or vote (by design)
- ✅ Role-based permission enforcement at middleware level
- ✅ Vanilla JS for client-side interactions (no framework)

## Deployment Notes

1. Set `SESSION_SECRET` in `.env` to a secure random string
2. Set `NODE_ENV=production` in production
3. Database file (`luo.db`) will be auto-created in project root
4. Create first admin before opening to public: `node scripts/create-admin.js <...>`
5. All routes are SSL-ready via httpOnly and sameSite cookies

## Future Enhancements

- Rate limiting on login/register routes
- CSRF token middleware
- Comment moderation queue
- Admin audit logs
- Search and filter
- Export definitions
- User reputation/badges
