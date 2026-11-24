/**
 * public/js/audit-log.js
 * Audit Log panel — self-contained module.
 * Renders into #auditLogPanel when present on the page.
 * Lazy-loaded: first fetch fires when the audit-log section is activated.
 */
(function () {
  'use strict';

  var ACTION_TYPES = [
    'LOGIN',
    'LOGOUT',
    'PASSWORD_CHANGED',
    'ACCOUNT_CREATED',
    'ACCOUNT_STATUS_CHANGED',
    'PASSWORD_RESET',
    'ROLE_PERMISSION_CHANGED',
    'SETTINGS_CHANGED',
    'STUDENT_CREATED',
    'STUDENT_UPDATED',
    'STUDENT_ARCHIVED',
    'STUDENT_RESTORED',
    'CLASS_CREATED',
    'CLASS_UPDATED',
    'CLASS_STUDENTS_UPDATED',
    'NOTIFICATION_ACCESS',
    'SEED',
    'PARTICIPATION_VIEWED',
  ];

  var _container   = null;  // #auditLogPanel element
  var _initialized = false; // filters/table HTML rendered
  var _currentPage = 1;
  var _totalPages  = 1;

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                             */
  /* ------------------------------------------------------------------ */
  function escHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return escHtml(iso);
    }
  }

  function jsonDetails(obj) {
    if (obj === null || obj === undefined) return '—';
    try {
      return JSON.stringify(obj, null, 2);
    } catch (e) {
      return String(obj);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Render: filter bar + table skeleton                                 */
  /* ------------------------------------------------------------------ */
  function renderShell() {
    var actionOptions = ACTION_TYPES.map(function (t) {
      return '<option value="' + escHtml(t) + '">' + escHtml(t) + '</option>';
    }).join('');

    _container.innerHTML =
      '<form id="auditFilterForm" class="panel-card-actions" style="flex-wrap:wrap;margin-bottom:16px;">' +
        '<input type="date" id="auditFrom" class="filter-select" title="Date from" />' +
        '<input type="date" id="auditTo"   class="filter-select" title="Date to" />' +
        '<input type="text" id="auditActor" class="search-input" placeholder="Actor name…" />' +
        '<select id="auditActionType" class="filter-select">' +
          '<option value="">All action types</option>' +
          actionOptions +
        '</select>' +
        '<button type="submit" class="btn-maroon btn-sm"><i class="fas fa-search"></i> Filter</button>' +
        '<button type="button" id="auditResetBtn" class="btn-soft btn-sm"><i class="fas fa-rotate-left"></i> Reset</button>' +
      '</form>' +

      '<div id="auditError" class="error-msg"></div>' +

      '<div class="data-table-wrap">' +
        '<table class="data-table" id="auditTable">' +
          '<thead><tr>' +
            '<th>Time</th>' +
            '<th>Actor</th>' +
            '<th>Role</th>' +
            '<th>Action</th>' +
            '<th>Target</th>' +
            '<th>Details</th>' +
          '</tr></thead>' +
          '<tbody id="auditTableBody">' +
            '<tr><td colspan="6" class="table-empty">Loading…</td></tr>' +
          '</tbody>' +
        '</table>' +
      '</div>' +

      '<div id="auditPagination" class="panel-card-actions" style="justify-content:flex-end;margin-top:12px;">' +
        '<button id="auditPrevBtn" class="btn-soft btn-sm" disabled><i class="fas fa-chevron-left"></i> Previous</button>' +
        '<span id="auditPageInfo" class="table-meta" style="align-self:center;"></span>' +
        '<button id="auditNextBtn" class="btn-soft btn-sm" disabled>Next <i class="fas fa-chevron-right"></i></button>' +
      '</div>';

    /* Wire filter form */
    var form = document.getElementById('auditFilterForm');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      loadAuditLogs(1);
    });

    /* Wire reset button */
    document.getElementById('auditResetBtn').addEventListener('click', function () {
      document.getElementById('auditFrom').value       = '';
      document.getElementById('auditTo').value         = '';
      document.getElementById('auditActor').value      = '';
      document.getElementById('auditActionType').value = '';
      loadAuditLogs(1);
    });

    /* Wire pagination */
    document.getElementById('auditPrevBtn').addEventListener('click', function () {
      if (_currentPage > 1) loadAuditLogs(_currentPage - 1);
    });
    document.getElementById('auditNextBtn').addEventListener('click', function () {
      if (_currentPage < _totalPages) loadAuditLogs(_currentPage + 1);
    });

    _initialized = true;
  }

  /* ------------------------------------------------------------------ */
  /*  Load data                                                           */
  /* ------------------------------------------------------------------ */
  function loadAuditLogs(page) {
    if (!_container) return;
    if (!_initialized) renderShell();

    var from       = (document.getElementById('auditFrom')       || {}).value || '';
    var to         = (document.getElementById('auditTo')         || {}).value || '';
    var actor      = (document.getElementById('auditActor')      || {}).value || '';
    var actionType = (document.getElementById('auditActionType') || {}).value || '';

    var params = 'page=' + encodeURIComponent(page) + '&limit=50';
    if (from)       params += '&from='        + encodeURIComponent(from);
    if (to)         params += '&to='          + encodeURIComponent(to);
    if (actor)      params += '&actor='       + encodeURIComponent(actor);
    if (actionType) params += '&action_type=' + encodeURIComponent(actionType);

    var tbody  = document.getElementById('auditTableBody');
    var errEl  = document.getElementById('auditError');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Loading…</td></tr>';
    if (errEl) errEl.textContent = '';

    api.get('/api/audit-logs?' + params)
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            throw new Error(body.error || body.message || ('Request failed: ' + res.status));
          });
        }
        return res.json();
      })
      .then(function (json) {
        var rows       = json.data        || [];
        var pagination = json.pagination  || {};
        _currentPage   = pagination.page  || 1;
        _totalPages    = pagination.pages || 1;

        renderRows(rows, pagination);
        renderPagination();
      })
      .catch(function (err) {
        if (errEl) errEl.textContent = 'Could not load audit logs: ' + (err.message || 'Unknown error');
        if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="table-empty">—</td></tr>';
      });
  }

  /* ------------------------------------------------------------------ */
  /*  Render table rows                                                   */
  /* ------------------------------------------------------------------ */
  function renderRows(rows, pagination) {
    var tbody = document.getElementById('auditTableBody');
    var metaEl = document.getElementById('auditPageInfo');
    if (!tbody) return;

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No audit log entries found.</td></tr>';
      if (metaEl) metaEl.textContent = '';
      return;
    }

    var html = rows.map(function (r) {
      var oldHtml = '';
      var newHtml = '';
      if (r.old_values !== null && r.old_values !== undefined) {
        oldHtml =
          '<details><summary>Old</summary>' +
          '<pre style="font-size:.75rem;white-space:pre-wrap;word-break:break-all;margin:4px 0 0;">' +
          escHtml(jsonDetails(r.old_values)) +
          '</pre></details>';
      }
      if (r.new_values !== null && r.new_values !== undefined) {
        newHtml =
          '<details><summary>New</summary>' +
          '<pre style="font-size:.75rem;white-space:pre-wrap;word-break:break-all;margin:4px 0 0;">' +
          escHtml(jsonDetails(r.new_values)) +
          '</pre></details>';
      }
      var detailsContent = (oldHtml || newHtml)
        ? oldHtml + newHtml
        : '—';
      var detailsHtml = (oldHtml || newHtml)
        ? '<details><summary>Details</summary>' + oldHtml + newHtml + '</details>'
        : '—';

      var targetHtml = r.target_table
        ? escHtml(r.target_table) + (r.target_id ? ' #' + escHtml(String(r.target_id)) : '')
        : '—';

      return (
        '<tr>' +
          '<td style="white-space:nowrap;">' + escHtml(formatDateTime(r.created_at)) + '</td>' +
          '<td>' + escHtml(r.actor_name || '—') + '</td>' +
          '<td>' + escHtml(r.actor_role || '—') + '</td>' +
          '<td><code style="font-size:.8rem;">' + escHtml(r.action_type || '—') + '</code></td>' +
          '<td>' + targetHtml + '</td>' +
          '<td>' + detailsHtml + '</td>' +
        '</tr>'
      );
    }).join('');

    tbody.innerHTML = html;

    if (metaEl) {
      var total = pagination.total || 0;
      var limit = pagination.limit || 50;
      var offset = (_currentPage - 1) * limit;
      var from   = total === 0 ? 0 : offset + 1;
      var to     = Math.min(offset + limit, total);
      metaEl.textContent = 'Showing ' + from + '–' + to + ' of ' + total + ' entries';
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Render pagination controls                                          */
  /* ------------------------------------------------------------------ */
  function renderPagination() {
    var prevBtn  = document.getElementById('auditPrevBtn');
    var nextBtn  = document.getElementById('auditNextBtn');
    var pageInfo = document.getElementById('auditPageInfo');

    if (prevBtn) prevBtn.disabled = (_currentPage <= 1);
    if (nextBtn) nextBtn.disabled = (_currentPage >= _totalPages);
    if (pageInfo && _totalPages > 1) {
      // pageInfo already set by renderRows; keep it or add page counter
      var existing = pageInfo.textContent;
      if (existing) {
        pageInfo.textContent = existing + '  (page ' + _currentPage + ' of ' + _totalPages + ')';
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Bootstrap on DOMContentLoaded                                       */
  /* ------------------------------------------------------------------ */
  document.addEventListener('DOMContentLoaded', function () {
    _container = document.getElementById('auditLogPanel');
    if (!_container) return; // not on this page — stay inert

    // Lazy-load: fire only when the audit-log nav item is clicked.
    // dashboard-common.js fires config.onSectionChange() after the click,
    // but we can also hook the nav item click directly for safety.
    var navItem = document.querySelector('[data-section="audit-log"]');
    if (navItem) {
      navItem.addEventListener('click', function () {
        if (!_initialized) {
          renderShell();
          loadAuditLogs(1);
        }
      });
    } else {
      // Fallback: if the nav item doesn't exist yet (dynamic nav),
      // watch for the section becoming active via MutationObserver.
      var panel = document.getElementById('audit-log');
      if (panel) {
        var observer = new MutationObserver(function (mutations) {
          mutations.forEach(function (m) {
            if (m.type === 'attributes' && m.attributeName === 'class') {
              if (panel.classList.contains('active') && !_initialized) {
                renderShell();
                loadAuditLogs(1);
              }
            }
          });
        });
        observer.observe(panel, { attributes: true });
      }
    }
  });

})();
