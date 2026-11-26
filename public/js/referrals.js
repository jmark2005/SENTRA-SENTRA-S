/**
 * public/js/referrals.js — student support referral submission and list (T-27B).
 *
 * Exposes window.initReferrals({ rootId }): builds the form and list inside the
 * element with that id on first call; later calls just refresh the list.
 * Each row's View button opens referral-detail.js (T-28B).
 * Used on the Teacher, Guidance, School Head, and SysAdmin dashboards.
 *
 * Referrals hold administrative information only; the remarks field is
 * labelled so no counseling or clinical content is recorded.
 * Writes go through api.js.
 */
'use strict';

(function (global) {

  var TYPES = ['Academic Assistance', 'Guidance Referral', 'Attendance-Related Follow-Up', 'Other School-Based Support'];
  var STATUS_CLASS = {
    Pending: 'status-inactive', Ongoing: 'status-onleave',
    Completed: 'status-enrolled', Referred: 'status-referred',
  };
  var LIST_TITLES = {
    teacher: 'My Referrals', guidance: 'Referral Queue',
    schoolhead: 'All Referrals', sysadmin: 'All Referrals',
  };
  var LIST_INTROS = {
    teacher: 'Referrals you submitted or are assigned to.',
    guidance: 'Unassigned Pending referrals, plus those assigned to you or submitted by you.',
    schoolhead: 'All active referrals.',
    sysadmin: 'All active referrals.',
  };

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function localToday() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function fmtDate(d) {
    if (!d) return '—';
    var p = d.split('-');
    if (p.length !== 3) return esc(d);
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[parseInt(p[1], 10) - 1] + ' ' + parseInt(p[2], 10) + ', ' + p[0];
  }

  function studentLabel(s) {
    return s.last_name + ', ' + s.first_name + ' (' + s.student_number + ')';
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

  // ── Markup ─────────────────────────────────────────────────────────────────
  function formHtml(me) {
    return (
      '<div class="panel-card">' +
        '<div class="panel-card-header">' +
          '<div class="panel-card-title"><i class="fas fa-hand-holding-heart"></i> Submit Support Referral</div>' +
        '</div>' +
        '<p class="dash-muted-intro">Refer a student to a school support service. New referrals go to the Guidance queue.</p>' +
        '<p class="settings-success-msg u-hidden" data-ref="success" role="status"></p>' +
        '<form data-ref="form" autocomplete="off" novalidate>' +
          '<div class="field">' +
            '<label for="refStudentQuery">Student <span class="req-mark">*</span></label>' +
            '<div class="ref-student-pick" data-ref="picked-wrap">' +
              '<div class="ref-search-row" data-ref="search-row">' +
                '<input type="text" id="refStudentQuery" data-ref="query" placeholder="Search by student number or name" />' +
                '<button type="button" class="btn-soft btn-sm" data-ref="search"><i class="fas fa-magnifying-glass"></i> Search</button>' +
              '</div>' +
              '<div class="ref-results" data-ref="results"></div>' +
              '<div class="ref-picked u-hidden" data-ref="picked">' +
                '<span data-ref="picked-label"></span>' +
                '<button type="button" class="btn-soft btn-sm" data-ref="change">Change</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="field-row">' +
            '<div class="field">' +
              '<label for="refType">Referral type <span class="req-mark">*</span></label>' +
              '<select id="refType" data-ref="type">' +
                '<option value="">— Select type —</option>' +
                TYPES.map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('') +
              '</select>' +
            '</div>' +
            '<div class="field">' +
              '<label for="refDate">Date of referral <span class="req-mark">*</span></label>' +
              '<input type="date" id="refDate" data-ref="date" value="' + localToday() + '" max="' + localToday() + '" />' +
            '</div>' +
          '</div>' +
          '<div class="field">' +
            '<label for="refBy">Referring person</label>' +
            '<input type="text" id="refBy" value="' + esc(me.full_name || '') + '" readonly />' +
          '</div>' +
          '<div class="field">' +
            '<label for="refRemarks">Administrative remarks only — do not record counseling notes or clinical information</label>' +
            '<textarea id="refRemarks" data-ref="remarks" rows="3" maxlength="1000" placeholder="Optional"></textarea>' +
          '</div>' +
          '<p class="error-msg" data-ref="error" role="alert"></p>' +
          '<div class="ref-actions">' +
            '<button type="submit" class="btn-maroon btn-sm" data-ref="submit"><i class="fas fa-paper-plane"></i> Submit Referral</button>' +
          '</div>' +
        '</form>' +
      '</div>'
    );
  }

  function listHtml(role) {
    return (
      '<div class="panel-card">' +
        '<div class="panel-card-header">' +
          '<div class="panel-card-title"><i class="fas fa-list"></i> ' + esc(LIST_TITLES[role] || 'Referrals') + '</div>' +
          '<div class="panel-card-actions">' +
            '<select class="filter-select" data-ref="filter-status" aria-label="Filter by status">' +
              '<option value="">All Statuses</option>' +
              ['Pending', 'Ongoing', 'Completed', 'Referred'].map(function (s) { return '<option value="' + s + '">' + s + '</option>'; }).join('') +
              (role === 'sysadmin' ? '<option value="__archived">Archived</option>' : '') +
            '</select>' +
          '</div>' +
        '</div>' +
        '<p class="dash-muted-intro">' + esc(LIST_INTROS[role] || '') + '</p>' +
        '<div class="data-table-wrap">' +
          '<table class="data-table">' +
            '<thead><tr><th>Student</th><th>Type</th><th>Date</th><th>Referred By</th><th>Assigned To</th><th>Status</th><th>Actions</th></tr></thead>' +
            '<tbody data-ref="list"><tr><td colspan="7" class="table-empty">Loading…</td></tr></tbody>' +
          '</table>' +
        '</div>' +
        '<div class="table-meta" data-ref="meta"></div>' +
      '</div>'
    );
  }

  // ── Behaviour ──────────────────────────────────────────────────────────────
  function bind(root) {
    function el(name) { return root.querySelector('[data-ref="' + name + '"]'); }
    var picked = null;
    var found = [];

    function showPicked(student) {
      picked = student;
      el('picked-label').textContent = studentLabel(student);
      el('picked').classList.remove('u-hidden');
      el('search-row').classList.add('u-hidden');
      el('results').innerHTML = '';
    }
    function clearPicked() {
      picked = null;
      el('picked').classList.add('u-hidden');
      el('search-row').classList.remove('u-hidden');
      el('query').focus();
    }

    async function search() {
      var q = el('query').value.trim();
      var box = el('results');
      if (q.length < 2) { box.innerHTML = '<p class="ia-note">Type at least 2 characters.</p>'; return; }
      box.innerHTML = '<p class="ia-note">Searching…</p>';
      try {
        var r = await api.get('/api/students?status=Active&q=' + encodeURIComponent(q));
        var d = await r.json();
        found = r.ok ? (d.data || []).slice(0, 10) : [];
        if (!r.ok) { box.innerHTML = '<p class="error-msg">' + esc(d.error || 'Search failed.') + '</p>'; return; }
        box.innerHTML = found.length
          ? found.map(function (s, i) {
              return '<button type="button" class="ref-result" data-pick="' + i + '">' + esc(studentLabel(s)) +
                ' <span class="muted-inline">Grade ' + esc(s.grade_level) + ' · ' + esc(s.section) + '</span></button>';
            }).join('')
          : '<p class="ia-note">No active students match.</p>';
      } catch (_) {
        box.innerHTML = '<p class="error-msg">Search failed.</p>';
      }
    }

    el('search').addEventListener('click', search);
    el('query').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); search(); }
    });
    el('results').addEventListener('click', function (e) {
      var b = e.target.closest('[data-pick]');
      if (b) showPicked(found[parseInt(b.getAttribute('data-pick'), 10)]);
    });
    el('change').addEventListener('click', clearPicked);

    el('form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var err = el('error');
      var ok = el('success');
      err.textContent = '';
      ok.classList.add('u-hidden');

      if (!picked) { err.textContent = 'Choose a student.'; return; }
      if (!el('type').value) { err.textContent = 'Choose a referral type.'; return; }

      var btn = el('submit');
      btn.disabled = true;
      try {
        var r = await api.post('/api/referrals', {
          student_id:    picked.id,
          referral_type: el('type').value,
          referral_date: el('date').value,
          remarks:       el('remarks').value,
        });
        var d = await r.json();
        if (!r.ok) {
          err.textContent = d.error || 'Submission failed.';
        } else {
          ok.textContent = 'Referral #' + d.id + ' submitted for ' + studentLabel(picked) + '. Guidance has been notified.';
          ok.classList.remove('u-hidden');
          el('type').value = '';
          el('remarks').value = '';
          el('date').value = localToday();
          clearPicked();
          el('query').value = '';
          loadList(root);
        }
      } catch (_) {
        err.textContent = 'Network error. Please try again.';
      }
      btn.disabled = false;
    });

    el('filter-status').addEventListener('change', function () { loadList(root); });
  }

  async function loadList(root) {
    var body = root.querySelector('[data-ref="list"]');
    var meta = root.querySelector('[data-ref="meta"]');
    var status = root.querySelector('[data-ref="filter-status"]').value;
    var url = status === '__archived'
      ? '/api/referrals/archived'
      : '/api/referrals' + (status ? '?status=' + encodeURIComponent(status) : '');
    try {
      var r = await api.get(url);
      var d = await r.json();
      if (!r.ok) {
        body.innerHTML = '<tr><td colspan="7" class="table-empty">' + esc(d.error || 'Could not load referrals.') + '</td></tr>';
        return;
      }
      var rows = d.data || [];
      meta.textContent = 'Showing ' + rows.length + (status === '__archived' ? ' archived' : '') +
        ' referral' + (rows.length === 1 ? '' : 's') + '.';
      body.innerHTML = rows.length
        ? rows.map(function (x) {
            return (
              '<tr data-referral-id="' + x.id + '">' +
                '<td><strong>' + esc(x.student_last_name + ', ' + x.student_first_name) + '</strong><br>' +
                  '<small class="muted-inline">' + esc(x.student_number) + ' · #' + x.id + '</small></td>' +
                '<td>' + esc(x.referral_type) + '</td>' +
                '<td>' + fmtDate(x.referral_date) + '</td>' +
                '<td>' + esc(x.referring_user_name) + '</td>' +
                '<td>' + (x.assigned_to_name ? esc(x.assigned_to_name) : '<span class="muted-inline">Unassigned</span>') + '</td>' +
                '<td><span class="status-pill ' + (STATUS_CLASS[x.status] || 'status-inactive') + '">' + esc(x.status) + '</span></td>' +
                '<td><button type="button" class="btn-icon" data-view-referral="' + x.id + '" title="View referral #' + x.id + '"' +
                  ' aria-label="View referral #' + x.id + '"><i class="fas fa-eye"></i></button></td>' +
              '</tr>'
            );
          }).join('')
        : '<tr><td colspan="7" class="table-empty">No referrals found.</td></tr>';
    } catch (_) {
      body.innerHTML = '<tr><td colspan="7" class="table-empty">Could not load referrals.</td></tr>';
    }
  }

  // Opens the detail view (referral-detail.js) from the list's View buttons.
  function bindDetail(root, me) {
    root.querySelector('[data-ref="list"]').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-view-referral]');
      if (!btn || !global.SentraReferralDetail) return;
      global.SentraReferralDetail.open(parseInt(btn.getAttribute('data-view-referral'), 10), {
        me: me,
        onChange: function () { loadList(root); },
      });
    });
  }

  async function initReferrals(cfg) {
    var root = document.getElementById((cfg && cfg.rootId) || 'referralsRoot');
    if (!root) return;
    if (root.getAttribute('data-ready') === '1') { loadList(root); return; }
    root.setAttribute('data-ready', '1');

    var me = await getMe();
    var role = me.role || '';
    var canSubmit = (me.permissions || []).indexOf('submit_referral') !== -1;
    root.innerHTML = (canSubmit ? formHtml(me) : '') + listHtml(role);
    if (canSubmit) bind(root);
    else root.querySelector('[data-ref="filter-status"]').addEventListener('change', function () { loadList(root); });
    bindDetail(root, me);
    loadList(root);
  }

  global.initReferrals = initReferrals;

})(window);
