'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
const studentsState = {
  students:     [],
  showArchived: false,
  searchQuery:  '',
  filterYear:   '',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escHtml(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function statusPill(status) {
  const cls = status === 'Active' ? 'status-enrolled' : 'status-inactive';
  return `<span class="status-pill ${cls}">${escHtml(status)}</span>`;
}

function avatarInitials(last, first) {
  const a = (last  || '').trim()[0] || '';
  const b = (first || '').trim()[0] || '';
  return (a + b).toUpperCase() || '?';
}

// ─── Load & Render ────────────────────────────────────────────────────────────
async function loadStudents() {
  const tbody   = document.getElementById('studentTableBody');
  const countEl = document.getElementById('studentCount');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="6" class="table-empty">Loading…</td></tr>`;

  try {
    if (studentsState.showArchived) {
      const r = await api.get('/api/students/archived');
      const d = await r.json();
      studentsState.students = r.ok ? (d.data || []) : [];
    } else {
      let url = '/api/students?status=Active';
      if (studentsState.filterYear)  url += `&school_year=${encodeURIComponent(studentsState.filterYear)}`;
      if (studentsState.searchQuery) url += `&q=${encodeURIComponent(studentsState.searchQuery)}`;
      const r = await api.get(url);
      const d = await r.json();
      studentsState.students = r.ok ? (d.data || []) : [];
    }
  } catch (_) {
    studentsState.students = [];
  }

  renderStudentTable();
  if (countEl) countEl.textContent = `Showing ${studentsState.students.length} student(s).`;
}

function renderStudentTable() {
  const tbody = document.getElementById('studentTableBody');
  if (!tbody) return;

  if (!studentsState.students.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty">No students found.</td></tr>`;
    return;
  }

  tbody.innerHTML = studentsState.students.map(s => {
    const archiveBtn = s.status === 'Active'
      ? `<button title="Archive" class="btn-icon btn-danger" data-action="archive-student"
           data-id="${s.id}" data-name="${escHtml(s.last_name + ', ' + s.first_name)}">
           <i class="fas fa-box-archive"></i></button>`
      : `<button title="Restore" class="btn-icon" data-action="restore-student"
           data-id="${s.id}" data-name="${escHtml(s.last_name + ', ' + s.first_name)}">
           <i class="fas fa-rotate-left"></i></button>`;

    return `
      <tr>
        <td>
          <div class="student-name">
            <div class="student-avatar">${avatarInitials(s.last_name, s.first_name)}</div>
            <div class="student-meta">
              ${escHtml(s.last_name)}, ${escHtml(s.first_name)}${s.middle_initial ? ' ' + escHtml(s.middle_initial) + '.' : ''}
              <small>${escHtml(s.grade_level)} — ${escHtml(s.section)}</small>
            </div>
          </div>
        </td>
        <td>${escHtml(s.student_number)}</td>
        <td>${escHtml(s.grade_level)} — ${escHtml(s.section)}</td>
        <td>${escHtml(s.school_year)}</td>
        <td>${statusPill(s.status)}</td>
        <td>
          <div class="row-actions">
            <button title="View" class="btn-icon" data-action="view-student" data-id="${s.id}">
              <i class="fas fa-eye"></i>
            </button>
            <button title="Edit" class="btn-icon" data-action="edit-student" data-id="${s.id}">
              <i class="fas fa-pen"></i>
            </button>
            ${archiveBtn}
          </div>
        </td>
      </tr>`;
  }).join('');
}

// ─── Modal open / close ────────────────────────────────────────────────────────
function openStudentModal() {
  document.getElementById('studentModal').classList.add('open');
}

function closeStudentModal() {
  document.getElementById('studentModal').classList.remove('open');
}

// ─── Add Student modal ────────────────────────────────────────────────────────
function showAddModal() {
  document.getElementById('studentModalTitle').innerHTML =
    '<i class="fas fa-user-plus"></i> Add Student';
  document.getElementById('studentModalBody').innerHTML = studentFormHtml({});
  document.getElementById('studentModalFooter').innerHTML = `
    <button class="btn-soft btn-sm" id="stuCancelBtn">Cancel</button>
    <button class="btn-maroon btn-sm" id="stuSaveBtn" data-mode="add">
      <i class="fas fa-check"></i> Add Student
    </button>`;
  wireModalFooter();
  openStudentModal();
}

// ─── View Student modal (tabs: Profile, Incidents, Referrals) ─────────────────
async function showViewModal(id) {
  document.getElementById('studentModalTitle').innerHTML =
    '<i class="fas fa-id-card"></i> Student Record';
  document.getElementById('studentModalBody').innerHTML =
    '<p class="modal-loading">Loading…</p>';
  document.getElementById('studentModalFooter').innerHTML = '';
  openStudentModal();

  const r = await api.get(`/api/students/${id}`);
  const s = await r.json();
  if (!r.ok) {
    document.getElementById('studentModalBody').innerHTML =
      `<p class="error-msg">${escHtml(s.error || 'Failed to load.')}</p>`;
    return;
  }

  document.getElementById('studentModalBody').innerHTML = `
    <div class="tab-bar">
      <button class="tab-btn tab-active" data-tab="profile">Profile</button>
      <button class="tab-btn" data-tab="incidents">Incidents (${s.incident_count ?? 0})</button>
      <button class="tab-btn" data-tab="referrals">Referrals (${s.referral_count ?? 0})</button>
    </div>

    <div class="tab-pane tab-pane-active" id="tab-profile">
      <div class="info-section-title"><i class="fas fa-user"></i> Personal Information</div>
      <div class="info-grid">
        <div class="info-item"><label>Last Name</label><span>${escHtml(s.last_name)}</span></div>
        <div class="info-item"><label>First Name</label><span>${escHtml(s.first_name)}</span></div>
        <div class="info-item"><label>Middle Initial</label><span>${escHtml(s.middle_initial || '—')}</span></div>
        <div class="info-item"><label>Student Number</label><span>${escHtml(s.student_number)}</span></div>
        <div class="info-item"><label>Grade Level</label><span>${escHtml(s.grade_level)}</span></div>
        <div class="info-item"><label>Section</label><span>${escHtml(s.section)}</span></div>
        <div class="info-item"><label>School Year</label><span>${escHtml(s.school_year)}</span></div>
        <div class="info-item"><label>Status</label><span>${statusPill(s.status)}</span></div>
      </div>
      <div class="info-section-title"><i class="fas fa-address-book"></i> Guardian</div>
      <div class="info-grid">
        <div class="info-item"><label>Guardian Name</label><span>${escHtml(s.guardian_name || '—')}</span></div>
        <div class="info-item"><label>Guardian Contact</label><span>${escHtml(s.guardian_contact || '—')}</span></div>
      </div>
    </div>

    <div class="tab-pane" id="tab-incidents">
      <p class="dash-muted-intro">
        This student is linked to <strong>${s.incident_count ?? 0}</strong> incident(s).
        Full incident details are visible in the Incident Reporting section.
      </p>
    </div>

    <div class="tab-pane" id="tab-referrals">
      <p class="dash-muted-intro">
        This student has <strong>${s.referral_count ?? 0}</strong> referral(s)
        and <strong>${s.attendance_count ?? 0}</strong> attendance record(s).
        Full details are visible in the Support Services and Attendance sections.
      </p>
    </div>`;

  // Wire tab switching
  document.querySelectorAll('#studentModalBody .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#studentModalBody .tab-btn').forEach(b => b.classList.remove('tab-active'));
      document.querySelectorAll('#studentModalBody .tab-pane').forEach(p => p.classList.remove('tab-pane-active'));
      btn.classList.add('tab-active');
      const pane = document.getElementById(`tab-${btn.dataset.tab}`);
      if (pane) pane.classList.add('tab-pane-active');
    });
  });

  document.getElementById('studentModalFooter').innerHTML = `
    <button class="btn-soft btn-sm" id="stuCancelBtn">Close</button>
    <button class="btn-maroon btn-sm" data-action="edit-student" data-id="${id}">
      <i class="fas fa-pen"></i> Edit
    </button>`;
  wireModalFooter();
}

