/**
 * public/js/reports.js — Reports panel (T-34B).
 *
 * Exposes window.initReports({ rootId }). Shows one card per report the
 * signed-in user may export, using the same rules as the server
 * (src/routes/report.routes.js and src/services/report.service.js):
 *   Incident Summary, Response Summary — view_reports + view_incidents; never Teachers
 *   Attendance Summary                 — view_reports + view_attendance
 *   Referral Summary                   — view_reports + view_referrals
 *   Audit Log                          — view_reports + view_audit_log
 * Each card has its filters and two plain GET links (CSV, PDF) to
 * /api/reports/<name>. The server sends the file as a download, scopes the
 * rows to the user's role, and records the export in the audit log.
 * School year and semester are pre-filled from System Settings.
 */
'use strict';

(function (global) {

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function options(list, anyLabel) {
    return '<option value="">' + esc(anyLabel) + '</option>' + list.map(function (o) {
      var value = typeof o === 'string' ? o : o.value;
      var label = typeof o === 'string' ? o : o.label;
      return '<option value="' + esc(value) + '">' + esc(label) + '</option>';
    }).join('');
  }

  var INCIDENT_STATUSES = ['Submitted', 'Under Review', 'Assigned', 'In Progress', 'For Follow-Up', 'Resolved', 'Closed'];
  var REFERRAL_TYPES = ['Academic Assistance', 'Guidance Referral', 'Attendance-Related Follow-Up', 'Other School-Based Support'];
  var REFERRAL_STATUSES = ['Pending', 'Ongoing', 'Completed', 'Referred'];
  var SEMESTERS = ['1st Semester', '2nd Semester'];
  // Suggestions only; any action type can be typed.
  var ACTION_TYPES = [
    'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'REPORT_EXPORTED', 'EMERGENCY_ALERT_SENT',
    'INCIDENT_SUBMITTED', 'INCIDENT_CLASSIFIED', 'INCIDENT_STATUS_CHANGED', 'INCIDENT_ASSIGNED',
    'INCIDENT_ACKNOWLEDGED', 'INCIDENT_ACTION_ADDED', 'INCIDENT_RESTRICTION_CHANGED', 'INCIDENT_CLOSED',
    'INCIDENT_ARCHIVED', 'INCIDENT_RESTORED', 'ATTACHMENT_UPLOADED', 'ATTACHMENT_DOWNLOADED',
    'REFERRAL_SUBMITTED', 'REFERRAL_ASSIGNED', 'REFERRAL_FOLLOWUP_ADDED', 'REFERRAL_STATUS_CHANGED',
    'REFERRAL_ARCHIVED', 'REFERRAL_RESTORED', 'ATTENDANCE_SUBMITTED', 'ATTENDANCE_CORRECTED',
    'ATTENDANCE_SUMMARY_VIEWED', 'ATTENDANCE_ARCHIVED', 'ATTENDANCE_RESTORED', 'ATTENDANCE_THRESHOLD_NOTICE',
    'FOLLOWUP_DUE_NOTICE', 'FOLLOWUP_OVERDUE_NOTICE', 'STUDENT_CREATED', 'STUDENT_UPDATED',
    'STUDENT_ARCHIVED', 'STUDENT_RESTORED', 'CLASS_CREATED', 'CLASS_UPDATED',
    'ACCOUNT_STATUS_CHANGED', 'PASSWORD_CHANGED', 'PASSWORD_RESET', 'ROLE_PERMISSION_CHANGED', 'SETTINGS_CHANGED',
  ];

  // ── Filter fields: param is the query-string name the server reads ──────────
  var FIELDS = {
    from:           { param: 'from',        label: 'From', type: 'date' },
    to:             { param: 'to',          label: 'To',   type: 'date' },
    category:       { param: 'category',    label: 'Category', type: 'select', any: 'All categories', list: 'categories' },
    incidentStatus: { param: 'status',      label: 'Status', type: 'select', any: 'Any status', list: INCIDENT_STATUSES },
    cls:            { param: 'class',       label: 'Class', type: 'select', any: 'All classes', list: 'classes' },
    section:        { param: 'section',     label: 'Section', type: 'text', placeholder: 'Any' },
    semester:       { param: 'semester',    label: 'Semester', type: 'select', any: 'Any', list: SEMESTERS, prefill: 'semester' },
    schoolYear:     { param: 'school_year', label: 'School year', type: 'text', placeholder: 'e.g. 2026–2027', prefill: 'school_year' },
    referralType:   { param: 'type',        label: 'Referral type', type: 'select', any: 'All types', list: REFERRAL_TYPES },
    referralStatus: { param: 'status',      label: 'Status', type: 'select', any: 'Any status', list: REFERRAL_STATUSES },
    actor:          { param: 'actor',       label: 'Actor name', type: 'text', placeholder: 'Any' },
    actionType:     { param: 'action_type', label: 'Action type', type: 'text', placeholder: 'Any', datalist: ACTION_TYPES },
  };

  function reportsFor(me) {
    var perms = new Set(me.permissions || []);
    var isTeacher = me.role === 'teacher';
    var seesNumbers = me.role === 'sysadmin' || me.role === 'schoolhead';
    if (!perms.has('view_reports')) return [];
    return [
      { key: 'incidents', title: 'Incident Summary', icon: 'fa-file-circle-exclamation',
        show: perms.has('view_incidents') && !isTeacher,
        desc: 'Reference number, category, date, severity, status, reporter and assigned personnel for each incident you can see.',
        fields: ['from', 'to', 'category', 'incidentStatus'] },
      { key: 'response', title: 'Response / Task Completion', icon: 'fa-clipboard-check',
        show: perms.has('view_incidents') && !isTeacher,
        desc: 'Resolution summary, number of actions, last action date, resolution date and who closed each incident.',
        fields: ['from', 'to'] },
      { key: 'attendance', title: 'Attendance Summary', icon: 'fa-calendar-check',
        show: perms.has('view_attendance'),
        desc: 'Absent, tardy and present counts and attendance % per student and class.' +
          (isTeacher ? ' Includes your own classes only.' : ''),
        fields: ['cls', 'section', 'semester', 'schoolYear', 'from', 'to'] },
      { key: 'referrals', title: 'Referral Summary', icon: 'fa-hand-holding-heart',
        show: perms.has('view_referrals'),
        desc: 'Number of referrals by type and status. ' + (seesNumbers
          ? 'Includes the student numbers in each group; no student names.'
          : 'Counts only; no student names or numbers.'),
        fields: ['from', 'to', 'referralType', 'referralStatus'] },
      { key: 'audit-log', title: 'Audit Log', icon: 'fa-scroll',
        show: perms.has('view_audit_log'),
        desc: 'Time, actor, role, action type, target and old/new values.' +
          (me.role === 'schoolhead' ? ' Account and permission changes are not included.' : ''),
        fields: ['from', 'to', 'actor', 'actionType'] },
    ].filter(function (r) { return r.show; });
  }

  function fieldHtml(report, name, lists) {
    var f = FIELDS[name];
    var id = 'rep-' + report.key + '-' + name;
    var control;
    if (f.type === 'select') {
      control = '<select id="' + id + '" data-param="' + f.param + '">' +
        options(typeof f.list === 'string' ? lists[f.list] : f.list, f.any) + '</select>';
    } else {
      control = '<input type="' + f.type + '" id="' + id + '" data-param="' + f.param + '"' +
        (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') +
        (f.datalist ? ' list="' + id + '-list" autocomplete="off"' : '') + ' />';
      if (f.datalist) {
        control += '<datalist id="' + id + '-list">' + f.datalist.map(function (v) {
          return '<option value="' + esc(v) + '"></option>';
        }).join('') + '</datalist>';
      }
    }
    return '<div class="field"><label for="' + id + '">' + esc(f.label) + '</label>' + control + '</div>';
  }

  function cardHtml(report, lists) {
    return (
      '<div class="panel-card rep-card" data-report="' + report.key + '">' +
        '<div class="panel-card-header">' +
          '<div class="panel-card-title"><i class="fas ' + report.icon + '"></i> ' + esc(report.title) + '</div>' +
        '</div>' +
        '<p class="dash-muted-intro rep-desc">' + esc(report.desc) + '</p>' +
        '<div class="sum-filters">' +
          report.fields.map(function (name) { return fieldHtml(report, name, lists); }).join('') +
        '</div>' +
        '<p class="error-msg" data-rep="error" role="alert"></p>' +
        '<div class="rep-links">' +
          '<a class="btn-maroon btn-sm" data-format="csv" download><i class="fas fa-file-csv"></i> Download CSV</a>' +
          '<a class="btn-soft btn-sm" data-format="pdf" download><i class="fas fa-file-pdf"></i> Download PDF</a>' +
        '</div>' +
      '</div>'
    );
  }

  /** Keeps a card's two links pointing at the report with its current filters. */
  function wireCard(card, term) {
    var key = card.getAttribute('data-report');
    var inputs = card.querySelectorAll('[data-param]');
    var links = card.querySelectorAll('[data-format]');
    var error = card.querySelector('[data-rep="error"]');

    inputs.forEach(function (input) {
      var name = input.id.replace('rep-' + key + '-', '');
      var prefill = FIELDS[name] && FIELDS[name].prefill;
      if (prefill && term[prefill]) input.value = term[prefill];
    });

    function update() {
      var params = [];
      var from = '', to = '';
      inputs.forEach(function (input) {
        var v = input.value.trim();
        if (input.dataset.param === 'from') from = v;
        if (input.dataset.param === 'to') to = v;
        if (v) params.push(encodeURIComponent(input.dataset.param) + '=' + encodeURIComponent(v));
      });
      var problem = from && to && from > to ? 'The From date must be on or before the To date.' : '';
      error.textContent = problem;
      links.forEach(function (a) {
        var href = '/api/reports/' + key + '?' + params.concat('format=' + a.dataset.format).join('&');
        a.setAttribute('href', href);
        a.classList.toggle('is-disabled', !!problem);
        a.setAttribute('aria-disabled', problem ? 'true' : 'false');
      });
    }

    links.forEach(function (a) {
      a.addEventListener('click', function (e) { if (a.classList.contains('is-disabled')) e.preventDefault(); });
    });
    card.addEventListener('input', update);
    card.addEventListener('change', update);
    update();
  }

  async function getJson(path) {
    try {
      var r = await api.get(path);
      return r.ok ? await r.json() : null;
    } catch (_) {
      return null;
    }
  }

  async function initReports(cfg) {
    var root = document.getElementById((cfg && cfg.rootId) || 'reportsRoot');
    if (!root || root.getAttribute('data-ready') === '1') return;
    root.setAttribute('data-ready', '1');
    root.innerHTML = '<div class="panel-card"><p class="table-empty">Loading reports…</p></div>';

    var me = (await getJson('/api/auth/me')) || {};
    var reports = reportsFor(me);
    if (!reports.length) {
      root.innerHTML = '<div class="panel-card"><p class="dash-muted-intro no-mb">No reports are available for your role.</p></div>';
      return;
    }

    var keys = reports.map(function (r) { return r.key; });
    var needsCategories = keys.indexOf('incidents') !== -1;
    var needsClasses = keys.indexOf('attendance') !== -1;
    var results = await Promise.all([
      needsCategories ? getJson('/api/incident-categories') : null,
      needsClasses ? getJson('/api/attendance/classes?all=1&include_inactive=1') : null,
      needsClasses ? getJson('/api/dashboard/summary') : null,
    ]);
    var lists = {
      categories: ((results[0] && results[0].data) || []).map(function (c) {
        return { value: String(c.id), label: c.name + (c.is_active === 0 ? ' (inactive)' : '') };
      }),
      classes: ((results[1] && results[1].data) || []).map(function (c) {
        return { value: String(c.id), label: c.name + ' — ' + c.semester + ', ' + c.school_year + (c.is_active ? '' : ' (inactive)') };
      }),
    };
    var term = results[2] ? { school_year: results[2].school_year, semester: results[2].semester } : {};

    root.innerHTML =
      '<div class="panel-card rep-intro">' +
        '<div class="panel-card-header">' +
          '<div class="panel-card-title"><i class="fas fa-file-export"></i> Reports</div>' +
        '</div>' +
        '<p class="dash-muted-intro no-mb">Choose filters, then download a report as CSV (for spreadsheets) or PDF (for printing). ' +
          'Leave a filter blank to include everything you are allowed to see. Every download is recorded in the audit log.</p>' +
      '</div>' +
      '<div class="rep-grid">' + reports.map(function (r) { return cardHtml(r, lists); }).join('') + '</div>';

    root.querySelectorAll('.rep-card').forEach(function (card) { wireCard(card, term); });
  }

  global.initReports = initReports;

})(window);
