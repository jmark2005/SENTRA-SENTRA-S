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
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:28px;color:var(--muted);">Loading...</td></tr>';

  try {
    const res  = await api.get(url);
    const data = await res.json();

    if (!res.ok) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#c0392b;padding:24px;">${data.error || 'Failed to load users.'}</td></tr>`;
      return;
    }

    const users = data.data || [];
    countEl.textContent = `Showing ${users.length} user(s).`;

    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:28px;color:var(--muted);">No users found.</td></tr>';
      return;
    }

    tbody.innerHTML = users.map(u => {
      const initials = u.full_name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
      const date = new Date(u.created_at).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
      const actions = buildActions(u);
      return `
        <tr>
          <td>
            <div class="student-name">
              <div class="student-avatar">${initials}</div>
              <div class="student-meta">${u.full_name}<small>${u.username} · ${u.email}</small></div>
            </div>
          </td>
          <td>${roleDisplay(u.role)}</td>
          <td><span class="status-pill ${userStatusClass(u.status)}">${u.status}</span></td>
          <td>${date}</td>
          <td><div class="row-actions">${actions}</div></td>
        </tr>
      `;
    }).join('');

    // Attach action handlers after rendering
    attachActionHandlers(users);

  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#c0392b;padding:24px;">Error: ${err.message}</td></tr>`;
  }
}

// ---------------------------------------------------------------------------
// buildActions(user) — returns HTML string of action buttons
// ---------------------------------------------------------------------------
function buildActions(u) {
  const btns = [];

  if (u.status === 'Pending') {
    btns.push(`<button title="Approve" data-action="approve" data-id="${u.id}" data-role="${u.role}" data-name="${u.full_name}"><i class="fas fa-check"></i></button>`);
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

      if (action === 'approve') {
        if (role === 'student') {
          // T-18: Student approval requires linking a student record
          document.getElementById('confirmModalTitle').innerHTML =
            '<i class="fas fa-check"></i> Approve Student Account';
          document.getElementById('confirmModalMessage').textContent =
            `Approve account for "${name}". Search for and select the student record to link.`;
          document.getElementById('confirmModalExtra').innerHTML = `
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
            <p id="student-link-error" class="error-msg"></p>`;
          document.getElementById('confirmModalOk').textContent = 'Approve & Link';
          document.getElementById('confirmModal').classList.add('open');

          // Wire search
          const doStudentSearch = async () => {
            const q = document.getElementById('student-link-search').value.trim();
            if (!q) return;
            const res  = await api.get(`/api/students?q=${encodeURIComponent(q)}&status=Active`);
            const data = await res.json();
            const results = document.getElementById('student-link-results');
            const list = res.ok ? (data.data || []) : [];
            if (!list.length) {
              results.innerHTML = '<p class="dash-muted-intro" style="padding:8px 12px;">No students found.</p>';
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

            results.querySelectorAll('[data-action="select-student-record"]').forEach(btn => {
              btn.addEventListener('click', () => {
                document.getElementById('selected-student-record-id').value = btn.dataset.studentId;
                document.getElementById('selected-student-label').textContent =
                  `\u2714 Selected: ${btn.dataset.studentLabel}`;
                document.getElementById('student-link-results').innerHTML = '';
                document.getElementById('student-link-search').value = '';
              });
            });
          };

          document.getElementById('btnSearchStudentLink').addEventListener('click', doStudentSearch);
          document.getElementById('student-link-search').addEventListener('keydown', e => {
            if (e.key === 'Enter') doStudentSearch();
          });

          // Override confirm button
          const okBtn = document.getElementById('confirmModalOk');
          const newOk = okBtn.cloneNode(true);
          okBtn.parentNode.replaceChild(newOk, okBtn);
          newOk.addEventListener('click', async () => {
            const recordId = document.getElementById('selected-student-record-id').value;
            const errEl    = document.getElementById('student-link-error');
            if (!recordId) {
              if (errEl) errEl.textContent = 'Please select a student record first.';
              return;
            }
            const res = await api.patch(`/api/users/${id}/status`, {
              status: 'Active',
              student_record_id: parseInt(recordId, 10),
            });
            const d = await res.json();
            if (!res.ok) {
              if (errEl) errEl.textContent = d.error || 'Failed to approve.';
              return;
            }
            document.getElementById('confirmModal').classList.remove('open');
            document.getElementById('confirmModalOk').textContent = 'Confirm';
            loadUsers();
          });
        } else {
          // Non-student approval — simple confirm
          confirmAction(
            `Approve account for "${name}"?`,
            async () => {
              const res = await api.patch(`/api/users/${id}/status`, { status: 'Active' });
              if (res.ok) loadUsers();
              else { const d = await res.json(); alert(d.error || 'Failed to approve.'); }
            }
          );
        }
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
          '<textarea id="reject-reason-input" placeholder="Optional rejection reason..." style="width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--border);border-radius:8px;font-size:.88rem;resize:vertical;min-height:70px;"></textarea>'
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
              <div style="display:flex;align-items:center;gap:8px;margin-top:8px;">
                <code id="tempPwDisplay" style="flex:1;background:var(--maroon-faint);padding:10px 14px;border-radius:8px;font-size:1rem;font-weight:700;letter-spacing:.05em;border:1px solid var(--border);">${escaped}</code>
                <button class="btn-maroon btn-sm" onclick="navigator.clipboard.writeText('${d.temp_password}').then(()=>this.textContent='Copied!').catch(()=>{})">Copy</button>
              </div>`;
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
