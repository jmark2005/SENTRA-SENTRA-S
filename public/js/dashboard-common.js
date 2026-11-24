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
    var backdrop = document.getElementById('dashBackdrop');
    var toggle   = document.getElementById('menuToggle');
    if (!sidebar || !backdrop || !toggle) return;

    toggle.addEventListener('click', function () {
      sidebar.classList.add('open');
      backdrop.classList.add('active');
    });
    backdrop.addEventListener('click', closeSidebarMobile);
  }

  function closeSidebarMobile() {
    var sidebar  = document.getElementById('dashSidebar');
    var backdrop = document.getElementById('dashBackdrop');
    if (sidebar)  sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('active');
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

      // Role guard
      if (config.allowedRoles && config.allowedRoles.length) {
        if (config.allowedRoles.indexOf(user.role_name) === -1) {
          window.location.href = 'login.html';
          return;
        }
      }

      var nameEl   = document.querySelector('.dash-user-name');
      var roleEl   = document.querySelector('.dash-user-role');
      var avatarEl = document.querySelector('.dash-avatar');

      if (nameEl)   nameEl.textContent   = user.full_name || user.username || '';
      if (roleEl)   roleEl.textContent   = ROLE_LABELS[user.role_name] || user.role_name || '';
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
        badge.style.display = 'flex';
      } else {
        badge.style.display = 'none';
      }
    }).catch(function () { /* silent */ });
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
    }).then(function (items) {
      renderNotifList(items);
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
      var unreadClass = n.is_read ? '' : ' unread';
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
    loadUserInfo(config);
  }

  /* ------------------------------------------------------------------ */
  /*  Exports                                                             */
  /* ------------------------------------------------------------------ */
  global.initDashboard  = initDashboard;
  global.confirmAction  = confirmAction;
  global.showSection    = function (id) { showSection(id, {}); };

})(window);