// ─── Edit Student modal ────────────────────────────────────────────────────────
async function showEditModal(id) {
  document.getElementById('studentModalTitle').innerHTML =
    '<i class="fas fa-pen"></i> Edit Student';
  document.getElementById('studentModalBody').innerHTML =
    '<p class="modal-loading">Loading…</p>';
  document.getElementById('studentModalFooter').innerHTML = '';
  openStudentModal();

  const r = await api.get(`/api/students/${id}`);
  const s = await r.json();
  if (!r.ok) {
    document.getElementById('studentModalBody').innerHTML =
      `<p class="error-msg">${escHtml(s.error || 'Failed to load.')}</p>`;
    return;
  }

  document.getElementById('studentModalBody').innerHTML = studentFormHtml(s);
  document.getElementById('studentModalFooter').innerHTML = `
    <button class="btn-soft btn-sm" id="stuCancelBtn">Cancel</button>
    <button class="btn-maroon btn-sm" id="stuSaveBtn" data-mode="edit" data-id="${id}">
      <i class="fas fa-check"></i> Save Changes
    </button>`;
  wireModalFooter();
}

// ─── Form HTML ────────────────────────────────────────────────────────────────
function studentFormHtml(s) {
  return `
    <div class="field-row">
      <div class="field">
        <label>Student Number *</label>
        <input id="f_student_number" value="${escHtml(s.student_number)}" />
      </div>
      <div class="field">
        <label>Last Name *</label>
        <input id="f_last_name" value="${escHtml(s.last_name)}" />
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label>First Name *</label>
        <input id="f_first_name" value="${escHtml(s.first_name)}" />
      </div>
      <div class="field">
        <label>Middle Initial</label>
        <input id="f_middle_initial" value="${escHtml(s.middle_initial)}" maxlength="3" />
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label>Grade Level *</label>
        <input id="f_grade_level" value="${escHtml(s.grade_level)}" />
      </div>
      <div class="field">
        <label>Section *</label>
        <input id="f_section" value="${escHtml(s.section)}" />
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label>School Year *</label>
        <input id="f_school_year" value="${escHtml(s.school_year)}" placeholder="2026–2027" />
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label>Guardian Name</label>
        <input id="f_guardian_name" value="${escHtml(s.guardian_name)}" />
      </div>
      <div class="field">
        <label>Guardian Contact</label>
        <input id="f_guardian_contact" value="${escHtml(s.guardian_contact)}" />
      </div>
    </div>
    <p id="stuFormError" class="error-msg"></p>`;
}

