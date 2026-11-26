/**
 * public/js/attachments.js — incident attachment upload zone and list (T-21).
 *
 * Exposes window.SentraAttachments:
 *   createUploadZone(opts)          wire a drop zone + hidden file input; returns a controller
 *   uploadAll(incidentId, files)    upload files one at a time; resolves { uploaded, failed }
 *   describeFailures(failed)        one-line message for failed uploads
 *   renderDetail(container, inc, o) attachment list with download links, plus an upload
 *                                   zone for an existing incident when o.canManage is true
 *   canManage()                     Promise<boolean>: user holds manage_attachments
 *
 * Uploads go through api.upload() in api.js, which sends the CSRF header and
 * leaves Content-Type to the browser. Client checks are advisory; the server
 * re-checks type, file signature, size, and the 3-file limit.
 */
'use strict';

(function (global) {

  var MAX_FILE_BYTES = 5 * 1024 * 1024;
  var MAX_FILES      = 3;
  var MSG_TYPE       = 'Only JPG, PNG, and PDF files are accepted';
  var MSG_SIZE       = 'File exceeds the 5 MB size limit';
  var ACCEPT_ATTR    = '.jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf';

  var ACCEPTED_MIME = ['image/jpeg', 'image/png', 'application/pdf'];
  var EXT_TO_MIME   = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function iconFor(mime) {
    return mime === 'application/pdf' ? 'fa-file-pdf' : 'fa-file-image';
  }

  // Declared type if accepted; if the browser gave no type, infer from the extension.
  function mimeFor(file) {
    if (ACCEPTED_MIME.indexOf(file.type) !== -1) return file.type;
    if (file.type) return null;
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    return EXT_TO_MIME[ext] || null;
  }

  // ── Permission (cached per page load) ──────────────────────────────────────
  var _canManage = null;

  function canManage() {
    if (!_canManage) {
      _canManage = api.get('/api/auth/me')
        .then(function (r) { return r.ok ? r.json() : { permissions: [] }; })
        .then(function (me) { return (me.permissions || []).indexOf('manage_attachments') !== -1; })
        .catch(function () { _canManage = null; return false; });
    }
    return _canManage;
  }

  // ── Upload zone ────────────────────────────────────────────────────────────
  /**
   * opts = { dropzone, input, errorEl, previewEl, maxFiles?, onChange? }
   * Returns { files(), clear(), setError(msg), setDisabled(bool) }.
   */
  function createUploadZone(opts) {
    var dropzone  = opts.dropzone;
    var input     = opts.input;
    var errorEl   = opts.errorEl;
    var previewEl = opts.previewEl;
    var maxFiles  = opts.maxFiles === undefined ? MAX_FILES : opts.maxFiles;
    var files     = [];
    var disabled  = false;

    function setError(msg) {
      if (errorEl) errorEl.textContent = msg || '';
    }

    function changed() {
      render();
      if (typeof opts.onChange === 'function') opts.onChange(files.slice());
    }

    function add(fileList) {
      if (disabled) return;
      setError('');
      var problems = [];
      var hitLimit = false;

      Array.prototype.forEach.call(fileList, function (f) {
        if (files.length >= maxFiles) { hitLimit = true; return; }
        var mime = mimeFor(f);
        if (!mime) { problems.push('"' + f.name + '": ' + MSG_TYPE + '.'); return; }
        if (f.size > MAX_FILE_BYTES) { problems.push('"' + f.name + '": ' + MSG_SIZE + '.'); return; }
        files.push(f.type === mime ? f : new File([f], f.name, { type: mime }));
      });

      if (hitLimit) {
        problems.push('Maximum ' + maxFiles + ' more file' + (maxFiles === 1 ? '' : 's') + ' for this incident.');
      }
      changed();
      if (problems.length) setError(problems.join(' '));
    }

    function render() {
      if (!previewEl) return;
      if (!files.length) { previewEl.innerHTML = ''; return; }
      previewEl.innerHTML =
        '<div class="file-preview-list">' +
        files.map(function (f, i) {
          return (
            '<div class="file-preview-item">' +
              '<div class="file-preview-icon"><i class="fas ' + iconFor(f.type) + '"></i></div>' +
              '<div class="file-preview-info">' +
                '<div class="file-preview-name">' + esc(f.name) + '</div>' +
                '<div class="file-preview-size">' + fmtSize(f.size) + '</div>' +
              '</div>' +
              '<button type="button" class="file-preview-remove" data-remove-idx="' + i + '" title="Remove" aria-label="Remove ' + esc(f.name) + '">' +
                '<i class="fas fa-xmark"></i>' +
              '</button>' +
            '</div>'
          );
        }).join('') +
        '</div>';
    }

    if (dropzone && input) {
      input.setAttribute('accept', ACCEPT_ATTR);
      dropzone.setAttribute('tabindex', '0');
      dropzone.setAttribute('role', 'button');

      dropzone.addEventListener('click', function () { if (!disabled) input.click(); });
      dropzone.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!disabled) input.click(); }
      });
      dropzone.addEventListener('dragover', function (e) {
        e.preventDefault();
        if (!disabled) dropzone.classList.add('drag-over');
      });
      dropzone.addEventListener('dragleave', function () { dropzone.classList.remove('drag-over'); });
      dropzone.addEventListener('drop', function (e) {
        e.preventDefault();
        dropzone.classList.remove('drag-over');
        if (e.dataTransfer && e.dataTransfer.files) add(e.dataTransfer.files);
      });
      input.addEventListener('change', function () {
        add(input.files);
        input.value = ''; // allow re-selecting the same file
      });
    }

    if (previewEl) {
      previewEl.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-remove-idx]');
        if (!btn || disabled) return;
        files.splice(parseInt(btn.getAttribute('data-remove-idx'), 10), 1);
        setError('');
        changed();
      });
    }

    render();

    return {
      files:    function () { return files.slice(); },
      clear:    function () { files = []; changed(); },
      setError: setError,
      setDisabled: function (on) {
        disabled = !!on;
        if (dropzone) dropzone.classList.toggle('is-disabled', disabled);
      },
    };
  }

  // ── Upload ─────────────────────────────────────────────────────────────────
  async function uploadAll(incidentId, files) {
    var result = { uploaded: [], failed: [] };
    var url = '/api/incidents/' + encodeURIComponent(incidentId) + '/attachments';

    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var fd = new FormData();
      fd.append('file', f, f.name);
      try {
        var r = await api.upload(url, fd);
        var d = {};
        try { d = await r.json(); } catch (_) { d = {}; }
        if (r.ok) result.uploaded.push(d);
        else result.failed.push({ name: f.name, error: d.error || ('Upload failed (HTTP ' + r.status + ').') });
      } catch (_) {
        result.failed.push({ name: f.name, error: 'Network error.' });
      }
    }
    return result;
  }

  function describeFailures(failed) {
    return failed.map(function (x) { return '"' + x.name + '": ' + x.error.replace(/\.?$/, '.'); }).join(' ');
  }

  // ── Detail panel ───────────────────────────────────────────────────────────
  /**
   * Renders the attachment list for an incident into `container`.
   * opts = { canManage: bool, readOnly?: bool, message?: string }
   * With canManage, names link to the download route and an upload zone is
   * shown while the incident has fewer than 3 attachments (never when readOnly).
   */
  function renderDetail(container, incident, opts) {
    if (!container) return;
    opts = opts || {};
    var list      = (incident.attachments || []).slice();
    var manage    = !!opts.canManage;
    var readOnly  = !!opts.readOnly; // closed or archived: downloads only
    var remaining = Math.max(0, MAX_FILES - list.length);
    var showZone  = manage && remaining > 0 && !readOnly;

    if (!list.length && !manage) { container.innerHTML = ''; return; }

    var listHtml = list.length
      ? '<ul class="attach-list">' +
          list.map(function (a) {
            var label = '<i class="fas ' + iconFor(a.mime_type) + '"></i> ' + esc(a.original_name);
            var name  = manage
              ? '<a class="attach-link" href="/api/attachments/' + encodeURIComponent(a.id) + '/download">' + label + '</a>'
              : '<span>' + label + '</span>';
            return '<li class="attach-item">' + name + ' <span class="attach-size">(' + fmtSize(a.size_bytes) + ')</span></li>';
          }).join('') +
        '</ul>'
      : '<p class="attach-note">No attachments yet.</p>';

    var zoneHtml = '';
    if (showZone) {
      zoneHtml =
        '<div class="file-dropzone attach-dropzone" data-part="dropzone">' +
          '<i class="fas fa-cloud-arrow-up"></i>' +
          '<span>Click to add files or drag &amp; drop</span>' +
          '<small>JPG, PNG, PDF, max 5 MB each. ' + remaining + ' more allowed.</small>' +
        '</div>' +
        '<input type="file" class="u-hidden" data-part="input" multiple />' +
        '<p class="error-msg" data-part="error" role="alert"></p>' +
        '<div data-part="preview"></div>' +
        '<div class="attach-actions u-hidden" data-part="actions">' +
          '<button type="button" class="btn-maroon btn-sm" data-part="upload">' +
            '<i class="fas fa-upload"></i> Upload' +
          '</button>' +
        '</div>';
    } else if (manage && !readOnly) {
      zoneHtml = '<p class="attach-note">This incident has the maximum of ' + MAX_FILES + ' attachments.</p>';
    }

    container.innerHTML =
      '<div class="info-section-title"><i class="fas fa-paperclip"></i> Attachments' +
        ' <span class="attach-count">' + list.length + ' of ' + MAX_FILES + '</span></div>' +
      listHtml +
      zoneHtml +
      (!showZone && opts.message ? '<p class="error-msg" role="alert">' + esc(opts.message) + '</p>' : '');

    if (!showZone) return;

    function part(name) { return container.querySelector('[data-part="' + name + '"]'); }
    var actions   = part('actions');
    var uploadBtn = part('upload');

    var zone = createUploadZone({
      dropzone:  part('dropzone'),
      input:     part('input'),
      errorEl:   part('error'),
      previewEl: part('preview'),
      maxFiles:  remaining,
      onChange:  function (files) { actions.classList.toggle('u-hidden', !files.length); },
    });
    if (opts.message) zone.setError(opts.message);

    uploadBtn.addEventListener('click', async function () {
      var files = zone.files();
      if (!files.length) return;
      uploadBtn.disabled = true;
      zone.setDisabled(true);
      zone.setError('');

      var res = await uploadAll(incident.id, files);
      var updated = list.concat(res.uploaded);
      renderDetail(container, { id: incident.id, attachments: updated }, {
        canManage: manage,
        message:   res.failed.length ? describeFailures(res.failed) : '',
      });
    });
  }

  global.SentraAttachments = {
    MAX_FILES:        MAX_FILES,
    createUploadZone: createUploadZone,
    uploadAll:        uploadAll,
    describeFailures: describeFailures,
    renderDetail:     renderDetail,
    canManage:        canManage,
  };

})(window);
