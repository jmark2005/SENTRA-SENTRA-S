/**
 * public/js/incident-categories.js
 * Incident Category Management panel for the Admin Dashboard.
 *
 * Exposes: initIncidentCategories()
 * Called from dashboard-admin.js when the category-management section is activated.
 */
'use strict';

(function (global) {

  // ── Escape helper ────────────────────────────────────────────────────────────
  function esc(v) {
    return String(v === null || v === undefined ? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ── Status badge helpers ─────────────────────────────────────────────────────
  function activeBadge(isActive) {
    return isActive
      ? '<span class="status-pill status-enrolled">Active</span>'
      : '<span class="status-pill status-inactive">Inactive</span>';
  }

  // ── Show / clear inline error ────────────────────────────────────────────────
  function setError(id, msg) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg || '';
  }

  // ── Load & render categories table ──────────────────────────────────────────
  async function loadCategories() {
    var tbody  = document.getElementById('catTableBody');
    var metaEl = document.getElementById('catTableMeta');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="3" class="table-empty">Loading\u2026</td></tr>';

    var rows;
    try {
      var r = await api.get('/api/incident-categories');
      var d = await r.json();
      rows = r.ok ? (d.data || []) : [];
    } catch (err) {
      tbody.innerHTML =
        '<tr><td colspan="3" class="table-empty">Could not load categories.</td></tr>';
      return;
    }

    if (metaEl) metaEl.textContent = 'Showing ' + rows.length + ' categor' + (rows.length === 1 ? 'y' : 'ies') + '.';

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="table-empty">No categories yet. Add one above.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(function (cat) {
      return (
        '<tr data-cat-id="' + cat.id + '">' +
          '<td id="cat-name-cell-' + cat.id + '">' + esc(cat.name) + '</td>' +
          '<td>' + activeBadge(cat.is_active) + '</td>' +
          '<td>' +
            '<div class="row-actions">' +
              '<button class="btn-icon" title="Edit name"' +
                ' data-action="edit-cat" data-id="' + cat.id + '" data-name="' + esc(cat.name) + '">' +
                '<i class="fas fa-pencil"></i>' +
              '</button>' +
              '<button class="btn-icon' + (cat.is_active ? ' btn-danger' : '') + '"' +
                ' title="' + (cat.is_active ? 'Deactivate' : 'Reactivate') + '"' +
                ' data-action="toggle-cat"' +
                ' data-id="' + cat.id + '"' +
                ' data-name="' + esc(cat.name) + '"' +
                ' data-active="' + (cat.is_active ? '1' : '0') + '">' +
                '<i class="fas ' + (cat.is_active ? 'fa-toggle-off' : 'fa-toggle-on') + '"></i>' +
              '</button>' +
            '</div>' +
          '</td>' +
        '</tr>'
      );
    }).join('');
  }

  // ── Inline edit: replace name cell with input + Save/Cancel ─────────────────
  function startInlineEdit(id, currentName) {
    var cell = document.getElementById('cat-name-cell-' + id);
    if (!cell) return;
    // Prevent opening a second editor on the same row
    if (cell.querySelector('input')) return;

    cell.innerHTML =
      '<div class="cat-inline-edit">' +
        '<input class="cat-inline-input search-input" id="cat-edit-input-' + id + '"' +
          ' value="' + esc(currentName) + '" maxlength="80" />' +
        '<button class="btn-maroon btn-sm" data-action="save-edit" data-id="' + id + '">' +
          '<i class="fas fa-check"></i> Save' +
        '</button>' +
        '<button class="btn-soft btn-sm" data-action="cancel-edit" data-id="' + id + '">' +
          'Cancel' +
        '</button>' +
      '</div>' +
      '<p id="cat-edit-error-' + id + '" class="error-msg cat-inline-error"></p>';

    var input = document.getElementById('cat-edit-input-' + id);
    if (input) {
      input.focus();
      input.select();
    }
  }

  async function saveInlineEdit(id) {
    var input  = document.getElementById('cat-edit-input-' + id);
    var errEl  = document.getElementById('cat-edit-error-' + id);
    var newName = input ? input.value.trim() : '';

    if (!newName) {
      if (errEl) errEl.textContent = 'Name cannot be empty.';
      return;
    }

    var r = await api.patch('/api/incident-categories/' + id, { name: newName });
    var d = await r.json();

    if (!r.ok) {
      if (errEl) errEl.textContent = d.error || 'Rename failed.';
      return;
    }

    loadCategories();
  }

  // ── Toggle active/inactive ───────────────────────────────────────────────────
  async function toggleCategory(id, name, currentlyActive) {
    var willActivate = !currentlyActive;
    var label = willActivate ? 'Reactivate' : 'Deactivate';

    var doToggle = async function () {
      var r = await api.patch('/api/incident-categories/' + id, { is_active: willActivate ? 1 : 0 });
      if (r.ok) {
        loadCategories();
      } else {
        var d = await r.json();
        setError('catAddError', d.error || label + ' failed.');
      }
    };

    if (currentlyActive) {
      // Confirm before deactivating
      if (typeof confirmAction === 'function') {
        confirmAction(
          'Deactivate category "' + name + '"? It will no longer appear in incident submission forms.',
          doToggle
        );
      } else {
        if (window.confirm('Deactivate "' + name + '"?')) doToggle();
      }
    } else {
      // Reactivate immediately — no confirmation needed
      doToggle();
    }
  }

  // ── Add Category ─────────────────────────────────────────────────────────────
  async function addCategory() {
    var input  = document.getElementById('catAddInput');
    var errEl  = document.getElementById('catAddError');
    var name   = input ? input.value.trim() : '';

    setError('catAddError', '');

    if (!name) {
      setError('catAddError', 'Please enter a category name.');
      return;
    }

    var r = await api.post('/api/incident-categories', { name: name });
    var d = await r.json();

    if (!r.ok) {
      setError('catAddError', d.error || 'Could not add category.');
      return;
    }

    if (input) input.value = '';
    loadCategories();
  }

  // ── Wire event handlers ──────────────────────────────────────────────────────
  function wireEvents() {
    // "Add" button
    var addBtn = document.getElementById('catAddBtn');
    if (addBtn) {
      addBtn.addEventListener('click', addCategory);
    }

    // Allow Enter key in the add input
    var addInput = document.getElementById('catAddInput');
    if (addInput) {
      addInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') addCategory();
      });
    }

    // Table delegation (edit, save-edit, cancel-edit, toggle)
    var panel = document.getElementById('category-management');
    if (panel) {
      panel.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-action]');
        if (!btn) return;

        var action = btn.dataset.action;
        var id     = btn.dataset.id;
        var name   = btn.dataset.name;

        if (action === 'edit-cat') {
          startInlineEdit(id, name);
        }

        if (action === 'save-edit') {
          saveInlineEdit(id);
        }

        if (action === 'cancel-edit') {
          loadCategories();
        }

        if (action === 'toggle-cat') {
          var isActive = btn.dataset.active === '1';
          toggleCategory(id, name, isActive);
        }
      });
    }
  }

  // ── Public init ──────────────────────────────────────────────────────────────
  function initIncidentCategories() {
    wireEvents();
    loadCategories();
  }

  global.initIncidentCategories = initIncidentCategories;
  global.loadCategories         = loadCategories; // expose for onSectionChange hook

})(window);
