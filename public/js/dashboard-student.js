'use strict';

/**
 * public/js/dashboard-student.js
 *
 * Student Dashboard: profile loading, edit modal, emergency alert,
 * and incident submission/list via incidents.js.
 */

// --- Student profile data (loaded from API) ---
var profile = null; // populated by loadStudentProfile()

function infoItem(label, value) {
  return '<div class="info-item"><label>' + label + '</label><span>' + value + '</span></div>';
}

var infoContainer = document.getElementById('infoContainer');
var overviewInfo  = document.getElementById('overviewInfo');

function renderInfo() {
  if (!profile) {
    infoContainer.innerHTML =
      '<div class="profile-state">' +
      '<i class="fas fa-spinner fa-spin profile-state-icon"></i><br><br>Loading profile…</div>';
    overviewInfo.innerHTML = '';
    return;
  }

  var s = profile; // student record fields from GET /api/students/:id

  infoContainer.innerHTML =
    '<div class="info-section-title"><i class="fas fa-user"></i> Personal Information</div>' +
    '<div class="info-grid">' +
      infoItem('Full Name', s.last_name + ', ' + s.first_name + (s.middle_initial ? ' ' + s.middle_initial + '.' : '')) +
      infoItem('Student Number', s.student_number) +
    '</div>' +
    '<div class="info-section-title"><i class="fas fa-graduation-cap"></i> Academic Information</div>' +
    '<div class="info-grid">' +
      infoItem('Grade Level', s.grade_level) +
      infoItem('Section', s.section) +
      infoItem('School Year', s.school_year) +
      infoItem('Status', '<span class="badge badge-active">' + (s.status || 'Active') + '</span>') +
    '</div>' +
    '<div class="info-section-title"><i class="fas fa-address-book"></i> Guardian Information</div>' +
    '<div class="info-grid">' +
      infoItem('Guardian Name', s.guardian_name || '—') +
      infoItem('Guardian Contact', s.guardian_contact || '—') +
    '</div>';

  var fullName = s.last_name + ', ' + s.first_name + (s.middle_initial ? ' ' + s.middle_initial + '.' : '');
  overviewInfo.innerHTML =
    infoItem('Full Name', fullName) +
    infoItem('Student Number', s.student_number) +
    infoItem('Grade Level', s.grade_level) +
    infoItem('Section', s.section) +
    infoItem('Guardian', s.guardian_name || '—') +
    infoItem('Guardian Contact', s.guardian_contact || '—');
}

function showProfileError(msg) {
  infoContainer.innerHTML =
    '<div class="profile-state is-error">' +
    '<i class="fas fa-triangle-exclamation profile-state-icon"></i><br><br>' + msg + '</div>';
  overviewInfo.innerHTML =
    '<div class="profile-unavailable">Profile unavailable.</div>';
}

// Load student profile via API
function loadStudentProfile() {
  api.get('/api/auth/me').then(function(res) {
    return res.json().then(function(me) {
      if (!res.ok) throw new Error(me.error || 'Failed to load user info.');
      if (!me.student_record_id) throw new Error('No linked student record. Contact your administrator.');
      return api.get('/api/students/' + me.student_record_id);
    });
  }).then(function(res) {
    return res.json().then(function(data) {
      if (!res.ok) throw new Error(data.error || 'Failed to load student record.');
      return data;
    });
  }).then(function(studentData) {
    profile = studentData;
    renderInfo();
  }).catch(function(err) {
    showProfileError(err.message || 'Could not load your profile.');
  });
}

// Show loading state immediately, then load from API
renderInfo();
loadStudentProfile();

// --- Edit modal — student record fields are managed by the administrator ---
var editModal     = document.getElementById('editModal');
var editModalBody = document.getElementById('editModalBody');

function openEditModal() {
  // Per NFR-03, students cannot edit protected record fields.
  // Show a read-only notice instead.
  editModalBody.innerHTML =
    '<div class="record-notice">' +
      '<i class="fas fa-shield-halved record-notice-icon"></i>' +
      '<p class="record-notice-title">Your student record is managed by the school administrator.</p>' +
      '<p class="record-notice-sub">If any information is incorrect, please contact your school administrator to request an update.</p>' +
    '</div>';
  editModal.classList.add('open');
}

document.getElementById('editInfoBtn').addEventListener('click', openEditModal);

document.querySelectorAll('[data-close-modal]').forEach(function (b) {
  b.addEventListener('click', function () { editModal.classList.remove('open'); });
});
editModal.addEventListener('click', function (e) { if (e.target === editModal) editModal.classList.remove('open'); });

// Wire "View Full Record" button in overview panel
var overviewViewRecordBtn = document.getElementById('overviewViewRecordBtn');
if (overviewViewRecordBtn) {
  overviewViewRecordBtn.addEventListener('click', function () {
    showSection('info');
  });
}

// --- Emergency alert ---
var emergencyBtn = document.getElementById('emergencyBtn');
if (emergencyBtn) {
  emergencyBtn.addEventListener('click', function () {
    var emergencyMsg = document.getElementById('emergencyMsg');
    if (emergencyMsg) {
      emergencyMsg.innerHTML =
        '<i class="fas fa-circle-check"></i> Emergency alert sent. School management has been notified of your location. Stay safe — help is on the way.';
    }
  });
}

// ============================================================
// Dashboard init
// ============================================================
document.addEventListener('DOMContentLoaded', function () {
  initDashboard({
    allowedRoles: ['student'],
    navItems: [
      { label: 'Overview',         section: 'overview',         icon: 'fa-gauge-high',              group: 'Main'           },
      { label: 'My Information',   section: 'info',             icon: 'fa-id-card',                 group: 'Student Services' },
      { label: 'Attendance',       section: 'attendance',       icon: 'fa-calendar-check',          group: 'Student Services' },
      { label: 'Submit Incident',  section: 'submit-incident',  icon: 'fa-file-circle-plus',       group: 'Student Services' },
      { label: 'My Submissions',   section: 'my-submissions',   icon: 'fa-file-circle-exclamation', group: 'Student Services' },
      { label: 'Support Services', section: 'support',          icon: 'fa-hand-holding-heart',     group: 'Student Services' },
      { label: 'Emergency Alert',  section: 'emergency',        icon: 'fa-bell',                   group: 'Campus Tools'   },
      { label: 'Facility Map',      section: 'facility',         icon: 'fa-map-location-dot',        group: 'Campus Tools'   },
    ],
    onSectionChange: function (id) {
      if (id === 'submit-incident' || id === 'my-submissions') {
        if (typeof initIncidents === 'function') {
          initIncidents({
            role:            'student',
            listSectionId:   'my-submissions',
            submitSectionId: 'submit-incident',
          });
        }
      }
    },
  });
});
