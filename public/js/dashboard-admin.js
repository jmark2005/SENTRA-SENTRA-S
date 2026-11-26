/**
 * public/js/dashboard-admin.js
 * Admin-dashboard: manages students, classes, users, settings, categories,
 * campus locations, audit log, and incident reporting via incidents.js.
 */

// ============================================================
// Dashboard init — runs after DOM is ready
// ============================================================
document.addEventListener('DOMContentLoaded', function () {

  // ---- initDashboard ----
  initDashboard({
    allowedRoles: ['sysadmin'],
    navItems: [
      { label: 'Overview',            section: 'overview',      icon: 'fa-gauge-high',              group: 'Main'         },
      { label: 'Student Information', section: 'students',      icon: 'fa-id-card',                 group: 'Management'   },
      { label: 'Submit Incident',     section: 'submit-incident', icon: 'fa-file-circle-plus',      group: 'Management'   },
      { label: 'Incident Reporting',  section: 'incidents',     icon: 'fa-file-circle-exclamation', group: 'Management'   },
      { label: 'Incident Categories', section: 'category-management',  icon: 'fa-tags',             group: 'Management'   },
      { label: 'Campus Locations',    section: 'campus-locations',      icon: 'fa-map-pin',          group: 'Management'   },
      { label: 'Classes',             section: 'classes',       icon: 'fa-chalkboard',              group: 'Management'   },
      { label: 'Attendance',          section: 'attendance',    icon: 'fa-calendar-check',          group: 'Management'   },
      { label: 'Support Services',    section: 'support',       icon: 'fa-hand-holding-heart',      group: 'Management'   },
      { label: 'Emergency Alerts',    section: 'emergency',     icon: 'fa-bell',                    group: 'Campus Tools' },
      { label: 'Facility Mapping',    section: 'facility',      icon: 'fa-map-location-dot',        group: 'Campus Tools' },
      { label: 'Escalation Rules',    section: 'escalation-rules', icon: 'fa-arrow-up-right-dots',  group: 'Campus Tools' },
      { label: 'User Accounts',       section: 'users',         icon: 'fa-users',                   group: 'Campus Tools' },
      { label: 'Permissions',         section: 'permissions',   icon: 'fa-shield-halved',           group: 'Campus Tools' },
      { label: 'System Settings',     section: 'settings',      icon: 'fa-gear',                    group: 'Campus Tools' },
      { label: 'Reports',             section: 'reports',       icon: 'fa-file-export',             group: 'Campus Tools' },
      { label: 'Retention Review',    section: 'retention',     icon: 'fa-box-archive',             group: 'Campus Tools' },
      { label: 'Participation',       section: 'participation', icon: 'fa-chart-bar',               group: 'Campus Tools' },
      { label: 'Trend Analysis',      section: 'trends',        icon: 'fa-chart-line',              group: 'Campus Tools' },
      { label: 'Audit Log',           section: 'audit-log',     icon: 'fa-scroll',                  group: 'Campus Tools' },
    ],
    onSectionChange: function (id) {
      if (id === 'overview' && typeof loadDashboardSummary === 'function') loadDashboardSummary();
      if (id === 'reports' && typeof initReports === 'function') initReports({ rootId: 'reportsRoot' });
      if (id === 'retention' && typeof initRetention === 'function') initRetention({ rootId: 'retentionRoot' });
      if (id === 'support' && typeof initReferrals === 'function') {
        initReferrals({ rootId: 'referralsRoot' });
      }
      if (id === 'attendance' && typeof initAttendance === 'function') {
        initAttendance({ rootId: 'attendanceRoot' });
        if (typeof initAttendanceSummary === 'function') initAttendanceSummary({ rootId: 'attendanceSummaryRoot' });
      }
      if (id === 'submit-incident' || id === 'incidents') {
        if (typeof initIncidents === 'function') {
          initIncidents({
            role:            'sysadmin',
            listSectionId:   'incidents',
            submitSectionId: 'submit-incident',
          });
        }
      }
      if (id === 'category-management' && typeof initIncidentCategories === 'function') {
        initIncidentCategories();
      }
      if (id === 'campus-locations' && typeof initCampusLocations === 'function') {
        initCampusLocations();
      }
      if (id === 'escalation-rules' && typeof initEscalationRules === 'function') {
        initEscalationRules();
      }
      if (id === 'trends' && typeof initTrends === 'function') {
        initTrends({ rootId: 'trendsRoot' });
      }
      if (id === 'facility' && typeof initCampusMap === 'function') {
        initCampusMap({ rootId: 'campusMapRootAdmin', role: 'sysadmin' });
      }
    }
  });
});
