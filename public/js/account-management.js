'use strict';

// ---------------------------------------------------------------------------
// confirmAction(message, onConfirm, extraHtml)
// Shows the confirm modal and calls onConfirm when user clicks Confirm.
// ---------------------------------------------------------------------------
function confirmAction(message, onConfirm, extraHtml = '') {
  const overlay = document.getElementById('confirmModal');
  document.getElementById('confirmModalMessage').textContent = message;
  document.getElementById('confirmModalExtra').innerHTML = extraHtml;
  overlay.classList.add('open');

  const ok = document.getElementById('confirmModalOk');
  const cancel = document.getElementById('confirmModalCancel');
  const close = document.getElementById('confirmModalClose');

  function cleanup() {
    overlay.classList.remove('open');
    ok.onclick = null;
    cancel.onclick = null;
    close.onclick = null;
  }

  ok.onclick = () => { cleanup(); onConfirm(); };
  cancel.onclick = cleanup;
  close.onclick = cleanup;
  overlay.onclick = (e) => { if (e.target === overlay) cleanup(); };
}

// ---------------------------------------------------------------------------
// Status pill helper
// ---------------------------------------------------------------------------
function userStatusClass(status) {
  const map = {
    Active: 'status-enrolled',
    Pending: 'status-onleave',
    Inactive: 'status-inactive',
    Rejected: 'status-inactive',
  };
  return map[status] || '';
}

// ---------------------------------------------------------------------------
// Role display helper
// ---------------------------------------------------------------------------
function roleDisplay(role) {
  const map = {
    sysadmin: 'System Admin',
    schoolhead: 'School Head',
    teacher: 'Teacher',
    guidance: 'Guidance',
    safetyofficer: 'Safety Officer',
    student: 'Student',
  };
  return map[role] || role;
}

// ---------------------------------------------------------------------------
// Requested-role display helper (uses full labels matching the signup form)
// ---------------------------------------------------------------------------
function requestedRoleDisplay(role) {
  const map = {
    teacher:       'Teacher',
    guidance:      'Guidance Counselor',
    safetyofficer: 'Safety Officer',
    student:       'Student',
  };
  return role ? (map[role] || role) : '—';
}

