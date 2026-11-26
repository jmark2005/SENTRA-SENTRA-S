/**
 * public/js/dashboard-common.js
 * Shared dashboard shell: sidebar, topbar, notifications, session warning, confirmAction.
 *
 * Usage:
 *   initDashboard({
 *     navItems: [
 *       { label: 'Overview', section: 'overview', icon: 'fa-gauge-high', group: 'Main' },
 *       ...
 *     ],
 *     allowedRoles: ['sysadmin'],          // optional
 *     onSectionChange: function(id) {}     // optional
 *   });
 */

(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /*  Role display names                                                  */
  /* ------------------------------------------------------------------ */
  var ROLE_LABELS = {
    sysadmin:      'System Administrator',
    schoolhead:    'School Head',
    teacher:       'Teacher',
    guidance:      'Guidance Counselor',
    safetyofficer: 'Safety Officer',
    student:       'Student',
  };

  /* ------------------------------------------------------------------ */
  /*  Notification type icons                                             */
  /* ------------------------------------------------------------------ */
  var NOTIF_ICONS = {
    'New Assignment':      'fa-user-check',
    'Pending Incident':    'fa-triangle-exclamation',
    'Follow-Up Reminder':  'fa-clock',
    'Overdue Action':      'fa-circle-exclamation',
    'Escalated':           'fa-arrow-up-right-dots',
    'Emergency Alert':     'fa-bell',
    'Account Approval':    'fa-user-shield',
    'System Notice':       'fa-circle-info',
  };

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                             */
  /* ------------------------------------------------------------------ */
  function getInitials(name) {
    if (!name) return '??';
    var parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }

  function formatRelativeTime(isoString) {
    if (!isoString) return '';
    var diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (diff < 60)   return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ------------------------------------------------------------------ */
  /*  confirmAction — reusable confirmation modal                         */
  /* ------------------------------------------------------------------ */
  function confirmAction(message, onConfirm) {
    var overlay  = document.getElementById('confirmModal');
    var msgEl    = document.getElementById('confirmModalMessage');
    var okBtn    = document.getElementById('confirmModalOk');
    var cancelBtn = document.getElementById('confirmModalCancel');
    var closeBtn  = document.getElementById('confirmModalClose');
    if (!overlay || !msgEl || !okBtn) return;

    msgEl.textContent = message;
    overlay.classList.add('open');

    // Clone ok button to remove old listeners
    var newOk = okBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOk, okBtn);

    function close() { overlay.classList.remove('open'); }

    newOk.addEventListener('click', function () { close(); onConfirm(); });
    cancelBtn.addEventListener('click', close, { once: true });
    closeBtn.addEventListener('click',  close, { once: true });
  }

  /* ------------------------------------------------------------------ */
  /*  Disclaimer banner                                                   */
  /* ------------------------------------------------------------------ */
  function insertDisclaimerBanner() {
    if (document.getElementById('dashDisclaimerBanner')) return;
    var content = document.querySelector('.dash-content');
    if (!content) return;
    var banner = document.createElement('div');
    banner.id = 'dashDisclaimerBanner';
    banner.className = 'dash-disclaimer-banner';
    banner.innerHTML =
      '<i class="fas fa-shield-halved"></i> ' +
      'SENTRA supports school-level coordination only. ' +
      'Software notifications must never delay official emergency procedures.';
    content.insertAdjacentElement('beforebegin', banner);
  }

  /* ------------------------------------------------------------------ */
  /*  Sidebar navigation                                                  */
  /* ------------------------------------------------------------------ */
  function buildSidebar(config) {
    var navEl = document.getElementById('dashNav');
    if (!navEl || !config.navItems || !config.navItems.length) return;

    var html = '';
    var lastGroup = null;
    config.navItems.forEach(function (item) {
      if (item.group && item.group !== lastGroup) {
        html += '<div class="dash-nav-section">' + escapeHtml(item.group) + '</div>';
        lastGroup = item.group;
      }
      html +=
        '<a class="dash-nav-item" data-section="' + escapeHtml(item.section) + '" href="#">' +
          '<i class="fas ' + escapeHtml(item.icon) + '"></i> ' +
          escapeHtml(item.label) +
        '</a>';
    });
    navEl.innerHTML = html;

    // Wire nav clicks
    navEl.querySelectorAll('.dash-nav-item').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        showSection(a.dataset.section, config);
      });
    });

    // Set first item active
    var firstSection = config.navItems[0].section;
    showSection(firstSection, config, true);
  }

  /* ------------------------------------------------------------------ */
  /*  Section switching                                                   */
  /* ------------------------------------------------------------------ */
  var sectionTitles = {};

  function showSection(sectionId, config, silent) {
    // Hide all panels
    document.querySelectorAll('.section-panel').forEach(function (p) {
      p.classList.remove('active');
    });
    var panel = document.getElementById(sectionId);
    if (panel) panel.classList.add('active');

    // Update nav active state
    document.querySelectorAll('.dash-nav-item').forEach(function (a) {
      a.classList.toggle('active', a.dataset.section === sectionId);
    });

    // Update topbar title
    var pageTitle = document.getElementById('pageTitle');
    if (pageTitle && sectionTitles[sectionId]) {
      var t = sectionTitles[sectionId];
      pageTitle.innerHTML = escapeHtml(t[0]) + ' <small>' + escapeHtml(t[1]) + '</small>';
    }

    if (!silent) {
      closeSidebarMobile();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    if (typeof config.onSectionChange === 'function') {
      config.onSectionChange(sectionId);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Sidebar mobile toggle                                               */
  /* ------------------------------------------------------------------ */
  function initSidebarToggle() {
    var sidebar  = document.getElementById('dashSidebar');
    var toggle   = document.getElementById('menuToggle');
    if (!sidebar || !toggle) return;

    // Prefer the HTML-stamped dashBackdrop; fall back to a dynamically
    // created .sidebar-overlay so pages without the backdrop element still
    // get an overlay that closes the sidebar on tap.
    var backdrop = document.getElementById('dashBackdrop');
    var overlay  = document.querySelector('.sidebar-overlay');

    if (!backdrop && !overlay) {
      overlay = document.createElement('div');
      overlay.className = 'sidebar-overlay';
      document.body.appendChild(overlay);
    }

    var toggleSidebar = function (open) {
      sidebar.classList.toggle('open', open);
      if (backdrop) backdrop.classList.toggle('active', open);
      if (overlay)  overlay.classList.toggle('visible', open);
    };

    toggle.addEventListener('click', function () {
      toggleSidebar(!sidebar.classList.contains('open'));
    });

    if (backdrop) backdrop.addEventListener('click', function () { toggleSidebar(false); });
    if (overlay)  overlay.addEventListener('click',  function () { toggleSidebar(false); });
  }

  function closeSidebarMobile() {
    var sidebar  = document.getElementById('dashSidebar');
    var backdrop = document.getElementById('dashBackdrop');
    var overlay  = document.querySelector('.sidebar-overlay');
    if (sidebar)  sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('active');
    if (overlay)  overlay.classList.remove('visible');
  }

  /* ------------------------------------------------------------------ */
  /*  Populate user info from /api/auth/me                               */
  /* ------------------------------------------------------------------ */
  function loadUserInfo(config) {
    return api.get('/api/auth/me').then(function (res) {
      if (res.status === 401) {
        window.location.href = 'login.html';
        return null;
      }
      return res.json();
    }).then(function (user) {
      if (!user) return;

      // Role guard (GET /api/auth/me returns the role name as `role`)
      if (config.allowedRoles && config.allowedRoles.length) {
        if (config.allowedRoles.indexOf(user.role) === -1) {
          window.location.href = 'login.html';
          return;
        }
      }

      var nameEl   = document.querySelector('.dash-user-name');
      var roleEl   = document.querySelector('.dash-user-role');
      var avatarEl = document.querySelector('.dash-avatar');

      if (nameEl)   nameEl.textContent   = user.full_name || user.username || '';
      if (roleEl)   roleEl.textContent   = ROLE_LABELS[user.role] || user.role || '';
      if (avatarEl) avatarEl.textContent = getInitials(user.full_name || user.username || '');

      return user;
    }).catch(function () {
      window.location.href = 'login.html';
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Logout button                                                       */
  /* ------------------------------------------------------------------ */
  function initLogout() {
    var logoutBtn = document.getElementById('logoutBtn');
    if (!logoutBtn) return;
    logoutBtn.addEventListener('click', function (e) {
      e.preventDefault();
      api.post('/api/auth/logout', {}).then(function () {
        window.location.href = 'login.html';
      }).catch(function () {
        window.location.href = 'login.html';
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Notification badge + drawer                                         */
  /* ------------------------------------------------------------------ */
  var _notifPollTimer = null;

  function initNotifications() {
    var bellBtn  = document.getElementById('notifBell');
    var drawerEl = document.getElementById('notifDrawer');
    var backdropEl = document.getElementById('notifBackdrop');
    var markAllBtn = document.getElementById('markAllReadBtn');
    var closeDrawerBtn = document.getElementById('notifDrawerClose');

    // Poll count every 30 seconds
    pollNotifCount();
    _notifPollTimer = setInterval(pollNotifCount, 30000);

    if (bellBtn) {
      bellBtn.addEventListener('click', function () {
        openNotifDrawer();
      });
    }

    if (closeDrawerBtn) {
      closeDrawerBtn.addEventListener('click', closeNotifDrawer);
    }

    if (backdropEl) {
      backdropEl.addEventListener('click', closeNotifDrawer);
    }

    if (markAllBtn) {
      markAllBtn.addEventListener('click', function () {
        api.patch('/api/notifications/read-all', {}).then(function () {
          pollNotifCount();
          renderNotifList([]);
          document.getElementById('notifList').innerHTML =
            '<p class="dash-muted-intro">All notifications marked as read.</p>';
        });
      });
    }
  }

  function pollNotifCount() {
    api.get('/api/notifications/count').then(function (res) {
      if (!res.ok) return;
      return res.json();
    }).then(function (data) {
      if (!data) return;
      var badge = document.getElementById('notifBadge');
      if (!badge) return;
      var count = data.unread_count || 0;
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.classList.remove('u-hidden');
      } else {
        badge.classList.add('u-hidden');
      }
      renderEmergencyBanner(data.emergency_alerts || []);
    }).catch(function () { /* silent */ });
  }

  /* ------------------------------------------------------------------ */
  /*  Emergency Alerts (T-32)                                             */
  /*  Banner for unread alerts (fed by the 30 s count poll) and, for     */
  /*  users with send_emergency_alert, a topbar button + send dialog.    */
  /* ------------------------------------------------------------------ */
  var EMERGENCY_DISCLAIMER = 'Sending this alert does not replace official emergency procedures. ' +
    'Contact emergency services directly.';

  function renderEmergencyBanner(alerts) {
    var banner = document.getElementById('emergencyBanner');
    if (!alerts.length) {
      if (banner) banner.remove();
      return;
    }
    if (!banner) {
      var main = document.querySelector('.dash-main');
      var topbar = document.querySelector('.dash-topbar');
      if (!main) return;
      banner = document.createElement('div');
      banner.id = 'emergencyBanner';
      banner.className = 'emergency-banner';
      banner.setAttribute('role', 'alert');
      if (topbar && topbar.parentNode === main) topbar.insertAdjacentElement('afterend', banner);
      else main.insertBefore(banner, main.firstChild);
      banner.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-ack-alert]');
        if (!btn) return;
        btn.disabled = true;
        api.patch('/api/notifications/' + btn.getAttribute('data-ack-alert') + '/read', {})
          .then(function () { pollNotifCount(); })
          .catch(function () { btn.disabled = false; });
      });
    }
    var latest = alerts[0];
    var key = alerts.map(function (a) { return a.id; }).join(',');
    if (banner.getAttribute('data-alerts') === key) return;
    banner.setAttribute('data-alerts', key);
    banner.innerHTML =
      '<div class="emergency-banner-icon"><i class="fas fa-triangle-exclamation"></i></div>' +
      '<div class="emergency-banner-body">' +
        '<div class="emergency-banner-title">' + escapeHtml(latest.title) +
          ' <span class="emergency-banner-time">' + formatRelativeTime(latest.created_at) + '</span>' +
          (alerts.length > 1 ? ' <span class="emergency-banner-more">+' + (alerts.length - 1) + ' more</span>' : '') +
        '</div>' +
        '<div class="emergency-banner-msg">' + escapeHtml(latest.message) + '</div>' +
        '<div class="emergency-banner-note">Follow official emergency procedures. This in-app alert does not replace them.</div>' +
      '</div>' +
      '<button type="button" class="emergency-banner-ack" data-ack-alert="' + escapeHtml(String(latest.id)) + '">' +
        '<i class="fas fa-check"></i> Acknowledge</button>';
  }

  var _emergencyModal = null;

  function ensureEmergencyModal() {
    if (_emergencyModal) return _emergencyModal;
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'emergencyAlertModal';
    overlay.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="emergencyAlertTitle">' +
        '<div class="modal-header">' +
          '<h3 id="emergencyAlertTitle"><i class="fas fa-triangle-exclamation"></i> Send Emergency Alert</h3>' +
          '<button class="modal-close" type="button" data-close aria-label="Close"><i class="fas fa-xmark"></i></button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<p class="emergency-disclaimer"><i class="fas fa-circle-exclamation"></i> ' + EMERGENCY_DISCLAIMER + '</p>' +
          '<div data-form>' +
            '<div class="field"><label for="emergencyAlertMessage">Alert message (required)</label>' +
              '<textarea id="emergencyAlertMessage" data-message rows="4" maxlength="500" ' +
              'placeholder="What is happening, where, and what staff should do"></textarea></div>' +
            '<p class="ia-note">Sent in-app to every active account in the roles set under System Settings.</p>' +
            '<p class="error-msg" data-error role="alert"></p>' +
          '</div>' +
          '<p class="settings-success-msg u-hidden" data-done role="status"></p>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="btn-soft btn-sm" type="button" data-close>Close</button>' +
          '<button class="btn-maroon btn-sm btn-emergency-send" type="button" data-send>' +
            '<i class="fas fa-paper-plane"></i> Send Alert</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    var m = {
      overlay: overlay,
      form:    overlay.querySelector('[data-form]'),
      message: overlay.querySelector('[data-message]'),
      error:   overlay.querySelector('[data-error]'),
      done:    overlay.querySelector('[data-done]'),
      send:    overlay.querySelector('[data-send]'),
    };
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.closest('[data-close]')) overlay.classList.remove('open');
    });
    m.send.addEventListener('click', function () {
      m.error.textContent = '';
      m.send.disabled = true;
      api.post('/api/notifications/emergency', { message: m.message.value }).then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      }).then(function (r) {
        if (!r.ok) {
          m.error.textContent = r.body.error || 'The alert could not be sent.';
          m.send.disabled = false;
          return;
        }
        m.form.classList.add('u-hidden');
        m.send.classList.add('u-hidden');
        m.done.textContent = 'Emergency Alert sent to ' + r.body.recipients + ' account' +
          (r.body.recipients === 1 ? '' : 's') + '. Remember to follow official emergency procedures.';
        m.done.classList.remove('u-hidden');
        pollNotifCount();
      }).catch(function () {
        m.error.textContent = 'Network error. The alert was not sent.';
        m.send.disabled = false;
      });
    });
    _emergencyModal = m;
    return m;
  }

  function openEmergencyModal() {
    var m = ensureEmergencyModal();
    m.message.value = '';
    m.error.textContent = '';
    m.done.classList.add('u-hidden');
    m.form.classList.remove('u-hidden');
    m.send.classList.remove('u-hidden');
    m.send.disabled = false;
    m.overlay.classList.add('open');
    m.message.focus();
  }

  function initEmergencyButton(user) {
    if (!user || (user.permissions || []).indexOf('send_emergency_alert') === -1) return;
    if (document.getElementById('emergencyAlertBtn')) return;
    var actions = document.querySelector('.dash-topbar-actions');
    if (!actions) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'emergencyAlertBtn';
    btn.className = 'dash-emergency-btn';
    btn.title = 'Send an Emergency Alert';
    btn.innerHTML = '<i class="fas fa-triangle-exclamation"></i><span>Emergency Alert</span>';
    btn.addEventListener('click', openEmergencyModal);
    actions.insertBefore(btn, actions.firstChild);
  }

  function openNotifDrawer() {
    var drawer  = document.getElementById('notifDrawer');
    var backdrop = document.getElementById('notifBackdrop');
    if (drawer)  drawer.classList.add('open');
    if (backdrop) backdrop.classList.add('active');
    loadNotifications();
  }

  function closeNotifDrawer() {
    var drawer  = document.getElementById('notifDrawer');
    var backdrop = document.getElementById('notifBackdrop');
    if (drawer)  drawer.classList.remove('open');
    if (backdrop) backdrop.classList.remove('active');
  }

  function loadNotifications() {
    var listEl = document.getElementById('notifList');
    if (!listEl) return;
    listEl.innerHTML = '<p class="dash-muted-intro">Loading…</p>';

    api.get('/api/notifications').then(function (res) {
      if (!res.ok) throw new Error('Failed to load');
      return res.json();
    }).then(function (body) {
      // GET /api/notifications returns { data: [...] }
      renderNotifList(body && body.data ? body.data : body);
    }).catch(function () {
      if (listEl) listEl.innerHTML = '<p class="dash-muted-intro">Could not load notifications.</p>';
    });
  }

  function renderNotifList(items) {
    var listEl = document.getElementById('notifList');
    if (!listEl) return;

    if (!items || !items.length) {
      listEl.innerHTML = '<p class="dash-muted-intro">No notifications.</p>';
      return;
    }

    var html = items.map(function (n) {
      var icon = NOTIF_ICONS[n.type] || 'fa-bell';
      var unreadClass = (n.is_read ? '' : ' unread') + (n.type === 'Emergency Alert' ? ' emergency' : '');
      return (
        '<div class="notif-item' + unreadClass + '" data-notif-id="' + escapeHtml(String(n.id)) + '" data-notif-link="' + escapeHtml(n.link || '') + '">' +
          '<div class="notif-item-header">' +
            '<i class="fas ' + escapeHtml(icon) + ' notif-item-icon"></i>' +
            '<span class="notif-item-title">' + escapeHtml(n.title) + '</span>' +
          '</div>' +
          '<div class="notif-item-msg">' + escapeHtml(n.message) + '</div>' +
          '<div class="notif-item-time">' + formatRelativeTime(n.created_at) + '</div>' +
        '</div>'
      );
    }).join('');

    listEl.innerHTML = html;

    listEl.querySelectorAll('.notif-item').forEach(function (el) {
      el.addEventListener('click', function () {
        var id   = el.dataset.notifId;
        var link = el.dataset.notifLink;
        api.patch('/api/notifications/' + id + '/read', {}).then(function () {
          el.classList.remove('unread');
          pollNotifCount();
          if (link) {
            closeNotifDrawer();
            window.location.href = link;
          }
        });
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Session-warning modal                                               */
  /* ------------------------------------------------------------------ */
  var _sessionWarningShown = false;
  var _sessionCheckTimer   = null;

  function initSessionWarning() {
    var stayBtn   = document.getElementById('sessionStayBtn');
    var logoutBtn = document.getElementById('sessionLogoutBtn');

    if (stayBtn) {
      stayBtn.addEventListener('click', function () {
        api.post('/api/auth/extend-session', {}).then(function () {
          hideSessionWarning();
        });
      });
    }

    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        api.post('/api/auth/logout', {}).then(function () {
          window.location.href = 'login.html';
        }).catch(function () {
          window.location.href = 'login.html';
        });
      });
    }

    // Check every 25 seconds using plain fetch (must NOT go through api.js which
    // attaches a CSRF token and updates last_active on the server side).
    _sessionCheckTimer = setInterval(checkSessionStatus, 25000);
  }

  function checkSessionStatus() {
    // Plain fetch — bypasses api.js so the server does not update last_active.
    fetch('/api/auth/session-status', { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) {
          if (res.status === 401) window.location.href = 'login.html';
          return null;
        }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        var idleSecs = data.idle_expires_in_seconds;
        var msgEl = document.getElementById('sessionWarningMsg');

        if (idleSecs < 120) {
          if (msgEl) {
            msgEl.textContent =
              'Your session will expire in ' + Math.max(0, Math.round(idleSecs)) +
              ' seconds due to inactivity.';
          }
          showSessionWarning();
        } else {
          hideSessionWarning();
        }
      })
      .catch(function () { /* silent */ });
  }

  function showSessionWarning() {
    if (_sessionWarningShown) return;
    var modal = document.getElementById('sessionWarningModal');
    if (modal) modal.classList.add('open');
    _sessionWarningShown = true;
  }

  function hideSessionWarning() {
    if (!_sessionWarningShown) return;
    var modal = document.getElementById('sessionWarningModal');
    if (modal) modal.classList.remove('open');
    _sessionWarningShown = false;
  }

  /* ------------------------------------------------------------------ */
  /*  Overview → Manage Students shortcut (admin dashboard)              */
  /* ------------------------------------------------------------------ */
  function initOverviewShortcuts(config) {
    var overviewBtn = document.getElementById('overviewManageStudentsBtn');
    if (overviewBtn) {
      overviewBtn.addEventListener('click', function () {
        showSection('students', config);
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Wire existing domain-script callbacks (settings save, participation */
  /*  view, user filters, permissions select)                             */
  /* ------------------------------------------------------------------ */
  function initDomainHooks(config) {
    var saveSettingsBtn = document.getElementById('saveSettingsBtn');
    if (saveSettingsBtn) {
      saveSettingsBtn.addEventListener('click', function () {
        if (typeof saveSettings === 'function') saveSettings();
      });
    }

    var viewPartBtn = document.getElementById('viewParticipationBtn');
    if (viewPartBtn) {
      viewPartBtn.addEventListener('click', function () {
        if (typeof loadParticipation === 'function') loadParticipation();
      });
    }

    ['userFilterStatus', 'userFilterRole'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', function () {
        if (typeof loadUsers === 'function') loadUsers();
      });
    });

    var permSel = document.getElementById('permRoleSelect');
    if (permSel) {
      permSel.addEventListener('change', function () {
        if (typeof loadPermissions === 'function') loadPermissions();
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Public entry point: initDashboard(config)                           */
  /* ------------------------------------------------------------------ */
  function initDashboard(config) {
    config = config || {};

    // Build section title map from navItems for topbar updates
    if (config.navItems) {
      config.navItems.forEach(function (item) {
        // Use label as both main and sub title; callers can override via sectionTitles
        sectionTitles[item.section] = [item.label, item.label];
      });
    }

    buildSidebar(config);
    initSidebarToggle();
    insertDisclaimerBanner();
    initLogout();
    initNotifications();
    initSessionWarning();
    initOverviewShortcuts(config);
    initDomainHooks(config);
    loadUserInfo(config).then(initEmergencyButton);
  }

  /* ------------------------------------------------------------------ */
  /*  Exports                                                             */
  /* ------------------------------------------------------------------ */
  global.initDashboard  = initDashboard;
  global.confirmAction  = confirmAction;
  global.showSection    = function (id) { showSection(id, {}); };

})(window);
