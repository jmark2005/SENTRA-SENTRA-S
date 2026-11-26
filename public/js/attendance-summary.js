/**
 * public/js/attendance-summary.js — attendance summary view (T-31B).
 *
 * Exposes window.initAttendanceSummary({ rootId }). Calls
 * GET /api/attendance/summary with the chosen filters and shows present,
 * absent, tardy and attendance % per student. Teachers see their own classes;
 * Guidance, School Head and SysAdmin see all (the server enforces scope).
 * SysAdmin also gets Archive / Restore for a class and semester, and a view of
 * archived records. Writes go through api.js.
 */
'use strict';

(function (global) {

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  var _me = null;
  function getMe() {
    if (!_me) {
      _me = api.get('/api/auth/me')
        .then(function (r) { return r.ok ? r.json() : {}; })
        .catch(function () { _me = null; return {}; });
    }
    return _me;
  }

  function shellHtml(isAdmin) {
    return (
      '<div class="panel-card">' +
        '<div class="panel-card-header">' +
          '<div class="panel-card-title"><i class="fas fa-chart-column"></i> Attendance Summary</div>' +
        '</div>' +
        '<p class="dash-muted-intro">Counts per student from recorded attendance. Attendance % counts Present and Tardy as attended.</p>' +
        '<div class="sum-filters">' +
          '<div class="field"><label for="sumClass">Class</label><select id="sumClass" data-sum="class"><option value="">All classes</option></select></div>' +
          '<div class="field"><label for="sumSection">Section</label><input type="text" id="sumSection" data-sum="section" placeholder="Any" /></div>' +
          '<div class="field"><label for="sumSemester">Semester</label><select id="sumSemester" data-sum="semester">' +
            '<option value="">Any</option><option>1st Semester</option><option>2nd Semester</option></select></div>' +
          '<div class="field"><label for="sumYear">School year</label><input type="text" id="sumYear" data-sum="school_year" placeholder="e.g. 2026–2027" /></div>' +
          '<div class="field"><label for="sumFrom">From</label><input type="date" id="sumFrom" data-sum="from" /></div>' +
          '<div class="field"><label for="sumTo">To</label><input type="date" id="sumTo" data-sum="to" /></div>' +
          '<div class="field"><label for="sumStatus">Show</label><select id="sumStatus" data-sum="status">' +
            '<option value="">All students</option><option value="Absent">With absences</option><option value="Tardy">With tardies</option></select></div>' +
          '<div class="field"><label for="sumStudent">Student</label><input type="text" id="sumStudent" data-sum="student" placeholder="Name or number" /></div>' +
        '</div>' +
        '<div class="sum-actions">' +
          (isAdmin
            ? '<label class="sum-archived"><input type="checkbox" data-sum="archived" /> Show archived records</label>' +
              '<button type="button" class="btn-soft btn-sm" data-sum="archive" disabled><i class="fas fa-box-archive"></i> Archive Class Attendance</button>' +
              '<button type="button" class="btn-soft btn-sm" data-sum="restore" disabled><i class="fas fa-box-open"></i> Restore Class Attendance</button>'
            : '') +
          '<button type="button" class="btn-maroon btn-sm" data-sum="apply"><i class="fas fa-filter"></i> Apply Filters</button>' +
        '</div>' +
        '<p class="settings-success-msg u-hidden" data-sum="success" role="status"></p>' +
        '<p class="error-msg" data-sum="error" role="alert"></p>' +
        '<div class="data-table-wrap">' +
          '<table class="data-table">' +
            '<thead><tr><th>Student</th><th>Class</th><th>Days</th><th>Present</th><th>Absent</th><th>Tardy</th><th>Attendance</th></tr></thead>' +
            '<tbody data-sum="rows"><tr><td colspan="7" class="table-empty">Loading…</td></tr></tbody>' +
          '</table>' +
        '</div>' +
        '<div class="table-meta" data-sum="meta"></div>' +
      '</div>'
    );
  }

  function setup(root, isAdmin) {
    function el(name) { return root.querySelector('[data-sum="' + name + '"]'); }
    var classes = [];
    var rows = [];

    function selectedClass() {
      var id = parseInt(el('class').value, 10);
      return classes.find(function (c) { return c.id === id; }) || null;
    }

    function updateAdminButtons() {
      if (!isAdmin) return;
      var c = selectedClass();
      var archivedView = el('archived').checked;
      el('archive').disabled = !c || archivedView;
      el('restore').disabled = !c;
    }

    function render() {
      var q = el('student').value.trim().toLowerCase();
      var shown = q
        ? rows.filter(function (r) {
            return (r.last_name + ', ' + r.first_name).toLowerCase().indexOf(q) !== -1
              || String(r.student_number).toLowerCase().indexOf(q) !== -1;
          })
        : rows;
      el('rows').innerHTML = shown.length
        ? shown.map(function (r) {
            return (
              '<tr>' +
                '<td><strong>' + esc(r.last_name + ', ' + r.first_name) + '</strong><br><small class="muted-inline">' + esc(r.student_number) + '</small></td>' +
                '<td>' + esc(r.class_name) + '<br><small class="muted-inline">' + esc(r.semester) + ' · ' + esc(r.school_year) + '</small></td>' +
                '<td>' + r.total_days + '</td>' +
                '<td>' + r.present + '</td>' +
                '<td>' + r.absent + '</td>' +
                '<td>' + r.tardy + '</td>' +
                '<td><strong>' + (r.attendance_rate === null ? '—' : r.attendance_rate + '%') + '</strong></td>' +
              '</tr>'
            );
          }).join('')
        : '<tr><td colspan="7" class="table-empty">No attendance data for these filters.</td></tr>';
      el('meta').textContent = shown.length + ' student' + (shown.length === 1 ? '' : 's') +
        (isAdmin && el('archived').checked ? ' (archived records)' : '') + '.';
    }

    async function load() {
      el('error').textContent = '';
      var params = [];
      ['class', 'section', 'semester', 'school_year', 'from', 'to', 'status'].forEach(function (k) {
        var v = el(k).value.trim();
        if (v) params.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
      });
      if (isAdmin && el('archived').checked) params.push('archived=1');
      el('rows').innerHTML = '<tr><td colspan="7" class="table-empty">Loading…</td></tr>';
      try {
        var r = await api.get('/api/attendance/summary' + (params.length ? '?' + params.join('&') : ''));
        var d = await r.json();
        if (!r.ok) {
          rows = [];
          el('rows').innerHTML = '<tr><td colspan="7" class="table-empty">—</td></tr>';
          el('meta').textContent = '';
          el('error').textContent = d.error || 'Could not load the summary.';
          return;
        }
        rows = d.data || [];
        render();
      } catch (_) {
        el('error').textContent = 'Could not load the summary.';
      }
    }

    function archiveOrRestore(action) {
      var c = selectedClass();
      if (!c) return;
      var msg = action === 'archive'
        ? 'Archive all attendance for ' + c.name + ' (' + c.semester + ', ' + c.school_year + ')? ' +
          'The records will be hidden from summaries and attendance views until restored.'
        : 'Restore the archived attendance for ' + c.name + ' (' + c.semester + ', ' + c.school_year + ')?';
      var go = async function () {
        el('error').textContent = '';
        el('success').classList.add('u-hidden');
        try {
          var r = await api.patch('/api/attendance/' + action, { class_id: c.id, semester: c.semester });
          var d = await r.json();
          if (!r.ok) { el('error').textContent = d.error || 'Request failed.'; return; }
          el('success').textContent = (action === 'archive' ? 'Archived ' : 'Restored ') + d.records +
            ' attendance record' + (d.records === 1 ? '' : 's') + ' for ' + c.name + '.';
          el('success').classList.remove('u-hidden');
          load();
        } catch (_) {
          el('error').textContent = 'Network error. Please try again.';
        }
      };
      if (typeof global.confirmAction === 'function') global.confirmAction(msg, go); else go();
    }

    el('apply').addEventListener('click', load);
    el('student').addEventListener('input', render);
    ['class', 'semester', 'status', 'from', 'to'].forEach(function (k) {
      el(k).addEventListener('change', function () { updateAdminButtons(); load(); });
    });
    ['section', 'school_year'].forEach(function (k) {
      el(k).addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); load(); } });
    });
    if (isAdmin) {
      el('archived').addEventListener('change', function () { updateAdminButtons(); load(); });
      el('archive').addEventListener('click', function () { archiveOrRestore('archive'); });
      el('restore').addEventListener('click', function () { archiveOrRestore('restore'); });
    }

    async function loadClasses() {
      try {
        var r = await api.get('/api/attendance/classes?all=1&include_inactive=1');
        var d = await r.json();
        classes = r.ok ? (d.data || []) : [];
        el('class').innerHTML = '<option value="">All classes</option>' + classes.map(function (c) {
          return '<option value="' + c.id + '">' + esc(c.name) + ' — ' + esc(c.semester) + ', ' + esc(c.school_year) +
            (c.is_active ? '' : ' (inactive)') + '</option>';
        }).join('');
      } catch (_) { /* filter stays at "All classes" */ }
    }

    return { load: load, loadClasses: loadClasses };
  }

  async function initAttendanceSummary(cfg) {
    var root = document.getElementById((cfg && cfg.rootId) || 'attendanceSummaryRoot');
    if (!root) return;
    if (root.getAttribute('data-ready') === '1') {
      if (root._sentraSummary) root._sentraSummary.load();
      return;
    }
    root.setAttribute('data-ready', '1');
    var me = await getMe();
    var isAdmin = me.role === 'sysadmin';
    root.innerHTML = shellHtml(isAdmin);
    var ctl = setup(root, isAdmin);
    root._sentraSummary = ctl;
    await ctl.loadClasses();
    ctl.load();
  }

  global.initAttendanceSummary = initAttendanceSummary;

})(window);
