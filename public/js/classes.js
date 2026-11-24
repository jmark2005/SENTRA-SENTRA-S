'use strict';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escC(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function activePill(isActive) {
  return isActive
    ? '<span class="status-pill status-enrolled">Active</span>'
    : '<span class="status-pill status-inactive">Inactive</span>';
}

// ─── Load & Render ────────────────────────────────────────────────────────────
async function loadClasses() {
  const tbody   = document.getElementById('classTableBody');
  const countEl = document.getElementById('classCount');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Loading\u2026</td></tr>';

  try {
    const r = await api.get('/api/classes');
    const d = await r.json();
    const classes = r.ok ? (d.data || []) : [];

    if (countEl) countEl.textContent = `Showing ${classes.length} class(es).`;

    if (!classes.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No classes found. Click Add Class to create one.</td></tr>';
      return;
    }

    tbody.innerHTML = classes.map(c => `
      <tr>
        <td>${escC(c.name)}</td>
        <td>${escC(c.grade_level)} \u2014 ${escC(c.section)}</td>
        <td>${escC(c.school_year)}</td>
        <td>${escC(c.semester)}</td>
        <td>${activePill(c.is_active)}</td>
        <td>
          <div class="row-actions">
            <button title="Manage Students" class="btn-icon"
              data-action="manage-students" data-id="${c.id}" data-name="${escC(c.name)}">
              <i class="fas fa-users"></i>
            </button>
            <button title="Assign Teachers" class="btn-icon"
              data-action="assign-teachers" data-id="${c.id}" data-name="${escC(c.name)}">
              <i class="fas fa-chalkboard-teacher"></i>
            </button>
            <button title="${c.is_active ? 'Deactivate' : 'Activate'}"
              class="btn-icon${c.is_active ? ' btn-danger' : ''}"
              data-action="toggle-active" data-id="${c.id}"
              data-name="${escC(c.name)}" data-active="${c.is_active}">
              <i class="fas ${c.is_active ? 'fa-toggle-off' : 'fa-toggle-on'}"></i>
            </button>
          </div>
        </td>
      </tr>`).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty">Error: ${escC(err.message)}</td></tr>`;
  }
}

// ─── Class Modal open / close ─────────────────────────────────────────────────
function openClassModal() {
  document.getElementById('classModal').classList.add('open');
}
function closeClassModal() {
  document.getElementById('classModal').classList.remove('open');
}

// ─── Add Class ────────────────────────────────────────────────────────────────
function showAddClassModal() {
  document.getElementById('classModalTitle').innerHTML =
    '<i class="fas fa-plus"></i> Add Class';
  document.getElementById('classModalBody').innerHTML = classFormHtml({});
  document.getElementById('classModalFooter').innerHTML = `
    <button class="btn-soft btn-sm" id="classCancelBtn">Cancel</button>
    <button class="btn-maroon btn-sm" id="classSaveBtn" data-mode="add">
      <i class="fas fa-check"></i> Add Class
    </button>`;
  wireClassSaveBtn();
  document.getElementById('classCancelBtn').addEventListener('click', closeClassModal);
  openClassModal();
}

// ─── Manage Students ─────────────────────────────────────────────────────────
async function showManageStudentsModal(classId, className) {
  document.getElementById('classModalTitle').innerHTML =
    `<i class="fas fa-users"></i> Manage Students \u2014 ${escC(className)}`;
  document.getElementById('classModalBody').innerHTML =
    '<p class="modal-loading">Loading\u2026</p>';
  document.getElementById('classModalFooter').innerHTML =
    '<button class="btn-soft btn-sm" id="classCancelBtn">Close</button>';
  document.getElementById('classCancelBtn').addEventListener('click', closeClassModal);
  openClassModal();

  const r = await api.get(`/api/classes/${classId}`);
  const cls = await r.json();
  if (!r.ok) {
    document.getElementById('classModalBody').innerHTML =
      `<p class="error-msg">${escC(cls.error || 'Failed to load.')}</p>`;
    return;
  }

  renderManageStudentsBody(classId, className, cls.students || []);
}

function renderManageStudentsBody(classId, className, students) {
  const body = document.getElementById('classModalBody');
  body.innerHTML = `
    <div class="class-student-search">
      <input id="studentAddSearch" class="search-input" type="text"
        placeholder="Search student by name or number\u2026" />
      <button class="btn-maroon btn-sm" id="btnFindStudent">
        <i class="fas fa-search"></i> Find
      </button>
    </div>
    <div id="studentSearchResults" class="class-search-results"></div>
    <div class="info-section-title">
      <i class="fas fa-users"></i> Enrolled (${students.length})
    </div>
    <div id="enrolledStudentsList">
      ${students.length
        ? students.map(s => `
          <div class="class-student-row">
            <span>${escC(s.last_name)}, ${escC(s.first_name)}
              <small>(${escC(s.student_number)})</small></span>
            <button class="btn-icon btn-danger"
              data-action="remove-student"
              data-class-id="${classId}"
              data-class-name="${escC(className)}"
              data-student-id="${s.id}"
              data-name="${escC(s.last_name + ', ' + s.first_name)}"
              title="Remove">
              <i class="fas fa-xmark"></i>
            </button>
          </div>`).join('')
        : '<p class="dash-muted-intro">No students assigned yet.</p>'
      }
    </div>
    <p id="manageStudentError" class="error-msg"></p>`;

  // Wire search
  async function doSearch() {
    const q = document.getElementById('studentAddSearch').value.trim();
    if (!q) return;
    const res  = await api.get(`/api/students?q=${encodeURIComponent(q)}&status=Active`);
    const data = await res.json();
    const resultsEl = document.getElementById('studentSearchResults');
    const list = res.ok ? (data.data || []) : [];

    if (!list.length) {
      resultsEl.innerHTML = '<p class="dash-muted-intro" style="padding:8px 12px;">No students found.</p>';
      return;
    }
    resultsEl.innerHTML = list.map(s => `
      <div class="class-student-row">
        <span>${escC(s.last_name)}, ${escC(s.first_name)}
          <small>(${escC(s.student_number)})</small></span>
        <button class="btn-maroon btn-sm"
          data-action="add-student"
          data-class-id="${classId}"
          data-class-name="${escC(className)}"
          data-student-id="${s.id}"
          data-name="${escC(s.last_name + ', ' + s.first_name)}">
          <i class="fas fa-plus"></i> Add
        </button>
      </div>`).join('');
  }

  document.getElementById('btnFindStudent').addEventListener('click', doSearch);
  document.getElementById('studentAddSearch').addEventListener('keydown', e => {
    if (e.key === 'Enter') doSearch();
  });

  // Event delegation for add / remove within modal body
  body.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, classId: cid, className: cname, studentId, name } = btn.dataset;

    if (action === 'add-student') {
      const res = await api.post(`/api/classes/${cid}/students`,
        { student_ids: [parseInt(studentId, 10)] });
      const d   = await res.json();
      const errEl = document.getElementById('manageStudentError');
      if (!res.ok && res.status !== 207) {
        if (errEl) errEl.textContent = d.error || 'Failed to add student.';
        return;
      }
      if (d.errors && d.errors.length > 0) {
        if (errEl) errEl.textContent = d.errors[0].error || 'Student already assigned this semester.';
        return;
      }
      if (errEl) errEl.textContent = '';
      await showManageStudentsModal(cid, cname);
    }

    if (action === 'remove-student') {
      const doRemove = async () => {
        const res = await api.del(`/api/classes/${cid}/students/${studentId}`);
        if (res.ok) {
          await showManageStudentsModal(cid, cname);
        } else {
          const d = await res.json();
          alert(d.error || 'Remove failed.');
        }
      };
      if (typeof confirmAction === 'function') {
        confirmAction(`Remove "${name}" from this class?`, doRemove);
      } else {
        if (confirm(`Remove "${name}" from this class?`)) doRemove();
      }
    }
  });
}

