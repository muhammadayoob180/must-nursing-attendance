const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const { db, UPLOADS_DIR } = require('./src/db');
const {
  createSession,
  deleteSession,
  requireAuth,
  requireAdmin,
  resolveAllowedShift
} = require('./src/auth');
const { generateAttendancePDF } = require('./src/pdfReport');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Multer setup for logo upload
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
    cb(null, 'logo' + (allowed.includes(ext) ? ext : '.png'));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Only PNG, JPG, or WEBP images are supported for PDF & web logo.'), ok);
  }
});

function getSettingsMap() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}

function buildReportData(date, subjectId, shift) {
  const settings = getSettingsMap();
  const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(subjectId);
  if (!subject) return null;

  const students = db
    .prepare('SELECT id, roll_no, name, ward, shift FROM students WHERE shift = ? AND active = 1 ORDER BY id ASC')
    .all(shift);

  const records = db
    .prepare('SELECT student_id, status, marked_by FROM attendance_records WHERE date = ? AND shift = ? AND subject_id = ?')
    .all(date, shift, subjectId);

  const recordMap = new Map(records.map((r) => [r.student_id, r.status]));

  const presentStudents = [];
  const absentStudents = [];

  for (const st of students) {
    const status = recordMap.get(st.id);
    if (status === 'absent') {
      absentStudents.push(st);
    } else if (status === 'present') {
      presentStudents.push(st);
    }
  }

  const session = db
    .prepare(
      `SELECT s.*, COALESCE(NULLIF(s.marked_by_name, ''), u.full_name, 'CR') AS resolved_marked_by
       FROM attendance_sessions s
       LEFT JOIN users u ON u.id = s.marked_by
       WHERE s.date = ? AND s.shift = ? AND s.subject_id = ?`
    )
    .get(date, shift, subjectId);

  let logoDiskPath = '';
  if (settings.logo_path) {
    const cleanRel = settings.logo_path.replace(/^\/+/, '');
    const candidate = path.join(__dirname, 'public', cleanRel);
    if (fs.existsSync(candidate)) logoDiskPath = candidate;
  }

  return {
    settings,
    date,
    shift,
    subject,
    session,
    markedByName: session?.resolved_marked_by || 'CR',
    presentStudents,
    absentStudents,
    totalStudents: students.length,
    markedCount: presentStudents.length + absentStudents.length,
    logoDiskPath
  };
}

// --- AUTH ROUTES ---
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username.trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = createSession(user);
  res.cookie('cr_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7
  });

  res.json({
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      shift: user.shift
    }
  });
});

app.post('/api/auth/logout', (req, res) => {
  deleteSession(req.cookies?.cr_session);
  res.clearCookie('cr_session');
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// --- SETTINGS & LOGO ---
app.get('/api/settings', (_req, res) => {
  res.json(getSettingsMap());
});

app.put('/api/settings', requireAuth, requireAdmin, (req, res) => {
  const allowedKeys = ['university_name', 'department_name', 'class_name'];
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const key of allowedKeys) {
    if (typeof req.body[key] === 'string') {
      upsert.run(key, req.body[key].trim());
    }
  }
  res.json(getSettingsMap());
});

app.post('/api/settings/logo', requireAuth, requireAdmin, (req, res) => {
  upload.single('logo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No logo file uploaded' });
    const logoUrl = `/uploads/${req.file.filename}?v=${Date.now()}`;
    const storedPath = `/uploads/${req.file.filename}`;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('logo_path', storedPath);
    res.json({ logo_path: logoUrl, settings: getSettingsMap() });
  });
});

// --- STUDENTS ---
app.get('/api/students', requireAuth, (req, res) => {
  if (req.user.role === 'admin' && req.query.shift === 'all') {
    const rows = db.prepare('SELECT * FROM students WHERE active = 1 ORDER BY shift ASC, id ASC').all();
    return res.json(rows);
  }
  const shift = resolveAllowedShift(req.user, req.query.shift);
  const rows = db
    .prepare('SELECT * FROM students WHERE shift = ? AND active = 1 ORDER BY id ASC')
    .all(shift);
  res.json(rows);
});

