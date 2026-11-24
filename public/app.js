const state = {
  user: null,
  settings: {},
  subjects: [],
  students: [],
  statusMap: {},
  currentReport: null
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showToast(msg, type = 'success') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  setTimeout(() => el.classList.add('hidden'), 3000);
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function renderLogo(containerEl, logoPath) {
  if (logoPath) {
    containerEl.innerHTML = `<img src="${logoPath}" alt="Logo" />`;
  } else {
    containerEl.innerHTML = `<span class="logo-placeholder">LOGO</span>`;
  }
}

function applyBranding() {
  const s = state.settings;
  $('#login-uni-name').textContent = s.university_name || 'CR Attendance Portal';
  $('#login-class-name').textContent = s.class_name || 'Class Attendance';
  $('#nav-class-name').textContent = s.class_name || 'Class Attendance';
  $('#nav-uni-name').textContent = s.university_name || '';
  renderLogo($('#login-logo-box'), s.logo_path);
  renderLogo($('#nav-logo-box'), s.logo_path);

  if ($('#set-uni')) {
    $('#set-uni').value = s.university_name || '';
    $('#set-dept').value = s.department_name || '';
    $('#set-class').value = s.class_name || '';
  }
}

async function loadSettings() {
  state.settings = await api('/api/settings');
  applyBranding();
}

async function initSession() {
  await loadSettings();
  try {
    const { user } = await api('/api/auth/me');
    enterApp(user);
  } catch {
    $('#login-view').classList.remove('hidden');
    $('#app-view').classList.add('hidden');
  }
}

async function enterApp(user) {
  state.user = user;
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');

  $('#user-name-label').textContent = user.full_name;
  $('#user-role-badge').textContent = user.role === 'admin' ? 'Admin' : `${user.shift} CR`;

  const isAdmin = user.role === 'admin';
  $('#admin-tab-btn').classList.toggle('hidden', !isAdmin);

  // Lock shift dropdowns for CRs, allow switching for Admin
  const attShiftEl = $('#att-shift');
  const repShiftEl = $('#rep-shift');
  if (!isAdmin) {
    attShiftEl.value = user.shift;
    repShiftEl.value = user.shift;
    attShiftEl.disabled = true;
    repShiftEl.disabled = true;
  } else {
    attShiftEl.disabled = false;
    repShiftEl.disabled = false;
  }

  $('#att-date').value = todayStr();
  $('#rep-date').value = todayStr();

  await loadSubjects();
  await loadAttendanceSheet();
  if (isAdmin) await loadAdminData();
}

async function loadSubjects() {
  state.subjects = await api('/api/subjects');
  const options = state.subjects
    .map((s) => `<option value="${s.id}">${s.code ? s.code + ' — ' : ''}${s.name} (${s.teacher_name})</option>`)
    .join('');
  $('#att-subject').innerHTML = options || '<option value="">No subjects</option>';
  $('#rep-subject').innerHTML = options || '<option value="">No subjects</option>';
}

// --- ATTENDANCE TAB ---
async function loadAttendanceSheet() {
  const date = $('#att-date').value;
  const subject_id = $('#att-subject').value;
  const shift = $('#att-shift').value;
  if (!date || !subject_id) return;

  const data = await api(`/api/attendance?date=${encodeURIComponent(date)}&subject_id=${subject_id}&shift=${shift}`);
  state.students = data.students;
  state.statusMap = {};

  // Default unmarked students to 'present' so CR only taps absentees (fast!)
  for (const st of state.students) {
    state.statusMap[st.id] = data.statusMap[st.id] || 'present';
  }

  $('#att-timeslot').value = data.session?.time_slot || '';
  $('#att-remarks').value = data.session?.remarks || '';
  $('#att-marked-by').value = data.session?.marked_by_name || state.user?.full_name || '';
  renderStudentList();
}

function renderStudentList() {
  const query = ($('#att-search').value || '').toLowerCase().trim();
  const listEl = $('#att-student-list');

  const filtered = state.students.filter(
    (s) =>
      s.roll_no.toLowerCase().includes(query) ||
      s.name.toLowerCase().includes(query) ||
      (s.ward || '').toLowerCase().includes(query)
  );

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="card muted">No students found in this shift.</div>`;
  } else {
    listEl.innerHTML = filtered
      .map((st) => {
        const status = state.statusMap[st.id] || 'present';
        return `
          <div class="student-row is-${status}" data-id="${st.id}">
            <div class="st-info">
              <div class="st-roll">${st.roll_no}${st.ward ? `<span class="ward-pill">${st.ward}</span>` : ''}</div>
              <div class="st-name">${st.name}</div>
            </div>
            <div class="toggle-group">
              <button type="button" class="toggle-btn present ${status === 'present' ? 'active' : ''}" data-status="present">P</button>
              <button type="button" class="toggle-btn absent ${status === 'absent' ? 'active' : ''}" data-status="absent">A</button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  updateStats();
}

function updateStats() {
  const total = state.students.length;
  let present = 0;
  let absent = 0;
  for (const st of state.students) {
    if (state.statusMap[st.id] === 'absent') absent++;
    else present++;
  }
  $('#stat-total').textContent = total;
  $('#stat-present').textContent = present;
  $('#stat-absent').textContent = absent;
}

async function saveAttendance(goToReport = false) {
  const date = $('#att-date').value;
  const subject_id = $('#att-subject').value;
  const shift = $('#att-shift').value;
  if (!date || !subject_id) return showToast('Select date and subject', 'error');

  const records = state.students.map((st) => ({
    student_id: st.id,
    status: state.statusMap[st.id] || 'present'
  }));

  await api('/api/attendance', {
    method: 'POST',
    body: JSON.stringify({
      date,
      subject_id,
      shift,
      time_slot: $('#att-timeslot').value,
      remarks: $('#att-remarks').value,
      marked_by_name: $('#att-marked-by').value,
      records
    })
  });

  showToast('Attendance saved!');
  if (goToReport) {
    $('#rep-date').value = date;
    $('#rep-subject').value = subject_id;
    $('#rep-shift').value = shift;
    switchTab('report');
    await loadReportPreview();
  }
}

// --- TEACHER REPORT TAB ---
async function loadReportPreview() {
  const date = $('#rep-date').value;
  const subject_id = $('#rep-subject').value;
  const shift = $('#rep-shift').value;
  if (!date || !subject_id) return;

  const data = await api(`/api/reports/daily?date=${encodeURIComponent(date)}&subject_id=${subject_id}&shift=${shift}`);
  state.currentReport = data;

  const { settings, subject, session, markedByName, presentStudents, absentStudents, totalStudents } = data;
  const pct = totalStudents > 0 ? Math.round((presentStudents.length / totalStudents) * 100) : 0;

  const absRows = absentStudents.length
    ? absentStudents
        .map(
          (st, i) => `<tr><td>${i + 1}</td><td><strong>${st.roll_no}</strong></td><td>${st.name}</td><td>${st.ward || '—'}</td><td class="status-tag-absent">ABSENT</td></tr>`
        )
        .join('')
    : `<tr><td colspan="5" class="muted">No students were absent — 100% attendance!</td></tr>`;

  const presRows = presentStudents.length
    ? presentStudents
        .map(
          (st, i) => `<tr><td>${i + 1}</td><td><strong>${st.roll_no}</strong></td><td>${st.name}</td><td>${st.ward || '—'}</td><td class="status-tag-present">PRESENT</td></tr>`
        )
        .join('')
    : `<tr><td colspan="5" class="muted">No attendance saved for this date/subject yet.</td></tr>`;

  $('#report-preview').innerHTML = `
    <div class="rep-header-centered">
      <div class="logo-box logo-sm">${settings.logo_path ? `<img src="${settings.logo_path}" alt="Logo" />` : '<span class="logo-placeholder">LOGO</span>'}</div>
      <div class="rep-title">${(settings.university_name || '').toUpperCase()}</div>
      <div class="muted">${settings.department_name || ''}</div>
    </div>
    <div class="rep-banner-pill">DAILY CLINICAL DUTY ATTENDANCE REPORT — TEACHER COPY</div>
    <div class="rep-meta">
      <div><strong>Date:</strong> ${date}</div>
      <div><strong>Shift:</strong> ${shift.toUpperCase()}</div>
      <div><strong>Duty / Subject:</strong> ${subject.name}</div>
      <div><strong>Faculty:</strong> ${subject.teacher_name}</div>
      <div><strong>Placement:</strong> ${settings.class_name || '—'}</div>
      <div><strong>Marked By:</strong> ${markedByName}${session?.time_slot ? ' (' + session.time_slot + ')' : ''}</div>
    </div>
    <div class="stats-bar">
      <span class="stat-pill">Total: <strong>${totalStudents}</strong></span>
      <span class="stat-pill stat-present">Present: <strong>${presentStudents.length} (${pct}%)</strong></span>
      <span class="stat-pill stat-absent">Absent: <strong>${absentStudents.length}</strong></span>
    </div>

    <div class="rep-section-title absent">ABSENT STUDENTS (${absentStudents.length})</div>
    <table class="rep-table">
      <thead><tr><th>Sr.</th><th>Roll No</th><th>Student Name</th><th>Ward</th><th>Status</th></tr></thead>
      <tbody>${absRows}</tbody>
    </table>

    <div class="rep-section-title present">PRESENT STUDENTS (${presentStudents.length})</div>
    <table class="rep-table">
      <thead><tr><th>Sr.</th><th>Roll No</th><th>Student Name</th><th>Ward</th><th>Status</th></tr></thead>
      <tbody>${presRows}</tbody>
    </table>
    ${session?.remarks ? `<p class="muted"><strong>Remarks:</strong> ${session.remarks}</p>` : ''}
    <div class="rep-dev-credit">Developed &amp; Designed by AR BROTHERS</div>
  `;
}

function copyWhatsAppReport() {
  const r = state.currentReport;
  if (!r) return showToast('Load a report first', 'error');

  const absList = r.absentStudents.length
    ? r.absentStudents.map((s, i) => `${i + 1}. ${s.roll_no} - ${s.name}${s.ward ? ' (' + s.ward + ')' : ''}`).join('\n')
    : 'None (100% Present)';

  const presList = r.presentStudents.length
    ? r.presentStudents.map((s, i) => `${i + 1}. ${s.roll_no} - ${s.name}${s.ward ? ' (' + s.ward + ')' : ''}`).join('\n')
    : 'None';

  const text = [
    `*${r.settings.university_name || 'Attendance Report'}*`,
    `*${r.settings.department_name || ''}*`,
    `📅 Date: ${r.date} | 🕒 Shift: ${r.shift.toUpperCase()}`,
    `🏥 Duty: ${r.subject.name}`,
    `👩‍🏫 Faculty: ${r.subject.teacher_name}`,
    `📝 Marked By: ${r.markedByName}`,
    `✅ Present: ${r.presentStudents.length}/${r.totalStudents} | ❌ Absent: ${r.absentStudents.length}`,
    '',
    `*ABSENT STUDENTS (${r.absentStudents.length}):*`,
    absList,
    '',
    `*PRESENT STUDENTS (${r.presentStudents.length}):*`,
    presList
  ].join('\n');

  navigator.clipboard.writeText(text).then(
    () => showToast('WhatsApp report copied!'),
    () => showToast('Could not copy to clipboard', 'error')
  );
}

// --- HISTORY TAB ---
async function loadHistory() {
  const rows = await api('/api/attendance/history');
  const el = $('#history-list');
  if (!rows.length) {
    el.innerHTML = '<p class="muted">No attendance records saved yet.</p>';
    return;
  }
  el.innerHTML = rows
    .map(
      (r) => `
      <div class="history-item">
        <div>
          <strong>${r.date}</strong> • <span class="badge" style="background:#e2e8f0;color:#0f172a;">${r.shift}</span>
          <div>${r.subject_code ? r.subject_code + ' — ' : ''}${r.subject_name} (${r.teacher_name})</div>
          <div class="muted">Present: ${r.present_count || 0} | Absent: ${r.absent_count || 0} • By ${r.marked_by_name || 'CR'}</div>
        </div>
        <button class="btn btn-secondary btn-sm view-hist-btn" data-date="${r.date}" data-sub="${r.subject_id}" data-shift="${r.shift}">View Report</button>
      </div>
    `
    )
    .join('');
}

// --- ADMIN TAB ---
async function loadAdminData() {
  if (state.user?.role !== 'admin') return;
  const [users, subjects, students] = await Promise.all([
    api('/api/users'),
    api('/api/subjects'),
    api(`/api/students?shift=${$('#admin-student-filter').value}`)
  ]);

  $('#admin-users-list').innerHTML = users
    .map(
      (u) => `
      <div class="mini-row">
        <div><strong>${u.full_name}</strong> (<code>${u.username}</code>) • ${u.role.toUpperCase()} / ${u.shift}</div>
        ${u.id !== state.user.id ? `<button class="btn btn-outline-red btn-sm del-user-btn" data-id="${u.id}">Delete</button>` : '<span class="muted">You</span>'}
      </div>
    `
    )
    .join('');

  $('#admin-subjects-list').innerHTML = subjects
    .map(
      (s) => `
      <div class="mini-row">
        <div><strong>${s.code ? s.code + ' ' : ''}${s.name}</strong> — ${s.teacher_name}</div>
        <button class="btn btn-outline-red btn-sm del-sub-btn" data-id="${s.id}">Delete</button>
      </div>
    `
    )
    .join('');

  $('#admin-students-list').innerHTML = students
    .map(
      (st) => `
      <div class="mini-row" data-st='${JSON.stringify({ id: st.id, roll_no: st.roll_no, name: st.name, ward: st.ward || '', shift: st.shift }).replace(/'/g, "&#39;")}'>
        <div><strong>${st.roll_no}</strong> — ${st.name}${st.ward ? ` <span class="ward-pill">${st.ward}</span>` : ''} <span class="muted">(${st.shift})</span></div>
        <div class="quick-actions">
          <button class="btn btn-ghost btn-sm swap-st-shift-btn" title="Move to ${st.shift === 'morning' ? 'Evening' : 'Morning'}">→ ${st.shift === 'morning' ? 'Evening' : 'Morning'}</button>
          <button class="btn btn-ghost btn-sm edit-st-ward-btn">Ward</button>
          <button class="btn btn-outline-red btn-sm del-st-btn" data-id="${st.id}">Remove</button>
        </div>
      </div>
    `
    )
    .join('');
}

function switchTab(tabName) {
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabName));
  $$('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${tabName}`));
}

