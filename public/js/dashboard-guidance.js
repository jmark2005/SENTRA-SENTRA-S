'use strict';

/**
 * public/js/dashboard-guidance.js
 * Initialises the Guidance Counselor dashboard shell and wires incident sections.
 */

document.addEventListener('DOMContentLoaded', function () {
  initDashboard({
    allowedRoles: ['guidance'],
    navItems: [
      { label: 'Overview',           section: 'overview',        icon: 'fa-gauge-high',              group: 'Main'       },
      { label: 'Submit Incident',    section: 'submit-incident', icon: 'fa-file-circle-plus',        group: 'Incidents'  },
      { label: 'My Incidents',       section: 'my-incidents',    icon: 'fa-file-circle-exclamation', group: 'Incidents'  },
      { label: 'Referrals',          section: 'referrals',       icon: 'fa-hand-holding-heart',      group: 'Support'    },
      { label: 'Attendance',         section: 'attendance',      icon: 'fa-calendar-check',          group: 'Monitoring' },
      { label: 'Students',           section: 'students',       icon: 'fa-id-card',                 group: 'Records'    },
      { label: 'Reports',            section: 'reports',         icon: 'fa-file-export',             group: 'Tools'      },
      { label: 'Notifications',      section: 'notifications',   icon: 'fa-bell',                    group: 'Tools'      },
      { label: 'Campus Map',         section: 'campus-map',      icon: 'fa-map-location-dot',        group: 'Tools'      },
    ],
    onSectionChange: function (id) {
      if (id === 'overview' && typeof loadDashboardSummary === 'function') loadDashboardSummary();
      if (id === 'reports' && typeof initReports === 'function') initReports({ rootId: 'reportsRoot' });
      if (id === 'attendance' && typeof initAttendanceSummary === 'function') {
        initAttendanceSummary({ rootId: 'attendanceSummaryRoot' });
      }
      if (id === 'referrals' && typeof initReferrals === 'function') {
        initReferrals({ rootId: 'referralsRoot' });
      }
      if (id === 'submit-incident' || id === 'my-incidents') {
        if (typeof initIncidents === 'function') {
          initIncidents({
            role:            'guidance',
            listSectionId:   'my-incidents',
            submitSectionId: 'submit-incident',
          });
        }
      }
    },
  });
});
