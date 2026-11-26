'use strict';

function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g,'&amp;').replace(/"/g,'&quot;')
    .replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function loadSettings() {
  const wrap = document.getElementById('settingsFormWrap');
  if (!wrap) return;

  try {
    const res  = await api.get('/api/settings');
    const data = await res.json();
    if (!res.ok) {
      wrap.innerHTML = `<p class="text-error">${data.error || 'Failed to load settings.'}</p>`;
      return;
    }
    const s = data.data || {};
    wrap.innerHTML = `
      <div class="field-row">
        <div class="field"><label>School Name</label>
          <input id="set_school_name" value="${esc(s.school_name)}"></div>
        <div class="field"><label>Current School Year (YYYY–YYYY)</label>
          <input id="set_current_school_year" value="${esc(s.current_school_year)}" placeholder="2026–2027"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Current Semester</label>
          <select id="set_current_semester">
            <option ${s.current_semester==='1st Semester'?'selected':''}>1st Semester</option>
            <option ${s.current_semester==='2nd Semester'?'selected':''}>2nd Semester</option>
          </select></div>
        <div class="field"><label>Timezone (IANA)</label>
          <input id="set_school_timezone" value="${esc(s.school_timezone)}" placeholder="Asia/Manila"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Session Idle Timeout (min, 5–480)</label>
          <input type="number" id="set_session_idle_minutes" value="${esc(s.session_idle_minutes)}" min="5" max="480"></div>
        <div class="field"><label>Session Max Duration (hr, 1–24)</label>
          <input type="number" id="set_session_max_hours" value="${esc(s.session_max_hours)}" min="1" max="24"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Absence Threshold</label>
          <input type="number" id="set_attendance_threshold_absences" value="${esc(s.attendance_threshold_absences)}" min="1" max="100"></div>
        <div class="field"><label>Tardy Threshold</label>
          <input type="number" id="set_attendance_threshold_tardies" value="${esc(s.attendance_threshold_tardies)}" min="1" max="100"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Escalation Job Interval (min)</label>
          <input type="number" id="set_escalation_job_interval_minutes" value="${esc(s.escalation_job_interval_minutes)}" min="1" max="1440"></div>
        <div class="field"><label>Reminders Job Interval (min)</label>
          <input type="number" id="set_reminders_job_interval_minutes" value="${esc(s.reminders_job_interval_minutes)}" min="1" max="1440"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Incident Retention (years)</label>
          <input type="number" id="set_retention_years_incidents" value="${esc(s.retention_years_incidents)}" min="0" max="100"></div>
        <div class="field"><label>Referral Retention (years)</label>
          <input type="number" id="set_retention_years_referrals" value="${esc(s.retention_years_referrals)}" min="0" max="100"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Attendance Retention (years)</label>
          <input type="number" id="set_retention_years_attendance" value="${esc(s.retention_years_attendance)}" min="0" max="100"></div>
        <div class="field"><label>Student Feature</label>
          <select id="set_student_feature_enabled">
            <option value="0" ${s.student_feature_enabled==='0'?'selected':''}>Disabled</option>
            <option value="1" ${s.student_feature_enabled==='1'?'selected':''}>Enabled</option>
          </select></div>
      </div>
      <div class="field"><label>Emergency Alert Recipient Roles (comma-separated)</label>
        <input id="set_emergency_alert_recipient_roles" value="${esc(s.emergency_alert_recipient_roles)}"></div>
    `;
  } catch (err) {
    wrap.innerHTML = `<p class="text-error">Error: ${err.message}</p>`;
  }
}

function fv(id) { const el = document.getElementById(id); return el ? el.value : null; }

async function saveSettings() {
  const errEl = document.getElementById('settingsError');
  const okEl  = document.getElementById('settingsSuccess');
  errEl.textContent = ''; okEl.textContent = '';

  const keys = [
    'school_name','current_school_year','current_semester','session_idle_minutes',
    'session_max_hours','student_feature_enabled','attendance_threshold_absences',
    'attendance_threshold_tardies','school_timezone','escalation_job_interval_minutes',
    'reminders_job_interval_minutes','retention_years_incidents','retention_years_referrals',
    'retention_years_attendance','emergency_alert_recipient_roles',
  ];

  const updates = {};
  keys.forEach(k => { const v = fv('set_' + k); if (v !== null) updates[k] = v; });

  try {
    const res  = await api.patch('/api/settings', updates);
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.errors ? Object.values(data.errors).join(' ') : (data.error || 'Failed to save.');
      return;
    }
    okEl.textContent = 'Settings saved successfully.';
    setTimeout(() => { okEl.textContent = ''; }, 3000);
  } catch (err) {
    errEl.textContent = 'Error: ' + err.message;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.dash-nav-item[data-section="settings"]').forEach(l => {
    l.addEventListener('click', loadSettings);
  });
});