// --- EVENT LISTENERS ---
$$('.chip-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $('#login-username').value = btn.dataset.user;
    $('#login-password').value = btn.dataset.pass;
  });
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { user } = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: $('#login-username').value,
        password: $('#login-password').value
      })
    });
    await enterApp(user);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  state.user = null;
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
});

$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const tab = btn.dataset.tab;
    switchTab(tab);
    if (tab === 'report') await loadReportPreview();
    if (tab === 'history') await loadHistory();
    if (tab === 'admin') await loadAdminData();
  });
});

$('#att-date').addEventListener('change', loadAttendanceSheet);
$('#att-subject').addEventListener('change', loadAttendanceSheet);
$('#att-shift').addEventListener('change', loadAttendanceSheet);
$('#att-search').addEventListener('input', renderStudentList);

$('#att-student-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.toggle-btn');
  if (!btn) return;
  const row = btn.closest('.student-row');
  const id = Number(row.dataset.id);
  state.statusMap[id] = btn.dataset.status;
  renderStudentList();
});

$('#mark-all-present').addEventListener('click', () => {
  for (const st of state.students) state.statusMap[st.id] = 'present';
  renderStudentList();
});

$('#mark-all-absent').addEventListener('click', () => {
  for (const st of state.students) state.statusMap[st.id] = 'absent';
  renderStudentList();
});

