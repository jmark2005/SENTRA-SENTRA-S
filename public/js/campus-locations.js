/**
 * public/js/campus-locations.js
 * Campus Location Management panel for the Admin Dashboard.
 *
 * Exposes:
 *   initCampusLocations()           — called by dashboard-admin.js when section activates
 *   populateCampusLocationDropdown(selectEl)
 *                                   — utility for incident submission forms (T-20B):
 *                                     fills <select> with active locations; hides it if empty.
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

  // ── Status badge ──────────────────────────────────────────────────────────
  function activeBadge(isActive) {
    return isActive
      ? '<span class="status-pill status-enrolled">Active</span>'
      : '<span class="status-pill status-inactive">Inactive</span>';
  }

  // ── Coord display ─────────────────────────────────────────────────────────
  function fmtCoord(v) {
    return (v !== null && v !== undefined) ? Number(v).toFixed(1) + '%' : '—';
  }

  // ── Load & render table ───────────────────────────────────────────────────
  async function loadLocations() {
    var tbody  = document.getElementById('campusLocTableBody');
    var metaEl = document.getElementById('campusLocTableMeta');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Loading\u2026</td></tr>';

    var rows;
    try {
      var r = await api.get('/api/campus-locations');
      var d = await r.json();
      rows = r.ok ? (d.data || []) : [];
    } catch (_) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Could not load locations.</td></tr>';
      return;
    }

    if (metaEl) {
      metaEl.textContent = 'Showing ' + rows.length + ' location' + (rows.length === 1 ? '' : 's') + '.';
    }

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No campus locations yet. Click \u201cAdd Location\u201d to create one.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(function (loc) {
      return (
        '<tr data-loc-id="' + loc.id + '">' +
          '<td>' + esc(loc.name) + '</td>' +
          '<td>' + esc(loc.description || '—') + '</td>' +
          '<td class="text-center">' + fmtCoord(loc.coord_x) + '</td>' +
          '<td class="text-center">' + fmtCoord(loc.coord_y) + '</td>' +
          '<td>' + activeBadge(loc.is_active) + '</td>' +
          '<td>' +
            '<div class="row-actions">' +
              '<button class="btn-icon" title="Edit"' +
                ' data-action="edit-loc"' +
                ' data-id="'   + loc.id + '"' +
                ' data-name="' + esc(loc.name) + '"' +
                ' data-desc="' + esc(loc.description || '') + '"' +
                ' data-cx="'   + (loc.coord_x !== null && loc.coord_x !== undefined ? loc.coord_x : '') + '"' +
                ' data-cy="'   + (loc.coord_y !== null && loc.coord_y !== undefined ? loc.coord_y : '') + '">' +
                '<i class="fas fa-pencil"></i>' +
              '</button>' +
              '<button class="btn-icon' + (loc.is_active ? ' btn-danger' : '') + '"' +
                ' title="' + (loc.is_active ? 'Deactivate' : 'Reactivate') + '"' +
                ' data-action="toggle-loc"' +
                ' data-id="'     + loc.id + '"' +
                ' data-name="'   + esc(loc.name) + '"' +
                ' data-active="' + (loc.is_active ? '1' : '0') + '">' +
                '<i class="fas ' + (loc.is_active ? 'fa-toggle-off' : 'fa-toggle-on') + '"></i>' +
              '</button>' +
            '</div>' +
          '</td>' +
        '</tr>'
      );
    }).join('');
  }

  // ── Open modal (add or edit) ──────────────────────────────────────────────
  function openModal(opts) {
    opts = opts || {};
    var modal    = document.getElementById('campusLocModal');
    var title    = document.getElementById('campusLocModalTitle');
    var nameIn   = document.getElementById('campusLocName');
    var descIn   = document.getElementById('campusLocDesc');
    var cxIn     = document.getElementById('campusLocCx');
    var cyIn     = document.getElementById('campusLocCy');
    var saveBtn  = document.getElementById('campusLocSaveBtn');
    var errEl    = document.getElementById('campusLocModalError');

    if (!modal) return;

    // Reset
    if (errEl)   errEl.textContent = '';
    if (nameIn)  nameIn.value  = opts.name  || '';
    if (descIn)  descIn.value  = opts.desc  || '';
    if (cxIn)    cxIn.value    = opts.cx    !== undefined ? opts.cx : '';
    if (cyIn)    cyIn.value    = opts.cy    !== undefined ? opts.cy : '';

    if (title) {
      title.innerHTML = opts.mode === 'edit'
        ? '<i class="fas fa-map-pin"></i> Edit Campus Location'
        : '<i class="fas fa-map-pin"></i> Add Campus Location';
    }

    if (saveBtn) {
      saveBtn.dataset.mode = opts.mode || 'add';
      saveBtn.dataset.id   = opts.id   || '';
    }

    modal.classList.add('open');
    if (nameIn) nameIn.focus();
  }

  function closeModal() {
    var modal = document.getElementById('campusLocModal');
    if (modal) modal.classList.remove('open');
  }

  // ── Save (add or edit) ────────────────────────────────────────────────────
  async function saveLocation() {
    var saveBtn = document.getElementById('campusLocSaveBtn');
    var errEl   = document.getElementById('campusLocModalError');
    var nameIn  = document.getElementById('campusLocName');
    var descIn  = document.getElementById('campusLocDesc');
    var cxIn    = document.getElementById('campusLocCx');
    var cyIn    = document.getElementById('campusLocCy');

    if (!saveBtn) return;
    var mode = saveBtn.dataset.mode;
    var id   = saveBtn.dataset.id;

    if (errEl) errEl.textContent = '';

    var name = nameIn ? nameIn.value.trim() : '';
    if (!name) {
      if (errEl) errEl.textContent = 'Name is required.';
      return;
    }

    var body = { name: name };
    if (descIn) body.description = descIn.value.trim() || null;

    var cxVal = cxIn ? cxIn.value.trim() : '';
    var cyVal = cyIn ? cyIn.value.trim() : '';

    if (cxVal !== '') {
      var cx = Number(cxVal);
      if (isNaN(cx) || cx < 0 || cx > 100) {
        if (errEl) errEl.textContent = 'Coord X must be between 0 and 100.';
        return;
      }
      body.coord_x = cx;
    } else {
      body.coord_x = null;
    }

    if (cyVal !== '') {
      var cy = Number(cyVal);
      if (isNaN(cy) || cy < 0 || cy > 100) {
        if (errEl) errEl.textContent = 'Coord Y must be between 0 and 100.';
        return;
      }
      body.coord_y = cy;
    } else {
      body.coord_y = null;
    }

    var r, d;
    if (mode === 'edit' && id) {
      r = await api.patch('/api/campus-locations/' + id, body);
    } else {
      r = await api.post('/api/campus-locations', body);
    }

    d = await r.json();

    if (!r.ok) {
      if (errEl) errEl.textContent = d.error || 'Save failed.';
      return;
    }

    closeModal();
    loadLocations();
  }

  // ── Toggle active/inactive ─────────────────────────────────────────────────
  async function toggleLocation(id, name, currentlyActive) {
    var newActive = currentlyActive ? 0 : 1;

    var doToggle = async function () {
      var r = await api.patch('/api/campus-locations/' + id, { is_active: newActive });
      if (r.ok) {
        loadLocations();
      } else {
        var d = await r.json();
        // Surface error near the table if possible
        var metaEl = document.getElementById('campusLocTableMeta');
        if (metaEl) metaEl.textContent = d.error || 'Toggle failed.';
      }
    };

    if (currentlyActive) {
      if (typeof confirmAction === 'function') {
        confirmAction(
          'Deactivate "' + name + '"? It will no longer appear in incident submission forms.',
          doToggle
        );
      } else {
        if (window.confirm('Deactivate "' + name + '"?')) doToggle();
      }
    } else {
      doToggle();
    }
  }

  // ── Wire events ───────────────────────────────────────────────────────────
  function wireEvents() {
    var addBtn = document.getElementById('campusLocAddBtn');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        openModal({ mode: 'add' });
      });
    }

    var closeBtn   = document.getElementById('campusLocModalClose');
    var cancelBtn  = document.getElementById('campusLocCancelBtn');
    var saveBtn    = document.getElementById('campusLocSaveBtn');
    var modalOverl = document.getElementById('campusLocModal');

    if (closeBtn)   closeBtn.addEventListener('click',  closeModal);
    if (cancelBtn)  cancelBtn.addEventListener('click', closeModal);
    if (saveBtn)    saveBtn.addEventListener('click',   saveLocation);

    // Close on overlay click
    if (modalOverl) {
      modalOverl.addEventListener('click', function (e) {
        if (e.target === modalOverl) closeModal();
      });
    }

    // Table row delegation
    var panel = document.getElementById('campus-locations');
    if (panel) {
      panel.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-action]');
        if (!btn) return;
        var action = btn.dataset.action;

        if (action === 'edit-loc') {
          openModal({
            mode: 'edit',
            id:   btn.dataset.id,
            name: btn.dataset.name,
            desc: btn.dataset.desc,
            cx:   btn.dataset.cx,
            cy:   btn.dataset.cy,
          });
        }

        if (action === 'toggle-loc') {
          var isActive = btn.dataset.active === '1';
          toggleLocation(btn.dataset.id, btn.dataset.name, isActive);
        }
      });
    }
  }

  // ── Public init ───────────────────────────────────────────────────────────
  function initCampusLocations() {
    wireEvents();
    loadLocations();
  }

  // ── Utility for incident submission forms (T-20B) ─────────────────────────
  /**
   * Populates a <select> element with active campus locations.
   * Hides the element (and an optional label wrapper) when no active locations exist.
   *
   * Usage in an incident form:
   *   await populateCampusLocationDropdown(
   *     document.getElementById('incidentCampusLocationSelect'),
   *     document.getElementById('incidentCampusLocationField')   // optional wrapper to hide
   *   );
   *
   * The select's value will be the campus_location_id (number string) or '' for none.
   */
  async function populateCampusLocationDropdown(selectEl, wrapperEl) {
    if (!selectEl) return;

    var r, d;
    try {
      r = await api.get('/api/campus-locations?active_only=true');
      d = await r.json();
    } catch (_) {
      // On error, hide the dropdown — don't block the form
      if (wrapperEl) wrapperEl.style.display = 'none';
      selectEl.style.display = 'none';
      return;
    }

    var locations = r.ok ? (d.data || []) : [];

    if (!locations.length) {
      // Hide: no active locations
      if (wrapperEl) wrapperEl.style.display = 'none';
      else selectEl.style.display = 'none';
      selectEl.value = '';
      return;
    }

    // Show and populate
    selectEl.innerHTML =
      '<option value="">\u2014 Select location (optional) \u2014</option>' +
      locations.map(function (loc) {
        return '<option value="' + loc.id + '">' + esc(loc.name) + '</option>';
      }).join('');

    if (wrapperEl) wrapperEl.style.display = '';
    else selectEl.style.display = '';
  }

  // Export
  global.initCampusLocations             = initCampusLocations;
  global.populateCampusLocationDropdown  = populateCampusLocationDropdown;
  global.loadCampusLocations             = loadLocations; // hook for external refresh

})(window);
