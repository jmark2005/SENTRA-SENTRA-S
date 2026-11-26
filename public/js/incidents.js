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
    return String(v === null || v === undefined ? '' : v)
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
  var _formUploadZone = null; // SentraAttachments controller for the submit form
  var _currentRole = 'teacher';
  var _listCfg = null;        // last list config, refreshed after detail actions

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
        ? ' <span class="status-pill pill-restricted" title="Restricted">RESTRICTED</span>'
        : '';
      return (
        '<tr>' +
          '<td>' +
            '<strong>' + esc(inc.reference_number) + '</strong>' + restricted + '<br>' +
            '<small class="muted-inline">' + esc(inc.category_name) + '</small>' +
          '</td>' +
          '<td>' + esc(inc.reporter_name || '—') + '</td>' +
          '<td>' + fmtDate(inc.incident_date) + '</td>' +
          '<td>' +
            (inc.severity
              ? '<span class="incident-severity" data-severity="' + esc(inc.severity) + '">' + esc(inc.severity) + '</span>'
              : '<span class="muted-inline">—</span>') +
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

  // Current user (id, role, permissions), fetched once per page
  var _me = null;
  function getMe() {
    if (!_me) {
      _me = api.get('/api/auth/me')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (me) {
          return me
            ? { id: me.id, role: me.role, permissions: me.permissions || [] }
            : { id: null, role: _currentRole, permissions: [] };
        })
        .catch(function () { _me = null; return { id: null, role: _currentRole, permissions: [] }; });
    }
    return _me;
  }

  // Stored timestamps are UTC (…Z); show them in the viewer's local time.
  function fmtStamp(s) {
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d.getTime())) return esc(s);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function roleLabel(role) {
    var labels = global.SentraIncidentActions ? global.SentraIncidentActions.ROLE_LABELS : {};
    return labels[role] || role || '';
  }

  function infoItem(label, valueHtml, wide) {
    return '<div class="info-item' + (wide ? ' info-item-span' : '') + '"><label>' + label + '</label><span>' + valueHtml + '</span></div>';
  }

  function buildDetailHtml(inc) {
    var badges =
      '<div class="incident-badges">' +
        '<span class="status-pill ' + statusClass(inc.status) + '">' + esc(inc.status) + '</span>' +
        (inc.is_restricted ? '<span class="status-pill pill-restricted">RESTRICTED</span>' : '') +
        (inc.is_archived ? '<span class="status-pill pill-archived">ARCHIVED</span>' : '') +
        (inc.severity ? '<span class="incident-severity" data-severity="' + esc(inc.severity) + '">' + esc(inc.severity) + '</span>' : '') +
      '</div>';

    var assigned = (inc.assignments || []).map(function (a) {
      return esc(a.full_name) + ' <em class="muted-inline">(' + esc(roleLabel(a.role)) + ', ' +
        (a.acknowledged_at ? 'acknowledged' : 'not yet acknowledged') + ')</em>';
    }).join('<br>');

    var details =
      '<div class="info-section-title"><i class="fas fa-circle-info"></i> Incident Details</div>' +
      '<div class="info-grid">' +
        infoItem('Reference', esc(inc.reference_number)) +
        infoItem('Category', esc(inc.category_name)) +
        infoItem('Date', fmtDate(inc.incident_date)) +
        infoItem('Time', esc(inc.incident_time || '—')) +
        infoItem('Location', esc(inc.location_text) +
          (inc.campus_location_name ? ' <em class="muted-inline">(' + esc(inc.campus_location_name) + ')</em>' : ''), true) +
        infoItem('Description', '<span class="pre-wrap">' + esc(inc.description) + '</span>', true) +
        infoItem('Reported By', esc(inc.reporter_name)) +
        infoItem('Submitted', fmtStamp(inc.created_at)) +
        (assigned ? infoItem('Assigned To', assigned, true) : '') +
        (inc.resolution_summary ? infoItem('Resolution Summary', '<span class="pre-wrap">' + esc(inc.resolution_summary) + '</span>', true) : '') +
        (inc.closure_summary ? infoItem('Closure Summary', '<span class="pre-wrap">' + esc(inc.closure_summary) + '</span>', true) : '') +
        (inc.closed_at ? infoItem('Closed', fmtStamp(inc.closed_at) + (inc.closed_by_name ? ' by ' + esc(inc.closed_by_name) : ''), true) : '') +
      '</div>';

    var parties = '';
    if (inc.parties && inc.parties.length) {
      parties =
        '<div class="info-section-title"><i class="fas fa-users"></i> Involved Parties</div>' +
        '<ul class="party-list">' +
        inc.parties.map(function (p) {
          if (p.student_id && p.student_number) {
            return '<li>' + esc(p.last_name + ', ' + p.first_name) + ' (' + esc(p.student_number) + ')</li>';
          }
          return '<li>' + esc(p.party_text || '(unnamed)') + '</li>';
        }).join('') +
        '</ul>';
    }

    var timeline = '';
    if (inc.timeline && inc.timeline.length) {
      timeline =
        '<div class="info-section-title"><i class="fas fa-clock-rotate-left"></i> Activity Timeline</div>' +
        '<div class="timeline-wrap">' +
        inc.timeline.map(function (t) {
          return (
            '<div class="timeline-entry">' +
              '<div class="timeline-dot"></div>' +
              '<div class="timeline-body">' +
                '<div class="timeline-meta">' +
                  '<strong>' + esc(t.entry_type) + '</strong>' +
                  ' &bull; ' + esc(t.actor_name) +
                  (t.actor_role ? ' <span class="muted-inline">(' + esc(roleLabel(t.actor_role)) + ')</span>' : '') +
                  ' &bull; <small class="muted-inline">' + fmtStamp(t.created_at) + '</small>' +
                '</div>' +
                '<div class="timeline-desc">' + esc(t.description) + '</div>' +
                (t.follow_up_date
                  ? '<div class="timeline-followup"><i class="fas fa-calendar-day"></i> Next follow-up: ' + fmtDate(t.follow_up_date) + '</div>'
                  : '') +
              '</div>' +
            '</div>'
          );
        }).join('') +
        '</div>';
    }

    return badges + details + parties +
      '<div id="incidentAttachmentsPanel"></div>' +
      timeline +
      '<div id="incidentActionsPanel" class="incident-actions"></div>';
  }

  async function viewIncident(id) {
    var modal    = document.getElementById('incidentDetailModal');
    var bodyEl   = document.getElementById('incidentDetailBody');
    var titleEl  = document.getElementById('incidentDetailTitle');
    if (!modal || !bodyEl) return;

    if (!modal.classList.contains('open')) {
      if (titleEl) titleEl.innerHTML = '<i class="fas fa-file-circle-exclamation"></i> Incident Details';
      bodyEl.innerHTML = '<p class="dash-muted-intro">Loading…</p>';
      modal.classList.add('open');
    }

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
        '<div class="incident-badges">' +
          '<span class="status-pill ' + statusClass(inc.status) + '">' + esc(inc.status) + '</span>' +
        '</div>' +
        '<div class="info-section-title"><i class="fas fa-circle-info"></i> Incident Details</div>' +
        '<div class="info-grid">' +
          infoItem('Reference', esc(inc.reference_number)) +
          infoItem('Category', esc(inc.category_name)) +
          infoItem('Date', fmtDate(inc.incident_date)) +
          infoItem('Status', esc(inc.status)) +
          infoItem('Submitted', fmtStamp(inc.created_at)) +
        '</div>';
      return;
    }

    // ── Full detail view (non-student) ───────────────────────────────────────
    var me = await getMe();
    bodyEl.innerHTML = buildDetailHtml(inc);

    // Attachment list, download links, and upload zone (T-21)
    var attachEl = document.getElementById('incidentAttachmentsPanel');
    if (attachEl && global.SentraAttachments) {
      global.SentraAttachments.canManage().then(function (ok) {
        global.SentraAttachments.renderDetail(attachEl, inc, {
          canManage: ok,
          readOnly:  inc.status === 'Closed' || !!inc.is_archived,
        });
      });
    }

    // Response controls (T-24B); after any change, reload this view and the list
    var actionsEl = document.getElementById('incidentActionsPanel');
    if (actionsEl && global.SentraIncidentActions) {
      global.SentraIncidentActions.render(actionsEl, inc, {
        me: me,
        onChange: function () {
          viewIncident(id);
          if (_listCfg) loadIncidentList(_listCfg);
        },
      });
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
      if (studentLookupWrap) studentLookupWrap.classList.add('u-hidden');
    } else {
      if (studentLookupWrap) studentLookupWrap.classList.remove('u-hidden');
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
      listEl.innerHTML = '<p class="party-empty">No parties added yet.</p>';
      return;
    }
    listEl.innerHTML = _parties.map(function (p, i) {
      return (
        '<div class="party-row">' +
          '<span class="party-name">' + esc(p.display) + '</span>' +
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

  // The zone itself lives in attachments.js. Files are held here and uploaded
  // only after POST /api/incidents has created the incident.
  function wireFileUpload() {
    if (!global.SentraAttachments) return;
    _formUploadZone = global.SentraAttachments.createUploadZone({
      dropzone:  document.getElementById('incidentFileDropzone'),
      input:     document.getElementById('incidentFileInput'),
      errorEl:   document.getElementById('incidentFileError'),
      previewEl: document.getElementById('incidentFilePreview'),
    });

    // Hide the zone for roles without manage_attachments (e.g. Student)
    var field = document.getElementById('incidentFileField');
    global.SentraAttachments.canManage().then(function (ok) {
      if (field) field.classList.toggle('u-hidden', !ok);
    });
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

    if (!r.ok) {
      if (submitBtn) submitBtn.disabled = false;
      if (errEl) errEl.textContent = d.error || 'Submission failed.';
      return;
    }

    // Upload attachments now that the incident exists (T-21)
    var attachNote = '';
    var pendingFiles = _formUploadZone ? _formUploadZone.files() : [];
    if (pendingFiles.length && d.id) {
      _formUploadZone.setDisabled(true);
      var up = await global.SentraAttachments.uploadAll(d.id, pendingFiles);
      _formUploadZone.setDisabled(false);
      _formUploadZone.clear();
      attachNote = ' Attachments uploaded: ' + up.uploaded.length + ' of ' + pendingFiles.length + '.';
      if (up.failed.length) {
        _formUploadZone.setError(
          global.SentraAttachments.describeFailures(up.failed) +
          ' The incident was saved. Open it from the list to add files again.'
        );
      }
    } else if (_formUploadZone) {
      _formUploadZone.clear();
    }

    if (submitBtn) submitBtn.disabled = false;

    // Show confirmation
    var successEl = document.getElementById('incidentFormSuccess');
    if (successEl) {
      successEl.innerHTML =
        '<i class="fas fa-check-circle icon-success"></i> ' +
        'Incident submitted. Reference number: <strong>' + esc(d.reference_number || '') + '</strong>' +
        esc(attachNote);
      successEl.classList.remove('u-hidden');
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
      if (successEl) successEl.classList.add('u-hidden');
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
    _listCfg = listCfg;

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