$('#save-att-btn').addEventListener('click', () => saveAttendance(false).catch((e) => showToast(e.message, 'error')));
$('#save-and-report-btn').addEventListener('click', () => saveAttendance(true).catch((e) => showToast(e.message, 'error')));

$('#rep-date').addEventListener('change', loadReportPreview);
$('#rep-subject').addEventListener('change', loadReportPreview);
$('#rep-shift').addEventListener('change', loadReportPreview);

$('#download-pdf-btn').addEventListener('click', () => {
  const date = $('#rep-date').value;
  const sub = $('#rep-subject').value;
  const shift = $('#rep-shift').value;
  if (!date || !sub) return;
  window.location.href = `/api/reports/pdf?date=${encodeURIComponent(date)}&subject_id=${sub}&shift=${shift}`;
});

$('#download-csv-btn').addEventListener('click', () => {
  const date = $('#rep-date').value;
  const sub = $('#rep-subject').value;
  const shift = $('#rep-shift').value;
  if (!date || !sub) return;
  window.location.href = `/api/reports/csv?date=${encodeURIComponent(date)}&subject_id=${sub}&shift=${shift}`;
});

$('#copy-whatsapp-btn').addEventListener('click', copyWhatsAppReport);
$('#refresh-history-btn').addEventListener('click', loadHistory);

