/**
 * public/js/campus-location-dropdown.js
 * Shared helper: populates campus location <select> dropdowns in incident
 * submission forms across all reporter dashboards.
 *
 * Usage:
 *   populateCampusLocationDropdown(selectElementId, wrapperElementId)
 *
 *   - selectElementId  : id of the <select> element to populate
 *   - wrapperElementId : id of the wrapping element (label + select) to
 *                        hide when no active locations exist
 */
'use strict';

(function (global) {

  /**
   * Fetches active campus locations and populates the given <select>.
   * Hides the wrapper if the response is empty.
   *
   * @param {string} selectId   — id of the <select> element
   * @param {string} wrapperId  — id of the wrapper element to hide/show
   */
  async function populateCampusLocationDropdown(selectId, wrapperId) {
    var sel     = document.getElementById(selectId);
    var wrapper = document.getElementById(wrapperId);
    if (!sel) return;

    // Reset to placeholder while loading
    sel.innerHTML = '<option value="">— Select location (optional) —</option>';

    var locations = [];
    try {
      var r = await api.get('/api/campus-locations?active_only=true');
      var d = await r.json();
      if (r.ok) locations = d.data || [];
    } catch (err) {
      // Network error — treat as no locations (hide dropdown gracefully)
      locations = [];
    }

    if (!locations.length) {
      if (wrapper) wrapper.style.display = 'none';
      return;
    }

    if (wrapper) wrapper.style.display = '';

    locations.forEach(function (loc) {
      var opt = document.createElement('option');
      opt.value       = loc.id;
      opt.textContent = loc.name;
      sel.appendChild(opt);
    });
  }

  global.populateCampusLocationDropdown = populateCampusLocationDropdown;

})(window);