// ---------------------------------------------------------------------------
// fetchPendingCount() — update sidebar badge and inline count
// ---------------------------------------------------------------------------
async function fetchPendingCount() {
  try {
    const res  = await api.get('/api/users?status=Pending&limit=1');
    const data = await res.json();
    if (!res.ok) return;
    const count = (data.pagination && data.pagination.total) || 0;

    const badge  = document.getElementById('pendingUsersBadge');
    const inline = document.getElementById('pendingUsersCount');

    if (badge) {
      if (count > 0) {
        badge.textContent = count;
        badge.classList.remove('u-hidden');
      } else {
        badge.classList.add('u-hidden');
      }
    }
    if (inline) {
      inline.textContent = count > 0 ? `(${count})` : '';
    }
  } catch (_) { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// loadUsers() — fetch and render the user table
// ---------------------------------------------------------------------------
async function loadUsers() {
  const status = document.getElementById('userFilterStatus').value;
  const role   = document.getElementById('userFilterRole').value;

  let url = '/api/users?limit=100';
  if (status) url += `&status=${encodeURIComponent(status)}`;
  if (role)   url += `&role=${encodeURIComponent(role)}`;

  const tbody   = document.getElementById('userTableBody');
  const countEl = document.getElementById('userCount');
  tbody.innerHTML = '<tr><td colspan="6" class="cell-msg">Loading...</td></tr>';

  try {
    const res  = await api.get(url);
    const data = await res.json();

    if (!res.ok) {
      tbody.innerHTML = `<tr><td colspan="6" class="cell-msg is-error">${data.error || 'Failed to load users.'}</td></tr>`;
      return;
    }

    const users = data.data || [];
    countEl.textContent = `Showing ${users.length} user(s).`;

    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="cell-msg">No users found.</td></tr>';
      return;
    }

    tbody.innerHTML = users.map(u => {
      const initials = u.full_name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
      const date = new Date(u.created_at).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
      const actions = buildActions(u);
      // Show "Requested: X" badge under the role for Pending users
      const roleCell = u.status === 'Pending' && u.requested_role
        ? `${roleDisplay(u.role)} <small class="requested-role-badge">Requested: ${requestedRoleDisplay(u.requested_role)}</small>`
        : roleDisplay(u.role);
      return `
        <tr>
          <td>
            <div class="student-name">
              <div class="student-avatar">${initials}</div>
              <div class="student-meta">${u.full_name}<small>${u.username} · ${u.email}</small></div>
            </div>
          </td>
          <td>${u.id_number || '—'}</td>
          <td>${roleCell}</td>
          <td><span class="status-pill ${userStatusClass(u.status)}">${u.status}</span></td>
          <td>${date}</td>
          <td><div class="row-actions">${actions}</div></td>
        </tr>
      `;
    }).join('');

    // Attach action handlers after rendering
    attachActionHandlers(users);

  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="cell-msg is-error">Error: ${err.message}</td></tr>`;
  }

  // Refresh the pending count badge whenever the table reloads
  fetchPendingCount();
}

// ---------------------------------------------------------------------------
// buildActions(user) — returns HTML string of action buttons
// ---------------------------------------------------------------------------
function buildActions(u) {
  const btns = [];

  if (u.status === 'Pending') {
    btns.push(`<button title="Approve" data-action="approve" data-id="${u.id}" data-role="${u.role}" data-requested-role="${u.requested_role || ''}" data-name="${u.full_name}"><i class="fas fa-check"></i></button>`);
    btns.push(`<button title="Reject" class="danger" data-action="reject" data-id="${u.id}" data-name="${u.full_name}"><i class="fas fa-ban"></i></button>`);
  }

  if (u.status === 'Active') {
    btns.push(`<button title="Deactivate" class="danger" data-action="deactivate" data-id="${u.id}" data-name="${u.full_name}"><i class="fas fa-user-slash"></i></button>`);
    btns.push(`<button title="Reset Password" data-action="reset-password" data-id="${u.id}" data-name="${u.full_name}"><i class="fas fa-key"></i></button>`);
  }

  if (u.status === 'Inactive') {
    btns.push(`<button title="Reactivate" data-action="reactivate" data-id="${u.id}" data-name="${u.full_name}"><i class="fas fa-user-check"></i></button>`);
  }

  return btns.join('');
}

// ---------------------------------------------------------------------------
// attachActionHandlers(users) — event delegation on the table body
// ---------------------------------------------------------------------------
function attachActionHandlers(users) {
  const tbody = document.getElementById('userTableBody');

  tbody.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      const id     = btn.dataset.id;
      const name   = btn.dataset.name;
      const role   = btn.dataset.role;
      const requestedRole = btn.dataset.requestedRole || '';

      if (action === 'approve') {
        // All pending approvals require the SysAdmin to confirm a role.
        // The dropdown is pre-selected to the user's requested_role.
        const requestedLabel = requestedRoleDisplay(requestedRole);
        document.getElementById('confirmModalTitle').innerHTML =
          '<i class="fas fa-check"></i> Approve Account';
        document.getElementById('confirmModalMessage').textContent =
          `Approve account for "${name}". Requested role: ${requestedLabel}. Confirm the role to assign.`;
        document.getElementById('confirmModalExtra').innerHTML = `
          <div class="input-group" style="margin-bottom:12px;">
            <label for="approve-role-select" style="display:block;margin-bottom:6px;font-weight:600;">
              Assign Role
            </label>
            <select id="approve-role-select" class="filter-select" style="width:100%;">
              <option value="">— Select a role —</option>
              <option value="teacher">Teacher</option>
              <option value="guidance">Guidance</option>
              <option value="safetyofficer">Safety Officer</option>
              <option value="schoolhead">School Head</option>
              <option value="student">Student</option>
            </select>
          </div>
          <div id="student-link-section" style="display:none;">
            <div class="class-student-search">
              <input id="student-link-search" class="search-input" type="text"
                placeholder="Search student by name or number\u2026" />
              <button class="btn-maroon btn-sm" id="btnSearchStudentLink">
                <i class="fas fa-search"></i> Find
              </button>
            </div>
            <div id="student-link-results" class="class-search-results"></div>
            <input type="hidden" id="selected-student-record-id" value="" />
            <p id="selected-student-label" class="dash-muted-intro"></p>
          </div>
          <p id="approve-error" class="error-msg"></p>`;
        document.getElementById('confirmModalOk').textContent = 'Approve';
        document.getElementById('confirmModal').classList.add('open');

        // Pre-select the requested role in the dropdown if it is one of the options
        const roleSelect = document.getElementById('approve-role-select');
        if (requestedRole && [...roleSelect.options].some(o => o.value === requestedRole)) {
          roleSelect.value = requestedRole;
          if (requestedRole === 'student') {
            document.getElementById('student-link-section').style.display = 'block';
          }
        }

        // Show/hide student record search based on role selection
        roleSelect.addEventListener('change', function () {
          const section = document.getElementById('student-link-section');
          section.style.display = this.value === 'student' ? 'block' : 'none';
          if (this.value !== 'student') {
            document.getElementById('selected-student-record-id').value = '';
            document.getElementById('selected-student-label').textContent = '';
            document.getElementById('student-link-results').innerHTML = '';
          }
        });

        // Wire student search
        const doStudentSearch = async () => {
          const q = document.getElementById('student-link-search').value.trim();
          if (!q) return;
          const res  = await api.get(`/api/students?q=${encodeURIComponent(q)}&status=Active`);
          const data = await res.json();
          const results = document.getElementById('student-link-results');
          const list = res.ok ? (data.data || []) : [];
          if (!list.length) {
            results.innerHTML = '<p class="dash-muted-intro search-empty">No students found.</p>';
            return;
          }
          results.innerHTML = list.map(s => `
            <div class="class-student-row">
              <span>${s.last_name}, ${s.first_name} <small>(${s.student_number})</small></span>
              <button class="btn-maroon btn-sm"
                data-action="select-student-record"
                data-student-id="${s.id}"
                data-student-label="${s.last_name}, ${s.first_name} (${s.student_number})">
                Select
              </button>
            </div>`).join('');

          results.querySelectorAll('[data-action="select-student-record"]').forEach(selBtn => {
            selBtn.addEventListener('click', () => {
              document.getElementById('selected-student-record-id').value = selBtn.dataset.studentId;
              document.getElementById('selected-student-label').textContent =
                `\u2714 Selected: ${selBtn.dataset.studentLabel}`;
              document.getElementById('student-link-results').innerHTML = '';
              document.getElementById('student-link-search').value = '';
            });
          });
        };

        document.getElementById('btnSearchStudentLink').addEventListener('click', doStudentSearch);
        document.getElementById('student-link-search').addEventListener('keydown', e => {
          if (e.key === 'Enter') doStudentSearch();
        });

        // Override the confirm button with approval logic
        const okBtn = document.getElementById('confirmModalOk');
        const newOk = okBtn.cloneNode(true);
        okBtn.parentNode.replaceChild(newOk, okBtn);
        newOk.addEventListener('click', async () => {
          const chosenRole = document.getElementById('approve-role-select').value;
          const errEl = document.getElementById('approve-error');
          errEl.textContent = '';

          if (!chosenRole) {
            errEl.textContent = 'Please select a role.';
            return;
          }

          const payload = { status: 'Active', role: chosenRole };

          if (chosenRole === 'student') {
            const recordId = document.getElementById('selected-student-record-id').value;
            if (!recordId) {
              errEl.textContent = 'Please select a student record.';
              return;
            }
            payload.student_record_id = parseInt(recordId, 10);
          }

          const res = await api.patch(`/api/users/${id}/status`, payload);
          const d = await res.json();
          if (!res.ok) {
            errEl.textContent = d.error || 'Failed to approve.';
            return;
          }

          document.getElementById('confirmModal').classList.remove('open');
          document.getElementById('confirmModalOk').textContent = 'Confirm';
          loadUsers();
        });
      }

      else if (action === 'reject') {
        confirmAction(
          `Reject account request for "${name}"? You may optionally provide a reason.`,
          async () => {
            const reason = document.getElementById('reject-reason-input')?.value?.trim() || '';
            const res = await api.patch(`/api/users/${id}/status`, { status: 'Rejected', rejection_reason: reason });
            if (res.ok) loadUsers();
            else { const d = await res.json(); alert(d.error || 'Failed to reject.'); }
          },
          '<textarea id="reject-reason-input" class="reject-reason-textarea" placeholder="Optional rejection reason..."></textarea>'
        );
      }

      else if (action === 'deactivate') {
        confirmAction(
          `Deactivate account for "${name}"? Their active sessions will be ended immediately.`,
          async () => {
            const res = await api.patch(`/api/users/${id}/status`, { status: 'Inactive' });
            if (res.ok) loadUsers();
            else { const d = await res.json(); alert(d.error || 'Failed to deactivate.'); }
          }
        );
      }

      else if (action === 'reactivate') {
        confirmAction(
          `Reactivate account for "${name}"?`,
          async () => {
            const res = await api.patch(`/api/users/${id}/status`, { status: 'Active' });
            if (res.ok) loadUsers();
            else { const d = await res.json(); alert(d.error || 'Failed to reactivate.'); }
          }
        );
      }

      else if (action === 'reset-password') {
        confirmAction(
          `Reset password for "${name}"? Their current sessions will be invalidated and they will be forced to change the temporary password on next login.`,
          async () => {
            const res = await api.post(`/api/users/${id}/reset-password`, {});
            const d   = await res.json();
            if (!res.ok) {
              alert(d.error || 'Failed to reset password.');
              return;
            }
            // Show temp password in a copy modal using the existing confirmModal
            const escaped = d.temp_password.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            document.getElementById('confirmModalTitle').innerHTML = '<i class="fas fa-key"></i> Temporary Password';
            document.getElementById('confirmModalMessage').textContent = `Password reset for "${name}". Share this temporary password securely — it will NOT be shown again.`;
            document.getElementById('confirmModalExtra').innerHTML = `
              <div class="temp-pw-row">
                <code id="tempPwDisplay" class="temp-pw-code">${escaped}</code>
                <button type="button" class="btn-maroon btn-sm" id="tempPwCopyBtn">Copy</button>
              </div>`;
            const copyBtn = document.getElementById('tempPwCopyBtn');
            copyBtn.addEventListener('click', () => {
              navigator.clipboard.writeText(d.temp_password)
                .then(() => { copyBtn.textContent = 'Copied!'; })
                .catch(() => {});
            });
            document.getElementById('confirmModalOk').textContent = 'Done';
            document.getElementById('confirmModalCancel').style.display = 'none';
            document.getElementById('confirmModal').classList.add('open');
            // Reset Cancel button visibility and OK text when modal closes
            document.getElementById('confirmModalOk').onclick = () => {
              document.getElementById('confirmModal').classList.remove('open');
              document.getElementById('confirmModalCancel').style.display = '';
              document.getElementById('confirmModalOk').textContent = 'Confirm';
              document.getElementById('confirmModalOk').onclick = null;
            };
          }
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Auto-load when the users section becomes active
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  // Fetch pending count on page load to show the sidebar badge immediately
  fetchPendingCount();

  // "Pending" quick-filter button
  const filterPendingBtn = document.getElementById('filterPendingBtn');
  if (filterPendingBtn) {
    filterPendingBtn.addEventListener('click', () => {
      const sel = document.getElementById('userFilterStatus');
      if (sel) {
        sel.value = sel.value === 'Pending' ? '' : 'Pending';
      }
      loadUsers();
    });
  }

  // If the page starts on the users section, load immediately
  const usersSection = document.getElementById('users');
  if (usersSection && usersSection.classList.contains('active')) {
    loadUsers();
  }

  // Watch for section navigation clicks
  document.querySelectorAll('.dash-nav-item[data-section="users"]').forEach(link => {
    link.addEventListener('click', loadUsers);
  });
});
