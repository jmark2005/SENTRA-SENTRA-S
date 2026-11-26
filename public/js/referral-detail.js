/**
 * public/js/referral-detail.js — referral detail and management (T-28B).
 *
 * Exposes window.SentraReferralDetail.open(id, opts)
 *   opts.me:       { id, role, full_name, permissions[] } from GET /api/auth/me
 *   opts.onChange: called after any successful change (refresh the list)
 *
 * Controls appear only when valid for the user and the referral's status;
 * the server enforces the same rules and its errors are shown inline.
 * Completed and Referred referrals are read-only. Referrals hold
 * administrative information only — no counseling or clinical content.
 * All writes go through api.js.
 */
'use strict';

(function (global) {

  var STATUS_CLASS = {
    Pending: 'status-inactive', Ongoing: 'status-onleave',
    Completed: 'status-enrolled', Referred: 'status-referred',
  };
  var ROLE_LABELS = {
    sysadmin: 'System Admin', schoolhead: 'School Head', teacher: 'Teacher',
    guidance: 'Guidance', safetyofficer: 'Safety Officer',
  };
  var FINAL = ['Completed', 'Referred'];

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
    var p = String(d).split('-');
    if (p.length !== 3) return esc(d);
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[parseInt(p[1], 10) - 1] + ' ' + parseInt(p[2], 10) + ', ' + p[0];
  }

  function fmtStamp(s) {
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d.getTime())) return esc(s);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function can(me, code) { return (me.permissions || []).indexOf(code) !== -1; }

  // ── Modal shell (created once per page) ────────────────────────────────────
  var modal = null;

  function ensureModal() {
    if (modal) return modal;
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'referralDetailModal';
    overlay.innerHTML =
      '<div class="modal modal-lg" role="dialog" aria-modal="true" aria-labelledby="referralDetailTitle">' +
        '<div class="modal-header">' +
          '<h3 id="referralDetailTitle"><i class="fas fa-hand-holding-heart"></i> Referral</h3>' +
          '<button class="modal-close" type="button" data-close aria-label="Close"><i class="fas fa-xmark"></i></button>' +
        '</div>' +
        '<div class="modal-body" data-body></div>' +
        '<div class="modal-footer"><button class="btn-soft btn-sm" type="button" data-close>Close</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.closest('[data-close]')) overlay.classList.remove('open');
    });
    modal = { overlay: overlay, title: overlay.querySelector('#referralDetailTitle'), body: overlay.querySelector('[data-body]') };
    return modal;
  }

  // ── Pieces ─────────────────────────────────────────────────────────────────
  function infoItem(label, html, wide) {
    return '<div class="info-item' + (wide ? ' info-item-span' : '') + '"><label>' + label + '</label><span>' + html + '</span></div>';
  }

  function card(name, title, icon, inner) {
    return (
      '<section class="ia-card" data-card="' + name + '">' +
        '<h4 class="ia-title"><i class="fas ' + icon + '"></i> ' + title + '</h4>' +
        inner +
        '<p class="error-msg" data-error role="alert"></p>' +
      '</section>'
    );
  }

  function button(act, label, icon, primary) {
    return '<button type="button" class="' + (primary ? 'btn-maroon' : 'btn-soft') + ' btn-sm" data-act="' + act + '">' +
      '<i class="fas ' + icon + '"></i> ' + label + '</button>';
  }

  function detailHtml(ref) {
    var badges =
      '<div class="incident-badges">' +
        '<span class="status-pill ' + (STATUS_CLASS[ref.status] || 'status-inactive') + '">' + esc(ref.status) + '</span>' +
        (ref.is_archived ? '<span class="status-pill pill-archived">ARCHIVED</span>' : '') +
      '</div>';

    var info =
      '<div class="info-section-title"><i class="fas fa-circle-info"></i> Referral Details</div>' +
      '<div class="info-grid">' +
        infoItem('Student', esc(ref.student_last_name + ', ' + ref.student_first_name) +
          ' <em class="muted-inline">(' + esc(ref.student_number) + ' · Grade ' + esc(ref.grade_level) + ' · ' + esc(ref.section) + ')</em>', true) +
        infoItem('Type', esc(ref.referral_type)) +
        infoItem('Date of Referral', fmtDate(ref.referral_date)) +
        infoItem('Referred By', esc(ref.referring_user_name)) +
        infoItem('Assigned To', ref.assigned_to_name ? esc(ref.assigned_to_name) : '<span class="muted-inline">Unassigned</span>') +
        (ref.remarks ? infoItem('Administrative Remarks', '<span class="pre-wrap">' + esc(ref.remarks) + '</span>', true) : '') +
        (ref.completion_note ? infoItem('Completion Note', '<span class="pre-wrap">' + esc(ref.completion_note) + '</span>', true) : '') +
        (ref.referred_destination ? infoItem('Referred To', esc(ref.referred_destination), true) : '') +
        infoItem('Submitted', fmtStamp(ref.created_at)) +
        infoItem('Last Updated', fmtStamp(ref.updated_at)) +
      '</div>';

    var followups = '';
    if (ref.limited_view) {
      followups = '<p class="ia-note ref-limited-note"><i class="fas fa-lock"></i> Follow-up records are shown only to the person handling this referral and the School Head.</p>';
    } else {
      var list = ref.followups || [];
      followups =
        '<div class="info-section-title"><i class="fas fa-clock-rotate-left"></i> Follow-Up Activity</div>' +
        (list.length
          ? '<div class="timeline-wrap">' + list.map(function (f) {
              return (
                '<div class="timeline-entry"><div class="timeline-dot"></div><div class="timeline-body">' +
                  '<div class="timeline-meta"><strong>' + fmtDate(f.activity_date) + '</strong> &bull; ' + esc(f.actor_name) +
                    ' <span class="muted-inline">(' + esc(ROLE_LABELS[f.actor_role] || f.actor_role) + ')</span></div>' +
                  '<div class="timeline-desc pre-wrap">' + esc(f.activity_desc) + '</div>' +
                  (f.next_followup ? '<div class="timeline-followup"><i class="fas fa-calendar-day"></i> Next follow-up: ' + fmtDate(f.next_followup) + '</div>' : '') +
                '</div></div>'
              );
            }).join('') + '</div>'
          : '<p class="ia-note">No follow-up activity recorded yet.</p>');
    }

    return badges + info + followups + '<div data-controls class="incident-actions"></div>';
  }

  // ── Which controls apply ───────────────────────────────────────────────────
  function buildCards(ref, me) {
    var cards = [];
    var pre = 'rd-' + ref.id + '-';
    var isManager = (me.role === 'guidance' || me.role === 'schoolhead') && can(me, 'manage_referrals');
    var isAssignee = ref.assigned_to === me.id;

    if (ref.is_archived) {
      if (me.role === 'sysadmin') {
        cards.push(card('records', 'Record', 'fa-box-archive',
          '<p class="ia-note">This referral is archived and hidden from all lists.</p>' +
          '<div class="ia-buttons">' + button('restore', 'Restore', 'fa-box-open', true) + '</div>'));
      }
      return cards;
    }

    if (FINAL.indexOf(ref.status) !== -1) {
      cards.push(card('final', 'Read-only', 'fa-lock',
        '<p class="ia-note">This referral is ' + esc(ref.status) + ' and read-only. No further follow-ups or changes can be made.</p>'));
    }

    // Assign / reassign
    if (isManager && (ref.status === 'Pending' || ref.status === 'Ongoing')) {
      cards.push(card('assign', ref.status === 'Pending' ? 'Assign' : 'Reassign', 'fa-user-check',
        '<div class="ia-row">' +
          '<div class="field ia-grow"><label for="' + pre + 'assignee">Assign to</label>' +
            '<select id="' + pre + 'assignee" data-field="assignee"><option value="">Loading…</option></select></div>' +
          button('assign', 'Assign', 'fa-user-check', true) +
        '</div>' +
        (me.role === 'guidance' && !isAssignee
          ? '<div class="ia-buttons">' + button('assign-self', 'Assign to Me', 'fa-hand', false) + '</div>' : '')));
    }

    // Follow-up (assigned person or School Head), only while Ongoing
    var mayFollowUp = ref.status === 'Ongoing' && (isAssignee || (me.role === 'schoolhead' && can(me, 'manage_referrals')));
    if (mayFollowUp) {
      cards.push(card('followup', 'Add Follow-Up', 'fa-pen-to-square',
        '<div class="field"><label for="' + pre + 'desc">Activity — administrative description only; no counseling notes or clinical details</label>' +
          '<textarea id="' + pre + 'desc" data-field="desc" rows="3" maxlength="2000" placeholder="e.g. Met with student and adviser; agreed on a study schedule"></textarea></div>' +
        '<div class="ia-row">' +
          '<div class="field ia-grow"><label for="' + pre + 'adate">Date of activity</label>' +
            '<input type="date" id="' + pre + 'adate" data-field="adate" value="' + localToday() + '" max="' + localToday() + '" /></div>' +
          '<div class="field ia-grow"><label for="' + pre + 'next">Next follow-up (optional)</label>' +
            '<input type="date" id="' + pre + 'next" data-field="next" min="' + localToday() + '" /></div>' +
        '</div>' +
        '<div class="ia-buttons">' + button('followup', 'Add Follow-Up', 'fa-plus', true) + '</div>'));
    }

    // Complete or refer on (assigned counselor or School Head), only while Ongoing
    var mayFinish = ref.status === 'Ongoing' && isManager && (me.role === 'schoolhead' || isAssignee);
    if (mayFinish) {
      cards.push(card('complete', 'Complete', 'fa-flag-checkered',
        '<div class="field"><label for="' + pre + 'note">Completion note (required) — administrative summary only; no counseling or clinical details</label>' +
          '<textarea id="' + pre + 'note" data-field="note" rows="3" maxlength="2000"></textarea></div>' +
        '<div class="ia-buttons">' + button('complete', 'Mark Completed', 'fa-flag-checkered', true) + '</div>'));
      cards.push(card('refer', 'Refer On', 'fa-share',
        '<div class="field"><label for="' + pre + 'dest">Referred to (required) — destination only, no clinical detail</label>' +
          '<input type="text" id="' + pre + 'dest" data-field="dest" maxlength="300" placeholder="e.g. Referred to the division office" /></div>' +
        '<div class="ia-buttons">' + button('refer', 'Mark Referred', 'fa-share', true) + '</div>'));
    }

    if (me.role === 'sysadmin') {
      cards.push(card('records', 'Record', 'fa-folder-open',
        '<div class="ia-buttons">' + button('archive', 'Archive', 'fa-box-archive', false) + '</div>'));
    }
    return cards;
  }

  async function loadAssignees(container, ref) {
    var sel = container.querySelector('[data-field="assignee"]');
    if (!sel) return;
    try {
      var r = await api.get('/api/referrals/assignable-users');
      var d = await r.json();
      var users = r.ok ? (d.data || []) : [];
      sel.innerHTML = '<option value="">— Select person —</option>' + users
        .filter(function (u) { return u.id !== ref.assigned_to; })
        .map(function (u) {
          return '<option value="' + u.id + '">' + esc(u.full_name) + ' (' + esc(ROLE_LABELS[u.role] || u.role) + ')</option>';
        }).join('');
    } catch (_) {
      sel.innerHTML = '<option value="">Could not load people</option>';
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  async function send(btn, errEl, request, after) {
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
      after();
    } catch (_) {
      errEl.textContent = 'Network error. Please try again.';
      btn.disabled = false;
    }
  }

  function handle(act, btn, cardEl, ref, opts, reload) {
    var errEl = cardEl.querySelector('[data-error]');
    var base = '/api/referrals/' + ref.id;
    function field(name) { return cardEl.querySelector('[data-field="' + name + '"]'); }
    errEl.textContent = '';

    switch (act) {
      case 'assign': {
        var uid = parseInt(field('assignee').value, 10);
        if (!uid) { errEl.textContent = 'Choose a person to assign.'; return; }
        send(btn, errEl, function () { return api.patch(base + '/assign', { user_id: uid }); }, reload);
        return;
      }
      case 'assign-self':
        send(btn, errEl, function () { return api.patch(base + '/assign', { user_id: opts.me.id }); }, reload);
        return;
      case 'followup':
        send(btn, errEl, function () {
          return api.post(base + '/followups', {
            activity_desc: field('desc').value,
            activity_date: field('adate').value,
            next_followup: field('next').value || null,
          });
        }, reload);
        return;
      case 'complete':
        send(btn, errEl, function () {
          return api.patch(base + '/status', { status: 'Completed', completion_note: field('note').value });
        }, reload);
        return;
      case 'refer':
        send(btn, errEl, function () {
          return api.patch(base + '/status', { status: 'Referred', referred_destination: field('dest').value });
        }, reload);
        return;
      case 'archive': {
        var msg = FINAL.indexOf(ref.status) !== -1
          ? 'Archive this referral? It will be hidden from all lists until restored.'
          : 'This referral is ' + ref.status + ', not finished. Archive it anyway? It will be hidden from all lists until restored.';
        var go = function () { send(btn, errEl, function () { return api.patch(base + '/archive', { confirmed: true }); }, reload); };
        if (typeof global.confirmAction === 'function') global.confirmAction(msg, go); else go();
        return;
      }
      case 'restore':
        send(btn, errEl, function () { return api.patch(base + '/restore', {}); }, reload);
        return;
      default:
    }
  }

  // ── Public ─────────────────────────────────────────────────────────────────
  async function open(id, opts) {
    opts = opts || {};
    var m = ensureModal();
    var me = opts.me || { id: null, role: '', permissions: [] };
    if (!m.overlay.classList.contains('open')) {
      m.body.innerHTML = '<p class="dash-muted-intro">Loading…</p>';
      m.overlay.classList.add('open');
    }

    var r, ref;
    try {
      r = await api.get('/api/referrals/' + id);
      ref = await r.json();
    } catch (_) {
      m.body.innerHTML = '<p class="error-msg">Could not load the referral.</p>';
      return;
    }
    if (!r.ok) {
      m.body.innerHTML = '<p class="error-msg">' + esc(ref.error || 'Could not load the referral.') + '</p>';
      return;
    }

    m.title.innerHTML = '<i class="fas fa-hand-holding-heart"></i> Referral #' + ref.id;
    m.body.innerHTML = detailHtml(ref);

    var controls = m.body.querySelector('[data-controls]');
    var cards = buildCards(ref, me);
    if (cards.length) {
      controls.innerHTML = '<div class="info-section-title"><i class="fas fa-list-check"></i> Manage</div>' +
        '<div class="ia-grid">' + cards.join('') + '</div>';
    }

    function reload() {
      open(id, opts);
      if (typeof opts.onChange === 'function') opts.onChange();
    }

    controls.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn || btn.disabled) return;
      handle(btn.getAttribute('data-act'), btn, btn.closest('[data-card]'), ref, { me: me }, reload);
    });

    loadAssignees(controls, ref);
  }

  global.SentraReferralDetail = { open: open };

})(window);
