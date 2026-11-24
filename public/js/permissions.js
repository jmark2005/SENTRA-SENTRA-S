'use strict';

async function initPermissionsPanel() {
  const select = document.getElementById('permRoleSelect');
  if (!select || select.options.length > 1) return; // already populated

  try {
    const res = await api.get('/api/roles');
    const data = await res.json();
    if (!res.ok) return;

    select.innerHTML = '<option value="">Select a role…</option>' +
      (data.data || []).map(r =>
        `<option value="${r.id}">${r.display_name} (${r.name})</option>`
      ).join('');
  } catch (_) {}
}

async function loadPermissions() {
  const roleId = document.getElementById('permRoleSelect').value;
  const wrap = document.getElementById('permTableWrap');

  if (!roleId) {
    wrap.innerHTML = '<p style="color:var(--muted);font-size:.88rem;">Select a role above to view and edit its permissions.</p>';
    return;
  }

  wrap.innerHTML = '<p style="color:var(--muted);font-size:.88rem;">Loading…</p>';

  try {
    const res = await api.get(`/api/roles/${roleId}/permissions`);
    const data = await res.json();
    if (!res.ok) {
      wrap.innerHTML = `<p style="color:#c0392b;">${data.error || 'Failed to load permissions.'}</p>`;
      return;
    }

    const perms = data.data || [];
    const roleName = data.role && data.role.name;
    const isSysadmin = roleName === 'sysadmin';
    const PROTECTED = ['manage_accounts', 'manage_roles_permissions'];

    let html = '<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Permission</th><th>Module</th><th>Description</th><th style="text-align:center;">Granted</th></tr></thead><tbody>';

    perms.forEach(p => {
      const checked = p.granted ? 'checked' : '';
      const isProtected = isSysadmin && PROTECTED.includes(p.code);
      const disabled = isProtected ? 'disabled title="Protected — cannot remove from sysadmin"' : '';
      html += `<tr>
        <td><code style="font-size:.82rem;">${p.code}</code></td>
        <td style="font-size:.82rem;color:var(--muted);">${p.module}</td>
        <td style="font-size:.82rem;">${p.description}</td>
        <td style="text-align:center;">
          <input type="checkbox" ${checked} ${disabled}
            data-perm-id="${p.id}" data-role-id="${roleId}"
            onchange="togglePermission(this)">
        </td>
      </tr>`;
    });

    html += '</tbody></table></div>';
    wrap.innerHTML = html;

  } catch (err) {
    wrap.innerHTML = `<p style="color:#c0392b;">Error: ${err.message}</p>`;
  }
}

async function togglePermission(checkbox) {
  const permId = checkbox.dataset.permId;
  const roleId = checkbox.dataset.roleId;
  const granted = checkbox.checked;

  checkbox.disabled = true;

  try {
    const res = await api.patch(`/api/roles/${roleId}/permissions`, {
      permission_id: parseInt(permId, 10),
      granted,
    });
    const d = await res.json();

    if (!res.ok) {
      alert(d.error || 'Failed to update permission.');
      checkbox.checked = !granted;
    }
  } catch (err) {
    alert('Error: ' + err.message);
    checkbox.checked = !granted;
  } finally {
    checkbox.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.dash-nav-item[data-section="permissions"]').forEach(link => {
    link.addEventListener('click', initPermissionsPanel);
  });
});
