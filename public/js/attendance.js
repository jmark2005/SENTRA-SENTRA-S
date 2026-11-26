/**
 * public/js/attendance.js — attendance entry and correction (T-29B).
 *
 * Exposes window.initAttendance({ rootId }). Teachers see their own classes;
 * School Head and SysAdmin see every class and may correct at any time.
 * Teachers may correct only on the record's own date (the server enforces it).
 * Every correction needs a reason. All writes go through api.js.
 */
'use strict';

(function (global) {

  var STATUSES = ['Present', 'Absent', 'Tardy'];
  var STATUS_CLASS = { Present: 'status-enrolled', Absent: 'status-inactive', Tardy: 'status-onleave' };

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function localToday() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function fmtStamp(s) {
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d.getTime())) return esc(s);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // ── Correct dialog (one per page) ──────────────────────────────────────────
  var dialog = null;

  function ensureDialog() {
    if (dialog) return dialog;
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'attendanceCorrectModal';
    overlay.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="attCorrectTitle">' +
        '<div class="modal-header">' +
          '<h3 id="attCorrectTitle"><i class="fas fa-pen"></i> Correct Attendance</h3>' +
          '<button class="modal-close" type="button" data-close aria-label="Close"><i class="fas fa-xmark"></i></button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<p class="dash-muted-intro" data-who></p>' +
          '<div class="field"><label for="attCorrectStatus">New status</label>' +
            '<select id="attCorrectStatus" data-status></select></div>' +
          '<div class="field"><label for="attCorrectReason">Reason (required)</label>' +
            '<textarea id="attCorrectReason" data-reason rows="3" maxlength="500" placeholder="e.g. Clerical error — student was present"></textarea></div>' +
          '<p class="error-msg" data-error role="alert"></p>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="btn-soft btn-sm" type="button" data-close>Cancel</button>' +
          '<button class="btn-maroon btn-sm" type="button" data-save><i class="fas fa-check"></i> Save Correction</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.closest('[data-close]')) overlay.classList.remove('open');
    });
    dialog = {
      overlay: overlay,
      who:     overlay.querySelector('[data-who]'),
      status:  overlay.querySelector('[data-status]'),
      reason:  overlay.querySelector('[data-reason]'),
      error:   overlay.querySelector('[data-error]'),
      save:    overlay.querySelector('[data-save]'),
      onSave:  null,
    };
    dialog.save.addEventListener('click', function () { if (dialog.onSave) dialog.onSave(); });
    return dialog;
  }

  function openCorrect(row, onDone) {
    var d = ensureDialog();
    d.who.textContent = row.name + ' (' + row.student_number + ') — currently ' + row.status + '.';
    d.status.innerHTML = STATUSES.filter(function (s) { return s !== row.status; })
      .map(function (s) { return '<option value="' + s + '">' + s + '</option>'; }).join('');
    d.reason.value = '';
    d.error.textContent = '';
    d.save.disabled = false;
    d.onSave = async function () {
      d.error.textContent = '';
      d.save.disabled = true;
      try {
        var r = await api.patch('/api/attendance/' + row.attendance_id, { status: d.status.value, reason: d.reason.value });
        var body = {};
        try { body = await r.json(); } catch (_) { body = {}; }
        if (!r.ok) {
          d.error.textContent = body.error || ('Correction failed (HTTP ' + r.status + ').');
          d.save.disabled = false;
          return;
        }
        d.overlay.classList.remove('open');
        onDone();
      } catch (_) {
        d.error.textContent = 'Network error. Please try again.';
        d.save.disabled = false;
      }
    };
    d.overlay.classList.add('open');
    d.reason.focus();
  }

  // ── Markup ─────────────────────────────────────────────────────────────────
  function shellHtml() {
    return (
      '<div class="panel-card">' +
        '<div class="panel-card-header">' +
          '<div class="panel-card-title"><i class="fas fa-calendar-check"></i> Attendance</div>' +
        '</div>' +
        '<p class="dash-muted-intro" data-att="intro">Loading classes…</p>' +
        '<div class="field-row">' +
          '<div class="field"><label for="attClass">Class</label><select id="attClass" data-att="class"></select></div>' +
          '<div class="field"><label for="attDate">Date</label>' +
            '<input type="date" id="attDate" data-att="date" value="' + localToday() + '" max="' + localToday() + '" /></div>' +
        '</div>' +
        '<p class="settings-success-msg u-hidden" data-att="success" role="status"></p>' +
        '<p class="error-msg" data-att="error" role="alert"></p>' +
        '<div data-att="sheet"></div>' +
      '</div>'
    );
  }

  function radioGroup(row) {
    return '<div class="att-choices" role="radiogroup" aria-label="Status for ' + esc(row.name) + '">' +
      STATUSES.map(function (s) {
        return '<label class="att-choice att-' + s.toLowerCase() + '">' +
          '<input type="radio" name="att-' + row.student_id + '" value="' + s + '" /> ' + s + '</label>';
      }).join('') + '</div>';
  }

  function sheetHtml(day) {
    var pending = day.students.filter(function (s) { return !s.status; });
    var recordedCount = day.students.length - pending.length;
    if (!day.students.length) return '<p class="table-empty">No active students are assigned to this class.</p>';

    var note = '';
    if (recordedCount && !day.can_correct) {
      note = '<p class="ia-note"><i class="fas fa-lock"></i> Corrections for past dates are made by the School Head or System Administrator.</p>';
    }

    var rows = day.students.map(function (s) {
      var cell;
      if (s.status) {
        cell = '<span class="status-pill ' + (STATUS_CLASS[s.status] || '') + '">' + esc(s.status) + '</span>' +
          (s.correction_count ? ' <small class="muted-inline">corrected ×' + s.correction_count + '</small>' : '') +
          (day.can_correct ? ' <button type="button" class="btn-soft btn-sm att-correct" data-correct="' + s.attendance_id + '">Correct</button>' : '');
        if (s.corrections && s.corrections.length) {
          cell += '<ul class="att-corrections">' + s.corrections.map(function (c) {
            return '<li>' + esc(c.old_status) + ' → ' + esc(c.new_status) + ' by ' + esc(c.corrected_by_name) +
              ' · ' + fmtStamp(c.corrected_at) + ': <em>' + esc(c.reason) + '</em></li>';
          }).join('') + '</ul>';
        }
      } else {
        cell = day.can_record ? radioGroup(s) : '<span class="muted-inline">Not recorded</span>';
      }
      return '<tr><td>' + esc(s.student_number) + '</td><td><strong>' + esc(s.name) + '</strong></td><td>' + cell + '</td></tr>';
    }).join('');

    var actions = '';
    if (pending.length && day.can_record) {
      actions =
        '<div class="att-actions">' +
          '<button type="button" class="btn-soft btn-sm" data-att="all-present"><i class="fas fa-check-double"></i> Mark all Present</button>' +
          '<button type="button" class="btn-maroon btn-sm" data-att="submit"><i class="fas fa-floppy-disk"></i> Submit Attendance (' + pending.length + ')</button>' +
        '</div>';
    }

    return note +
      '<div class="data-table-wrap"><table class="data-table">' +
        '<thead><tr><th>Student No.</th><th>Name</th><th>Status</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table></div>' +
      '<div class="table-meta">' + recordedCount + ' of ' + day.students.length + ' recorded for ' + esc(day.date) + '.</div>' +
      actions;
  }

  // ── Behaviour ──────────────────────────────────────────────────────────────
  function setup(root) {
    function el(name) { return root.querySelector('[data-att="' + name + '"]'); }
    var current = null;

    async function loadSheet() {
      var classId = el('class').value;
      var date = el('date').value;
      el('error').textContent = '';
      if (!classId) { el('sheet').innerHTML = ''; return; }
      el('sheet').innerHTML = '<p class="dash-muted-intro">Loading…</p>';
      try {
        var r = await api.get('/api/attendance/classes/' + encodeURIComponent(classId) + '/date/' + encodeURIComponent(date));
        var d = await r.json();
        if (!r.ok) { el('sheet').innerHTML = ''; el('error').textContent = d.error || 'Could not load attendance.'; return; }
        current = d;
        el('sheet').innerHTML = sheetHtml(d);
      } catch (_) {
        el('sheet').innerHTML = '';
        el('error').textContent = 'Could not load attendance.';
      }
    }

    async function submit(btn) {
      var pending = current.students.filter(function (s) { return !s.status; });
      var records = [];
      var missing = 0;
      pending.forEach(function (s) {
        var picked = root.querySelector('input[name="att-' + s.student_id + '"]:checked');
        if (picked) records.push({ student_id: s.student_id, status: picked.value });
        else missing += 1;
      });
      if (missing) {
        el('error').textContent = 'Choose a status for every student (' + missing + ' not marked).';
        return;
      }
      btn.disabled = true;
      try {
        var r = await api.post('/api/attendance/classes/' + current.class.id + '/date/' + current.date, { records: records });
        var d = await r.json();
        if (!r.ok) {
          el('error').textContent = d.error || 'Could not save attendance.';
          btn.disabled = false;
          return;
        }
        el('success').textContent = 'Attendance saved for ' + d.saved + ' student' + (d.saved === 1 ? '' : 's') +
          ' (' + current.class.name + ', ' + current.date + ').';
        el('success').classList.remove('u-hidden');
        loadSheet();
      } catch (_) {
        el('error').textContent = 'Network error. Please try again.';
        btn.disabled = false;
      }
    }

    el('class').addEventListener('change', function () { el('success').classList.add('u-hidden'); loadSheet(); });
    el('date').addEventListener('change', function () { el('success').classList.add('u-hidden'); loadSheet(); });
    el('sheet').addEventListener('click', function (e) {
      if (e.target.closest('[data-att="all-present"]')) {
        root.querySelectorAll('[data-att="sheet"] input[type="radio"][value="Present"]').forEach(function (i) { i.checked = true; });
        return;
      }
      var submitBtn = e.target.closest('[data-att="submit"]');
      if (submitBtn && !submitBtn.disabled) { el('error').textContent = ''; submit(submitBtn); return; }
      var fix = e.target.closest('[data-correct]');
      if (fix) {
        var id = parseInt(fix.getAttribute('data-correct'), 10);
        var row = current.students.find(function (s) { return s.attendance_id === id; });
        if (row) openCorrect(row, function () {
          el('success').textContent = 'Correction saved for ' + row.name + '.';
          el('success').classList.remove('u-hidden');
          loadSheet();
        });
      }
    });

    return { loadSheet: loadSheet };
  }

  async function loadClasses(root, ctl) {
    var sel = root.querySelector('[data-att="class"]');
    var intro = root.querySelector('[data-att="intro"]');
    try {
      var r = await api.get('/api/attendance/classes');
      var d = await r.json();
      if (!r.ok) { intro.textContent = d.error || 'Could not load classes.'; return; }
      var term = [d.school_year, d.semester].filter(Boolean).join(', ');
      var classes = d.data || [];
      if (!classes.length) {
        intro.textContent = 'No active classes' + (term ? ' for ' + term : '') + '.';
        sel.innerHTML = '<option value="">No classes</option>';
        return;
      }
      intro.textContent = 'Choose a class and date' + (term ? ' (' + term + ')' : '') +
        '. Attendance is recorded once per student per day; changes after that are corrections with a reason.';
      sel.innerHTML = classes.map(function (c) {
        return '<option value="' + c.id + '">' + esc(c.name) + ' — Grade ' + esc(c.grade_level) + ' ' + esc(c.section) +
          ' (' + c.student_count + ' student' + (c.student_count === 1 ? '' : 's') + ')</option>';
      }).join('');
      ctl.loadSheet();
    } catch (_) {
      intro.textContent = 'Could not load classes.';
    }
  }

  function initAttendance(cfg) {
    var root = document.getElementById((cfg && cfg.rootId) || 'attendanceRoot');
    if (!root) return;
    if (root.getAttribute('data-ready') === '1') {
      if (root._sentraAttendance) root._sentraAttendance.loadSheet();
      return;
    }
    root.setAttribute('data-ready', '1');
    root.innerHTML = shellHtml();
    var ctl = setup(root);
    root._sentraAttendance = ctl;
    loadClasses(root, ctl);
  }

  global.initAttendance = initAttendance;

})(window);
