/**
 * Self-contained HTML template for the real-time audit dashboard.
 *
 * Returns a single HTML string with all CSS and JS inline,
 * matching the Khoregos website's dark-first design language.
 */

import type { K6sConfig } from "../models/config.js";

export function getDashboardHTML(sessionId: string, config: K6sConfig): string {
  const projectName = config.project?.name ?? "Khoregos";
  const shortId = sessionId.slice(0, 8);

  // All dynamic values are escaped server-side. The inline JS `esc()` function
  // escapes any data rendered into the DOM at runtime via textContent-based
  // sanitisation — this is safe because the dashboard is served on localhost
  // and all data originates from the local SQLite audit database.

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Khoregos Dashboard — ${escapeHTML(projectName)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root, [data-theme="dark"] {
      --bg: #0B0B09;
      --surface: #131310;
      --surface-2: #1a1a16;
      --amber: #F0900A;
      --text: #F0EDE7;
      --text-dim: #8a877e;
      --border: #2a2a24;
      --green: #4ADE80;
      --yellow: #FCD34D;
      --red: #F87171;
      --blue: #60A5FA;
    }
    [data-theme="light"] {
      --bg: #F9F5EE;
      --surface: #F0EAE0;
      --surface-2: #e8e2d8;
      --amber: #9A4E04;
      --text: #1A1814;
      --text-dim: #6b6860;
      --border: #d4cfc6;
      --green: #16a34a;
      --yellow: #ca8a04;
      --red: #dc2626;
      --blue: #2563eb;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      overflow-x: hidden;
    }

    body::before {
      content: '';
      position: fixed;
      inset: 0;
      opacity: 0.5;
      pointer-events: none;
      z-index: 9999;
      background: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.05'/%3E%3C/svg%3E");
    }

    .header {
      display: flex; align-items: center; gap: 16px;
      padding: 16px 24px; border-bottom: 1px solid var(--border); flex-wrap: wrap;
    }
    .header h1 { font-size: 16px; font-weight: 600; color: var(--amber); letter-spacing: -0.02em; }
    .session-id { font-family: 'IBM Plex Mono', monospace; font-size: 13px; color: var(--text-dim); }
    .status-badge {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 10px; border-radius: 3px; font-size: 12px; font-weight: 500;
      background: color-mix(in srgb, var(--green) 15%, transparent); color: var(--green);
    }
    .status-badge .dot {
      width: 6px; height: 6px; border-radius: 50%; background: var(--green);
      animation: pulse 2s infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .duration { font-family: 'IBM Plex Mono', monospace; font-size: 13px; color: var(--text-dim); }
    .header-actions { margin-left: auto; display: flex; gap: 8px; align-items: center; }
    .btn {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 5px 12px; border: 1px solid var(--border); border-radius: 3px;
      background: var(--surface); color: var(--text); font-size: 12px;
      font-family: inherit; cursor: pointer; transition: background 0.15s;
    }
    .btn:hover { background: var(--surface-2); }
    .btn-amber { border-color: var(--amber); color: var(--amber); }

    .filter-bar {
      display: flex; gap: 8px; padding: 12px 24px;
      border-bottom: 1px solid var(--border); flex-wrap: wrap; align-items: center;
    }
    .filter-bar select, .filter-bar input[type="text"] {
      padding: 5px 10px; border: 1px solid var(--border); border-radius: 3px;
      background: var(--surface); color: var(--text); font-size: 12px;
      font-family: 'IBM Plex Mono', monospace; outline: none;
    }
    .filter-bar select:focus, .filter-bar input[type="text"]:focus { border-color: var(--amber); }
    .filter-bar input[type="text"] { width: 200px; }
    .filter-bar label {
      font-size: 12px; color: var(--text-dim);
      display: inline-flex; align-items: center; gap: 3px; cursor: pointer;
      white-space: nowrap;
    }
    .filter-bar label input[type="checkbox"] { margin: 0; width: auto; }

    .main-grid {
      display: grid; grid-template-columns: 1fr 320px; gap: 0;
      height: calc(100vh - 110px);
    }
    @media (max-width: 1200px) { .main-grid { grid-template-columns: 1fr 280px; } }
    @media (max-width: 768px) { .main-grid { grid-template-columns: 1fr; height: auto; } }

    .audit-panel { overflow-y: auto; border-right: 1px solid var(--border); }
    .sidebar { overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }

    .sparkline-container { padding: 12px 24px; border-bottom: 1px solid var(--border); }
    .sparkline-label { font-size: 11px; color: var(--text-dim); margin-bottom: 4px; }
    .sparkline svg { width: 100%; height: 40px; }
    .sparkline path { fill: none; stroke: var(--amber); stroke-width: 1.5; }
    .sparkline .area { fill: color-mix(in srgb, var(--amber) 10%, transparent); stroke: none; }

    .audit-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .audit-table th {
      position: sticky; top: 0; background: var(--surface);
      border-bottom: 1px solid var(--border); padding: 8px 12px;
      text-align: left; font-weight: 600; font-size: 11px;
      text-transform: uppercase; letter-spacing: 0.04em;
      color: var(--text-dim); z-index: 10;
    }
    .audit-table td {
      padding: 6px 12px;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
      font-family: 'IBM Plex Mono', monospace; font-size: 12px;
      vertical-align: top; max-width: 400px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
    }
    .audit-table tr { animation: fadeUp 0.2s ease-out; }
    @keyframes fadeUp { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
    .audit-table tr:hover td { background: var(--surface-2); }

    .severity-info { color: var(--blue); }
    .severity-warning { color: var(--yellow); }
    .severity-critical { color: var(--red); }

    .event-type-badge {
      display: inline-block; padding: 1px 6px; border-radius: 3px;
      font-size: 11px; background: var(--surface-2); color: var(--text-dim);
    }
    .event-type-badge.tool_use { color: var(--blue); background: color-mix(in srgb, var(--blue) 10%, transparent); }
    .event-type-badge.agent_spawn { color: var(--green); background: color-mix(in srgb, var(--green) 10%, transparent); }
    .event-type-badge.agent_complete { color: var(--text-dim); }
    .event-type-badge.session_start { color: var(--amber); background: color-mix(in srgb, var(--amber) 10%, transparent); }
    .event-type-badge.session_complete { color: var(--amber); }
    .event-type-badge.boundary_violation { color: var(--red); background: color-mix(in srgb, var(--red) 10%, transparent); }
    .event-type-badge.gate_triggered { color: var(--yellow); background: color-mix(in srgb, var(--yellow) 10%, transparent); }

    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 3px; padding: 14px; }
    .card-title {
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
      color: var(--text-dim); margin-bottom: 10px; font-weight: 600;
    }
    .cost-value { font-family: 'IBM Plex Mono', monospace; font-size: 24px; font-weight: 600; color: var(--amber); }
    .cost-detail { font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: var(--text-dim); margin-top: 4px; }

    .agent-card {
      display: flex; align-items: center; gap: 8px; padding: 8px 0;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
    }
    .agent-card:last-child { border-bottom: none; }
    .agent-dot { width: 8px; height: 8px; border-radius: 50%; }
    .agent-dot.active { background: var(--green); }
    .agent-dot.completed { background: var(--text-dim); }
    .agent-name { font-size: 13px; font-weight: 500; }
    .agent-meta { font-size: 11px; color: var(--text-dim); margin-left: auto; font-family: 'IBM Plex Mono', monospace; }

    .review-item {
      padding: 8px; border-left: 3px solid var(--amber); margin-bottom: 8px;
      background: color-mix(in srgb, var(--amber) 5%, transparent);
      border-radius: 0 3px 3px 0; cursor: pointer;
    }
    .review-item:hover { background: color-mix(in srgb, var(--amber) 10%, transparent); }
    .review-item .rule { font-size: 12px; font-weight: 500; }
    .review-item .file { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--text-dim); margin-top: 2px; }

    .transcript-panel {
      border-top: 1px solid var(--border);
      max-height: 50vh; overflow-y: auto;
    }
    .transcript-panel.hidden { display: none !important; }
    .transcript-entry {
      padding: 10px 24px;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
      animation: fadeUp 0.2s ease-out;
    }
    .transcript-entry:hover { background: var(--surface-2); }
    .transcript-meta {
      display: flex; gap: 12px; align-items: center;
      margin-bottom: 4px; font-size: 11px; color: var(--text-dim);
      font-family: 'IBM Plex Mono', monospace;
    }
    .transcript-role {
      font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
    }
    .transcript-role.user { color: var(--blue); }
    .transcript-role.assistant { color: var(--green); }
    .transcript-content {
      font-family: 'IBM Plex Mono', monospace; font-size: 12px;
      white-space: pre-wrap; word-break: break-word; line-height: 1.5;
      max-height: 200px; overflow-y: auto; color: var(--text);
    }
    .transcript-redacted {
      display: inline-block; padding: 0 4px; border-radius: 2px;
      font-size: 10px; background: color-mix(in srgb, var(--yellow) 15%, transparent);
      color: var(--yellow); margin-left: 6px;
    }
    .transcript-tokens {
      font-family: 'IBM Plex Mono', monospace; font-size: 11px;
      color: var(--text-dim);
    }
    .transcript-empty {
      padding: 24px; text-align: center;
      font-size: 12px; color: var(--text-dim);
    }

    .scroll-resume { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 100; }
    .event-count { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--text-dim); padding: 12px 24px; }
    .session-select {
      padding: 5px 10px; border: 1px solid var(--border); border-radius: 3px;
      background: var(--surface); color: var(--text); font-size: 12px;
      font-family: 'IBM Plex Mono', monospace;
    }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Khoregos</h1>
    <span class="session-id" id="sessionId">${escapeHTML(shortId)}...</span>
    <span class="status-badge" id="statusBadge">
      <span class="dot"></span>
      <span id="statusText">Live</span>
    </span>
    <span class="duration" id="duration">00:00:00</span>
    <div class="header-actions">
      <select class="session-select" id="sessionSelect">
        <option value="${escapeHTML(sessionId)}">${escapeHTML(shortId)}... (current)</option>
      </select>
      <button class="btn" id="themeToggle" title="Toggle theme">Theme</button>
      <button class="btn" id="exportJSON" title="Export filtered events as JSON">JSON</button>
      <button class="btn" id="exportCSV" title="Export filtered events as CSV">CSV</button>
    </div>
  </div>

  <div class="filter-bar">
    <select id="filterType">
      <option value="">All types</option>
      <option value="tool_use">tool_use</option>
      <option value="agent_spawn">agent_spawn</option>
      <option value="agent_complete">agent_complete</option>
      <option value="session_start">session_start</option>
      <option value="session_complete">session_complete</option>
      <option value="boundary_violation">boundary_violation</option>
      <option value="gate_triggered">gate_triggered</option>
      <option value="dependency_added">dependency_added</option>
      <option value="dependency_removed">dependency_removed</option>
      <option value="dependency_updated">dependency_updated</option>
      <option value="system">system</option>
    </select>
    <select id="filterSeverity">
      <option value="">All severities</option>
      <option value="info">info</option>
      <option value="warning">warning</option>
      <option value="critical">critical</option>
    </select>
    <select id="filterAgent"><option value="">All agents</option></select>
    <input type="text" id="searchInput" placeholder="Search events...">
    <label><input type="checkbox" id="sortNewest" checked> Newest first</label>
    <label><input type="checkbox" id="autoScroll"> Auto-scroll</label>
    <label><input type="checkbox" id="colTimestamp" checked> Time</label>
    <label><input type="checkbox" id="colAgent" checked> Agent</label>
    <label><input type="checkbox" id="colFiles"> Files</label>
    <label><input type="checkbox" id="showTranscript"> Transcript</label>
  </div>

  <div class="sparkline-container">
    <div class="sparkline-label">Events / minute (last 30 min)</div>
    <div class="sparkline" id="sparkline"><svg></svg></div>
  </div>

  <div class="main-grid">
    <div class="audit-panel" id="auditPanel">
      <div class="event-count" id="eventCount">0 events</div>
      <table class="audit-table">
        <thead>
          <tr>
            <th>#</th>
            <th class="col-timestamp">Time</th>
            <th>Type</th>
            <th>Severity</th>
            <th class="col-agent">Agent</th>
            <th>Action</th>
            <th class="col-files hidden">Files</th>
          </tr>
        </thead>
        <tbody id="eventBody"></tbody>
      </table>
      <div class="transcript-panel hidden" id="transcriptPanel">
        <div class="transcript-empty" id="transcriptEmpty">Transcript storage is off or no entries recorded yet.</div>
        <div id="transcriptEntries"></div>
      </div>
    </div>

    <div class="sidebar">
      <div class="card">
        <div class="card-title">Session Cost</div>
        <div class="cost-value" id="totalCost">$0.0000</div>
        <div class="cost-detail" id="tokenSummary">0 input / 0 output tokens</div>
      </div>
      <div class="card">
        <div class="card-title">Agents</div>
        <div id="agentList"><span style="color:var(--text-dim);font-size:12px">No agents yet</span></div>
      </div>
      <div class="card">
        <div class="card-title">Sensitive Review</div>
        <div id="reviewList"><span style="color:var(--text-dim);font-size:12px">No items</span></div>
      </div>
    </div>
  </div>

  <div class="scroll-resume hidden" id="scrollResume">
    <button class="btn btn-amber" id="resumeBtn">Resume auto-scroll</button>
  </div>

<script>
(function() {
  const SESSION_ID = ${JSON.stringify(sessionId).replace(/</g, "\\u003c")};
  let currentSessionId = SESSION_ID;
  let allEvents = [];
  let startTime = Date.now();
  let sortNewestFirst = true;
  let autoScrollEnabled = false;
  const sparklineBuckets = new Array(30).fill(0);
  let bucketStart = Date.now();

  // Safe text escaping via textContent (no raw HTML injection).
  function esc(s) {
    const d = document.createElement('span');
    d.textContent = String(s);
    return d.textContent;
  }

  function truncStr(s, n) {
    return s.length > n ? s.slice(0, n) + '...' : s;
  }

  // Build a table row using DOM methods (safe, no raw HTML).
  function buildRowElement(ev) {
    const tr = document.createElement('tr');
    const time = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : '';
    const severity = ev.severity || 'info';
    const files = Array.isArray(ev.files_affected) ? ev.files_affected.join(', ') : '';

    function addCell(text, cls) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      return td;
    }

    tr.appendChild(addCell(String(ev.sequence || '')));
    tr.appendChild(addCell(time, 'col-timestamp'));

    const tdType = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'event-type-badge ' + (ev.event_type || '');
    badge.textContent = ev.event_type || '';
    tdType.appendChild(badge);
    tr.appendChild(tdType);

    tr.appendChild(addCell(severity, 'severity-' + severity));
    tr.appendChild(addCell(ev.agent_id ? ev.agent_id.slice(0, 8) : '-', 'col-agent'));

    const tdAction = addCell(truncStr(ev.action || '', 80));
    tdAction.title = ev.action || '';
    tr.appendChild(tdAction);

    tr.appendChild(addCell(truncStr(files, 60), 'col-files'));

    return tr;
  }

  // Theme toggle.
  const themeToggle = document.getElementById('themeToggle');
  const storedTheme = localStorage.getItem('k6s-theme');
  if (storedTheme) document.documentElement.dataset.theme = storedTheme;
  themeToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('k6s-theme', next);
  });

  // Sort order.
  const sortNewestCheck = document.getElementById('sortNewest');
  const savedSort = localStorage.getItem('k6s-sort-newest');
  if (savedSort !== null) {
    sortNewestFirst = savedSort === 'true';
    sortNewestCheck.checked = sortNewestFirst;
  }
  sortNewestCheck.addEventListener('change', () => {
    sortNewestFirst = sortNewestCheck.checked;
    localStorage.setItem('k6s-sort-newest', String(sortNewestFirst));
    renderTable();
  });

  // Column visibility.
  function updateColumns() {
    const showTime = document.getElementById('colTimestamp').checked;
    const showAgent = document.getElementById('colAgent').checked;
    const showFiles = document.getElementById('colFiles').checked;
    document.querySelectorAll('.col-timestamp').forEach((el) => { el.classList.toggle('hidden', !showTime); });
    document.querySelectorAll('.col-agent').forEach((el) => { el.classList.toggle('hidden', !showAgent); });
    document.querySelectorAll('.col-files').forEach((el) => { el.classList.toggle('hidden', !showFiles); });
    localStorage.setItem('k6s-cols', JSON.stringify({ time: showTime, agent: showAgent, files: showFiles }));
  }
  const savedCols = localStorage.getItem('k6s-cols');
  if (savedCols) {
    try {
      const c = JSON.parse(savedCols);
      if (c.time !== undefined) document.getElementById('colTimestamp').checked = c.time;
      if (c.agent !== undefined) document.getElementById('colAgent').checked = c.agent;
      if (c.files !== undefined) document.getElementById('colFiles').checked = c.files;
    } catch(e) {}
  }
  document.getElementById('colTimestamp').addEventListener('change', updateColumns);
  document.getElementById('colAgent').addEventListener('change', updateColumns);
  document.getElementById('colFiles').addEventListener('change', updateColumns);
  updateColumns();

  // Auto-scroll.
  const auditPanel = document.getElementById('auditPanel');
  const scrollResume = document.getElementById('scrollResume');
  const autoScrollCheck = document.getElementById('autoScroll');
  autoScrollCheck.addEventListener('change', () => {
    autoScrollEnabled = autoScrollCheck.checked;
    scrollResume.classList.toggle('hidden', autoScrollEnabled);
  });
  auditPanel.addEventListener('scroll', () => {
    const atBottom = auditPanel.scrollHeight - auditPanel.scrollTop - auditPanel.clientHeight < 50;
    if (!atBottom && autoScrollEnabled) {
      autoScrollEnabled = false;
      autoScrollCheck.checked = false;
      scrollResume.classList.remove('hidden');
    }
  });
  document.getElementById('resumeBtn').addEventListener('click', () => {
    autoScrollEnabled = true;
    autoScrollCheck.checked = true;
    scrollResume.classList.add('hidden');
    auditPanel.scrollTop = auditPanel.scrollHeight;
  });

  // Duration timer.
  setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    document.getElementById('duration').textContent = h + ':' + m + ':' + s;
  }, 1000);

  // Filters.
  const filterType = document.getElementById('filterType');
  const filterSeverity = document.getElementById('filterSeverity');
  const filterAgent = document.getElementById('filterAgent');
  const searchInput = document.getElementById('searchInput');

  function matchesFilters(ev) {
    if (filterType.value && ev.event_type !== filterType.value) return false;
    if (filterSeverity.value && ev.severity !== filterSeverity.value) return false;
    if (filterAgent.value && ev.agent_id !== filterAgent.value) return false;
    if (searchInput.value) {
      const q = searchInput.value.toLowerCase();
      const text = (ev.action || '') + ' ' + (ev.event_type || '') + ' ' + JSON.stringify(ev.details || {});
      if (text.toLowerCase().indexOf(q) === -1) return false;
    }
    return true;
  }

  function getFilteredEvents() { return allEvents.filter(matchesFilters); }

  [filterType, filterSeverity, filterAgent, searchInput].forEach((el) => {
    el.addEventListener('change', renderTable);
    el.addEventListener('input', renderTable);
  });

  // Render entire table.
  function renderTable() {
    const tbody = document.getElementById('eventBody');
    let filtered = getFilteredEvents();
    if (sortNewestFirst) filtered = filtered.slice().reverse();
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    for (let i = 0; i < filtered.length; i++) {
      tbody.appendChild(buildRowElement(filtered[i]));
    }
    updateColumns();
    let countText = filtered.length + ' events';
    if (filtered.length !== allEvents.length) countText += ' (filtered from ' + allEvents.length + ')';
    document.getElementById('eventCount').textContent = countText;
    if (autoScrollEnabled) auditPanel.scrollTop = auditPanel.scrollHeight;
  }

  // Add a single event.
  function addEvent(ev) {
    if (allEvents.some((e) => e.id && e.id === ev.id)) return;
    allEvents.push(ev);

    const bucketIdx = Math.floor((Date.now() - bucketStart) / 60000);
    if (bucketIdx >= 0 && bucketIdx < 30) sparklineBuckets[bucketIdx]++;
    else { sparklineBuckets.shift(); sparklineBuckets.push(1); bucketStart += 60000; }

    if (matchesFilters(ev)) {
      const tbody = document.getElementById('eventBody');
      const row = buildRowElement(ev);
      if (sortNewestFirst && tbody.firstChild) {
        tbody.insertBefore(row, tbody.firstChild);
      } else {
        tbody.appendChild(row);
      }
      updateColumns();
      const filtered = getFilteredEvents();
      let countText = filtered.length + ' events';
      if (filtered.length !== allEvents.length) countText += ' (filtered from ' + allEvents.length + ')';
      document.getElementById('eventCount').textContent = countText;
      if (autoScrollEnabled) auditPanel.scrollTop = auditPanel.scrollHeight;
    }

    if (ev.severity === 'critical' && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('Khoregos Alert', { body: ev.action || 'Critical event', tag: ev.id });
    }
    renderSparkline();
  }

  // Sparkline.
  function renderSparkline() {
    const container = document.getElementById('sparkline');
    const svg = container.querySelector('svg');
    const max = Math.max(1, Math.max.apply(null, sparklineBuckets));
    const w = svg.clientWidth || 600;
    const h = 40;
    const step = w / 29;
    let pathD = 'M0,' + (h - sparklineBuckets[0] / max * h);
    let areaD = 'M0,' + h + ' L0,' + (h - sparklineBuckets[0] / max * h);
    for (let i = 1; i < 30; i++) {
      const x = i * step;
      const y = h - (sparklineBuckets[i] / max * h);
      pathD += ' L' + x + ',' + y;
      areaD += ' L' + x + ',' + y;
    }
    areaD += ' L' + (29 * step) + ',' + h + ' Z';
    // Build SVG elements safely via DOM.
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const ns = 'http://www.w3.org/2000/svg';
    const areaPath = document.createElementNS(ns, 'path');
    areaPath.setAttribute('class', 'area');
    areaPath.setAttribute('d', areaD);
    svg.appendChild(areaPath);
    const linePath = document.createElementNS(ns, 'path');
    linePath.setAttribute('d', pathD);
    svg.appendChild(linePath);
  }

  // SSE.
  function connectSSE() {
    const es = new EventSource('/events');
    es.addEventListener('audit', (e) => {
      try { addEvent(JSON.parse(e.data)); } catch(ex) {}
    });
    es.addEventListener('cost', () => { fetchCost(); });
    es.onerror = () => {
      document.getElementById('statusText').textContent = 'Reconnecting...';
      setTimeout(() => { document.getElementById('statusText').textContent = 'Live'; }, 3000);
    };
  }

  // Fetch initial data.
  function fetchInitial() {
    Promise.all([
      fetch('/api/events?limit=500'),
      fetch('/api/cost'),
      fetch('/api/agents'),
      fetch('/api/review'),
      fetch('/api/sessions'),
    ]).then((responses) => {
      return Promise.all(responses.map((r) => r.json()));
    }).then((results) => {
      const [evData, costData, agentData, reviewData, sessData] = results;

      if (evData.events) {
        allEvents = evData.events;
        if (allEvents.length > 0 && allEvents[0].timestamp) {
          startTime = new Date(allEvents[0].timestamp).getTime();
        }
        renderTable();
      }
      if (costData.summary) updateCostDisplay(costData);
      if (agentData.agents) updateAgentDisplay(agentData.agents);
      if (reviewData.items) updateReviewDisplay(reviewData.items);
      if (sessData.sessions) {
        const sel = document.getElementById('sessionSelect');
        while (sel.firstChild) sel.removeChild(sel.firstChild);
        sessData.sessions.forEach((s) => {
          const opt = document.createElement('option');
          opt.value = s.id;
          const short = s.id.slice(0, 8);
          opt.textContent = s.id === SESSION_ID ? short + '... (current)' : short + '... ' + (s.state || '');
          if (s.id === currentSessionId) opt.selected = true;
          sel.appendChild(opt);
        });
      }
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    }).catch((e) => { console.error('Failed to fetch initial data:', e); });
  }

  function fetchCost() {
    fetch('/api/cost').then((r) => r.json()).then(updateCostDisplay).catch(() => {});
  }

  function updateCostDisplay(data) {
    const total = Number(data.summary && data.summary.total_cost || 0);
    document.getElementById('totalCost').textContent = '$' + total.toFixed(4);
    const inp = Number(data.summary && data.summary.total_input_tokens || 0);
    const out = Number(data.summary && data.summary.total_output_tokens || 0);
    document.getElementById('tokenSummary').textContent = inp.toLocaleString() + ' input / ' + out.toLocaleString() + ' output tokens';
  }

  function updateAgentDisplay(agents) {
    const container = document.getElementById('agentList');
    const agentSel = document.getElementById('filterAgent');
    if (!agents.length) {
      container.textContent = 'No agents yet';
      return;
    }
    while (container.firstChild) container.removeChild(container.firstChild);
    agents.forEach((a) => {
      const div = document.createElement('div');
      div.className = 'agent-card';
      const dot = document.createElement('div');
      dot.className = 'agent-dot ' + (a.state === 'active' || a.state === 'created' ? 'active' : 'completed');
      const name = document.createElement('span');
      name.className = 'agent-name';
      name.textContent = a.name || 'unknown';
      const meta = document.createElement('span');
      meta.className = 'agent-meta';
      meta.textContent = (a.tool_call_count || 0) + ' calls';
      div.appendChild(dot);
      div.appendChild(name);
      div.appendChild(meta);
      container.appendChild(div);
    });

    const current = agentSel.value;
    while (agentSel.firstChild) agentSel.removeChild(agentSel.firstChild);
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All agents';
    agentSel.appendChild(allOpt);
    agents.forEach((a) => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name || a.id.slice(0, 8);
      if (a.id === current) opt.selected = true;
      agentSel.appendChild(opt);
    });
  }

  function updateReviewDisplay(items) {
    const container = document.getElementById('reviewList');
    if (!items.length) {
      container.textContent = 'No items';
      return;
    }
    while (container.firstChild) container.removeChild(container.firstChild);
    items.forEach((item) => {
      const details = item.details || {};
      const file = details.file || (Array.isArray(item.files_affected) ? item.files_affected[0] : '') || '';
      const div = document.createElement('div');
      div.className = 'review-item';
      const ruleDiv = document.createElement('div');
      ruleDiv.className = 'rule';
      ruleDiv.textContent = item.action || details.rule_id || item.event_type || '';
      const fileDiv = document.createElement('div');
      fileDiv.className = 'file';
      fileDiv.textContent = file;
      div.appendChild(ruleDiv);
      div.appendChild(fileDiv);
      container.appendChild(div);
    });
  }

  // Session switching.
  document.getElementById('sessionSelect').addEventListener('change', (e) => {
    currentSessionId = e.target.value;
    document.getElementById('sessionId').textContent = currentSessionId.slice(0, 8) + '...';
    allEvents = [];
    fetchInitial();
  });

  // Export.
  document.getElementById('exportJSON').addEventListener('click', () => {
    const data = JSON.stringify(getFilteredEvents(), null, 2);
    download('k6s-events.json', data, 'application/json');
  });
  document.getElementById('exportCSV').addEventListener('click', () => {
    const rows = getFilteredEvents();
    const lines = ['sequence,timestamp,event_type,severity,agent_id,action'];
    function csvSafe(s) {
      let str = String(s);
      // Prevent CSV formula injection in spreadsheet applications.
      if (/^[=+\\-@\\t\\r]/.test(str)) str = "'" + str;
      return '"' + str.replace(/"/g, '""') + '"';
    }
    rows.forEach((r) => {
      lines.push([r.sequence, r.timestamp, r.event_type, r.severity, r.agent_id || '', csvSafe(r.action || '')].join(','));
    });
    download('k6s-events.csv', lines.join('\\n'), 'text/csv');
  });
  function download(name, content, type) {
    const blob = new Blob([content], { type: type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Transcript panel.
  let transcriptLoaded = false;
  const showTranscriptCheck = document.getElementById('showTranscript');
  const transcriptPanel = document.getElementById('transcriptPanel');

  // Restore saved preference.
  const savedTranscript = localStorage.getItem('k6s-transcript');
  if (savedTranscript === 'true') {
    showTranscriptCheck.checked = true;
    transcriptPanel.classList.remove('hidden');
  }

  showTranscriptCheck.addEventListener('change', () => {
    const show = showTranscriptCheck.checked;
    transcriptPanel.classList.toggle('hidden', !show);
    localStorage.setItem('k6s-transcript', String(show));
    if (show && !transcriptLoaded) fetchTranscript();
  });

  function fetchTranscript() {
    fetch('/api/transcript?limit=200').then((r) => r.json()).then((data) => {
      transcriptLoaded = true;
      const entries = data.entries || [];
      const container = document.getElementById('transcriptEntries');
      const empty = document.getElementById('transcriptEmpty');
      if (!entries.length) {
        empty.classList.remove('hidden');
        return;
      }
      empty.classList.add('hidden');
      while (container.firstChild) container.removeChild(container.firstChild);
      entries.forEach((e) => {
        const div = document.createElement('div');
        div.className = 'transcript-entry';

        const meta = document.createElement('div');
        meta.className = 'transcript-meta';

        const roleSpan = document.createElement('span');
        roleSpan.className = 'transcript-role ' + (e.role || '');
        roleSpan.textContent = e.role || e.entry_type || '';
        meta.appendChild(roleSpan);

        if (e.model) {
          const modelSpan = document.createElement('span');
          modelSpan.textContent = e.model;
          meta.appendChild(modelSpan);
        }

        if (e.timestamp) {
          const timeSpan = document.createElement('span');
          timeSpan.textContent = new Date(e.timestamp).toLocaleTimeString();
          meta.appendChild(timeSpan);
        }

        if (e.input_tokens || e.output_tokens) {
          const tokSpan = document.createElement('span');
          tokSpan.className = 'transcript-tokens';
          tokSpan.textContent = (e.input_tokens || 0) + ' in / ' + (e.output_tokens || 0) + ' out';
          meta.appendChild(tokSpan);
        }

        if (e.redacted) {
          const redBadge = document.createElement('span');
          redBadge.className = 'transcript-redacted';
          redBadge.textContent = 'REDACTED';
          meta.appendChild(redBadge);
        }

        div.appendChild(meta);

        if (e.content) {
          const contentDiv = document.createElement('div');
          contentDiv.className = 'transcript-content';
          const text = String(e.content);
          contentDiv.textContent = text.length > 2000 ? text.slice(0, 2000) + '...[truncated]' : text;
          div.appendChild(contentDiv);
        }

        container.appendChild(div);
      });
    }).catch(() => {});
  }

  // If transcript was already toggled on from localStorage, load it.
  if (showTranscriptCheck.checked) fetchTranscript();

  // Init.
  fetchInitial();
  connectSSE();
  renderSparkline();
})();
</script>
</body>
</html>`;
}

function escapeHTML(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
