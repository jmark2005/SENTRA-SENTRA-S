/**
 * public/js/map.js — Campus Map View (T-40B).
 *
 * Exposes window.initCampusMap({ rootId, role }).
 * Renders blueprint.svg with coloured incident-count markers at (coord_x%, coord_y%).
 * Colour coding: green 1–2, yellow 3–5, red 6+, grey 0.
 * Click handler: popup with location details.
 *   teacher/guidance: count + ref numbers only.
 *   sysadmin/schoolhead/safetyofficer: full detail link to incident.
 */
'use strict';

(function (global) {

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function markerColor(count) {
    if (count === 0)        return 'map-marker-grey';
    if (count <= 2)         return 'map-marker-green';
    if (count <= 5)         return 'map-marker-yellow';
    return 'map-marker-red';
  }

  // ── Build panel ───────────────────────────────────────────────────────────

  function buildPanel(root) {
    root.innerHTML =
      '<div class="panel-card">' +
        '<div class="panel-card-header">' +
          '<div class="panel-card-title"><i class="fas fa-map-location-dot"></i> Campus Map</div>' +
          '<button id="mapApplyBtn" class="btn-maroon btn-sm" type="button">' +
            '<i class="fas fa-rotate"></i> Apply Filters' +
          '</button>' +
        '</div>' +
        '<p class="dash-muted-intro">Incident locations overlaid on the campus facility map. ' +
          'Green = 1–2 incidents, Yellow = 3–5, Red = 6+. Click a marker for details.</p>' +
        '<div class="filter-bar">' +
          '<div class="filter-group"><label>From</label>' +
            '<input type="date" id="mapFrom" class="filter-select" />' +
          '</div>' +
          '<div class="filter-group"><label>To</label>' +
            '<input type="date" id="mapTo" class="filter-select" />' +
          '</div>' +
          '<div class="filter-group"><label>Category</label>' +
            '<select id="mapCategory" class="filter-select">' +
              '<option value="">All Categories</option>' +
            '</select>' +
          '</div>' +
        '</div>' +
        '<p id="mapError" class="error-msg"></p>' +
        '<div id="mapLegend" class="map-legend">' +
          '<span class="map-legend-item"><span class="map-dot map-marker-green"></span> 1–2</span>' +
          '<span class="map-legend-item"><span class="map-dot map-marker-yellow"></span> 3–5</span>' +
          '<span class="map-legend-item"><span class="map-dot map-marker-red"></span> 6+</span>' +
          '<span class="map-legend-item"><span class="map-dot map-marker-grey"></span> 0</span>' +
        '</div>' +
        '<div class="map-wrap" id="mapWrap">' +
          '<img src="blueprint.svg" alt="School Facility Map" class="facility-map-img" id="mapBaseImg" />' +
          '<div id="mapMarkers" class="map-markers-layer"></div>' +
        '</div>' +
      '</div>' +
      '<div class="map-popup-overlay u-hidden" id="mapPopupOverlay">' +
        '<div class="map-popup" id="mapPopup">' +
          '<div class="map-popup-header">' +
            '<span id="mapPopupTitle"></span>' +
            '<button class="modal-close" id="mapPopupClose" type="button"><i class="fas fa-xmark"></i></button>' +
          '</div>' +
          '<div class="map-popup-body" id="mapPopupBody"></div>' +
        '</div>' +
      '</div>';
  }

  // ── Load categories dropdown ───────────────────────────────────────────────

  async function loadCategories() {
    var sel = document.getElementById('mapCategory');
    if (!sel) return;
    try {
      var r = await api.get('/api/incident-categories');
      var d = await r.json();
      var cats = r.ok ? (d.data || []) : [];
      sel.innerHTML = '<option value="">All Categories</option>' +
        cats.filter(function (c) { return c.is_active; })
            .map(function (c) {
              return '<option value="' + c.id + '">' + esc(c.name) + '</option>';
            }).join('');
    } catch (_) { /* keep default */ }
  }

  // ── Load map data and render markers ──────────────────────────────────────

  var _currentData = [];

  async function load(role) {
    var from     = (document.getElementById('mapFrom')     || {}).value || '';
    var to       = (document.getElementById('mapTo')       || {}).value || '';
    var category = (document.getElementById('mapCategory') || {}).value || '';

    var errEl = document.getElementById('mapError');
    if (errEl) errEl.textContent = '';

    var params = '';
    function addParam(k, v) { if (v) params += (params ? '&' : '?') + encodeURIComponent(k) + '=' + encodeURIComponent(v); }
    addParam('from', from); addParam('to', to); addParam('category', category);

    try {
      var r = await api.get('/api/campus-locations/map-data' + params);
      var d = await r.json();
      _currentData = r.ok ? (d.data || []) : [];
      renderMarkers(_currentData, role);
    } catch (_) {
      if (errEl) errEl.textContent = 'Could not load map data. Please try again.';
    }
  }

  function renderMarkers(locations, role) {
    var layer = document.getElementById('mapMarkers');
    if (!layer) return;

    layer.innerHTML = locations.map(function (loc) {
      var colorClass = markerColor(loc.count);
      return (
        '<button type="button"' +
          ' class="map-marker ' + colorClass + '"' +
          ' style="left:' + loc.coord_x + '%;top:' + loc.coord_y + '%"' +
          ' data-loc-id="' + loc.location_id + '"' +
          ' title="' + esc(loc.name) + ' (' + loc.count + ')">' +
          '<span class="map-marker-count">' + loc.count + '</span>' +
        '</button>'
      );
    }).join('');
  }

  // ── Popup ─────────────────────────────────────────────────────────────────

  var _fullDetailRoles = ['sysadmin', 'schoolhead', 'safetyofficer'];

  function openPopup(locId, role) {
    var loc = _currentData.find(function (l) { return l.location_id === locId; });
    if (!loc) return;

    var title    = document.getElementById('mapPopupTitle');
    var body     = document.getElementById('mapPopupBody');
    var overlay  = document.getElementById('mapPopupOverlay');

    if (title)  title.textContent = loc.name;

    var fullDetail = _fullDetailRoles.indexOf(role) !== -1;

    var html = '<p class="map-popup-count"><strong>' + loc.count + '</strong> incident' + (loc.count === 1 ? '' : 's') + '</p>';

    if (loc.incidents && loc.incidents.length) {
      html += '<ul class="map-popup-list">';
      loc.incidents.forEach(function (inc) {
        if (fullDetail) {
          html += '<li><a href="#" data-incident-id="' + inc.id + '" class="map-incident-link">' +
            esc(inc.ref) + '</a> <span class="muted-inline">' + esc(inc.status) + '</span></li>';
        } else {
          html += '<li>' + esc(inc.ref) + ' &mdash; <span class="muted-inline">' + esc(inc.category) + '</span></li>';
        }
      });
      html += '</ul>';
    } else {
      html += '<p class="dash-muted-intro">No incidents at this location.</p>';
    }

    if (body)   body.innerHTML = html;
    if (overlay) overlay.classList.remove('u-hidden');
  }

  function closePopup() {
    var overlay = document.getElementById('mapPopupOverlay');
    if (overlay) overlay.classList.add('u-hidden');
  }

  // ── Wire events ───────────────────────────────────────────────────────────

  function wireEvents(role) {
    var applyBtn = document.getElementById('mapApplyBtn');
    if (applyBtn) applyBtn.addEventListener('click', function () { load(role); });

    ['mapFrom', 'mapTo'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('keydown', function (e) { if (e.key === 'Enter') load(role); });
    });

    var catSel = document.getElementById('mapCategory');
    if (catSel) catSel.addEventListener('change', function () { load(role); });

    // Marker click delegation
    var wrap = document.getElementById('mapWrap');
    if (wrap) {
      wrap.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-loc-id]');
        if (btn) {
          var id = parseInt(btn.getAttribute('data-loc-id'), 10);
          openPopup(id, role);
        }
      });
    }

    // Close popup
    var closeBtn = document.getElementById('mapPopupClose');
    if (closeBtn) closeBtn.addEventListener('click', closePopup);

    var overlay = document.getElementById('mapPopupOverlay');
    if (overlay) {
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closePopup();
      });
    }
  }

  // ── Public init ───────────────────────────────────────────────────────────

  function initCampusMap(cfg) {
    cfg = cfg || {};
    var root = document.getElementById(cfg.rootId || 'campusMapRoot');
    if (!root) return;
    buildPanel(root);
    var role = cfg.role || 'teacher';
    wireEvents(role);
    loadCategories().then(function () { load(role); });
  }

  global.initCampusMap = initCampusMap;

})(window);
