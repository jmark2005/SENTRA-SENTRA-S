/**
 * public/js/dashboard-summary.js — Overview stat cards (T-33).
 *
 * Fills the Overview section's .stat-grid from GET /api/dashboard/summary
 * (metrics for the signed-in user's role only) and adds a short breakdown
 * panel. The current school year and semester come from System Settings via
 * the same response. Exposes window.loadDashboardSummary() so dashboards can
 * refresh it when Overview is opened; it also runs once on page load.
 */
'use strict';

(function (global) {

  var STATUS_ORDER = ['Submitted', 'Under Review', 'Assigned', 'In Progress', 'For Follow-Up', 'Resolved'];

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function pct(v) { return v === null || v === undefined ? '—' : v + '%'; }

  function card(icon, color, label, value, sub) {
    return (
      '<div class="stat-card">' +
        '<div class="stat-card-ico ' + color + '"><i class="fas ' + icon + '"></i></div>' +
        '<div class="stat-card-body"><small>' + esc(label) + '</small><strong>' + esc(value) + '</strong>' +
          (sub ? '<span class="stat-card-sub">' + esc(sub) + '</span>' : '') +
        '</div>' +
      '</div>'
    );
  }

  function listHtml(title, icon, rows, empty) {
    return (
      '<div class="sum-block">' +
        '<h4 class="ia-title"><i class="fas ' + icon + '"></i> ' + esc(title) + '</h4>' +
        (rows.length
          ? '<ul class="sum-list">' + rows.map(function (r) {
              return '<li><span>' + esc(r[0]) + '</span><strong>' + esc(r[1]) + '</strong></li>';
            }).join('') + '</ul>'
          : '<p class="ia-note">' + esc(empty) + '</p>') +
      '</div>'
    );
  }

  function view(s) {
    var m = s.metrics;
    var term = s.school_year + ' · ' + s.semester;

    switch (s.role) {
      case 'sysadmin':
      case 'schoolhead':
        return {
          cards: [
            card('fa-user-graduate', 'maroon', 'Active Students', m.active_students),
            card('fa-triangle-exclamation', 'red', 'Open Incidents', m.open_incidents, 'Not yet closed'),
            card('fa-calendar-check', 'green', 'Attendance Rate', pct(m.attendance.rate), term),
            card('fa-hand-holding-heart', 'orange', 'Pending Referrals', m.pending_referrals, 'Awaiting assignment'),
            card('fa-user-clock', 'purple', 'Pending Accounts', m.pending_accounts, 'Awaiting approval'),
          ],
          breakdown:
            listHtml('Open incidents by status', 'fa-list-check',
              STATUS_ORDER.map(function (st) { return [st, m.open_incidents_by_status[st] || 0]; }), 'No open incidents.') +
            listHtml('Submitted, awaiting review — by category', 'fa-tags',
              m.pending_incidents_by_category.map(function (c) { return [c.category, c.count]; }), 'Nothing awaiting review.'),
        };

      case 'teacher':
        return {
          cards: [
            card('fa-chalkboard', 'maroon', 'My Classes', m.classes.length, term),
            card('fa-calendar-check', 'green', 'Attendance Today', m.attendance_today.recorded + ' / ' + m.attendance_today.students, 'Students recorded'),
            card('fa-file-circle-exclamation', 'red', 'My Incidents', m.incidents_reported.open, m.incidents_reported.total + ' reported · open shown'),
            card('fa-hand-holding-heart', 'orange', 'My Referrals', m.referrals_submitted.pending, m.referrals_submitted.total + ' submitted · pending shown'),
          ],
          breakdown: listHtml('My classes this term', 'fa-chalkboard',
            m.classes.map(function (c) {
              return [c.name, c.recorded_today + '/' + c.students + ' today · ' + pct(c.attendance_rate) + ' term'];
            }), 'No classes assigned to you this term.'),
        };

      case 'guidance':
        return {
          cards: [
            card('fa-inbox', 'orange', 'Referral Queue', m.referral_queue, 'Unassigned, pending'),
            card('fa-hand-holding-heart', 'maroon', 'My Ongoing Referrals', m.referrals_assigned_by_status.Ongoing),
            card('fa-calendar-day', 'green', 'Follow-Ups Due Today', m.followups_due_today),
            card('fa-calendar-week', 'teal', 'Due This Week', m.followups_due_this_week, 'Through ' + m.week.to),
          ],
          breakdown: listHtml('Referrals assigned to me', 'fa-list-check', [
            ['Ongoing', m.referrals_assigned_by_status.Ongoing],
            ['Completed', m.referrals_assigned_by_status.Completed],
            ['Referred', m.referrals_assigned_by_status.Referred],
            ['Follow-ups overdue', m.followups_overdue],
          ], ''),
        };

      case 'safetyofficer':
        return {
          cards: [
            card('fa-file-circle-exclamation', 'red', 'Open Assigned Incidents', m.open_assigned_incidents),
            card('fa-circle-check', 'orange', 'Awaiting My Acknowledgement', m.awaiting_acknowledgement),
            card('fa-calendar-day', 'green', 'Follow-Ups Due Today', m.followups_due_today),
            card('fa-clock', 'maroon', 'Overdue Follow-Ups', m.overdue_followups),
          ],
          breakdown: '',
        };

      default:
        return null;
    }
  }

  async function loadDashboardSummary() {
    var section = document.getElementById('overview');
    var grid = section && section.querySelector('.stat-grid');
    if (!grid) return;
    try {
      var r = await api.get('/api/dashboard/summary');
      if (!r.ok) return; // auth guard in dashboard-common.js handles 401
      var s = await r.json();
      var v = view(s);
      if (!v) return;

      grid.innerHTML = v.cards.join('');
      grid.classList.toggle('stat-grid-5', v.cards.length === 5);

      var termEl = section.querySelector('[data-dash-term]');
      if (!termEl) {
        termEl = document.createElement('p');
        termEl.className = 'dash-term';
        termEl.setAttribute('data-dash-term', '');
        grid.insertAdjacentElement('beforebegin', termEl);
      }
      termEl.innerHTML = '<i class="fas fa-calendar"></i> ' + esc(s.school_year) + ' · ' + esc(s.semester) +
        ' <span class="muted-inline">(as of ' + esc(s.today) + ')</span>';

      var panel = section.querySelector('[data-dash-breakdown]');
      if (v.breakdown) {
        if (!panel) {
          panel = document.createElement('div');
          panel.className = 'panel-card';
          panel.setAttribute('data-dash-breakdown', '');
          grid.insertAdjacentElement('afterend', panel);
        }
        panel.innerHTML =
          '<div class="panel-card-header"><div class="panel-card-title"><i class="fas fa-chart-simple"></i> At a Glance</div></div>' +
          '<div class="sum-blocks">' + v.breakdown + '</div>';
      } else if (panel) {
        panel.remove();
      }
    } catch (_) { /* leave the cards as they are */ }
  }

  global.loadDashboardSummary = loadDashboardSummary;
  document.addEventListener('DOMContentLoaded', loadDashboardSummary);

})(window);