function getFormData() {
  const fv = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  return {
    student_number:   fv('f_student_number'),
    last_name:        fv('f_last_name'),
    first_name:       fv('f_first_name'),
    middle_initial:   fv('f_middle_initial') || null,
    grade_level:      fv('f_grade_level'),
    section:          fv('f_section'),
    school_year:      fv('f_school_year'),
    guardian_name:    fv('f_guardian_name') || null,
    guardian_contact: fv('f_guardian_contact') || null,
  };
}

async function saveStudent(mode, id) {
  const errEl = document.getElementById('stuFormError');
  if (errEl) errEl.textContent = '';

  const data = getFormData();
  if (!data.student_number || !data.last_name || !data.first_name ||
      !data.grade_level || !data.section || !data.school_year) {
    if (errEl) errEl.textContent = 'Please fill in all required fields (*).';
    return;
  }

  const r = mode === 'add'
    ? await api.post('/api/students', data)
    : await api.patch(`/api/students/${id}`, data);

  const result = await r.json();
  if (!r.ok) {
    if (errEl) errEl.textContent = result.error || 'Save failed.';
    return;
  }

  closeStudentModal();
  await loadStudents();
  refreshYearFilter();
}

// ─── Wire modal footer buttons (called after each modal body render) ───────────
function wireModalFooter() {
  const cancelBtn = document.getElementById('stuCancelBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', closeStudentModal);

  const saveBtn = document.getElementById('stuSaveBtn');
  if (saveBtn) saveBtn.addEventListener('click', () => saveStudent(saveBtn.dataset.mode, saveBtn.dataset.id));

  // Edit button inside view modal footer
  const editBtn = document.querySelector('#studentModalFooter [data-action="edit-student"]');
  if (editBtn) editBtn.addEventListener('click', () => {
    closeStudentModal();
    showEditModal(editBtn.dataset.id);
  });
}