// ─── Assign Teachers ──────────────────────────────────────────────────────────
async function showAssignTeachersModal(classId, className) {
  document.getElementById('classModalTitle').innerHTML =
    `<i class="fas fa-chalkboard-teacher"></i> Assign Teachers \u2014 ${escC(className)}`;
  document.getElementById('classModalBody').innerHTML =
    '<p class="modal-loading">Loading\u2026</p>';
  document.getElementById('classModalFooter').innerHTML = '';
  openClassModal();

  const [classRes, usersRes] = await Promise.all([
    api.get(`/api/classes/${classId}`),
    api.get('/api/users?role=teacher&limit=200'),
  ]);
  const classData = await classRes.json();
  const usersData = await usersRes.json();

  if (!classRes.ok) {
    document.getElementById('classModalBody').innerHTML =
      `<p class="error-msg">${escC(classData.error || 'Failed to load.')}</p>`;
    return;
  }

  const currentIds  = new Set((classData.teachers || []).map(t => t.id));
  const allTeachers = usersRes.ok ? (usersData.data || []) : [];

  document.getElementById('classModalBody').innerHTML = `
    <p class="dash-muted-intro">Select teachers to assign. Uncheck to remove.</p>
    <div id="teacherCheckList" class="teacher-check-list">
      ${allTeachers.length
        ? allTeachers.map(t => `
          <label class="toggle-label teacher-check-item">
            <input type="checkbox" class="teacher-checkbox"
              value="${t.id}" ${currentIds.has(t.id) ? 'checked' : ''} />
            <span>${escC(t.full_name)} <small>(${escC(t.username)})</small></span>
          </label>`).join('')
        : '<p class="dash-muted-intro">No teacher accounts found.</p>'
      }
    </div>
    <p id="teacherAssignError" class="error-msg"></p>`;

  document.getElementById('classModalFooter').innerHTML = `
    <button class="btn-soft btn-sm" id="classCancelBtn">Cancel</button>
    <button class="btn-maroon btn-sm" id="classSaveTeachersBtn">
      <i class="fas fa-check"></i> Save Teachers
    </button>`;

  document.getElementById('classCancelBtn').addEventListener('click', closeClassModal);
  document.getElementById('classSaveTeachersBtn').addEventListener('click', async () => {
    const checked = [...document.querySelectorAll('.teacher-checkbox:checked')]
      .map(el => parseInt(el.value, 10));
    const res = await api.patch(`/api/classes/${classId}`, { teacher_ids: checked });
    const d   = await res.json();
    if (!res.ok) {
      const errEl = document.getElementById('teacherAssignError');
      if (errEl) errEl.textContent = d.error || 'Failed to save teachers.';
      return;
    }
    closeClassModal();
    loadClasses();
  });
}