app.post('/api/students', requireAuth, requireAdmin, (req, res) => {
  const { roll_no, name, ward, shift } = req.body || {};
  if (!roll_no || !name || !['morning', 'evening'].includes(shift)) {
    return res.status(400).json({ error: 'roll_no, name, and valid shift (morning/evening) are required' });
  }
  try {
    const info = db
      .prepare('INSERT INTO students (roll_no, name, ward, shift) VALUES (?, ?, ?, ?)')
      .run(roll_no.trim(), name.trim(), (ward || '').trim(), shift);
    res.status(201).json({ id: info.lastInsertRowid, roll_no: roll_no.trim(), name: name.trim(), ward: (ward || '').trim(), shift });
  } catch (e) {
    res.status(409).json({ error: 'Student with this Roll No already exists in this shift' });
  }
});

app.post('/api/students/bulk', requireAuth, requireAdmin, (req, res) => {
  const { shift, lines, replaceExisting } = req.body || {};
  if (!['morning', 'evening'].includes(shift) || !Array.isArray(lines)) {
    return res.status(400).json({ error: 'shift and lines array are required' });
  }

  db.exec('BEGIN');
  try {
    if (replaceExisting) {
      db.prepare('DELETE FROM students WHERE shift = ?').run(shift);
    }
    const upsert = db.prepare(
      `INSERT INTO students (roll_no, name, ward, shift, active)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(roll_no, shift) DO UPDATE SET name = excluded.name, ward = excluded.ward, active = 1`
    );
    let count = 0;
    for (const item of lines) {
      const roll = String(item.roll_no || '').trim();
      const name = String(item.name || '').trim();
      const ward = String(item.ward || '').trim();
      if (roll && name) {
        upsert.run(roll, name, ward, shift);
        count++;
      }
    }
    db.exec('COMMIT');
    res.json({ imported: count, shift });
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/students/:id', requireAuth, requireAdmin, (req, res) => {
  const { roll_no, name, ward, shift } = req.body || {};
  if (!roll_no || !name || !['morning', 'evening'].includes(shift)) {
    return res.status(400).json({ error: 'Invalid student fields' });
  }
  try {
    db.prepare('UPDATE students SET roll_no = ?, name = ?, ward = ?, shift = ? WHERE id = ?').run(
      roll_no.trim(),
      name.trim(),
      (ward || '').trim(),
      shift,
      req.params.id
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: 'Duplicate roll number in shift' });
  }
});