$('#history-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.view-hist-btn');
  if (!btn) return;
  $('#rep-date').value = btn.dataset.date;
  $('#rep-subject').value = btn.dataset.sub;
  if (state.user.role === 'admin') $('#rep-shift').value = btn.dataset.shift;
  switchTab('report');
  await loadReportPreview();
});

// Admin Forms
$('#add-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username: $('#new-user-username').value,
        full_name: $('#new-user-fullname').value,
        password: $('#new-user-pass').value,
        role: $('#new-user-role').value,
        shift: $('#new-user-shift').value
      })
    });
    e.target.reset();
    await loadAdminData();
    showToast('User created!');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

$('#add-subject-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/subjects', {
      method: 'POST',
      body: JSON.stringify({
        code: '',
        name: $('#new-sub-name').value,
        teacher_name: $('#new-sub-teacher').value
      })
    });
    e.target.reset();
    await loadSubjects();
    await loadAdminData();
    showToast('Placement / Faculty added!');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

$('#add-student-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/students', {
      method: 'POST',
      body: JSON.stringify({
        roll_no: $('#new-st-roll').value,
        name: $('#new-st-name').value,
        ward: $('#new-st-ward').value,
        shift: $('#new-st-shift').value
      })
    });
    e.target.reset();
    await loadAdminData();
    await loadAttendanceSheet();
    showToast('Student added!');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

