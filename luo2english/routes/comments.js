const express = require('express');
const db = require('../db/postgres');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const router = express.Router();
for (const param of ['id', 'word_id']) {
  router.param(param, (req, res, next, value) => {
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 2147483647) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }
    next();
  });
}

// Helper: Validate comment length
const isValidComment = (body) => typeof body === 'string' && body.trim().length > 0 && body.trim().length <= 500;

// POST: Create a comment (user must be logged in, max 1 per word)
router.post('/:word_id', requireAuth, async (req, res) => {
  if (req.session.role === 'admin') {
    // Admins cannot comment (you can change this if needed)
    return res.status(403).json({
      success: false,
      message: 'Admins cannot post comments'
    });
  }

  const { body } = req.body;
  const word_id = req.params.word_id;
  const user_id = req.session.user_id;

  if (!isValidComment(body)) {
    return res.status(400).json({
      success: false,
      message: 'Comment must be between 1 and 500 characters'
    });
  }

  try {
    if (!(await db.query('SELECT id FROM words WHERE id = $1', [word_id])).rows[0]) {
      return res.status(404).json({ success: false, message: 'Word not found' });
    }
    // Check if user already commented on this word
    const existing = (await db.query(
      'SELECT id FROM comments WHERE user_id = $1 AND word_id = $2', [user_id, word_id]
    )).rows[0];

    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'You have already commented on this word'
      });
    }

    // Create comment
    const result = await db.query(`
      INSERT INTO comments (word_id, user_id, body)
      VALUES ($1, $2, $3) RETURNING id
    `, [word_id, user_id, body.trim()]);

    res.json({
      success: true,
      message: 'Comment posted',
      comment_id: result.rows[0].id
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'You have already commented on this word' });
    }
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Failed to post comment'
    });
  }
});

// PUT: Edit a comment (user can only edit own comment)
router.put('/:id', requireAuth, async (req, res) => {
  const { body } = req.body;
  const comment_id = req.params.id;
  const user_id = req.session.user_id;

  if (!isValidComment(body)) {
    return res.status(400).json({
      success: false,
      message: 'Comment must be between 1 and 500 characters'
    });
  }

  try {
    // Check if comment exists and belongs to user
    const comment = (await db.query('SELECT * FROM comments WHERE id = $1', [comment_id])).rows[0];

    if (!comment) {
      return res.status(404).json({
        success: false,
        message: 'Comment not found'
      });
    }

    // Only comment author or admin can edit
    if (comment.user_id !== user_id && req.session.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'You can only edit your own comments'
      });
    }

    // Update comment
    await db.query(`
      UPDATE comments SET body = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2
    `, [body.trim(), comment_id]);

    res.json({
      success: true,
      message: 'Comment updated'
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Failed to update comment'
    });
  }
});

// DELETE: Delete a comment (user can delete own, admin can delete any)
router.delete('/:id', requireAuth, async (req, res) => {
  const comment_id = req.params.id;
  const user_id = req.session.user_id;

  try {
    // Check if comment exists
    const comment = (await db.query('SELECT * FROM comments WHERE id = $1', [comment_id])).rows[0];

    if (!comment) {
      return res.status(404).json({
        success: false,
        message: 'Comment not found'
      });
    }

    // Only comment author or admin can delete
    if (comment.user_id !== user_id && req.session.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'You can only delete your own comments'
      });
    }

    // Delete comment (cascades to votes)
    await db.query('DELETE FROM comments WHERE id = $1', [comment_id]);

    res.json({
      success: true,
      message: 'Comment deleted'
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete comment'
    });
  }
});

// POST: Vote on a comment (toggle or switch)
// Body: { value: 1 or -1 }
router.post('/:id/vote', requireAuth, async (req, res) => {
  if (req.session.role === 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Admins cannot vote on comments'
    });
  }

  const { value } = req.body;
  const comment_id = req.params.id;
  const user_id = req.session.user_id;

  if (![1, -1].includes(value)) {
    return res.status(400).json({
      success: false,
      message: 'Vote value must be 1 (upvote) or -1 (downvote)'
    });
  }

  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    // Check if comment exists
    const comment = (await client.query('SELECT * FROM comments WHERE id = $1 FOR UPDATE', [comment_id])).rows[0];
    if (!comment) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Comment not found'
      });
    }

    // Cannot vote on own comment
    if (comment.user_id === user_id) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        success: false,
        message: 'You cannot vote on your own comment'
      });
    }

    // Check if user already voted
    const existingVote = (await client.query(
      'SELECT * FROM votes WHERE comment_id = $1 AND user_id = $2', [comment_id, user_id]
    )).rows[0];

    if (existingVote) {
      if (existingVote.value === value) {
        // Same vote: remove it (toggle)
        await client.query('DELETE FROM votes WHERE id = $1', [existingVote.id]);
        await client.query('COMMIT');
        return res.json({
          success: true,
          message: 'Vote removed',
          action: 'removed'
        });
      } else {
        // Different vote: switch it
        await client.query('UPDATE votes SET value = $1 WHERE id = $2', [value, existingVote.id]);
        await client.query('COMMIT');
        return res.json({
          success: true,
          message: 'Vote changed',
          action: 'changed'
        });
      }
    }

    // No existing vote: create one
    await client.query(`
      INSERT INTO votes (comment_id, user_id, value)
      VALUES ($1, $2, $3)
    `, [comment_id, user_id, value]);
    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Vote recorded',
      action: 'added'
    });
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Vote rollback failed:', rollbackError);
      }
    }
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Failed to record vote'
    });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
