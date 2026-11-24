/**
 * public/js/api.js — shared API fetch wrapper
 * Caches CSRF token, injects X-CSRF-Token on POST/PATCH/DELETE, retries once on 403.
 */
(function (global) {
  'use strict';

  let _csrfToken = null;

  async function fetchCsrfToken() {
    const res = await fetch('/api/csrf-token');
    const data = await res.json();
    _csrfToken = data.csrfToken;
    return _csrfToken;
  }

  async function getToken() {
    if (!_csrfToken) await fetchCsrfToken();
    return _csrfToken;
  }

  async function apiFetch(method, url, body, retry = true) {
    const headers = { 'Content-Type': 'application/json' };
    const mutating = ['POST', 'PATCH', 'DELETE'].includes(method.toUpperCase());

    if (mutating) {
      headers['X-CSRF-Token'] = await getToken();
    }

    const opts = { method, headers, credentials: 'same-origin' };
    if (body !== undefined && body !== null) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);

    // On 403, refresh the CSRF token once and retry (token may have been rotated)
    if (res.status === 403 && mutating && retry) {
      _csrfToken = null;
      await fetchCsrfToken();
      return apiFetch(method, url, body, false);
    }

    return res;
  }

  // Upload helper for multipart/form-data (file uploads).
  // Does NOT set Content-Type — the browser sets the multipart boundary.
  async function apiUpload(url, formData, retry = true) {
    const headers = {};
    const token = await getToken();
    if (token) headers['X-CSRF-Token'] = token;

    const opts = { method: 'POST', headers, credentials: 'same-origin', body: formData };
    let res = await fetch(url, opts);

    if (res.status === 403 && retry) {
      _csrfToken = null;
      await fetchCsrfToken();
      return apiUpload(url, formData, false);
    }
    return res;
  }

  const api = {
    get:    (url)         => apiFetch('GET',    url, null),
    post:   (url, body)   => apiFetch('POST',   url, body),
    patch:  (url, body)   => apiFetch('PATCH',  url, body),
    del:    (url, body)   => apiFetch('DELETE', url, body),
    upload: (url, formData) => apiUpload(url, formData),
  };

  // Export for both browser global and CommonJS (tests)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.api = api;
  }
})(typeof window !== 'undefined' ? window : global);
