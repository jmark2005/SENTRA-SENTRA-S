'use strict';

async function initParticipationPanel() {
  const sel = document.getElementById('partUserSelect');
  if (!sel || sel.options.length > 1) return; // already loaded

  try {
    const res  = await api.get('/api/users?limit=200');
    const data = await res.json();
    if (!res.ok) return;
    sel.innerHTML = '<option value="">— select a user —</option>' +
      (data.data || []).filter(u => u.role !== 'student').map(u =>
        `<option value="${u.id}">${u.full_name} (${u.role})</option>`
      ).join('');
  } catch (_) {}
}

async function loadParticipation() {
  const userId = document.getElementById('partUserSelect').value;
  const from   = document.getElementById('partFrom').value;
  const to     = document.getElementById('partTo').value;
  const result = document.getElementById('participationResult');

  if (!userId) {
    result.innerHTML = '<p class="muted-note">Select a user above.</p>';
    return;
  }

  result.innerHTML = '<p class="muted-note">Loading…</p>';

  let url = `/api/users/${userId}/participation`;
  const params = [];
  if (from) params.push(`from=${encodeURIComponent(from)}`);
  if (to)   params.push(`to=${encodeURIComponent(to)}`);
  if (params.length) url += '?' + params.join('&');

  try {
    const res  = await api.get(url);
    const data = await res.json();

    if (!res.ok) {
      result.innerHTML = `<p class="text-error">${data.error || 'Failed.'}</p>`;
      return;
    }

    const u = data.user;
    const p = data.participation;
    const rows = [
      ['Incidents Reported',          p.incidents_reported],
      ['Incidents Assigned',          p.incidents_assigned],
      ['Incident Activity Entries',   p.incident_activity_entries],
      ['Referrals Submitted',         p.referrals_submitted],
      ['Referrals Assigned',          p.referrals_assigned],
      ['Referral Follow-ups',         p.referral_followups],
      ['Attendance Records Recorded', p.attendance_recorded],
    ];

    result.innerHTML = `
      <p class="part-summary">
        Showing participation for <strong>${u.full_name}</strong> (${u.role})
        ${from || to ? `· ${from||''} → ${to||''}` : '· all time'}.
      </p>
      <div class="data-table-wrap">
        <table class="data-table">
          <thead><tr><th>Category</th><th class="cell-right">Count</th></tr></thead>
          <tbody>
            ${rows.map(([label, count]) => `
              <tr>
                <td>${label}</td>
                <td class="cell-right cell-strong">${count}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (err) {
    result.innerHTML = `<p class="text-error">Error: ${err.message}</p>`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.dash-nav-item[data-section="participation"]').forEach(l => {
    l.addEventListener('click', initParticipationPanel);
  });
});
