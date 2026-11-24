'use strict';
document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('.signup-form');
  const errorEl = document.getElementById('signup-error');
  const successEl = document.getElementById('signup-success');
  const roleInput = document.getElementById('role-value');

  // Map tab radio IDs to backend role values
  const TAB_ROLE_MAP = {
    'tab_teacher':   'teacher',
    'tab_counselor': 'guidance',
    'tab_staff':     'safetyofficer',
    'tab_student':   'student',
  };

  // Update hidden role input when tab changes
  document.querySelectorAll('.tab-radio').forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked && TAB_ROLE_MAP[radio.id]) {
        roleInput.value = TAB_ROLE_MAP[radio.id];
      }
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    successEl.textContent = '';

    const full_name       = document.getElementById('fullname').value.trim();
    const id_number       = document.getElementById('idnumber').value.trim();
    const email           = document.getElementById('email').value.trim();
    const username        = document.getElementById('username').value.trim();
    const password        = document.getElementById('password').value;
    const confirm_password = document.getElementById('confirm_password').value;
    const role            = roleInput.value;
    const agree           = document.querySelector('input[name="agree_terms"]').checked;

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
        full_name, id_number, email, username, password, confirm_password, role,
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
