/**
 * public/js/retention.js — Retention Review panel (T-35, SysAdmin).
 *
 * Exposes window.initRetention({ rootId }). Lists the records that
 * GET /api/retention/review says have reached the retention period in System
 * Settings: incidents, referrals, and attendance (one row per class, because
 * attendance is archived a whole class at a time).
 *
 * Nothing is archived automatically. Each row has an Archive button that asks
 * for confirmation and then calls the record's own archive endpoint
 * (incidents, referrals, attendance), after which the list reloads.
 */
'use strict';

(function (global) {

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function day(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleDateString('en-CA');
  }

  function years(n) { return n + (n === 1 ? ' year' : ' years'); }

  // Per record type: table columns, row cells, and how to archive a row.
  var TYPES = {
    incident: {
      icon: 'fa-file-circle-exclamation',
      head: ['Reference', 'Category', 'Status', 'Created', 'Age', ''],
      cells: function (r) {
        return [
          '<strong>' + esc(r.reference) + '</strong>' + (r.is_restricted ? ' <span class="status-pill pill-restricted">Restricted</span>' : ''),
          esc(r.category), esc(r.status), esc(day(r.created_at)), esc(years(r.age_years)),
        ];
      },
      archive: function (r) {
        return {
          message: 'Archive incident ' + r.reference + ' (' + r.status + ')? It will be hidden from all incident lists and reports until a System Administrator restores it.',
          path: '/api/incidents/' + r.id + '/archive',
          body: { confirmed: true },
          done: 'Archived incident ' + r.reference + '.',
        };
      },
    },
    referral: {
      icon: 'fa-hand-holding-heart',
      head: ['Reference', 'Type', 'Status', 'Student No.', 'Created', 'Age', ''],
      cells: function (r) {
        return [
          '<strong>' + esc(r.reference) + '</strong>', esc(r.referral_type), esc(r.status),
          esc(r.student_number), esc(day(r.created_at)), esc(years(r.age_years)),
        ];
      },
      archive: function (r) {
        return {
          message: 'Archive ' + r.reference + ' (' + r.referral_type + ', ' + r.status + ')? It will be hidden from referral lists and reports until restored.',
          path: '/api/referrals/' + r.id + '/archive',
          body: { confirmed: true },
          done: 'Archived ' + r.reference + '.',
        };
      },
    },
    attendance: {
      icon: 'fa-calendar-check',
      head: ['Class', 'Records past retention', 'Oldest record', 'Age', ''],
      cells: function (r) {
        return [
          '<strong>' + esc(r.class_name) + '</strong><br><small class="muted-inline">' + esc(r.semester) + ' · ' + esc(r.school_year) +
            (r.section ? ' · ' + esc(r.section) : '') + '</small>',
          esc(r.eligible_records) + ' of ' + esc(r.active_records),
          esc(day(r.created_at)), esc(years(r.age_years)),
        ];
      },
      archive: function (r) {
        var newer = r.active_records - r.eligible_records;
        return {
          message: 'Archive all ' + r.active_records + ' attendance records for ' + r.reference + '?' +
            (newer > 0 ? ' This includes ' + newer + ' record' + (newer === 1 ? '' : 's') + ' not yet past the retention period, because attendance is archived a whole class at a time.' : '') +
            ' They will be hidden from attendance views and summaries until restored.',
          path: '/api/attendance/archive',
          body: { class_id: r.class_id, semester: r.semester },
          done: 'Archived ' + r.active_records + ' attendance records for ' + r.class_name + '.',
        };
      },
    },
  };

  function groupHtml(g) {
    var t = TYPES[g.record_type];
    var rows = g.data.length
      ? g.data.map(function (r, i) {
          return '<tr>' + t.cells(r).map(function (c) { return '<td>' + c + '</td>'; }).join('') +
            '<td><button type="button" class="btn-soft btn-sm" data-ret-archive="' + g.record_type + ':' + i + '">' +
            '<i class="fas fa-box-archive"></i> Archive</button></td></tr>';
        }).join('')
      : '<tr><td colspan="' + t.head.length + '" class="table-empty">Nothing has reached the retention period.</td></tr>';
    return (
      '<div class="panel-card">' +
        '<div class="panel-card-header">' +
          '<div class="panel-card-title"><i class="fas ' + t.icon + '"></i> ' + esc(g.label) + '</div>' +
          '<span class="status-pill">' + g.count + ' ' + (g.record_type === 'attendance' ? (g.count === 1 ? 'class' : 'classes') : 'eligible') + '</span>' +
        '</div>' +
        '<p class="dash-muted-intro">Retention period: <strong>' + esc(years(g.retention_years)) + '</strong>. ' +
          'Listed: records created on or before ' + esc(day(g.cutoff)) + ' that are not archived.</p>' +
        '<div class="data-table-wrap"><table class="data-table">' +
          '<thead><tr>' + t.head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table></div>' +
      '</div>'
    );
  }

  function setup(root) {
    var data = null;
    function el(name) { return root.querySelector('[data-ret="' + name + '"]'); }

    function message(kind, text) {
      el('error').textContent = kind === 'error' ? text : '';
      el('success').textContent = kind === 'success' ? text : '';
      el('success').classList.toggle('u-hidden', kind !== 'success');
    }

    async function load() {
      el('groups').innerHTML = '<div class="panel-card"><p class="table-empty">Loading…</p></div>';
      try {
        var r = await api.get('/api/retention/review');
        var d = await r.json();
        if (!r.ok) { el('groups').innerHTML = ''; message('error', d.error || 'Could not load the retention review.'); return; }
        data = d;
        el('groups').innerHTML = d.groups.map(groupHtml).join('');
        el('meta').textContent = 'Checked ' + new Date(d.generated_at).toLocaleString() + '.';
      } catch (_) {
        el('groups').innerHTML = '';
        message('error', 'Could not load the retention review.');
      }
    }

    function archive(type, index) {
      var group = data && data.groups.find(function (g) { return g.record_type === type; });
      var row = group && group.data[index];
      if (!row) return;
      var a = TYPES[type].archive(row);
      var go = async function () {
        message(null);
        try {
          var r = await api.patch(a.path, a.body);
          var d = await r.json().catch(function () { return {}; });
          if (!r.ok) { message('error', d.error || 'Archive failed.'); return; }
          message('success', a.done);
          load();
        } catch (_) {
          message('error', 'Network error. Please try again.');
        }
      };
      if (typeof global.confirmAction === 'function') global.confirmAction(a.message, go); else go();
    }

    root.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-ret-archive]');
      if (btn) {
        var parts = btn.getAttribute('data-ret-archive').split(':');
        archive(parts[0], parseInt(parts[1], 10));
      }
      if (e.target.closest('[data-ret="refresh"]')) { message(null); load(); }
    });

    return { load: load };
  }

  function initRetention(cfg) {
    var root = document.getElementById((cfg && cfg.rootId) || 'retentionRoot');
    if (!root) return;
    if (root.getAttribute('data-ready') === '1') { root._sentraRetention.load(); return; }
    root.setAttribute('data-ready', '1');
    root.innerHTML =
      '<div class="panel-card">' +
        '<div class="panel-card-header">' +
          '<div class="panel-card-title"><i class="fas fa-box-archive"></i> Retention Review</div>' +
          '<button type="button" class="btn-soft btn-sm" data-ret="refresh"><i class="fas fa-rotate"></i> Refresh</button>' +
        '</div>' +
        '<p class="dash-muted-intro">Records that have reached the retention period set in System Settings are listed here ' +
          'for archive review. Nothing is archived or deleted automatically: each Archive button asks you to confirm first, ' +
          'and archived records can be restored.</p>' +
        '<p class="settings-success-msg u-hidden" data-ret="success" role="status"></p>' +
        '<p class="error-msg" data-ret="error" role="alert"></p>' +
        '<div class="table-meta" data-ret="meta"></div>' +
      '</div>' +
      '<div data-ret="groups"></div>';
    root._sentraRetention = setup(root);
    root._sentraRetention.load();
  }

  global.initRetention = initRetention;

})(window);
