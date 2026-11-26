/**
 * public/js/incident-actions.js — incident response controls (T-24B).
 *
 * Exposes window.SentraIncidentActions.render(container, incident, opts)
 *   incident:      GET /api/incidents/:id response (includes assignments)
 *   opts.me:       { id, role, permissions[] } from GET /api/auth/me
 *   opts.onChange: called after any successful change (re-render detail + list)
 *
 * A control appears only when the state machine allows it for this user.
 * The server enforces the same rules; its error messages are shown inline
 * under the control that was used. All writes go through api.js.
 */
'use strict';

(function (global) {

  var SEVERITIES  = ['Low', 'Moderate', 'High', 'Critical'];
  var ROLE_LABELS = {
    sysadmin: 'System Admin', schoolhead: 'School Head', teacher: 'Teacher',
    guidance: 'Guidance', safetyofficer: 'Safety Officer', student: 'Student',
  };
  var RESPONSE_STATUSES = ['In Progress', 'For Follow-Up'];

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function localToday() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function can(me, code) { return (me.permissions || []).indexOf(code) !== -1; }

  function myAssignment(inc, me) {
    var list = inc.assignments || [];
    for (var i = 0; i < list.length; i++) if (list[i].assigned_to === me.id) return list[i];
    return null;
  }

  // ── HTML pieces ────────────────────────────────────────────────────────────
  function card(name, title, icon, inner) {
    return (
      '<section class="ia-card" data-card="' + name + '">' +
        '<h4 class="ia-title"><i class="fas ' + icon + '"></i> ' + title + '</h4>' +
        inner +
        '<p class="error-msg" data-error role="alert"></p>' +
      '</section>'
    );
  }

  function button(act, label, icon, primary, extra) {
    return (
      '<button type="button" class="' + (primary ? 'btn-maroon' : 'btn-soft') + ' btn-sm" data-act="' + act + '"' +
        (extra || '') + '><i class="fas ' + icon + '"></i> ' + label + '</button>'
    );
  }

  function textArea(id, field, label, placeholder) {
    return (
      '<div class="field">' +
        '<label for="' + id + '">' + label + '</label>' +
        '<textarea id="' + id + '" data-field="' + field + '" rows="3" maxlength="2000" placeholder="' + esc(placeholder) + '"></textarea>' +
      '</div>'
    );
  }

  // ── Which controls apply ───────────────────────────────────────────────────
  function buildCards(inc, me) {
    var cards  = [];
    var pre    = 'ia-' + inc.id + '-';
    var status = inc.status;
    var mine   = myAssignment(inc, me);
    var isHead = me.role === 'schoolhead';
    var responder = can(me, 'respond_incidents') && (isHead || !!mine);

    if (inc.is_archived) {
      if (me.role === 'sysadmin' && can(me, 'archive_incidents')) {
        cards.push(card('records', 'Record', 'fa-box-archive',
          '<p class="ia-note">This incident is archived and hidden from all lists.</p>' +
          '<div class="ia-buttons">' + button('restore', 'Restore', 'fa-box-open', true) + '</div>'));
      }
      return cards;
    }

    // Review & classify
    if (status !== 'Closed' && can(me, 'manage_incidents')) {
      var options = SEVERITIES.map(function (s) {
        return '<option value="' + s + '"' + (s === (inc.severity || 'Moderate') ? ' selected' : '') + '>' + s + '</option>';
      }).join('');
      cards.push(card('classify', status === 'Submitted' ? 'Review &amp; Classify' : 'Severity', 'fa-magnifying-glass',
        '<div class="ia-row">' +
          '<div class="field ia-grow"><label for="' + pre + 'severity">Severity</label>' +
            '<select id="' + pre + 'severity" data-field="severity">' + options + '</select></div>' +
          button('classify', status === 'Submitted' ? 'Classify &amp; Move to Under Review' : 'Update Severity', 'fa-check', true) +
        '</div>'));
    }

    // Assign (School Head, Under Review)
    if (status === 'Under Review' && isHead && can(me, 'assign_incidents')) {
      cards.push(card('assign', 'Assign Personnel', 'fa-user-check', inc.severity
        ? '<div class="ia-assignees" data-field="assignees"><p class="ia-note">Loading personnel…</p></div>' +
          '<div class="ia-buttons">' + button('assign', 'Assign Selected', 'fa-user-check', true) + '</div>'
        : '<p class="ia-note">Set the severity before assigning personnel.</p>'));
    }

    // Acknowledge (assigned user who has not yet acknowledged)
    if (mine && !mine.acknowledged_at && can(me, 'respond_incidents')
        && ['Assigned', 'In Progress', 'For Follow-Up'].indexOf(status) !== -1) {
      cards.push(card('acknowledge', 'Your Assignment', 'fa-circle-check',
        '<p class="ia-note">You are assigned to this incident. Acknowledge to confirm you have received it.</p>' +
        '<div class="ia-buttons">' + button('acknowledge', 'Acknowledge', 'fa-circle-check', true) + '</div>'));
    }

    // School Head can start work on an Assigned incident
    if (status === 'Assigned' && isHead && can(me, 'respond_incidents')) {
      cards.push(card('start', 'Start Response', 'fa-play',
        '<div class="ia-buttons">' + button('status', 'Mark In Progress', 'fa-play', false, ' data-to="In Progress"') + '</div>'));
    }

    if (responder && RESPONSE_STATUSES.indexOf(status) !== -1) {
      cards.push(card('action', 'Record Action', 'fa-pen-to-square',
        textArea(pre + 'action', 'action-desc', 'Action taken', 'What was done, by whom, and the outcome') +
        '<div class="ia-row">' +
          '<div class="field ia-grow"><label for="' + pre + 'followup">Next follow-up date (optional)</label>' +
            '<input type="date" id="' + pre + 'followup" data-field="action-date" min="' + localToday() + '" /></div>' +
          button('action', 'Add Action', 'fa-plus', true) +
        '</div>'));

      cards.push(card('followup', 'Follow-Up', 'fa-clock',
        '<div class="ia-buttons">' + (status === 'In Progress'
          ? button('status', 'Mark For Follow-Up', 'fa-clock', false, ' data-to="For Follow-Up"')
          : button('status', 'Resume (In Progress)', 'fa-arrow-rotate-left', false, ' data-to="In Progress"')) +
        '</div>'));

      cards.push(card('resolve', 'Resolve', 'fa-flag-checkered',
        textArea(pre + 'resolution', 'resolution', 'Resolution summary (required)', 'How the incident was resolved') +
        '<div class="ia-buttons">' + button('resolve', 'Mark Resolved', 'fa-flag-checkered', true) + '</div>'));
    }

    // Close (Resolved): School Head, SysAdmin, or an assigned Safety Officer
    var mayClose = isHead || me.role === 'sysadmin' || (me.role === 'safetyofficer' && !!mine);
    if (status === 'Resolved' && mayClose && can(me, 'manage_incidents')) {
      cards.push(card('close', 'Close Incident', 'fa-lock',
        textArea(pre + 'closure', 'closure', 'Closure summary (required)', 'Final review notes for the record') +
        '<p class="ia-note">A closed incident is read-only.</p>' +
        '<div class="ia-buttons">' + button('close', 'Close Incident', 'fa-lock', true) + '</div>'));
    }

    // Record management: restrict (SysAdmin/SchHead), archive (SysAdmin)
    var recordButtons = '';
    if ((me.role === 'sysadmin' || isHead) && can(me, 'manage_incidents')) {
      recordButtons += button('restrict', inc.is_restricted ? 'Remove Restriction' : 'Restrict Incident',
        inc.is_restricted ? 'fa-unlock' : 'fa-lock', false);
    }
    if (me.role === 'sysadmin' && can(me, 'archive_incidents')) {
      recordButtons += button('archive', 'Archive', 'fa-box-archive', false);
    }
    if (recordButtons) {
      cards.push(card('records', 'Record', 'fa-folder-open', '<div class="ia-buttons">' + recordButtons + '</div>'));
    }

    return cards;
  }

  // ── Assign picker ──────────────────────────────────────────────────────────
  async function loadAssignees(container) {
    var box = container.querySelector('[data-field="assignees"]');
    if (!box) return;
    try {
      var r = await api.get('/api/incidents/assignable-users');
      var d = await r.json();
      var users = r.ok ? (d.data || []) : [];
      if (!r.ok) { box.innerHTML = '<p class="error-msg">' + esc(d.error || 'Could not load personnel.') + '</p>'; return; }
      if (!users.length) {
        box.innerHTML = '<p class="ia-note">No active Safety Officer, Guidance, or Teacher accounts.</p>';
        return;
      }
      box.innerHTML = users.map(function (u) {
        return (
          '<label class="ia-check">' +
            '<input type="checkbox" value="' + u.id + '" /> ' + esc(u.full_name) +
            ' <span class="ia-role">' + esc(ROLE_LABELS[u.role] || u.role) + '</span>' +
          '</label>'
        );
      }).join('');
    } catch (_) {
      box.innerHTML = '<p class="error-msg">Could not load personnel.</p>';
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  async function send(btn, errEl, request, opts) {
    btn.disabled = true;
    try {
      var r = await request();
      var d = {};
      try { d = await r.json(); } catch (_) { d = {}; }
      if (!r.ok) {
        errEl.textContent = d.error || ('Request failed (HTTP ' + r.status + ').');
        btn.disabled = false;
        return;
      }
      if (typeof opts.onChange === 'function') opts.onChange();
    } catch (_) {
      errEl.textContent = 'Network error. Please try again.';
      btn.disabled = false;
    }
  }

  function confirmThen(message, fn) {
    if (typeof global.confirmAction === 'function') global.confirmAction(message, fn);
    else fn();
  }

  function handle(act, btn, cardEl, inc, opts) {
    var errEl = cardEl.querySelector('[data-error]');
    var base  = '/api/incidents/' + inc.id;
    function field(name) { return cardEl.querySelector('[data-field="' + name + '"]'); }
    errEl.textContent = '';

    switch (act) {
      case 'classify':
        return send(btn, errEl, function () {
          return api.patch(base + '/classify', { severity: field('severity').value });
        }, opts);

      case 'assign': {
        var ids = Array.prototype.map.call(
          cardEl.querySelectorAll('input[type="checkbox"]:checked'),
          function (c) { return parseInt(c.value, 10); });
        if (!ids.length) { errEl.textContent = 'Select at least one person to assign.'; return undefined; }
        return send(btn, errEl, function () { return api.post(base + '/assign', { user_ids: ids }); }, opts);
      }

      case 'acknowledge':
        return send(btn, errEl, function () { return api.post(base + '/acknowledge', {}); }, opts);

      case 'action':
        return send(btn, errEl, function () {
          return api.post(base + '/actions', {
            description:    field('action-desc').value,
            follow_up_date: field('action-date').value || null,
          });
        }, opts);

      case 'status':
        return send(btn, errEl, function () {
          return api.patch(base + '/status', { status: btn.getAttribute('data-to') });
        }, opts);

      case 'resolve':
        return send(btn, errEl, function () {
          return api.patch(base + '/status', { status: 'Resolved', resolution_summary: field('resolution').value });
        }, opts);

      case 'close':
        return send(btn, errEl, function () {
          return api.patch(base + '/status', { status: 'Closed', closure_summary: field('closure').value });
        }, opts);

      case 'restrict': {
        var next = !inc.is_restricted;
        return confirmThen(next
          ? 'Restrict this incident? Only the System Admin, School Head, and assigned personnel will see it.'
          : 'Remove the restriction? The incident becomes visible to all roles that normally see it.',
        function () {
          send(btn, errEl, function () { return api.patch(base + '/restrict', { is_restricted: next }); }, opts);
        });
      }

      case 'archive':
        return confirmThen(inc.status === 'Closed'
          ? 'Archive this incident? It will be hidden from all lists until restored.'
          : 'This incident is ' + inc.status + ', not Closed. Archive it anyway? It will be hidden from all lists until restored.',
        function () {
          send(btn, errEl, function () { return api.patch(base + '/archive', { confirmed: true }); }, opts);
        });

      case 'restore':
        return send(btn, errEl, function () { return api.patch(base + '/restore', {}); }, opts);

      default:
        return undefined;
    }
  }

  // ── Public ─────────────────────────────────────────────────────────────────
  function render(container, incident, opts) {
    if (!container) return;
    opts = opts || {};
    var me = opts.me || { id: null, role: '', permissions: [] };
    var cards = buildCards(incident, me);

    if (!cards.length) { container.innerHTML = ''; return; }
    container.innerHTML =
      '<div class="info-section-title"><i class="fas fa-list-check"></i> Response</div>' +
      '<div class="ia-grid">' + cards.join('') + '</div>';

    container.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn || !container.contains(btn) || btn.disabled) return;
      handle(btn.getAttribute('data-act'), btn, btn.closest('[data-card]'), incident, opts);
    });

    loadAssignees(container);
  }

  global.SentraIncidentActions = { render: render, ROLE_LABELS: ROLE_LABELS };

})(window);
