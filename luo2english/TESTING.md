# Manual Testing Checklist

## Setup Before Testing

1. Start with a fresh database
2. Run: `npm start`
3. Server should be at `http://localhost:3000`
4. Create admin user: `node scripts/create-admin.js admin admin@test.com Admin123`

## Test Data Setup

### Create test data as admin:
1. Log in with admin account
2. Go to Admin → Manage Words
3. Add a word: "nyasi" (grass)
4. Add definitions:
   - Definition 1: "Green plant material covering the ground"
   - Definition 2: "Thin strands of vegetation used in agriculture"

## Test Cases

### 1. Registration & Authentication

**Test 1.1: Public Registration**
- [ ] Navigate to http://localhost:3000/auth/register
- [ ] Fill form with username="testuser", email="test@example.com", password="Test1234"
- [ ] Confirm password matches
- [ ] Click Register
- [ ] Should redirect to home page and show "Hello, testuser" in navbar
- [ ] Session should be created (auto-login after registration)

**Test 1.2: Duplicate Username**
- [ ] Try registering with same username as testuser
- [ ] Should show error: "Username or email already in use"

**Test 1.3: Duplicate Email**
- [ ] Try registering with different username but same email as testuser
- [ ] Should show error: "Username or email already in use"

**Test 1.4: Invalid Inputs**
- [ ] Username < 3 chars: should show "Username must be at least 3 characters"
- [ ] Invalid email: should show "Invalid email format"
- [ ] Password < 8 chars: should show "Password must be at least 8 characters"
- [ ] Mismatched passwords: should show "Passwords do not match"

**Test 1.5: Login/Logout**
- [ ] Log out (click Logout button)
- [ ] Navbar should show Login/Register buttons
- [ ] Go to /auth/login
- [ ] Enter credentials for testuser
- [ ] Should redirect to home and show "Hello, testuser"
- [ ] Click Logout again
- [ ] Session should be destroyed

### 2. Role-Based Access Control

**Test 2.1: Non-Admin Cannot Create Words**
- [ ] Log in as testuser (non-admin)
- [ ] Try accessing http://localhost:3000/admin
- [ ] Should show "Access denied. Admin privileges required."

**Test 2.2: Non-Admin Cannot Edit Words**
- [ ] Logged in as testuser, go to /word/1 (any word)
- [ ] No edit/delete buttons should appear
- [ ] Manually navigate to /admin/words/1/edit
- [ ] Should show access denied error

**Test 2.3: Non-Admin Cannot Delete Words**
- [ ] Same as above; /admin/words/1/delete should be denied

**Test 2.4: Admin Can Access All Functions**
- [ ] Log in as admin
- [ ] Navigate to /admin
- [ ] Should see dashboard with stats
- [ ] Click "Manage Words"
- [ ] Should see word list with Edit/Delete buttons

### 3. Comments

**Test 3.1: Logged-Out Users Cannot Comment**
- [ ] Log out
- [ ] Go to /word/1 (any word with definition)
- [ ] Should see "Login to Comment" button
- [ ] Clicking should redirect to /auth/login

**Test 3.2: User Can Post One Comment Per Definition**
- [ ] Log in as testuser
- [ ] Go to /word/1 → Definition 1
- [ ] Post comment: "This is a great definition!"
- [ ] Comment should appear immediately
- [ ] Comment header should show username "testuser" and today's date

**Test 3.3: User Cannot Post Second Comment on Same Definition**
- [ ] Still on Definition 1, try posting another comment
- [ ] Should show alert: "You have already commented on this definition"
- [ ] No new comment should appear

**Test 3.4: User Can Comment on Different Definition**
- [ ] Go to Definition 2 of the same word
- [ ] Post a comment there
- [ ] Should succeed (different definition)
- [ ] Now testuser has 2 comments (one per definition)

**Test 3.5: User Can Edit Own Comment**
- [ ] On Definition 1, click "Edit" button on your comment
- [ ] Comment should switch to edit mode
- [ ] Change text to "Updated comment text"
- [ ] Click "Save"
- [ ] Should show alert "Comment updated"
- [ ] Page should refresh with new text