app.delete('/api/students/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/students/shuffle', requireAuth, requireAdmin, (req, res) => {
  const { mode, shift } = req.body || {};
  if (!['swap_shifts', 'shuffle_wards'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid shuffle mode' });
  }

  db.exec('BEGIN');
  try {
    if (mode === 'swap_shifts') {
      const all = db.prepare('SELECT id, shift FROM students WHERE active = 1').all();
      const upd = db.prepare('UPDATE students SET shift = ? WHERE id = ?');
      // Use a two-step update to avoid UNIQUE(roll_no, shift) collisions if same roll exists
      for (const st of all) {
        const nextShift = st.shift === 'morning' ? 'evening' : 'morning';
        upd.run(nextShift, st.id);
      }
      db.exec('COMMIT');
      return res.json({ ok: true, mode, updated: all.length });
    }

    // shuffle_wards
    const targetShifts = shift === 'morning' || shift === 'evening' ? [shift] : ['morning', 'evening'];
    let updated = 0;
    const updWard = db.prepare('UPDATE students SET ward = ? WHERE id = ?');
    for (const sh of targetShifts) {
      const list = db.prepare('SELECT id, ward FROM students WHERE shift = ? AND active = 1').all(sh);
      if (list.length < 2) continue;
      const wards = list.map((s) => s.ward || '');
      // Fisher-Yates shuffle
      for (let i = wards.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [wards[i], wards[j]] = [wards[j], wards[i]];
      }
      list.forEach((st, idx) => {
        updWard.run(wards[idx], st.id);
        updated++;
      });
    }
    db.exec('COMMIT');
    res.json({ ok: true, mode, updated });
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

// --- SUBJECTS ---
app.get('/api/subjects', requireAuth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM subjects WHERE active = 1 ORDER BY code ASC, name ASC').all();
  res.json(rows);
});

app.post('/api/subjects', requireAuth, requireAdmin, (req, res) => {
  const { code, name, teacher_name } = req.body || {};
  if (!name || !teacher_name) {
    return res.status(400).json({ error: 'Subject name and teacher name are required' });
  }
  const info = db
    .prepare('INSERT INTO subjects (code, name, teacher_name) VALUES (?, ?, ?)')
    .run((code || '').trim(), name.trim(), teacher_name.trim());
  res.status(201).json({ id: info.lastInsertRowid, code: (code || '').trim(), name: name.trim(), teacher_name: teacher_name.trim() });
});

app.delete('/api/subjects/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM subjects WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- USERS (ADMIN ONLY) ---
app.get('/api/users', requireAuth, requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT id, username, full_name, role, shift, active, created_at FROM users ORDER BY id ASC').all();
  res.json(rows);
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, full_name, role, shift } = req.body || {};
  if (!username || !password || !full_name || !['admin', 'cr'].includes(role)) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  const finalShift = role === 'admin' ? 'all' : (shift === 'evening' ? 'evening' : 'morning');
  try {
    const info = db
      .prepare('INSERT INTO users (username, password_hash, full_name, role, shift) VALUES (?, ?, ?, ?, ?)')
      .run(username.trim(), bcrypt.hashSync(password, 10), full_name.trim(), role, finalShift);
    res.status(201).json({ id: info.lastInsertRowid, username: username.trim(), full_name: full_name.trim(), role, shift: finalShift });
  } catch {
    res.status(409).json({ error: 'Username already exists' });
  }
});

app.put('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const { full_name, password, shift, active } = req.body || {};
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  const newName = full_name ? full_name.trim() : existing.full_name;
  const newShift = existing.role === 'admin' ? 'all' : (['morning', 'evening'].includes(shift) ? shift : existing.shift);
  const newActive = typeof active === 'number' ? active : existing.active;
  const newHash = password ? bcrypt.hashSync(password, 10) : existing.password_hash;

  db.prepare('UPDATE users SET full_name = ?, password_hash = ?, shift = ?, active = ? WHERE id = ?').run(
    newName,
    newHash,
    newShift,
    newActive,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own active admin account' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- ATTENDANCE ---
app.get('/api/attendance', requireAuth, (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const subjectId = Number(req.query.subject_id);
  const shift = resolveAllowedShift(req.user, req.query.shift);

  const students = db
    .prepare('SELECT id, roll_no, name, ward, shift FROM students WHERE shift = ? AND active = 1 ORDER BY id ASC')
    .all(shift);

  let records = [];
  let session = null;
  if (subjectId) {
    records = db
      .prepare('SELECT student_id, status FROM attendance_records WHERE date = ? AND shift = ? AND subject_id = ?')
      .all(date, shift, subjectId);
    session = db
      .prepare('SELECT time_slot, remarks, marked_by_name, updated_at FROM attendance_sessions WHERE date = ? AND shift = ? AND subject_id = ?')
      .get(date, shift, subjectId);
  }

  const statusMap = {};
  for (const r of records) statusMap[r.student_id] = r.status;

  res.json({ date, shift, subject_id: subjectId, students, statusMap, session });
});

app.post('/api/attendance', requireAuth, (req, res) => {
  const { date, subject_id, shift: requestedShift, records, time_slot, remarks, marked_by_name } = req.body || {};
  if (!date || !subject_id || !Array.isArray(records)) {
    return res.status(400).json({ error: 'date, subject_id, and records are required' });
  }
  const shift = resolveAllowedShift(req.user, requestedShift);
  const subjectId = Number(subject_id);
  const finalMarkedByName = (marked_by_name || req.user.full_name || '').trim();

  // Validate that all student IDs belong to the allowed shift
  const validIds = new Set(
    db.prepare('SELECT id FROM students WHERE shift = ? AND active = 1').all(shift).map((s) => s.id)
  );

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO attendance_sessions (date, shift, subject_id, time_slot, remarks, marked_by, marked_by_name, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(date, shift, subject_id) DO UPDATE SET
         time_slot = excluded.time_slot,
         remarks = excluded.remarks,
         marked_by = excluded.marked_by,
         marked_by_name = excluded.marked_by_name,
         updated_at = CURRENT_TIMESTAMP`
    ).run(date, shift, subjectId, (time_slot || '').trim(), (remarks || '').trim(), req.user.id, finalMarkedByName);

    const upsertRecord = db.prepare(
      `INSERT INTO attendance_records (date, shift, subject_id, student_id, status, marked_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(date, shift, subject_id, student_id) DO UPDATE SET
         status = excluded.status,
         marked_by = excluded.marked_by,
         updated_at = CURRENT_TIMESTAMP`
    );

    let saved = 0;
    for (const rec of records) {
      const sid = Number(rec.student_id);
      if (validIds.has(sid) && (rec.status === 'present' || rec.status === 'absent')) {
        upsertRecord.run(date, shift, subjectId, sid, rec.status, req.user.id);
        saved++;
      }
    }
    db.exec('COMMIT');
    res.json({ ok: true, saved, date, shift, subject_id: subjectId });
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/attendance/history', requireAuth, (req, res) => {
  const shiftFilter = req.user.role === 'cr' ? req.user.shift : req.query.shift;
  const whereClause = shiftFilter === 'morning' || shiftFilter === 'evening' ? 'WHERE s.shift = ?' : '';
  const params = shiftFilter === 'morning' || shiftFilter === 'evening' ? [shiftFilter] : [];

  const rows = db
    .prepare(
      `SELECT
         s.date,
         s.shift,
         s.subject_id,
         s.time_slot,
         s.updated_at,
         sub.code AS subject_code,
         sub.name AS subject_name,
         sub.teacher_name,
         COALESCE(NULLIF(s.marked_by_name, ''), u.full_name, 'CR') AS marked_by_name,
         SUM(CASE WHEN r.status = 'present' THEN 1 ELSE 0 END) AS present_count,
         SUM(CASE WHEN r.status = 'absent' THEN 1 ELSE 0 END) AS absent_count
       FROM attendance_sessions s
       JOIN subjects sub ON sub.id = s.subject_id
       LEFT JOIN users u ON u.id = s.marked_by
       LEFT JOIN attendance_records r ON r.date = s.date AND r.shift = s.shift AND r.subject_id = s.subject_id
       ${whereClause}
       GROUP BY s.id
       ORDER BY s.date DESC, s.updated_at DESC
       LIMIT 60`
    )
    .all(...params);

  res.json(rows);
});

// --- REPORTS & EXPORTS ---
app.get('/api/reports/daily', requireAuth, (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const subjectId = Number(req.query.subject_id);
  const shift = resolveAllowedShift(req.user, req.query.shift);

  if (!subjectId) return res.status(400).json({ error: 'subject_id is required' });
  const data = buildReportData(date, subjectId, shift);
  if (!data) return res.status(404).json({ error: 'Subject not found' });

  res.json(data);
});

app.get('/api/reports/pdf', requireAuth, (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const subjectId = Number(req.query.subject_id);
  const shift = resolveAllowedShift(req.user, req.query.shift);

  if (!subjectId) return res.status(400).json({ error: 'subject_id is required' });
  const data = buildReportData(date, subjectId, shift);
  if (!data) return res.status(404).json({ error: 'Subject not found' });

  generateAttendancePDF(res, data);
});

app.get('/api/reports/csv', requireAuth, (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const subjectId = Number(req.query.subject_id);
  const shift = resolveAllowedShift(req.user, req.query.shift);

  if (!subjectId) return res.status(400).json({ error: 'subject_id is required' });
  const data = buildReportData(date, subjectId, shift);
  if (!data) return res.status(404).json({ error: 'Subject not found' });

  const escapeCsv = (val) => `"${String(val || '').replace(/"/g, '""')}"`;
  const lines = [
    ['Date', date, 'Shift', shift.toUpperCase(), 'Duty / Subject', data.subject.name, 'Faculty', data.subject.teacher_name].map(escapeCsv).join(','),
    ['Sr.', 'Roll No', 'Student Name', 'Ward', 'Status'].map(escapeCsv).join(',')
  ];

  let sr = 1;
  for (const st of data.absentStudents) {
    lines.push([sr++, st.roll_no, st.name, st.ward || '-', 'ABSENT'].map(escapeCsv).join(','));
  }
  for (const st of data.presentStudents) {
    lines.push([sr++, st.roll_no, st.name, st.ward || '-', 'PRESENT'].map(escapeCsv).join(','));
  }

  const safeSubject = data.subject.name.replace(/[^a-zA-Z0-9_-]+/g, '_');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Attendance_${date}_${shift}_${safeSubject}.csv"`);
  res.send(lines.join('\r\n'));
});

// Fallback to index.html for SPA
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CR Attendance Server running at http://localhost:${PORT}`);
});
