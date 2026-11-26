/**
 * public/js/trends.js — Trend Analysis panel (T-39).
 *
 * Exposes window.initTrends({ rootId, readOnly }).
 * Renders:
 *   – Bar chart: incidents by category
 *   – Line chart: incidents over time
 *   – Table:      incidents by location
 *
 * Uses /vendor/chartjs/chart.umd.min.js (global Chart) and api.js helpers.
 */
'use strict';

(function (global) {

  // ── Chart instances (destroy before re-creating) ──────────────────────────
  var _charts = {};

  // ── Escape helper ─────────────────────────────────────────────────────────
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Build panel markup ────────────────────────────────────────────────────
  function buildPanel(root) {
    root.innerHTML =
      '<div class="panel-card">' +
        '<div class="panel-card-header">' +
          '<div class="panel-card-title"><i class="fas fa-chart-line"></i> Trend Analysis</div>' +
          '<button id="trendsApplyBtn" class="btn-maroon btn-sm" type="button">' +
            '<i class="fas fa-rotate"></i> Apply Filters' +
          '</button>' +
        '</div>' +
        '<div class="filter-bar">' +
          '<div class="filter-group"><label>From</label>' +
            '<input type="date" id="trendsFrom" class="filter-select" />' +
          '</div>' +
          '<div class="filter-group"><label>To</label>' +
            '<input type="date" id="trendsTo" class="filter-select" />' +
          '</div>' +
          '<div class="filter-group"><label>Period</label>' +
            '<select id="trendsPeriod" class="filter-select">' +
              '<option value="daily">Daily</option>' +
              '<option value="weekly">Weekly</option>' +
              '<option value="monthly" selected>Monthly</option>' +
              '<option value="semester">Semester</option>' +
            '</select>' +
          '</div>' +
          '<div class="filter-group"><label>Category</label>' +
            '<select id="trendsCategory" class="filter-select">' +
              '<option value="">All Categories</option>' +
            '</select>' +
          '</div>' +
        '</div>' +
        '<p id="trendsError" class="error-msg"></p>' +
      '</div>' +

      '<div class="panel-card">' +
        '<div class="panel-card-header">' +
          '<div class="panel-card-title"><i class="fas fa-chart-bar"></i> Incidents by Category</div>' +
        '</div>' +
        '<div class="chart-container">' +
          '<canvas id="trendsCatCanvas"></canvas>' +
        '</div>' +
        '<p id="trendsCatEmpty" class="table-empty u-hidden">No incidents in this date range.</p>' +
      '</div>' +

      '<div class="panel-card">' +
        '<div class="panel-card-header">' +
          '<div class="panel-card-title"><i class="fas fa-chart-line"></i> Incidents Over Time</div>' +
        '</div>' +
        '<div class="chart-container">' +
          '<canvas id="trendsTimeCanvas"></canvas>' +
        '</div>' +
        '<p id="trendsTimeEmpty" class="table-empty u-hidden">No incidents in this date range.</p>' +
      '</div>' +

      '<div class="panel-card">' +
        '<div class="panel-card-header">' +
          '<div class="panel-card-title"><i class="fas fa-map-pin"></i> Incidents by Location</div>' +
        '</div>' +
        '<div class="data-table-wrap">' +
          '<table class="data-table">' +
            '<thead><tr><th>#</th><th>Location</th><th>Incident Count</th></tr></thead>' +
            '<tbody id="trendsLocTable">' +
              '<tr><td colspan="3" class="table-empty">Loading\u2026</td></tr>' +
            '</tbody>' +
          '</table>' +
        '</div>' +
      '</div>';
  }

  // ── Render charts ─────────────────────────────────────────────────────────

  function destroyChart(id) {
    if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
  }

  function renderBarChart(canvasId, labels, counts) {
    destroyChart(canvasId);
    var canvas = document.getElementById(canvasId);
    if (!canvas || !global.Chart) return;
    _charts[canvasId] = new global.Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Incidents',
          data: counts,
          backgroundColor: 'rgba(128, 0, 0, 0.75)',
          borderColor: 'rgba(128, 0, 0, 1)',
          borderWidth: 1,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } } },
      },
    });
  }

  function renderLineChart(canvasId, labels, counts) {
    destroyChart(canvasId);
    var canvas = document.getElementById(canvasId);
    if (!canvas || !global.Chart) return;
    _charts[canvasId] = new global.Chart(canvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Incidents',
          data: counts,
          fill: false,
          borderColor: 'rgba(128, 0, 0, 1)',
          backgroundColor: 'rgba(128, 0, 0, 0.2)',
          tension: 0.3,
          pointRadius: 4,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
      },
    });
  }

  // ── Load data and update UI ───────────────────────────────────────────────

  async function load() {
    var from     = (document.getElementById('trendsFrom')     || {}).value || '';
    var to       = (document.getElementById('trendsTo')       || {}).value || '';
    var period   = (document.getElementById('trendsPeriod')   || {}).value || 'monthly';
    var category = (document.getElementById('trendsCategory') || {}).value || '';

    var errEl = document.getElementById('trendsError');
    if (errEl) errEl.textContent = '';

    function qs(base, extra) {
      var p = '';
      function add(k, v) { if (v) p += (p ? '&' : '?') + encodeURIComponent(k) + '=' + encodeURIComponent(v); }
      add('from', from); add('to', to);
      if (extra) extra.forEach(function(pair) { add(pair[0], pair[1]); });
      return base + p;
    }

    try {
      // 1. By-category
      var r1 = await api.get(qs('/api/trends/by-category', [['period', period], ['category', category]]));
      var d1 = await r1.json();
      var catData = r1.ok ? (d1.data || []) : [];
      var catEmpty = document.getElementById('trendsCatEmpty');
      if (catData.length) {
        if (catEmpty) catEmpty.classList.add('u-hidden');
        renderBarChart('trendsCatCanvas',
          catData.map(function (r) { return r.category; }),
          catData.map(function (r) { return r.count; }));
      } else {
        if (catEmpty) catEmpty.classList.remove('u-hidden');
        destroyChart('trendsCatCanvas');
      }

      // 2. Over-time
      var r2 = await api.get(qs('/api/trends/over-time', [['period', period], ['category', category]]));
      var d2 = await r2.json();
      var timeData = r2.ok ? (d2.data || []) : [];
      var timeEmpty = document.getElementById('trendsTimeEmpty');
      if (timeData.length) {
        if (timeEmpty) timeEmpty.classList.add('u-hidden');
        renderLineChart('trendsTimeCanvas',
          timeData.map(function (r) { return r.period_label; }),
          timeData.map(function (r) { return r.count; }));
      } else {
        if (timeEmpty) timeEmpty.classList.remove('u-hidden');
        destroyChart('trendsTimeCanvas');
      }

      // 3. By-location (period not applicable)
      var r3 = await api.get(qs('/api/trends/by-location', [['category', category]]));
      var d3 = await r3.json();
      var locData = r3.ok ? (d3.data || []) : [];
      var locTbody = document.getElementById('trendsLocTable');
      if (locTbody) {
        locTbody.innerHTML = locData.length
          ? locData.map(function (row, i) {
              return '<tr><td>' + (i + 1) + '</td><td>' + esc(row.location_name) +
                     '</td><td>' + esc(row.count) + '</td></tr>';
            }).join('')
          : '<tr><td colspan="3" class="table-empty">No incidents in this date range.</td></tr>';
      }

    } catch (_) {
      if (errEl) errEl.textContent = 'Could not load trend data. Please try again.';
    }
  }

  // ── Load categories into filter dropdown ──────────────────────────────────

  async function loadCategories() {
    var sel = document.getElementById('trendsCategory');
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

  // ── Wire events ───────────────────────────────────────────────────────────

  function wireEvents() {
    var applyBtn = document.getElementById('trendsApplyBtn');
    if (applyBtn) applyBtn.addEventListener('click', load);

    ['trendsFrom', 'trendsTo'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('keydown', function (e) { if (e.key === 'Enter') load(); });
    });

    ['trendsPeriod', 'trendsCategory'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', load);
    });
  }

  // ── Public init ───────────────────────────────────────────────────────────

  function initTrends(cfg) {
    cfg = cfg || {};
    var root = document.getElementById(cfg.rootId || 'trendsRoot');
    if (!root) return;
    // Idempotent: rebuild each activation so canvases are fresh
    buildPanel(root);
    wireEvents();
    loadCategories().then(load);
  }

  global.initTrends = initTrends;

})(window);
