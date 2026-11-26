/**
 * public/js/escalation-rules.js
 * Escalation Rules Management panel for the Admin Dashboard (T-36).
 *
 * Exposes:
 *   initEscalationRules() — called by dashboard-admin.js when section activates
 */
'use strict';

(function (global) {

  // ── Escape helper ─────────────────────────────────────────────────────────
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function activeBadge(isActive) {
    return isActive
      ? '<span class="status-pill status-enrolled">Active</span>'
      : '<span class="status-pill status-inactive">Inactive</span>';
  }

  // ── Build panel markup into #escalationRulesRoot ────────────────────────────
  function buildPanel() {
    var root = document.getElementById('escalationRulesRoot');
    if (!root) return false;

    root.innerHTML =
      '<div class="panel-card">' +
        '<div class="panel-card-header">' +
          '<div class="panel-card-title"><i class="fas fa-arrow-up-right-dots"></i> Escalation Rule Management</div>' +
          '<div class="panel-card-actions">' +
            '<button id="escRuleAddBtn" class="btn-maroon btn-sm"><i class="fas fa-plus"></i> Add Rule</button>' +
          '</div>' +
        '</div>' +
        '<p class="dash-muted-intro">Define escalation rules that notify a designated user when an incident stays in a given status longer than the time target. Each rule matches a severity and a watch status.</p>' +
        '<div class="data-table-wrap">' +
          '<table class="data-table">' +
            '<thead><tr>' +
              '<th>Severity</th><th>Watch Status</th><th>Time Target (min)</th>' +
              '<th>Escalation User</th><th>Active</th><th>Actions</th>' +
            '</tr></thead>' +
            '<tbody id="escRuleTableBody">' +
              '<tr><td colspan="6" class="table-empty">Loading\u2026</td></tr>' +
            '</tbody>' +
          '</table>' +
        '</div>' +
        '<div class="table-meta" id="escRuleTableMeta"></div>' +
      '</div>' +
      '<!-- Escalation Rule Modal -->' +
      '<div class="modal-overlay" id="escRuleModal">' +
        '<div class="modal">' +
          '<div class="modal-header">' +
            '<h3 id="escRuleModalTitle"><i class="fas fa-arrow-up-right-dots"></i> Escalation Rule</h3>' +
            '<button class="modal-close" id="escRuleModalClose" type="button"><i class="fas fa-xmark"></i></button>' +
          '</div>' +
          '<div class="modal-body">' +
            '<p id="escRuleModalError" class="error-msg"></p>' +
            '<div class="field">' +
              '<label>Severity <span class="req-mark">*</span></label>' +
              '<select id="escRuleSeverity" class="filter-select u-w-full">' +
                '<option value="">— Select severity —</option>' +
                '<option value="Low">Low</option>' +
                '<option value="Moderate">Moderate</option>' +
                '<option value="High">High</option>' +
                '<option value="Critical">Critical</option>' +
              '</select>' +
            '</div>' +
            '<div class="field">' +
              '<label>Watch Status <span class="req-mark">*</span></label>' +
              '<select id="escRuleWatchStatus" class="filter-select u-w-full">' +
                '<option value="">— Select status —</option>' +
                '<option value="In Progress">In Progress</option>' +
                '<option value="For Follow-Up">For Follow-Up</option>' +
              '</select>' +
            '</div>' +
            '<div class="field">' +
              '<label>Time Target (minutes) <span class="req-mark">*</span></label>' +
              '<input id="escRuleTimeTarget" class="search-input u-w-full" type="number" min="1" step="1" placeholder="e.g. 15" />' +
            '</div>' +
            '<div class="field">' +
              '<label>Escalation User <span class="req-mark">*</span></label>' +
              '<select id="escRuleUser" class="filter-select u-w-full">' +
                '<option value="">— Select user —</option>' +
              '</select>' +
            '</div>' +
            '<div class="field">' +
              '<label>Active</label>' +
              '<select id="escRuleActive" class="filter-select u-w-full">' +
                '<option value="1">Yes</option>' +
                '<option value="0">No</option>' +
              '</select>' +
            '</div>' +
          '</div>' +
          '<div class="modal-footer">' +
            '<button class="btn-soft btn-sm" id="escRuleCancelBtn" type="button">Cancel</button>' +
            '<button class="btn-maroon btn-sm" id="escRuleSaveBtn" type="button" data-mode="add" data-id="">' +
              '<i class="fas fa-check"></i> Save' +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    return true;
  }

  // ── Load active users into the escalation user dropdown ──────────────────────
  async function loadUsers(selectEl) {
    if (!selectEl) return;
    try {
      var r = await api.get('/api/users?limit=200');
      var d = await r.json();
      var users = r.ok ? (d.data || []) : [];
      selectEl.innerHTML =
        '<option value="">— Select user —</option>' +
        users.map(function (u) {
          return '<option value="' + u.id + '">' + esc(u.full_name) + ' (' + esc(u.role) + ')</option>';
        }).join('');
    } catch (_) {
      selectEl.innerHTML = '<option value="">Could not load users</option>';
    }
  }

  // ── Load & render table ───────────────────────────────────────────────────
  async function loadRules() {
    var tbody  = document.getElementById('escRuleTableBody');
    var metaEl = document.getElementById('escRuleTableMeta');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Loading\u2026</td></tr>';

    var rows;
    try {
      var r = await api.get('/api/escalation-rules');
      var d = await r.json();
      rows = r.ok ? (d.data || []) : [];
    } catch (_) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Could not load escalation rules.</td></tr>';
      return;
    }

    if (metaEl) {
      metaEl.textContent = 'Showing ' + rows.length + ' rule' + (rows.length === 1 ? '' : 's') + '.';
    }

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No escalation rules yet. Click \u201cAdd Rule\u201d to create one.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(function (rule) {
      var userName = rule.escalation_user_name
        ? esc(rule.escalation_user_name)
        : ('User #' + rule.escalation_user_id);
      return (
        '<tr data-rule-id="' + rule.id + '">' +
          '<td>' + esc(rule.severity) + '</td>' +
          '<td>' + esc(rule.watch_status) + '</td>' +
          '<td class="text-center">' + esc(rule.time_target_minutes) + '</td>' +
          '<td>' + userName + '</td>' +
          '<td>' + activeBadge(rule.is_active) + '</td>' +
          '<td>' +
            '<div class="row-actions">' +
              '<button class="btn-icon" title="Edit"' +
                ' data-action="edit-rule"' +
                ' data-id="'      + rule.id + '"' +
                ' data-severity="'    + esc(rule.severity) + '"' +
                ' data-status="'      + esc(rule.watch_status) + '"' +
                ' data-time="'        + rule.time_target_minutes + '"' +
                ' data-user="'        + rule.escalation_user_id + '"' +
                ' data-active="'      + (rule.is_active ? '1' : '0') + '">' +
                '<i class="fas fa-pencil"></i>' +
              '</button>' +
              '<button class="btn-icon' + (rule.is_active ? ' btn-danger' : '') + '"' +
                ' title="' + (rule.is_active ? 'Deactivate' : 'Reactivate') + '"' +
                ' data-action="toggle-rule"' +
                ' data-id="'     + rule.id + '"' +
                ' data-name="'    + esc(rule.severity + ' / ' + rule.watch_status) + '"' +
                ' data-active="' + (rule.is_active ? '1' : '0') + '">' +
                '<i class="fas ' + (rule.is_active ? 'fa-toggle-off' : 'fa-toggle-on') + '"></i>' +
              '</button>' +
            '</div>' +
          '</td>' +
        '</tr>'
      );
    }).join('');
  }

  // ── Open modal (add or edit) ──────────────────────────────────────────────
  async function openModal(opts) {
    opts = opts || {};
    var modal     = document.getElementById('escRuleModal');
    var title     = document.getElementById('escRuleModalTitle');
    var sevSel    = document.getElementById('escRuleSeverity');
    var statSel   = document.getElementById('escRuleWatchStatus');
    var timeIn    = document.getElementById('escRuleTimeTarget');
    var userSel   = document.getElementById('escRuleUser');
    var activeSel = document.getElementById('escRuleActive');
    var saveBtn   = document.getElementById('escRuleSaveBtn');
    var errEl     = document.getElementById('escRuleModalError');

    if (!modal) return;

    if (errEl) errEl.textContent = '';

    // Load users into dropdown before setting value
    await loadUsers(userSel);

    if (sevSel)    sevSel.value    = opts.severity || '';
    if (statSel)   statSel.value   = opts.status || '';
    if (timeIn)    timeIn.value    = opts.time !== undefined ? opts.time : '';
    if (userSel)   userSel.value   = opts.user !== undefined ? opts.user : '';
    if (activeSel) activeSel.value = opts.active !== undefined ? String(opts.active) : '1';

    if (title) {
      title.innerHTML = opts.mode === 'edit'
        ? '<i class="fas fa-arrow-up-right-dots"></i> Edit Escalation Rule'
        : '<i class="fas fa-arrow-up-right-dots"></i> Add Escalation Rule';
    }

    if (saveBtn) {
      saveBtn.dataset.mode = opts.mode || 'add';
      saveBtn.dataset.id   = opts.id   || '';
    }

    modal.classList.add('open');
    if (sevSel) sevSel.focus();
  }

  function closeModal() {
    var modal = document.getElementById('escRuleModal');
    if (modal) modal.classList.remove('open');
  }

  // ── Save (add or edit) ────────────────────────────────────────────────────
  async function saveRule() {
    var saveBtn   = document.getElementById('escRuleSaveBtn');
    var errEl     = document.getElementById('escRuleModalError');
    var sevSel    = document.getElementById('escRuleSeverity');
    var statSel   = document.getElementById('escRuleWatchStatus');
    var timeIn    = document.getElementById('escRuleTimeTarget');
    var userSel   = document.getElementById('escRuleUser');
    var activeSel = document.getElementById('escRuleActive');

    if (!saveBtn) return;
    var mode = saveBtn.dataset.mode;
    var id   = saveBtn.dataset.id;

    if (errEl) errEl.textContent = '';

    var body = {};

    var severity = sevSel ? sevSel.value : '';
    if (!severity) { if (errEl) errEl.textContent = 'Severity is required.'; return; }
    body.severity = severity;

    var watchStatus = statSel ? statSel.value : '';
    if (!watchStatus) { if (errEl) errEl.textContent = 'Watch Status is required.'; return; }
    body.watch_status = watchStatus;

    var timeVal = timeIn ? timeIn.value.trim() : '';
    var ttm = Number(timeVal);
    if (timeVal === '' || isNaN(ttm) || !Number.isInteger(ttm) || ttm < 1) {
      if (errEl) errEl.textContent = 'Time Target must be a positive integer (>= 1).';
      return;
    }
    body.time_target_minutes = ttm;

    var userId = userSel ? userSel.value : '';
    if (!userId) { if (errEl) errEl.textContent = 'Escalation User is required.'; return; }
    body.escalation_user_id = parseInt(userId, 10);

    if (activeSel) body.is_active = parseInt(activeSel.value, 10);

    var r, d;
    if (mode === 'edit' && id) {
      r = await api.patch('/api/escalation-rules/' + id, body);
    } else {
      r = await api.post('/api/escalation-rules', body);
    }

    d = await r.json();

    if (!r.ok) {
      if (errEl) errEl.textContent = d.error || 'Save failed.';
      return;
    }

    closeModal();
    loadRules();
  }

  // ── Toggle active/inactive ─────────────────────────────────────────────────
  async function toggleRule(id, name, currentlyActive) {
    var newActive = currentlyActive ? 0 : 1;

    var doToggle = async function () {
      var r = await api.patch('/api/escalation-rules/' + id, { is_active: newActive });
      if (r.ok) {
        loadRules();
      } else {
        var d = await r.json();
        var metaEl = document.getElementById('escRuleTableMeta');
        if (metaEl) metaEl.textContent = d.error || 'Toggle failed.';
      }
    };

    if (currentlyActive) {
      if (typeof confirmAction === 'function') {
        confirmAction(
          'Deactivate rule "' + name + '"? It will no longer trigger escalations.',
          doToggle
        );
      } else {
        if (window.confirm('Deactivate rule "' + name + '"?')) doToggle();
      }
    } else {
      doToggle();
    }
  }

  // ── Wire events ───────────────────────────────────────────────────────────
  function wireEvents() {
    var addBtn = document.getElementById('escRuleAddBtn');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        openModal({ mode: 'add' });
      });
    }

    var closeBtn   = document.getElementById('escRuleModalClose');
    var cancelBtn  = document.getElementById('escRuleCancelBtn');
    var saveBtn    = document.getElementById('escRuleSaveBtn');
    var modalOverl = document.getElementById('escRuleModal');

    if (closeBtn)   closeBtn.addEventListener('click',  closeModal);
    if (cancelBtn)  cancelBtn.addEventListener('click', closeModal);
    if (saveBtn)    saveBtn.addEventListener('click',   saveRule);

    if (modalOverl) {
      modalOverl.addEventListener('click', function (e) {
        if (e.target === modalOverl) closeModal();
      });
    }

    var panel = document.getElementById('escalation-rules');
    if (panel) {
      panel.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-action]');
        if (!btn) return;
        var action = btn.dataset.action;

        if (action === 'edit-rule') {
          openModal({
            mode:   'edit',
            id:      btn.dataset.id,
            severity: btn.dataset.severity,
            status:   btn.dataset.status,
            time:     btn.dataset.time,
            user:     btn.dataset.user,
            active:   btn.dataset.active,
          });
        }

        if (action === 'toggle-rule') {
          var isActive = btn.dataset.active === '1';
          toggleRule(btn.dataset.id, btn.dataset.name, isActive);
        }
      });
    }
  }

  // ── Public init ───────────────────────────────────────────────────────────
  function initEscalationRules() {
    if (!buildPanel()) return;
    wireEvents();
    loadRules();
  }

  global.initEscalationRules = initEscalationRules;

})(window);
