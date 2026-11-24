'use strict';

/**
 * public/js/dashboard-safetyofficer.js
 * Initialises the Safety Officer dashboard shell and wires incident sections.
 */

document.addEventListener('DOMContentLoaded', function () {
  initDashboard({
    allowedRoles: ['safetyofficer'],
    navItems: [
      { label: 'Overview',           section: 'overview',        icon: 'fa-gauge-high',              group: 'Main'       },
      { label: 'Submit Incident',    section: 'submit-incident', icon: 'fa-file-circle-plus',        group: 'Incidents'  },
      { label: 'Incidents',          section: 'incidents',       icon: 'fa-file-circle-exclamation', group: 'Incidents'  },
      { label: 'Notifications',      section: 'notifications',   icon: 'fa-bell',                    group: 'Tools'      },
      { label: 'Campus Map',         section: 'campus-map',      icon: 'fa-map-location-dot',        group: 'Tools'      },
      { label: 'Trend Analysis',     section: 'trends',          icon: 'fa-chart-line',              group: 'Tools'      },
    ],
    onSectionChange: function (id) {
      if (id === 'submit-incident' || id === 'incidents') {
        if (typeof initIncidents === 'function') {
          initIncidents({
            role:            'safetyofficer',
            listSectionId:   'incidents',
            submitSectionId: 'submit-incident',
          });
        }
      }
    },
  });
});
