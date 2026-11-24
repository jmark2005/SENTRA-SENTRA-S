'use strict';

/**
 * public/js/dashboard-schoolhead.js
 * Initialises the School Head dashboard shell.
 * Domain-specific panels (incidents, referrals, attendance, reports, trends)
 * will be wired in later tasks.
 */

document.addEventListener('DOMContentLoaded', function () {
  initDashboard({
    allowedRoles: ['schoolhead'],
    navItems: [
      { label: 'Overview',          section: 'overview',      icon: 'fa-gauge-high',              group: 'Main'         },
      { label: 'Incidents',         section: 'incidents',     icon: 'fa-file-circle-exclamation', group: 'Monitoring'   },
      { label: 'Response Tracking', section: 'response',      icon: 'fa-clipboard-list',          group: 'Monitoring'   },
      { label: 'Referrals',         section: 'referrals',     icon: 'fa-hand-holding-heart',      group: 'Monitoring'   },
      { label: 'Attendance',        section: 'attendance',    icon: 'fa-calendar-check',          group: 'Monitoring'   },
      { label: 'Students',          section: 'students',      icon: 'fa-id-card',                 group: 'Records'      },
      { label: 'Reports',           section: 'reports',       icon: 'fa-chart-bar',               group: 'Reports'      },
      { label: 'Participation',     section: 'participation', icon: 'fa-chart-pie',               group: 'Reports'      },
      { label: 'Notifications',     section: 'notifications', icon: 'fa-bell',                    group: 'Tools'        },
      { label: 'Trend Analysis',    section: 'trends',        icon: 'fa-chart-line',              group: 'Tools'        },
      { label: 'Campus Map',        section: 'campus-map',    icon: 'fa-map-location-dot',        group: 'Tools'        },
      { label: 'Audit Log',         section: 'audit-log',     icon: 'fa-scroll',                  group: 'Tools'        },
    ],
    onSectionChange: function (id) {
      if (id === 'incidents') {
        if (typeof initIncidents === 'function') {
          initIncidents({
            role:            'schoolhead',
            listSectionId:   'incidents',
            submitSectionId: null,
          });
        }
      }
    },
  });
});
