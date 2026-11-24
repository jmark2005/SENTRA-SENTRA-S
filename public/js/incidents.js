/**
 * public/js/incidents.js
 * Shared Incident Submission, List, and Detail module.
 *
 * Exposes:
 *   initIncidents(config)  — call once from each dashboard's onSectionChange handler
 *   loadIncidentList()     — refresh the list in the current context
 *
 * config = {
 *   role:          string   e.g. 'teacher' — controls which controls are shown
 *   listSectionId: string   DOM id of the section containing the list table (default 'incidents')
 *   submitSectionId: string  DOM id of the submit-form section (default 'submit-incident', null to skip)
 *   tbodyId:       string   override for list tbody id
 *   metaId:        string   override for list meta id
 *   filterStatusId: string   override for status filter id
 *   filterCategoryId: string override for category filter id
 *   filterFromId:  string   override for from-date filter id
 *   filterToId:    string   override for to-date filter id
 * }
 */
'use strict';

(function (global) {

  // ── Escape ───────────────────────────────────────────────────────────────────
  function esc(v) {
    return String(v === null || v === undefined ? '')
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Status pill CSS class ─────────────────────────────────────────────────
  function statusClass(s) {
    switch (s) {
      case 'Submitted':     return 'status-inactive';
      case 'Under Review':  return 'status-onleave';
      case 'Assigned':      return 'status-onleave';
      case 'In Progress':   return 'status-onleave';
      case 'For Follow-Up': return 'status-onleave';
      case 'Resolved':      return 'status-enrolled';
      case 'Closed':        return 'status-enrolled';
      default:              return 'status-inactive';
    }
  }

  // ── Format date ───────────────────────────────────────────────────────────
  function fmtDate(d) {
    if (!d) return '—';
    var parts = d.split('-');
    if (parts.length !== 3) return d;
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[parseInt(parts[1], 10) - 1] + ' ' + parseInt(parts[2], 10) + ', ' + parts[0];
  }

  // ── Today YYYY-MM-DD (client side, for max= attr) ────────────────────────
  function todayISO() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var dy = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + dy;
  }

  // ── State ──────────────────────────────────────────────────────────────────
  var _parties = [];
  var _files = [];
  var _currentRole = 'teacher';

  // ─────────────────────────────────────────────────────────────────────────────
  // INCIDENT LIST
  // ─────────────────────────────────────────────────────────────────────────────

  async function loadIncidentList(cfg) {
    var tbody  = document.getElementById(cfg.tbodyId || 'incidentListBody');
    var metaEl = document.getElementById(cfg.metaId  || 'incidentListMeta');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Loading\u2026</td></tr>';

    var params = [];
    var statusEl   = document.getElementById(cfg.filterStatusId   || 'incidentFilterStatusNew');
    var categoryEl = document.getElementById(cfg.filterCategoryId || 'incidentFilterCategory');
    var fromEl     = document.getElementById(cfg.filterFromId     || 'incidentFilterFrom');
    var toEl       = document.getElementById(cfg.filterToId       || 'incidentFilterTo');

    if (statusEl   && statusEl.value)   params.push('status='   + encodeURIComponent(statusEl.value));
    if (categoryEl && categoryEl.value) params.push('category=' + encodeURIComponent(categoryEl.value));
    if (fromEl     && fromEl.value)     params.push('from='     + encodeURIComponent(fromEl.value));
    if (toEl       && toEl.value)       params.push('to='       + encodeURIComponent(toEl.value));

    var url = '/api/incidents' + (params.length ? '?' + params.join('&') : '');

    var rows;
    try {
      var r = await api.get(url);
      var d = await r.json();
      rows = r.ok ? (d.data || []) : [];
    } catch (_) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Could not load incidents.</td></tr>';
      return;
    }

    if (metaEl) {
      metaEl.textContent = 'Showing ' + rows.length + ' incident' + (rows.length === 1 ? '' : 's') + '.';
    }

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No incidents found.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(function (inc) {
      var restricted = inc.is_restricted
        ? ' <span class="status-pill" style="background:#f9e5e5;color:#c0392b;" title="Restricted">RESTRICTED</span>'
        : '';
      return (
        '<tr>' +
          '<td>' +
            '<strong>' + esc(inc.reference_number) + '</strong>' + restricted + '<br>' +
            '<small style="color:var(--muted);">' + esc(inc.category_name) + '</small>' +
          '</td>' +
          '<td>' + esc(inc.reporter_name || '—') + '</td>' +
          '<td>' + fmtDate(inc.incident_date) + '</td>' +
          '<td>' +
            (inc.severity
              ? '<span class="incident-severity" data-severity="' + esc(inc.severity) + '">' + esc(inc.severity) + '</span>'
              : '<span style="color:var(--muted);">—</span>') +
          '</td>' +
          '<td><span class="status-pill ' + statusClass(inc.status) + '">' + esc(inc.status) + '</span></td>' +
          '<td>' +
            '<button class="btn-icon" title="View Details"' +
              ' data-action="view-incident" data-id="' + inc.id + '">' +
              '<i class="fas fa-eye"></i>' +
            '</button>' +
          '</td>' +
        '</tr>'
      );
    }).join('');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // INCIDENT DETAIL MODAL
  // ─────────────────────────────────────────────────────────────────────────────

  async function viewIncident(id) {
    var modal    = document.getElementById('incidentDetailModal');
    var bodyEl   = document.getElementById('incidentDetailBody');
    var titleEl  = document.getElementById('incidentDetailTitle');
    if (!modal || !bodyEl) return;

    if (titleEl) titleEl.innerHTML = '<i class="fas fa-file-circle-exclamation"></i> Incident Details';
    bodyEl.innerHTML = '<p class="dash-muted-intro">Loading\u2026</p>';
    modal.classList.add('open');

    var r, inc;
    try {
      r   = await api.get('/api/incidents/' + id);
      inc = await r.json();
    } catch (_) {
      bodyEl.innerHTML = '<p class="error-msg">Could not load incident details.</p>';
      return;
    }

    if (!r.ok) {
      bodyEl.innerHTML = '<p class="error-msg">' + esc(inc.error || 'Error loading incident.') + '</p>';
      return;
    }

    if (titleEl) {
      titleEl.innerHTML =
        '<i class="fas fa-file-circle-exclamation"></i> ' +
        esc(inc.reference_number || 'Incident Details');
    }

    // ── Student role: trimmed view ──────────────────────────────────────────
    if (_currentRole === 'student') {
      bodyEl.innerHTML =
        '<div style="margin-bottom:4px;">' +
          '<span class="status-pill ' + statusClass(inc.status) + '">' + esc(inc.status) + '</span>' +
        '</div>' +
        '<div class="info-section-title" style="margin-top:14px;"><i class="fas fa-circle-info"></i> Incident Details</div>' +
        '<div class="info-grid">' +
          '<div class="info-item"><label>Reference</label><span>' + esc(inc.reference_number) + '</span></div>' +
          '<div class="info-item"><label>Category</label><span>' + esc(inc.category_name) + '</span></div>' +
          '<div class="info-item"><label>Date</label><span>' + fmtDate(inc.incident_date) + '</span></div>' +
          '<div class="info-item"><label>Status</label><span>' + esc(inc.status) + '</span></div>' +
          '<div class="info-item"><label>Submitted</label><span>' + esc((inc.created_at || '').replace('T', ' ').replace('Z', '')) + '</span></div>' +
        '</div>';
      return;
    }

    // ── Full detail view (non-student) ───────────────────────────────────────

    // Build parties list
    var partiesHtml = '';
    if (inc.parties && inc.parties.length) {
      partiesHtml = '<div class="info-section-title"><i class="fas fa-users"></i> Involved Parties</div>' +
        '<ul style="margin:0 0 12px;padding-left:18px;font-size:.88rem;">' +
        inc.parties.map(function (p) {
          if (p.student_id && p.student_number) {
            return '<li>' + esc(p.last_name + ', ' + p.first_name) + ' (' + esc(p.student_number) + ')</li>';
          }
          return '<li>' + esc(p.party_text || '(unnamed)') + '</li>';
        }).join('') +
        '</ul>';
    }

    // Build timeline
    var timelineHtml = '';
    if (inc.timeline && inc.timeline.length) {
      timelineHtml =
        '<div class="info-section-title" style="margin-top:16px;"><i class="fas fa-clock-rotate-left"></i> Activity Timeline</div>' +
        '<div class="timeline-wrap">' +
        inc.timeline.map(function (t) {
          return (
            '<div class="timeline-entry">' +
              '<div class="timeline-dot"></div>' +
              '<div class="timeline-body">' +
                '<div class="timeline-meta">' +
                  '<strong>' + esc(t.entry_type) + '</strong>' +
                  ' &bull; ' + esc(t.actor_name) +
                  ' &bull; <small style="color:var(--muted);">' + esc((t.created_at || '').replace('T', ' ').replace('Z', '')) + '</small>' +
                '</div>' +
                '<div class="timeline-desc">' + esc(t.description) + '</div>' +
              '</div>' +
            '</div>'
          );
        }).join('') +
        '</div>';
    }

    // Build attachments
    var attachHtml = '';
    if (inc.attachments && inc.attachments.length) {
      attachHtml =
        '<div class="info-section-title"><i class="fas fa-paperclip"></i> Attachments</div>' +
        '<ul style="margin:0 0 12px;padding-left:18px;font-size:.88rem;">' +
        inc.attachments.map(function (a) {
          return '<li>' + esc(a.original_name) + ' <small style="color:var(--muted);">(' + Math.round(a.size_bytes / 1024) + ' KB)</small></li>';
        }).join('') +
        '</ul>';
    }

    var restrictedBadge = inc.is_restricted
      ? '<span class="status-pill" style="background:#f9e5e5;color:#c0392b;margin-left:8px;">RESTRICTED</span>'
      : '';

    // ── Status transition buttons ────────────────────────────────────────────
    var actionButtonsHtml = buildStatusButtons(inc.status, _currentRole, inc.id);

    // ── Restrict toggle (sysadmin/schoolhead only) ───────────────────────────
    var restrictHtml = '';
    if (_currentRole === 'sysadmin' || _currentRole === 'schoolhead') {
      var restrictLabel = inc.is_restricted ? 'Remove Restriction' : 'Restrict Incident';
      var restrictActive = inc.is_restricted ? ' active' : '';
      restrictHtml =
        '<div class="incident-action-bar">' +
          '<button class="incident-restrict-toggle' + restrictActive + '" data-action="restrict-toggle" data-id="' + inc.id + '" data-restricted="' + (inc.is_restricted ? '1' : '0') + '">' +
            '<i class="fas fa-' + (inc.is_restricted ? 'unlock' : 'lock') + '"></i> ' + restrictLabel +
          '</button>' +
        '</div>';
    }

    bodyEl.innerHTML =
      '<div style="margin-bottom:4px;">' +
        '<span class="status-pill ' + statusClass(inc.status) + '">' + esc(inc.status) + '</span>' +
        restrictedBadge +
        (inc.severity ? ' <span class="incident-severity" data-severity="' + esc(inc.severity) + '">' + esc(inc.severity) + '</span>' : '') +
      '</div>' +

      '<div class="info-section-title" style="margin-top:14px;"><i class="fas fa-circle-info"></i> Incident Details</div>' +
      '<div class="info-grid">' +
        '<div class="info-item"><label>Reference</label><span>' + esc(inc.reference_number) + '</span></div>' +
        '<div class="info-item"><label>Category</label><span>' + esc(inc.category_name) + '</span></div>' +
        '<div class="info-item"><label>Date</label><span>' + fmtDate(inc.incident_date) + '</span></div>' +
        '<div class="info-item"><label>Time</label><span>' + esc(inc.incident_time || '—') + '</span></div>' +
        '<div class="info-item info-item-span"><label>Location</label><span>' + esc(inc.location_text) + (inc.campus_location_name ? ' <em style="color:var(--muted);">(' + esc(inc.campus_location_name) + ')</em>' : '') + '</span></div>' +
        '<div class="info-item info-item-span"><label>Description</label><span style="white-space:pre-wrap;">' + esc(inc.description) + '</span></div>' +
        '<div class="info-item"><label>Reported By</label><span>' + esc(inc.reporter_name) + '</span></div>' +
        '<div class="info-item"><label>Submitted</label><span>' + esc((inc.created_at || '').replace('T', ' ').replace('Z', '')) + '</span></div>' +
      '</div>' +

      partiesHtml +
      attachHtml +
      timelineHtml +
      (actionButtonsHtml ? '<div class="incident-action-bar" id="incidentActionBar">' + actionButtonsHtml + '</div>' : '') +
      restrictHtml;

    // Wire status transition buttons
    wireStatusButtons(inc.id);

    // Wire restrict toggle
    wireRestrictToggle(inc.id);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // STATUS TRANSITION BUTTONS
  // ─────────────────────────────────────────────────────────────────────────────

  function buildStatusButtons(status, role, incidentId) {
    var buttons = [];
    var canReview    = ['sysadmin', 'schoolhead', 'safetyofficer'].indexOf(role) !== -1;
    var canAssign    = role === 'schoolhead';
    var canRespond   = ['sysadmin', 'schoolhead', 'safetyofficer'].indexOf(role) !== -1;
    var canClose      = ['sysadmin', 'schoolhead', 'safetyofficer'].indexOf(role) !== -1;

    if (status === 'Submitted' && canReview) {
      buttons.push({ label: 'Review &amp; Classify', icon: 'fa-magnifying-glass', action: 'review', to: 'Under Review' });
    }
    if (status === 'Under Review' && canAssign) {
      buttons.push({ label: 'Assign', icon: 'fa-user-check', action: 'assign', to: 'Assigned' });
    }
    if (status === 'Assigned' && canRespond) {
      buttons.push({ label: 'Acknowledge', icon: 'fa-circle-check', action: 'transition', to: 'In Progress' });
    }
    if (status === 'In Progress' && canRespond) {
      buttons.push({ label: 'Mark For Follow-Up', icon: 'fa-clock', action: 'transition', to: 'For Follow-Up' });
      buttons.push({ label: 'Resolve', icon: 'fa-circle-check', action: 'transition', to: 'Resolved' });
    }
    if (status === 'For Follow-Up' && canRespond) {
      buttons.push({ label: 'Resume', icon: 'fa-arrow-rotate-left', action: 'transition', to: 'In Progress' });
      buttons.push({ label: 'Resolve', icon: 'fa-circle-check', action: 'transition', to: 'Resolved' });
    }
    if (status === 'Resolved' && canClose) {
      buttons.push({ label: 'Close Incident', icon: 'fa-lock', action: 'transition', to: 'Closed' });
    }

    if (!buttons.length) return '';

    return buttons.map(function (b) {
      return (
        '<button class="btn-soft btn-sm" data-action="status-transition"' +
          ' data-id="' + incidentId + '"' +
          ' data-to="' + esc(b.to) + '"' +
          ' data-transition-action="' + esc(b.action) + '"' +
          ' title="Transition to ' + esc(b.to) + '">' +
          '<i class="fas ' + esc(b.icon) + '"></i> ' + b.label +
        '</button>'
      );
    }).join('');
  }

  function wireStatusButtons(incidentId) {
    var bodyEl = document.getElementById('incidentDetailBody');
    if (!bodyEl) return;
    var btns = bodyEl.querySelectorAll('[data-action="status-transition"]');
    btns.forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var toStatus = btn.dataset.to;
        var transitionAction = btn.dataset.transitionAction;
        var errEl = document.getElementById('incidentTransitionError');
        if (errEl) errEl.textContent = '';

        btn.disabled = true;
        try {
          var r, d;
          if (transitionAction === 'review') {
            // Review & Classify calls the classify endpoint
            r = await api.patch('/api/incidents/' + incidentId + '/classify', { severity: 'Moderate' });
          } else if (transitionAction === 'assign') {
            // Assign — schoolhead only (T-24 not implemented yet)
            r = await api.post('/api/incidents/' + incidentId + '/assign', {});
          } else {
            // Generic status transition
            r = await api.patch('/api/incidents/' + incidentId + '/status', { status: toStatus });
          }
          d = await r.json();
          if (!r.ok) {
            // Endpoint doesn't exist yet (T-22/T-24) — show graceful error
            var msg = d.error || 'This action is not available yet.';
            showTransitionError(msg);
          } else {
            // Success — refresh detail
            viewIncident(incidentId);
          }
        } catch (e) {
          showTransitionError('Network error. Please try again.');
        }
        btn.disabled = false;
      });
    });
  }

  function showTransitionError(msg) {
    var bodyEl = document.getElementById('incidentDetailBody');
    if (!bodyEl) return;
    var existing = document.getElementById('incidentTransitionError');
    if (existing) existing.remove();
    var err = document.createElement('p');
    err.id = 'incidentTransitionError';
    err.className = 'error-msg';
    err.textContent = msg;
    err.style.marginTop = '8px';
    var actionBar = document.getElementById('incidentActionBar');
    if (actionBar) {
      actionBar.appendChild(err);
    } else {
      bodyEl.appendChild(err);
    }
    setTimeout(function () { if (err.parentNode) err.remove(); }, 5000);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RESTRICT TOGGLE
  // ─────────────────────────────────────────────────────────────────────────────

  function wireRestrictToggle(incidentId) {
    var bodyEl = document.getElementById('incidentDetailBody');
    if (!bodyEl) return;
    var btn = bodyEl.querySelector('[data-action="restrict-toggle"]');
    if (!btn) return;

    btn.addEventListener('click', async function () {
      var currentlyRestricted = btn.dataset.restricted === '1';
      var newRestricted = !currentlyRestricted;
      var msg = newRestricted
        ? 'Restrict this incident? It will be hidden from Teacher, Guidance, and Student lists.'
        : 'Remove restriction? This incident will be visible to all authorised roles again.';

      if (typeof confirmAction === 'function') {
        confirmAction(msg, function () { doRestrictToggle(incidentId, btn, newRestricted); });
      } else {
        doRestrictToggle(incidentId, btn, newRestricted);
      }
    });
  }

  async function doRestrictToggle(incidentId, btn, newRestricted) {
    try {
      var r = await api.patch('/api/incidents/' + incidentId + '/restrict', { is_restricted: newRestricted });
      var d = await r.json();
      if (!r.ok) {
        // Endpoint doesn't exist yet (T-22) — show graceful error
        showTransitionError(d.error || 'Restrict toggle is not available yet.');
        return;
      }
      // Success — refresh detail
      viewIncident(incidentId);
    } catch (e) {
      showTransitionError('Network error. Please try again.');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SUBMISSION FORM
  // ─────────────────────────────────────────────────────────────────────────────

  async function populateSubmitForm(role) {
    // Load categories into dropdown
    var catSel = document.getElementById('incidentFormCategory');
    if (catSel) {
      catSel.innerHTML = '<option value="">Loading\u2026</option>';
      try {
        var cr = await api.get('/api/incident-categories?active_only=true');
        var cd = await cr.json();
        var cats = cr.ok ? (cd.data || []) : [];
        catSel.innerHTML = '<option value="">\u2014 Select category \u2014</option>' +
          cats.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('');
      } catch (_) {
        catSel.innerHTML = '<option value="">Could not load categories</option>';
      }
    }

    // Set max date to today (client-side guard; server also validates)
    var dateIn = document.getElementById('incidentFormDate');
    if (dateIn) dateIn.max = todayISO();

    // Load campus locations into optional dropdown
    var locFieldWrap = document.getElementById('incidentFormLocFieldWrap');
    var locSel       = document.getElementById('incidentFormCampusLoc');
    if (locSel && typeof populateCampusLocationDropdown === 'function') {
      await populateCampusLocationDropdown(locSel, locFieldWrap);
    }

    // Student lookup (non-student reporters only)
    var partySection = document.getElementById('incidentFormPartySection');
    var studentLookupWrap = document.getElementById('incidentFormStudentLookupWrap');
    if (role === 'student') {
      // Students use free-text only
      if (studentLookupWrap) studentLookupWrap.style.display = 'none';
    } else {
      if (studentLookupWrap) studentLookupWrap.style.display = '';
      wireStudentLookup();
    }

    // Wire file upload zone
    wireFileUpload();
  }

  // ── Student lookup for incident parties (non-student reporters) ────────────

  function wireStudentLookup() {
    _parties = [];
    renderParties();

    var lookupBtn = document.getElementById('incidentPartyLookupBtn');
    var lookupIn  = document.getElementById('incidentPartyStudentNum');
    var addFreeBtn = document.getElementById('incidentPartyAddFreeBtn');
    var freeIn    = document.getElementById('incidentPartyFreeText');

    if (lookupBtn && lookupIn) {
      lookupBtn.addEventListener('click', async function () {
        var num = lookupIn.value.trim();
        if (!num) return;
        var errEl = document.getElementById('incidentPartyError');
        if (errEl) errEl.textContent = '';
        try {
          var r = await api.get('/api/students?q=' + encodeURIComponent(num));
          var d = await r.json();
          var list = r.ok ? (d.data || []) : [];
          var match = list.find(function (s) { return s.student_number === num; });
          if (!match) {
            if (errEl) errEl.textContent = 'Student number not found.';
            return;
          }
          // Don't add duplicates
          if (_parties.some(function (p) { return p.student_id === match.id; })) {
            if (errEl) errEl.textContent = 'Already added.';
            return;
          }
          _parties.push({ student_id: match.id, party_text: null, display: match.last_name + ', ' + match.first_name + ' (' + match.student_number + ')' });
          lookupIn.value = '';
          renderParties();
        } catch (_) {
          var errEl2 = document.getElementById('incidentPartyError');
          if (errEl2) errEl2.textContent = 'Lookup failed.';
        }
      });
    }

    if (addFreeBtn && freeIn) {
      addFreeBtn.addEventListener('click', function () {
        var text = freeIn.value.trim();
        if (!text) return;
        _parties.push({ student_id: null, party_text: text, display: text });
        freeIn.value = '';
        renderParties();
      });
    }
  }

  function renderParties() {
    var listEl = document.getElementById('incidentPartyList');
    if (!listEl) return;
    if (!_parties.length) {
      listEl.innerHTML = '<p style="color:var(--muted);font-size:.85rem;">No parties added yet.</p>';
      return;
    }
    listEl.innerHTML = _parties.map(function (p, i) {
      return (
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
          '<span style="font-size:.88rem;">' + esc(p.display) + '</span>' +
          '<button type="button" class="btn-icon btn-danger" data-action="remove-party" data-idx="' + i + '" title="Remove">' +
            '<i class="fas fa-xmark"></i>' +
          '</button>' +
        '</div>'
      );
    }).join('');

    listEl.querySelectorAll('[data-action="remove-party"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _parties.splice(parseInt(btn.dataset.idx, 10), 1);
        renderParties();
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // FILE UPLOAD ZONE
  // ─────────────────────────────────────────────────────────────────────────────

  var ACCEPTED_MIME = ['image/jpeg', 'image/png', 'application/pdf'];
  var ACCEPTED_EXT  = ['.jpg', '.jpeg', '.png', '.pdf'];
  var MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
  var MAX_FILES      = 3;

  function wireFileUpload() {
    _files = [];

    var dropzone = document.getElementById('incidentFileDropzone');
    var fileInput = document.getElementById('incidentFileInput');
    var errEl = document.getElementById('incidentFileError');
    if (errEl) errEl.textContent = '';

    if (!dropzone || !fileInput) return;

    // Click to browse
    dropzone.addEventListener('click', function () { fileInput.click(); });

    // Drag and drop
    dropzone.addEventListener('dragover', function (e) {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
    dropzone.addEventListener('dragleave', function () {
      dropzone.classList.remove('drag-over');
    });
    dropzone.addEventListener('drop', function (e) {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      handleFiles(e.dataTransfer.files);
    });

    // File input change
    fileInput.addEventListener('change', function () {
      handleFiles(this.files);
      this.value = ''; // reset so same file can be re-selected
    });

    renderFilePreview();
  }

  function handleFiles(fileList) {
    var errEl = document.getElementById('incidentFileError');
    if (errEl) errEl.textContent = '';

    var files = Array.from(fileList);

    for (var i = 0; i < files.length; i++) {
      var f = files[i];

      // Check max file count
      if (_files.length >= MAX_FILES) {
        if (errEl) errEl.textContent = 'Maximum ' + MAX_FILES + ' files allowed.';
        break;
      }

      // Check file type
      var validType = ACCEPTED_MIME.indexOf(f.type) !== -1;
      if (!validType) {
        // Also check by extension as fallback (some browsers don't set MIME for PDF)
        var ext = '.' + (f.name.split('.').pop() || '').toLowerCase();
        validType = ACCEPTED_EXT.indexOf(ext) !== -1;
      }
      if (!validType) {
        if (errEl) errEl.textContent = '"' + f.name + '": Only JPG, PNG, and PDF files are accepted.';
        continue;
      }

      // Check file size
      if (f.size > MAX_FILE_SIZE) {
        if (errEl) errEl.textContent = '"' + f.name + '": File exceeds the 5 MB size limit.';
        continue;
      }

      _files.push(f);
    }

    renderFilePreview();
  }

  function renderFilePreview() {
    var previewEl = document.getElementById('incidentFilePreview');
    if (!previewEl) return;

    if (!_files.length) {
      previewEl.innerHTML = '';
      return;
    }

    var html = '<div class="file-preview-list">';

    _files.forEach(function (f, i) {
      var sizeStr = f.size < 1024 ? f.size + ' B' : f.size < 1024 * 1024 ? Math.round(f.size / 1024) + ' KB' : (f.size / (1024 * 1024)).toFixed(1) + ' MB';
      var isImage = f.type.indexOf('image/') === 0;
      var icon = f.type === 'application/pdf' ? 'fa-file-pdf' : 'fa-file-image';

      html +=
        '<div class="file-preview-item" data-file-idx="' + i + '">' +
          (isImage
            ? '<img class="file-preview-thumb" alt="" data-file-idx="' + i + '" />'
            : '<div class="file-preview-icon"><i class="fas ' + icon + '"></i></div>') +
          '<div class="file-preview-info">' +
            '<div class="file-preview-name">' + esc(f.name) + '</div>' +
            '<div class="file-preview-size">' + sizeStr + '</div>' +
          '</div>' +
          '<button type="button" class="file-preview-remove" data-action="remove-file" data-idx="' + i + '" title="Remove">' +
            '<i class="fas fa-xmark"></i>' +
          '</button>' +
        '</div>';
    });

    html += '</div>';
    previewEl.innerHTML = html;

    // Load image thumbnails
    _files.forEach(function (f, i) {
      if (f.type.indexOf('image/') === 0) {
        var reader = new FileReader();
        reader.onload = function (e) {
          var img = previewEl.querySelector('.file-preview-thumb[data-file-idx="' + i + '"]');
          if (img) img.src = e.target.result;
        };
        reader.readAsDataURL(f);
      }
    });

    // Wire remove buttons
    previewEl.querySelectorAll('[data-action="remove-file"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _files.splice(parseInt(btn.dataset.idx, 10), 1);
        renderFilePreview();
      });
    });
  }

  async function uploadFiles(incidentId) {
    var warnEl = document.getElementById('incidentFileError');
    if (!_files.length) return;

    for (var i = 0; i < _files.length; i++) {
      var f = _files[i];
      try {
        var formData = new FormData();
        formData.append('file', f, f.name);
        var r = await api.upload('/api/incidents/' + incidentId + '/attachments', formData);
        // Endpoint doesn't exist yet (T-21) — 404 or 405 expected
        if (!r.ok) {
          // Graceful: don't block, just warn
          if (warnEl) {
            warnEl.textContent = 'Attachment upload is not available yet. Your incident was still submitted successfully.';
          }
          break;
        }
      } catch (e) {
        if (warnEl) {
          warnEl.textContent = 'Attachment upload failed. Your incident was still submitted successfully.';
        }
        break;
      }
    }

    // Clear files after upload attempt
    _files = [];
    renderFilePreview();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SUBMIT FORM
  // ─────────────────────────────────────────────────────────────────────────────

  async function submitIncidentForm(role, listCfg) {
    var errEl = document.getElementById('incidentFormError');
    if (errEl) errEl.textContent = '';

    var catSel  = document.getElementById('incidentFormCategory');
    var dateIn  = document.getElementById('incidentFormDate');
    var timeIn  = document.getElementById('incidentFormTime');
    var locIn   = document.getElementById('incidentFormLocation');
    var descIn  = document.getElementById('incidentFormDescription');
    var locSel  = document.getElementById('incidentFormCampusLoc');

    var category_id    = catSel  ? catSel.value  : '';
    var incident_date  = dateIn  ? dateIn.value  : '';
    var incident_time  = timeIn  ? timeIn.value  : '';
    var location_text  = locIn   ? locIn.value.trim() : '';
    var description    = descIn  ? descIn.value.trim() : '';
    var campus_location_id = (locSel && locSel.value) ? parseInt(locSel.value, 10) : null;

    // Client-side required validation
    var missing = [];
    if (!category_id)   missing.push('category');
    if (!incident_date) missing.push('date');
    if (!incident_time) missing.push('time');
    if (!location_text) missing.push('location');
    if (!description)   missing.push('description');

    if (missing.length) {
      if (errEl) errEl.textContent = 'Please fill in: ' + missing.join(', ') + '.';
      return;
    }

    // Client-side future-date guard
    if (incident_date > todayISO()) {
      if (errEl) errEl.textContent = 'Incident date cannot be in the future.';
      return;
    }

    var body = {
      category_id:         parseInt(category_id, 10),
      incident_date:       incident_date,
      incident_time:       incident_time,
      location_text:       location_text,
      description:         description,
      campus_location_id:  campus_location_id,
      parties: _parties.map(function (p) {
        return { student_id: p.student_id || null, party_text: p.party_text || null };
      }),
    };

    var submitBtn = document.getElementById('incidentFormSubmitBtn');
    if (submitBtn) submitBtn.disabled = true;

    var r, d;
    try {
      r = await api.post('/api/incidents', body);
      d = await r.json();
    } catch (_) {
      if (errEl) errEl.textContent = 'Network error. Please try again.';
      if (submitBtn) submitBtn.disabled = false;
      return;
    }

    if (submitBtn) submitBtn.disabled = false;

    if (!r.ok) {
      if (errEl) errEl.textContent = d.error || 'Submission failed.';
      return;
    }

    // Show confirmation
    var successEl = document.getElementById('incidentFormSuccess');
    if (successEl) {
      successEl.innerHTML =
        '<i class="fas fa-check-circle" style="color:#27ae60;"></i> ' +
        'Incident submitted. Reference number: <strong>' + esc(d.reference_number || '') + '</strong>';
      successEl.style.display = '';
    }

    // Attempt file uploads (endpoint may not exist yet — T-21)
    var incidentId = d.id || (d.reference_number ? d.reference_number : null);
    if (incidentId && _files.length) {
      await uploadFiles(incidentId);
    } else {
      _files = [];
      renderFilePreview();
    }

    // Reset form
    var form = document.getElementById('incidentSubmitForm');
    if (form) form.reset();
    _parties = [];
    renderParties();

    // Re-set date max after reset
    if (dateIn) dateIn.max = todayISO();

    // Refresh list after short delay
    setTimeout(function () {
      if (successEl) successEl.style.display = 'none';
      if (listCfg) loadIncidentList(listCfg);
    }, 3000);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // FILTER BAR population
  // ─────────────────────────────────────────────────────────────────────────────

  async function populateCategoryFilter(selectId) {
    var sel = document.getElementById(selectId);
    if (!sel) return;
    try {
      var r = await api.get('/api/incident-categories');
      var d = await r.json();
      var cats = r.ok ? (d.data || []) : [];
      sel.innerHTML = '<option value="">All Categories</option>' +
        cats.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('');
    } catch (_) { /* silent */ }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────────────────────

  var _initialised = {};

  function initIncidents(cfg) {
    cfg = cfg || {};
    var role           = cfg.role           || 'teacher';
    var listSectionId  = cfg.listSectionId  || 'incidents';
    var submitSectionId = cfg.submitSectionId !== undefined ? cfg.submitSectionId : 'submit-incident';

    // Store role for viewIncident
    _currentRole = role;

    var listCfg = {
      tbodyId:          cfg.tbodyId          || 'incidentListBody',
      metaId:           cfg.metaId           || 'incidentListMeta',
      filterStatusId:   cfg.filterStatusId   || 'incidentFilterStatusNew',
      filterCategoryId: cfg.filterCategoryId || 'incidentFilterCategory',
      filterFromId:     cfg.filterFromId     || 'incidentFilterFrom',
      filterToId:       cfg.filterToId       || 'incidentFilterTo',
    };

    // Wire list section only once
    var listKey = listSectionId;
    if (!_initialised[listKey]) {
      _initialised[listKey] = true;

      // Filter change handlers — use configured IDs
      var filterIds = [listCfg.filterStatusId, listCfg.filterCategoryId, listCfg.filterFromId, listCfg.filterToId];
      filterIds.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('change', function () { loadIncidentList(listCfg); });
      });

      // Event delegation on table
      var tbody = document.getElementById(listCfg.tbodyId);
      if (tbody) {
        tbody.addEventListener('click', function (e) {
          var btn = e.target.closest('[data-action]');
          if (!btn) return;
          if (btn.dataset.action === 'view-incident') {
            viewIncident(parseInt(btn.dataset.id, 10));
          }
        });
      }

      // Category filter populate
      populateCategoryFilter(listCfg.filterCategoryId);
    }

    // Wire submit section only once
    if (submitSectionId && !_initialised['submit-' + submitSectionId]) {
      _initialised['submit-' + submitSectionId] = true;
      populateSubmitForm(role);

      var form = document.getElementById('incidentSubmitForm');
      if (form) {
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          submitIncidentForm(role, listCfg);
        });
      }
    }

    // Wire detail modal close
    if (!_initialised['detail-modal']) {
      _initialised['detail-modal'] = true;
      var detailModal = document.getElementById('incidentDetailModal');
      var closeBtn    = document.getElementById('incidentDetailClose');
      var closeFooterBtn = document.getElementById('incidentDetailCloseFooter');
      if (closeBtn && detailModal) {
        closeBtn.addEventListener('click', function () { detailModal.classList.remove('open'); });
      }
      if (closeFooterBtn && detailModal) {
        closeFooterBtn.addEventListener('click', function () { detailModal.classList.remove('open'); });
      }
      if (detailModal) {
        detailModal.addEventListener('click', function (e) {
          if (e.target === detailModal) detailModal.classList.remove('open');
        });
      }
    }

    // Always load fresh list
    loadIncidentList(listCfg);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Exports
  // ─────────────────────────────────────────────────────────────────────────────
  global.initIncidents    = initIncidents;
  global.loadIncidentList = loadIncidentList;

})(window);