$('#bulk-student-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = $('#bulk-lines').value.trim();
  if (!raw) return;
  const lines = raw
    .split(/\r?\n/)
    .map((line) => {
      const parts = line.split(/[,\t]+/);
      return {
        roll_no: (parts[0] || '').trim(),
        name: (parts[1] || '').trim(),
        ward: (parts[2] || '').trim()
      };
    })
    .filter((x) => x.roll_no && x.name);

  if (!lines.length) return showToast('Format: Roll No, Student Name, Ward per line', 'error');

  try {
    const res = await api('/api/students/bulk', {
      method: 'POST',
      body: JSON.stringify({
        shift: $('#bulk-shift').value,
        replaceExisting: $('#bulk-replace').checked,
        lines
      })
    });
    $('#bulk-lines').value = '';
    await loadAdminData();
    await loadAttendanceSheet();
    showToast(`Imported ${res.imported} students to ${res.shift} shift!`);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

$('#admin-student-filter').addEventListener('change', loadAdminData);

$('#shuffle-wards-btn').addEventListener('click', async () => {
  const shift = $('#admin-student-filter').value;
  if (!confirm(`Shuffle wards for ${shift === 'all' ? 'both shifts' : shift + ' shift'}?`)) return;
  try {
    const res = await api('/api/students/shuffle', {
      method: 'POST',
      body: JSON.stringify({ mode: 'shuffle_wards', shift })
    });
    await loadAdminData();
    await loadAttendanceSheet();
    showToast(`Shuffled wards for ${res.updated} students!`);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

$('#swap-shifts-btn').addEventListener('click', async () => {
  if (!confirm('Swap ALL Morning students to Evening and Evening students to Morning?')) return;
  try {
    const res = await api('/api/students/shuffle', {
      method: 'POST',
      body: JSON.stringify({ mode: 'swap_shifts' })
    });
    await loadAdminData();
    await loadAttendanceSheet();
    showToast(`Swapped shifts for ${res.updated} students!`);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

$('#tab-admin').addEventListener('click', async (e) => {
  const swapBtn = e.target.closest('.swap-st-shift-btn');
  if (swapBtn) {
    const st = JSON.parse(swapBtn.closest('.mini-row').dataset.st);
    const nextShift = st.shift === 'morning' ? 'evening' : 'morning';
    try {
      await api(`/api/students/${st.id}`, {
        method: 'PUT',
        body: JSON.stringify({ roll_no: st.roll_no, name: st.name, ward: st.ward, shift: nextShift })
      });
      await loadAdminData();
      await loadAttendanceSheet();
      return showToast(`${st.name} moved to ${nextShift} shift!`);
    } catch (err) {
      return showToast(err.message, 'error');
    }
  }
  const wardBtn = e.target.closest('.edit-st-ward-btn');
  if (wardBtn) {
    const st = JSON.parse(wardBtn.closest('.mini-row').dataset.st);
    const newWard = prompt(`Enter new Ward for ${st.name} (${st.roll_no}):`, st.ward || '');
    if (newWard === null) return;
    try {
      await api(`/api/students/${st.id}`, {
        method: 'PUT',
        body: JSON.stringify({ roll_no: st.roll_no, name: st.name, ward: newWard.trim(), shift: st.shift })
      });
      await loadAdminData();
      await loadAttendanceSheet();
      return showToast(`Updated ward for ${st.name}!`);
    } catch (err) {
      return showToast(err.message, 'error');
    }
  }
  const delUser = e.target.closest('.del-user-btn');
  if (delUser) {
    await api(`/api/users/${delUser.dataset.id}`, { method: 'DELETE' });
    await loadAdminData();
    return showToast('User deleted');
  }
  const delSub = e.target.closest('.del-sub-btn');
  if (delSub) {
    await api(`/api/subjects/${delSub.dataset.id}`, { method: 'DELETE' });
    await loadSubjects();
    await loadAdminData();
    return showToast('Subject deleted');
  }
  const delSt = e.target.closest('.del-st-btn');
  if (delSt) {
    await api(`/api/students/${delSt.dataset.id}`, { method: 'DELETE' });
    await loadAdminData();
    await loadAttendanceSheet();
    return showToast('Student removed');
  }
});

initSession();
