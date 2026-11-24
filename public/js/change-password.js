'use strict';
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('change-password-form');
  const errorEl = document.getElementById('error-msg');
  const successEl = document.getElementById('success-msg');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    successEl.textContent = '';

    const current_password = document.getElementById('current-password').value;
    const new_password = document.getElementById('new-password').value;
    const confirm_password = document.getElementById('confirm-password').value;

    if (new_password !== confirm_password) {
      errorEl.textContent = 'New passwords do not match.';
      return;
    }

    try {
      const res = await api.post('/api/auth/change-password', { current_password, new_password });
      const data = await res.json();

      if (!res.ok) {
        errorEl.textContent = data.error || 'Password change failed.';
        return;
      }

      successEl.textContent = 'Password changed successfully. Redirecting...';
      setTimeout(() => {
        window.location.href = data.redirect || '/';
      }, 1200);
    } catch (err) {
      errorEl.textContent = 'An error occurred. Please try again.';
    }
  });
});
