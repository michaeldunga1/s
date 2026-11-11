// Client-side app.js for handling comments and votes

async function postComment(wordId, bodyElement) {
  const body = bodyElement.value.trim();

  if (!body) {
    alert('Comment cannot be empty');
    return;
  }

  try {
    const response = await fetch(`/comments/${wordId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body })
    });

    const data = await response.json();

    if (!response.ok) {
      alert(data.message || 'Failed to post comment');
      return;
    }

    // Clear and refresh
    bodyElement.value = '';
    location.reload();
  } catch (error) {
    console.error('Error posting comment:', error);
    alert('Error posting comment');
  }
}

async function editComment(commentId, bodyElement) {
  const body = bodyElement.value.trim();

  if (!body) {
    alert('Comment cannot be empty');
    return;
  }

  try {
    const response = await fetch(`/comments/${commentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body })
    });

    const data = await response.json();

    if (!response.ok) {
      alert(data.message || 'Failed to update comment');
      return;
    }

    alert('Comment updated');
    location.reload();
  } catch (error) {
    console.error('Error updating comment:', error);
    alert('Error updating comment');
  }
}

async function deleteComment(commentId) {
  if (!confirm('Are you sure you want to delete this comment?')) {
    return;
  }

  try {
    const response = await fetch(`/comments/${commentId}`, {
      method: 'DELETE'
    });

    const data = await response.json();

    if (!response.ok) {
      alert(data.message || 'Failed to delete comment');
      return;
    }

    alert('Comment deleted');
    location.reload();
  } catch (error) {
    console.error('Error deleting comment:', error);
    alert('Error deleting comment');
  }
}

async function vote(commentId, value, buttonElement) {
  try {
    const response = await fetch(`/comments/${commentId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value })
    });

    const data = await response.json();

    if (!response.ok) {
      alert(data.message || 'Failed to vote');
      return;
    }

    // Refresh the vote display
    location.reload();
  } catch (error) {
    console.error('Error voting:', error);
    alert('Error voting');
  }
}

function toggleEditMode(commentId) {
  const viewEl = document.getElementById(`comment-view-${commentId}`);
  const editEl = document.getElementById(`comment-edit-${commentId}`);

  if (viewEl.style.display === 'none') {
    viewEl.style.display = 'block';
    editEl.style.display = 'none';
  } else {
    viewEl.style.display = 'none';
    editEl.style.display = 'block';
  }
}
