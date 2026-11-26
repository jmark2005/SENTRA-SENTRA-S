'use strict';

async function initLoginPage() {
  // Check whether the student feature is enabled (used only for future display decisions).
  try {
    await fetch('/api/public/config');
  } catch (_) {
    // Offline / server not yet up — ignore.
  }

  var form = document.getElementById('loginForm');
  if (form) {
    form.addEventListener('submit', handleSubmit);
  }
}

async function handleSubmit(e) {
  e.preventDefault();

  var errEl    = document.getElementById('loginError');
  var username = document.getElementById('username').value.trim();
  var password = document.getElementById('password').value;

  if (errEl) errEl.textContent = '';

  if (!username || !password) {
    if (errEl) errEl.textContent = 'Please enter your username and password.';
    return;
  }

  try {
    var res = await api.post('/api/auth/login', {
      username: username,
      password: password,
    });

    var data = await res.json();

    if (!res.ok) {
      if (errEl) errEl.textContent = data.error || 'Invalid username or password.';
      return;
    }

    window.location.href = data.redirect || '/dashboard-admin.html';
  } catch (err) {
    if (errEl) {
      errEl.textContent = 'An error occurred. Please try again.';
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initLoginPage);
} else {
  initLoginPage();
}
