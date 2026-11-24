'use strict';

/**
 * public/js/dashboard-teacher.js
 * Initialises the Teacher dashboard shell and wires incident sections.
 */

document.addEventListener('DOMContentLoaded', function () {
  initDashboard({
    allowedRoles: ['teacher'],
    navItems: [
      { label: 'Overview',           section: 'overview',        icon: 'fa-gauge-high',              group: 'Main'       },
      { label: 'Submit Incident',    section: 'submit-incident', icon: 'fa-file-circle-plus',        group: 'Incidents'  },
      { label: 'My Incidents',       section: 'my-incidents',    icon: 'fa-file-circle-exclamation', group: 'Incidents'  },
      { label: 'Attendance',         section: 'attendance',      icon: 'fa-calendar-check',          group: 'Classes'    },
      { label: 'Support Referrals',  section: 'referrals',       icon: 'fa-hand-holding-heart',      group: 'Support'    },
      { label: 'Notifications',      section: 'notifications',   icon: 'fa-bell',                    group: 'Tools'      },
      { label: 'Campus Map',         section: 'campus-map',      icon: 'fa-map-location-dot',        group: 'Tools'      },
    ],
    onSectionChange: function (id) {
      if (id === 'submit-incident' || id === 'my-incidents') {
        if (typeof initIncidents === 'function') {
          initIncidents({
            role:            'teacher',
            listSectionId:   'my-incidents',
            submitSectionId: 'submit-incident',
          });
        }
      }
    },
  });
});