// ─── Class form + save ────────────────────────────────────────────────────────
function classFormHtml(c) {
  const semOpts = ['1st Semester', '2nd Semester'].map(s =>
    `<option${c.semester === s ? ' selected' : ''}>${escC(s)}</option>`).join('');
  return `
    <div class="field-row">
      <div class="field">
        <label>Class Name *</label>
        <input id="cf_name" value="${escC(c.name)}" placeholder="e.g. Grade 11 \u2014 Section A" />
      </div>
      <div class="field">
        <label>Grade Level *</label>
        <input id="cf_grade_level" value="${escC(c.grade_level)}" placeholder="e.g. 11" />
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label>Section *</label>
        <input id="cf_section" value="${escC(c.section)}" placeholder="e.g. A" />
      </div>
      <div class="field">
        <label>School Year *</label>
        <input id="cf_school_year" value="${escC(c.school_year)}" placeholder="2026\u20132027" />
      </div>
    </div>
    <div class="field">
      <label>Semester *</label>
      <select id="cf_semester" class="filter-select">
        <option value="" disabled${!c.semester ? ' selected' : ''}>Select\u2026</option>
        ${semOpts}
      </select>
    </div>
    <p id="classFormError" class="error-msg"></p>`;
}

function wireClassSaveBtn() {
  const saveBtn = document.getElementById('classSaveBtn');
  if (!saveBtn) return;
  saveBtn.addEventListener('click', async () => {
    const fv    = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const errEl = document.getElementById('classFormError');
    if (errEl) errEl.textContent = '';

    const data = {
      name:        fv('cf_name'),
      grade_level: fv('cf_grade_level'),
      section:     fv('cf_section'),
      school_year: fv('cf_school_year'),
      semester:    fv('cf_semester'),
    };

    if (!data.name || !data.grade_level || !data.section ||
        !data.school_year || !data.semester) {
      if (errEl) errEl.textContent = 'Please fill in all required fields (*).';
      return;
    }

    const r = saveBtn.dataset.mode === 'add'
      ? await api.post('/api/classes', data)
      : await api.patch(`/api/classes/${saveBtn.dataset.id}`, data);

    const result = await r.json();
    if (!r.ok) {
      if (errEl) errEl.textContent = result.error || 'Save failed.';
      return;
    }
    closeClassModal();
    loadClasses();
  });
}

// ─── DOMContentLoaded ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Modal close button and backdrop
  const closeBtn = document.getElementById('classModalClose');
  if (closeBtn) closeBtn.addEventListener('click', closeClassModal);
  const overlay = document.getElementById('classModal');
  if (overlay) overlay.addEventListener('click', e => {
    if (e.target === overlay) closeClassModal();
  });

  // Add Class button
  const addBtn = document.getElementById('btnAddClass');
  if (addBtn) addBtn.addEventListener('click', showAddClassModal);

  // Table row delegation
  const tbody = document.getElementById('classTableBody');
  if (tbody) {
    tbody.addEventListener('click', async e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const { action, id, name } = btn.dataset;
      const isActive = btn.dataset.active === '1' || btn.dataset.active === 'true';

      if (action === 'manage-students')  showManageStudentsModal(id, name);
      if (action === 'assign-teachers')  showAssignTeachersModal(id, name);
      if (action === 'toggle-active') {
        const willActivate = !isActive;
        const label = willActivate ? 'Activate' : 'Deactivate';
        const doToggle = async () => {
          const res = await api.patch(`/api/classes/${id}`, { is_active: willActivate ? 1 : 0 });
          if (res.ok) loadClasses();
          else { const d = await res.json(); alert(d.error || `${label} failed.`); }
        };
        if (typeof confirmAction === 'function') {
          confirmAction(`${label} class "${name}"?`, doToggle);
        } else {
          if (confirm(`${label} class "${name}"?`)) doToggle();
        }
      }
    });
  }

  // Auto-load on nav click
  document.querySelectorAll('.dash-nav-item[data-section="classes"]').forEach(link => {
    link.addEventListener('click', loadClasses);
  });
});
