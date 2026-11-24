'use strict';

// Tab id → role value sent to the API
const TAB_ROLE_MAP = {
  tab_sysadmin:      'sysadmin',
  tab_schoolhead:    'schoolhead',
  tab_teacher:       'teacher',
  tab_guidance:      'guidance',
  tab_safetyofficer: 'safetyofficer',
  tab_student:       'student',
};

async function initLoginPage() {
  // --- 1. Fetch public config (plain fetch — GET, no CSRF needed) ---
  let studentEnabled = true;
  try {
    const res = await fetch('/api/public/config');
    if (res.ok) {
      const data = await res.json();
      studentEnabled =
        data.student_feature_enabled === '1' ||
        data.student_feature_enabled === 1;
    }
  } catch (_) {
    // Offline / server not yet up — default to showing all tabs
  }

  // --- 2. Hide the Student tab when the flag is off ---
  if (!studentEnabled) {
    const radio = document.getElementById('tab_student');
    const lbl   = document.querySelector('label[for="tab_student"]');
    if (radio) radio.classList.add('tab-hidden');
    if (lbl)   lbl.classList.add('tab-hidden');
  }

  // --- 3. Default-select the first visible tab ---
  const firstVisible = document.querySelector('.tab-radio:not(.tab-hidden)');
  if (firstVisible) {
    firstVisible.checked = true;
    updateSelectedRole(firstVisible.id);
  }

  // --- 4. Keep hidden role input in sync with tab selection ---
  document.querySelectorAll('input[name="role_tab"]').forEach(function (radio) {
    radio.addEventListener('change', function () {
      updateSelectedRole(radio.id);
    });
  });

  // --- 5. Wire form submit ---
  var form = document.getElementById('loginForm');
  if (form) {
    form.addEventListener('submit', handleSubmit);
  }
}

function updateSelectedRole(tabId) {
  var roleInput = document.getElementById('selectedRole');
  if (roleInput) {
    roleInput.value = TAB_ROLE_MAP[tabId] || '';
  }
}

async function handleSubmit(e) {
  e.preventDefault();

  var errEl    = document.getElementById('loginError');
  var username = document.getElementById('username').value.trim();
  var password = document.getElementById('password').value;
  var role     = document.getElementById('selectedRole').value;
  var rememberEl = document.querySelector('input[name="remember"]');
  var remember = rememberEl ? rememberEl.checked : false;

  if (errEl) errEl.textContent = '';

  if (!username || !password || !role) {
    if (errEl) errEl.textContent = 'Please fill in all required fields.';
    return;
  }

  try {
    // api.post returns a Response object; parse JSON and check status
    var res = await api.post('/api/auth/login', {
      username:    username,
      password:    password,
      role:        role,
      remember_me: remember,
    });

    var data = await res.json();

    if (!res.ok) {
      if (errEl) errEl.textContent = data.error || 'Invalid username or password.';
      return;
    }

    // Redirect to the role-specific dashboard returned by the server
    window.location.href = data.redirect || '/dashboard-admin.html';
  } catch (err) {
    if (errEl) {
      errEl.textContent = 'An error occurred. Please try again.';
    }
  }
}

// Run after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initLoginPage);
} else {
  initLoginPage();
}