// ─── Archive / Restore ────────────────────────────────────────────────────────
async function archiveStudent(id, name) {
  const doArchive = async () => {
    const r = await api.patch(`/api/students/${id}/archive`, {});
    if (r.ok) {
      await loadStudents();
    } else {
      const d = await r.json();
      alert(d.error || 'Archive failed.');
    }
  };

  if (typeof confirmAction === 'function') {
    confirmAction(`Archive student "${name}"? They will be hidden from search results.`, doArchive);
  } else {
    if (confirm(`Archive student "${name}"?`)) doArchive();
  }
}

async function restoreStudent(id) {
  const r = await api.patch(`/api/students/${id}/restore`, {});
  if (r.ok) {
    await loadStudents();
  } else {
    const d = await r.json();
    alert(d.error || 'Restore failed.');
  }
}

// ─── Year filter helper ────────────────────────────────────────────────────────
function refreshYearFilter() {
  const sel = document.getElementById('studentFilterYear');
  if (!sel) return;
  const years = [...new Set(studentsState.students.map(s => s.school_year).filter(Boolean))]
    .sort().reverse();
  const current = sel.value;
  sel.innerHTML = '<option value="">All School Years</option>' +
    years.map(y => `<option value="${escHtml(y)}"${y === current ? ' selected' : ''}>${escHtml(y)}</option>`).join('');
}

// ─── DOMContentLoaded ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Modal close button and backdrop click
  const modalCloseBtn = document.getElementById('studentModalClose');
  if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeStudentModal);
  const modalOverlay = document.getElementById('studentModal');
  if (modalOverlay) modalOverlay.addEventListener('click', e => {
    if (e.target === modalOverlay) closeStudentModal();
  });

  // Add Student button
  const addBtn = document.getElementById('btnAddStudent');
  if (addBtn) addBtn.addEventListener('click', showAddModal);

  // Search — debounced
  const searchInput = document.getElementById('studentSearch');
  let searchTimer;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        studentsState.searchQuery = searchInput.value.trim();
        loadStudents();
      }, 300);
    });
  }

  // Year filter
  const yearSel = document.getElementById('studentFilterYear');
  if (yearSel) {
    yearSel.addEventListener('change', () => {
      studentsState.filterYear = yearSel.value;
      loadStudents();
    });
  }

  // Show Archived toggle
  const archivedToggle = document.getElementById('showArchived');
  if (archivedToggle) {
    archivedToggle.addEventListener('change', () => {
      studentsState.showArchived = archivedToggle.checked;
      loadStudents();
    });
  }

  // Table row action delegation
  const tbody = document.getElementById('studentTableBody');
  if (tbody) {
    tbody.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const { action, id, name } = btn.dataset;
      if (action === 'view-student')    showViewModal(id);
      if (action === 'edit-student')    showEditModal(id);
      if (action === 'archive-student') archiveStudent(id, name);
      if (action === 'restore-student') restoreStudent(id);
    });
  }

  // Auto-load when the students nav item is clicked
  document.querySelectorAll('.dash-nav-item[data-section="students"]').forEach(link => {
    link.addEventListener('click', async () => {
      await loadStudents();
      refreshYearFilter();
    });
  });
});