**Test 3.6: User Can Delete Own Comment**
- [ ] On Definition 1, click "Delete" button
- [ ] Should confirm: "Are you sure you want to delete this comment?"
- [ ] Click OK
- [ ] Should show alert "Comment deleted"
- [ ] Comment should disappear
- [ ] Should now be able to post a new comment on Definition 1

**Test 3.7: User Cannot Edit/Delete Others' Comments**
- [ ] Log in as different user (or create new user)
- [ ] Navigate to Definition 1 where testuser's comment exists
- [ ] You should NOT see Edit/Delete buttons on testuser's comment

**Test 3.8: Admin Can Delete Any Comment**
- [ ] Log in as admin
- [ ] Go to Definition 1 with testuser's comment
- [ ] Should see "Delete (Admin)" button on comment
- [ ] Click it
- [ ] Should show alert "Comment deleted"
- [ ] Comment should disappear

**Test 3.9: Admin Cannot Post Comments**
- [ ] Logged in as admin, go to Definition 2
- [ ] Should NOT see a comment form
- [ ] Should see message "Admins cannot post comments"

**Test 3.10: Comment Length Limit**
- [ ] Log in as testuser
- [ ] Go to Definition 1 (empty now after admin deleted)
- [ ] Try to post a comment longer than 500 characters
- [ ] Textarea should have maxlength="500" attribute (HTML5 prevents exceeding)
- [ ] Submitting just at 500 chars should work

### 4. Voting

**Test 4.1: Logged-Out Users Cannot Vote**
- [ ] Log out
- [ ] Go to Definition 1 with testuser's new comment
- [ ] Vote buttons should not be clickable; should see "Login to vote"

**Test 4.2: User Can Upvote Comments**
- [ ] Log in as another user (not the comment author)
- [ ] Go to Definition 1 with testuser's comment
- [ ] Click 👍 upvote button
- [ ] Score should change from 0 to 1
- [ ] Button should appear highlighted/active

**Test 4.3: User Can Downvote Comments**
- [ ] Click 👎 downvote button
- [ ] Score should change from 1 to -1
- [ ] Downvote button should appear highlighted/active
- [ ] Upvote button should no longer be highlighted

**Test 4.4: Toggle Vote (Remove by Clicking Same Button)**
- [ ] Click 👎 again (same vote)
- [ ] Score should return to 0
- [ ] Downvote button should no longer be highlighted

**Test 4.5: Switch Vote (Opposite Button)**
- [ ] Click 👍 upvote
- [ ] Score becomes 1
- [ ] Click 👎 downvote
- [ ] Score should become -1 (vote switched, not added twice)

**Test 4.6: Multiple Users Voting**
- [ ] Create/log in as 3rd user
- [ ] Go to testuser's comment
- [ ] Click 👍
- [ ] Score should now be 0 (3rd user votes +1, and we already had +1 from 2nd user's downvote removal, but let's be clear)
- [ ] Actually: Start fresh with score calculation
  - User 2 upvotes → score = 1
  - User 3 upvotes → score = 2
  - User 2 switches to downvote → score = 0
  - User 3 downvotes → score = -1

**Test 4.7: Cannot Vote on Own Comments**
- [ ] Log in as testuser
- [ ] Go to a definition where testuser has a comment
- [ ] Try to access vote buttons
- [ ] Should see "You cannot vote on your own comment" (or buttons should be disabled)
- [ ] Clicking vote button should show: "You cannot vote on your own comment"

**Test 4.8: Admin Cannot Vote**
- [ ] Log in as admin
- [ ] Find any comment
- [ ] Should see message "Admins cannot vote" instead of vote buttons
- [ ] Clicking should show alert: "Admins cannot vote on comments"

**Test 4.9: Comments Sorted by Score Then Date**
- [ ] On a definition with multiple comments:
  - Comment A by User1: 5 upvotes (score = 5)
  - Comment B by User2: 2 upvotes (score = 2)
  - Comment C by User3: 2 upvotes but posted earlier (score = 2)
- [ ] Display order should be: A (5), C (2, older), B (2, newer)
- [ ] Actually: B and C both have score 2, so C (posted first) should appear first

### 5. Read-Only Access for Visitors

