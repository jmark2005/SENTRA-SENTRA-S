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
    wrap.innerHTML = '<p class="muted-note">Select a role above to view and edit its permissions.</p>';
    return;
  }

  wrap.innerHTML = '<p class="muted-note">Loading…</p>';

  try {
    const res = await api.get(`/api/roles/${roleId}/permissions`);
    const data = await res.json();
    if (!res.ok) {
      wrap.innerHTML = `<p class="text-error">${data.error || 'Failed to load permissions.'}</p>`;
      return;
    }

    const perms = data.data || [];
    const roleName = data.role && data.role.name;
    const isSysadmin = roleName === 'sysadmin';
    const PROTECTED = ['manage_accounts', 'manage_roles_permissions'];

    let html = '<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Permission</th><th>Module</th><th>Description</th><th class="cell-center">Granted</th></tr></thead><tbody>';

    perms.forEach(p => {
      const checked = p.granted ? 'checked' : '';
      const isProtected = isSysadmin && PROTECTED.includes(p.code);
      const disabled = isProtected ? 'disabled title="Protected — cannot remove from sysadmin"' : '';
      html += `<tr>
        <td><code class="perm-code">${p.code}</code></td>
        <td class="perm-module">${p.module}</td>
        <td class="perm-desc">${p.description}</td>
        <td class="cell-center">
          <input type="checkbox" ${checked} ${disabled}
            data-perm-id="${p.id}" data-role-id="${roleId}">
        </td>
      </tr>`;
    });

    html += '</tbody></table></div>';
    wrap.innerHTML = html;
    wrap.querySelectorAll('input[data-perm-id]').forEach(cb => {
      cb.addEventListener('change', () => togglePermission(cb));
    });

  } catch (err) {
    wrap.innerHTML = `<p class="text-error">Error: ${err.message}</p>`;
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
