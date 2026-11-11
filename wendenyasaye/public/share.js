const shareLink = document.querySelector('#share-link');
const shareButton = document.querySelector('#share-button');
const shareStatus = document.querySelector('#share-status');
shareLink.textContent = shareLink.href;
if (navigator.share || navigator.clipboard?.writeText) {
  shareButton.hidden = false;
  shareButton.textContent = navigator.share ? 'Share' : 'Copy link';
  shareButton.addEventListener('click', async () => {
    shareStatus.textContent = '';
    try {
      if (navigator.share) {
        await navigator.share({ title: document.title, url: shareLink.href });
        shareStatus.textContent = 'Share opened.';
      } else {
        await navigator.clipboard.writeText(shareLink.href);
        shareStatus.textContent = 'Link copied.';
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
      console.error('Unable to share hymn:', error);
      shareStatus.textContent = 'Unable to share automatically. Copy the link above instead.';
    }
  });
}