**Test 5.1: Visitor Can View Word List**
- [ ] Log out
- [ ] Go to http://localhost:3000/
- [ ] Should see grid of all words
- [ ] Should be able to click words

**Test 5.2: Visitor Can View Definitions**
- [ ] On /word/1
- [ ] Should see all definitions
- [ ] Should see all comments

**Test 5.3: Visitor Can See Vote Counts**
- [ ] Comments should show their vote scores
- [ ] Score should be accurate (sum of all votes)

**Test 5.4: Visitor Cannot Change Data**
- [ ] No edit/delete buttons on any content
- [ ] No comment form
- [ ] No vote buttons (or disabled)
- [ ] All write routes should redirect to login

### 6. Data Integrity

**Test 6.1: Cascading Delete - Comment Deletion**
- [ ] Delete a user via database or by deleting their account (if implemented)
- [ ] Their comments should be automatically deleted
- [ ] Verify in database: `SELECT * FROM comments WHERE user_id = <deleted_user>`

**Test 6.2: Cascading Delete - Vote Deletion**
- [ ] When a comment is deleted, all votes on it should be deleted
- [ ] Verify: `SELECT * FROM votes WHERE comment_id = <deleted_comment>`

**Test 6.3: Cascading Delete - Definition Deletion**
- [ ] Delete a definition
- [ ] All comments on it should be deleted
- [ ] All votes on those comments should be deleted

**Test 6.4: Unique Constraint - One Comment Per User Per Definition**
- [ ] Database should prevent duplicate (user_id, definition_id) pairs
- [ ] Attempting to INSERT duplicate should fail
- [ ] UI should prevent this with error message

**Test 6.5: Unique Constraint - One Vote Per User Per Comment**
- [ ] Database should prevent duplicate (user_id, comment_id) pairs
- [ ] Multiple vote attempts should be handled by toggle/switch logic

### 7. Security

**Test 7.1: Password Hashing**
- [ ] Manually check database: `SELECT password_hash FROM users`
- [ ] Hashes should NOT contain plaintext passwords
- [ ] All hashes should be bcrypt format (starting with $2a$, $2b$, etc.)

**Test 7.2: XSS Prevention**
- [ ] Post comment with HTML: `<script>alert('XSS')</script>`
- [ ] Should display as escaped text, not execute
- [ ] View page source and confirm content is HTML-escaped

**Test 7.3: Session Security**
- [ ] Open dev tools → Application → Cookies
- [ ] Session cookie should have:
  - [ ] HttpOnly flag (cannot access via JS)
  - [ ] Secure flag (HTTPS only in production)
  - [ ] SameSite=Strict

**Test 7.4: Session Regeneration**
- [ ] Log in as user
- [ ] Check session ID in cookies
- [ ] Log out and log back in
- [ ] Session ID should be different (regenerated)

### 8. Edge Cases

**Test 8.1: Very Long Comment**
- [ ] Post a comment of exactly 500 characters
- [ ] Should succeed

**Test 8.2: Comment with Special Characters**
- [ ] Post comment with: `@#$%^&*()_+-=[]{}|;':",./<>?`
- [ ] Should display correctly and not cause errors

**Test 8.3: Concurrent Voting**
- [ ] Have 2 users vote on same comment simultaneously (or very quickly)
- [ ] Both votes should be recorded
- [ ] Score should be accurate

**Test 8.4: Rapid Comment Posting**
- [ ] User tries to post 2 comments quickly on Definition 2
- [ ] Second should be rejected with error

**Test 8.5: Empty Comment**
- [ ] Try to submit empty comment form
- [ ] Should show "Comment cannot be empty"

## Browser Compatibility

- [ ] Test in Chrome/Edge
- [ ] Test in Firefox
- [ ] Test in Safari
- [ ] Test on mobile (responsive design)

## Performance

- [ ] Page load time < 1s for word list
- [ ] Page load time < 2s for word with comments
- [ ] Vote action completes < 500ms

## Final Checklist

- [ ] All features working as described
- [ ] No console errors
- [ ] No SQL errors
- [ ] Database integrally intact (no orphaned records)
- [ ] Admin user created successfully
- [ ] README accurate and complete
- [ ] All routes accessible and working
- [ ] Color scheme consistent across pages
- [ ] Navigation working on all pages
