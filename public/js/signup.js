'use strict';
document.addEventListener('DOMContentLoaded', () => {
  const form      = document.querySelector('.signup-form');
  const errorEl   = document.getElementById('signup-error');
  const successEl = document.getElementById('signup-success');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent   = '';
    successEl.textContent = '';

    const full_name        = document.getElementById('fullname').value.trim();
    const id_number        = document.getElementById('idnumber').value.trim();
    const email            = document.getElementById('email').value.trim();
    const username         = document.getElementById('username').value.trim();
    const password         = document.getElementById('password').value;
    const confirm_password = document.getElementById('confirm_password').value;
    const requested_role   = document.getElementById('requested_role').value;
    const agree            = document.querySelector('input[name="agree_terms"]').checked;

    if (!requested_role) {
      errorEl.textContent = 'Please select the role you are applying for.';
      return;
    }

    if (!agree) {
      errorEl.textContent = 'You must agree to the Terms & Conditions.';
      return;
    }

    if (password !== confirm_password) {
      errorEl.textContent = 'Passwords do not match.';
      return;
    }

    try {
      const res = await api.post('/api/users/signup', {
        full_name,
        id_number,
        email,
        username,
        password,
        confirm_password,
        requested_role,
      });
      const data = await res.json();

      if (!res.ok) {
        errorEl.textContent = data.error || 'Signup failed.';
        return;
      }

      successEl.textContent = data.message;
      form.reset();
    } catch (err) {
      errorEl.textContent = 'An error occurred. Please try again.';
    }
  });
});
