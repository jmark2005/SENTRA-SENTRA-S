# SENTRA Responsive Layout Audit — T-45

## Page Checklist

| Page | Viewport meta | Tables scroll | Sidebar hamburger | Forms stack | Modals fit | Nav active | responsive.css |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| index.html | ✅ | N/A | ✅ | ✅ | N/A | N/A | ✅ |
| login.html | ✅ | N/A | N/A | ⚠ | N/A | N/A | ✅ |
| signup.html | ✅ | N/A | N/A | ⚠ | N/A | N/A | ✅ |
| change-password.html | ✅ | N/A | N/A | ✅ | N/A | N/A | ✅ |
| dashboard-admin.html | ✅ | ⚠ | ⚠ | ⚠ | ⚠ | ⚠ | ✅ |
| dashboard-schoolhead.html | ✅ | ⚠ | ⚠ | ⚠ | ⚠ | ⚠ | ✅ |
| dashboard-teacher.html | ✅ | ⚠ | ⚠ | ⚠ | ⚠ | ⚠ | ✅ |
| dashboard-guidance.html | ✅ | ⚠ | ⚠ | ⚠ | ⚠ | ⚠ | ✅ |
| dashboard-safetyofficer.html | ✅ | ⚠ | ⚠ | ⚠ | ⚠ | ⚠ | ✅ |
| dashboard-student.html | ✅ | ⚠ | ⚠ | ⚠ | ⚠ | ⚠ | ✅ |

**Key:** ✅ = already present and correct | ⚠ = fixed/enhanced in this task (T-45) | N/A = not applicable to this page

---

## Findings by Page

### index.html
- Viewport meta: present. `responsive.css` link: present.
- No data tables. Sidebar hamburger button (`.hamburger`) shown via `display:flex !important` at ≤768px by responsive.css.
- Landing page form (contact) already collapses via `.form-row { grid-template-columns: 1fr }` in styles.css at ≤768px; responsive.css extends to ≤480px.
- No modals on this page.

### login.html
- Viewport meta: present. `responsive.css` link: present.
- Role tabs: responsive.css adds `overflow-x: auto; flex-wrap: nowrap; scrollbar-width: none` at ≤480px so tabs scroll horizontally without wrapping.
- No tables. No modals. Left/right panel collapses to single column at ≤900px (already in styles.css).

### signup.html
- Viewport meta: present. `responsive.css` link: present.
- Two-column name/ID row collapses to single column at ≤560px (styles.css) and ≤480px (responsive.css).
- Role tabs: same horizontal scroll fix as login.html.

### change-password.html
- Viewport meta: present. `responsive.css` link: present.
- Single-column form — no layout changes needed. Auth-page wrapper already collapses at ≤900px.

### dashboard-admin.html
- Viewport meta: present. `responsive.css` link: present.
- Sidebar off-canvas: `styles.css` already collapses at ≤900px; responsive.css adds explicit 768px breakpoint and sidebar-overlay fallback.
- All `<table>` elements wrapped in `.data-table-wrap` with `overflow-x: auto` (styles.css). responsive.css adds `min-width: 500px` on bare `table`, and `-webkit-overflow-scrolling: touch`.
- Stat grid: `styles.css` goes 4→2 at ≤1100px and 2→1 at ≤640px. responsive.css adds explicit 1-col at ≤480px.
- Modals: responsive.css enforces `width: 95vw; max-width: 95vw; margin: 1rem auto` at ≤480px for `.modal`, `.modal-content`, `.modal-box`, `.modal-panel`, `#sessionWarningModal .modal`, `#confirmModal .modal`.
- Nav active state: `dash-nav-item.active` has `border-left: 3px solid #f4a0a0` added in responsive.css.
- Form rows in modals (`.field-row`): collapse to 1 column at ≤480px.

### dashboard-schoolhead.html / dashboard-teacher.html / dashboard-guidance.html / dashboard-safetyofficer.html / dashboard-student.html
- Same responsive fixes as dashboard-admin.html apply (all use the same `initDashboard()` shell, same modal structure, same table wrapper classes).

---

## Fixes Applied in This Task (T-45)

### `public/responsive.css` — rewritten with 30 targeted rule blocks

| # | Fix | Detail |
|---|-----|--------|
| 1 | Table scroll | `.table-wrapper` gets `overflow-x:auto; -webkit-overflow-scrolling:touch`; `@media (max-width:768px) table { min-width:500px }` |
| 2 | Sidebar off-canvas ≤768px | `transform: translateX(-100%)` default; `.open` = `translateX(0)`; `.sidebar-overlay` created as fallback when no `dashBackdrop` div exists |
| 3 | Nav active state | `.nav-item.active > a`, `.nav-link.active` get `border-left: 3px solid var(--maroon-light)` + background tint; `dash-nav-item.active` retains gradient + left border |
| 4 | Field errors | `.field-error` color/font; `input.error`, `select.error`, `textarea.error` border highlight |
| 5 | Forms stack ≤480px | `.field-row`, `.form-row`, `.form-grid` → `grid-template-columns:1fr`; `.form-actions`, `.btn-row`, `.action-bar` → `flex-wrap:wrap; gap:0.5rem` |
| 6 | Modals fit ≤480px | `width:95vw; max-width:95vw; margin:1rem auto` on `.modal`, `.modal-content`, `.modal-box`, `.modal-panel`, `#sessionWarningModal .modal`, `#confirmModal .modal` |
| 7 | Dashboard grids | Explicit `1fr 1fr` at ≤768px; `1fr` at ≤480px for `.dashboard-grid`, `.stats-grid`, `.card-grid`, `.stat-grid` |
| 8 | Stat cards wrap | `.stat-card { min-width:140px; flex:1 1 140px }` with `flex-wrap:wrap` on `.stat-cards`, `.summary-cards` |
| 9 | Filter bars stack | `.panel-card-header` wraps/stacks ≤600px; search/select inputs go full-width ≤480px |
| 10 | Login role tabs scroll | `overflow-x:auto; flex-wrap:nowrap; scrollbar-width:none` at ≤480px; webkit scrollbar hidden |
| 11 | Notification drawer | `width:100vw; max-width:100vw` at ≤480px |
| 12 | Touch targets | `min-height:44px` on all interactive elements; `font-size:1rem` on inputs at ≤768px |
| 13 | Action button rows wrap | `.form-actions`, `.btn-row`, `.action-bar` → `flex-wrap:wrap; gap:0.5rem` at ≤480px |
| 14 | Emergency alert banner/modal | `flex-direction:column` at ≤480px; `.emergency-panel` full-width |
| 15 | Disclaimer banner | `flex-wrap:wrap; font-size:.74rem` at ≤600px |

### `public/js/dashboard-common.js` — `initSidebarToggle()` patched

- **Before:** Looked for `#dashBackdrop` only; returned early if not found; used `.classList.add/.remove` directly.
- **After:** Falls back to creating a `.sidebar-overlay` div if no `dashBackdrop` or `.sidebar-overlay` already exists; uses `toggleSidebar(open)` helper with `classList.toggle`; both `backdrop` and `overlay` get click-to-close listeners; `closeSidebarMobile()` now clears both elements.

### HTML files — no changes required
All 10 HTML files already had:
- `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
- `<link rel="stylesheet" href="responsive.css" />`

No HTML modifications were needed.
