const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'attendance.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'cr')),
    shift TEXT NOT NULL CHECK(shift IN ('all', 'morning', 'evening')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roll_no TEXT NOT NULL,
    name TEXT NOT NULL,
    ward TEXT DEFAULT '',
    shift TEXT NOT NULL CHECK(shift IN ('morning', 'evening')),
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE(roll_no, shift)
  );

  CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT DEFAULT '',
    name TEXT NOT NULL,
    teacher_name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS attendance_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    shift TEXT NOT NULL CHECK(shift IN ('morning', 'evening')),
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    time_slot TEXT DEFAULT '',
    remarks TEXT DEFAULT '',
    marked_by INTEGER REFERENCES users(id),
    marked_by_name TEXT DEFAULT '',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date, shift, subject_id)
  );

  CREATE TABLE IF NOT EXISTS attendance_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    shift TEXT NOT NULL CHECK(shift IN ('morning', 'evening')),
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('present', 'absent')),
    marked_by INTEGER REFERENCES users(id),
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date, shift, subject_id, student_id)
  );
`);

// Ensure ward and marked_by_name columns exist if upgrading an older DB
const cols = db.prepare('PRAGMA table_info(students)').all();
if (!cols.some((c) => c.name === 'ward')) {
  db.exec("ALTER TABLE students ADD COLUMN ward TEXT DEFAULT ''");
}
const sessCols = db.prepare('PRAGMA table_info(attendance_sessions)').all();
if (!sessCols.some((c) => c.name === 'marked_by_name')) {
  db.exec("ALTER TABLE attendance_sessions ADD COLUMN marked_by_name TEXT DEFAULT ''");
}

function seedDefaults() {
  const defaultSettings = {
    university_name: 'Multan University of Science & Technology',
    department_name: 'School of Nursing — BS Nursing 7th Semester (Section-B)',
    class_name: 'Placement: Khwaja Fareed Hospital Multan',
    logo_path: '/uploads/must-logo.png'
  };

  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
  );
  for (const [k, v] of Object.entries(defaultSettings)) {
    insertSetting.run(k, v);
  }

  const userCount = db.prepare('SELECT COUNT(*) AS cnt FROM users').get().cnt;
  if (userCount === 0) {
    const insertUser = db.prepare(
      'INSERT INTO users (username, password_hash, full_name, role, shift) VALUES (?, ?, ?, ?, ?)'
    );
    insertUser.run('admin', bcrypt.hashSync('admin123', 10), 'Main Admin', 'admin', 'all');
    insertUser.run('morning_cr', bcrypt.hashSync('morning123', 10), 'Morning CR', 'cr', 'morning');
    insertUser.run('evening_cr', bcrypt.hashSync('evening123', 10), 'Evening CR', 'cr', 'evening');
  }

  const subjectCount = db.prepare('SELECT COUNT(*) AS cnt FROM subjects').get().cnt;
  if (subjectCount === 0) {
    const insertSubject = db.prepare(
      'INSERT INTO subjects (code, name, teacher_name) VALUES (?, ?, ?)'
    );
    insertSubject.run('CLINICAL', 'Clinical Duty — Khwaja Fareed Hospital', 'Ms. Kiran Ejaz');
  }

  const studentCount = db.prepare('SELECT COUNT(*) AS cnt FROM students').get().cnt;
  if (studentCount === 0) {
    const insertStudent = db.prepare(
      'INSERT INTO students (roll_no, name, ward, shift) VALUES (?, ?, ?, ?)'
    );

    const morningRoster = [
      ['2023-NURSING-F-002', 'Muhammad Ali Raza', 'CCU'],
      ['2023-NURSING-F-003', 'Muhammad Nasir', 'Emergency'],
      ['2023-NURSING-F-008', 'Muhammad Awais', 'CCU'],
      ['2023-NURSING-F-011', 'M. Zain-ul-Abideen', 'CCU'],
      ['2023-NURSING-F-016', 'M. Asad Aslam', 'Emergency'],
      ['2023-NURSING-F-017', 'Syed Awais Hamdani', 'Emergency'],
      ['2023-NURSING-F-020', 'Nadeem Anjum', 'Surgical'],
      ['2023-NURSING-F-022', 'Muhammad Sajjad', 'Surgical'],
      ['2023-NURSING-F-023', 'Ghulam Muhammad', 'Peads'],
      ['2023-NURSING-F-024', 'Saeed-ur-Rehman', 'Peads'],
      ['2023-NURSING-F-025', 'Junaid Ahmed Riaz', 'CCU'],
      ['2023-NURSING-F-031', 'M. Azhar Rafiq', 'OT'],
      ['2023-NURSING-F-032', 'Muhammad Waseem', 'OT'],
      ['2023-NURSING-F-033', 'Muhammad Zohaib', 'MM'],
      ['2023-NURSING-F-034', 'Janbaz Gul', 'Surgical'],
      ['2023-NURSING-F-035', 'Muhammad Saqlain', 'MM'],
      ['2023-NURSING-F-036', 'Nawab Muhammad Umer', 'FM'],
      ['2023-NURSING-F-039', 'M. Abdullah', 'FM'],
      ['2023-NURSING-F-040', 'Yaqoob Ahmad', 'Pulmo'],
      ['2023-NURSING-F-057', 'Samran Zeeshan', 'Pulmo'],
      ['2023-NURSING-F-059', 'Muhammad Ali Asghar', 'Pulmo'],
      ['2023-NURSING-F-061', 'Zohaib Saleem', 'OT'],
      ['2023-NURSING-F-068', 'Muqadas Khalil', 'Surgical'],
      ['2023-NURSING-F-072', 'Malaika Afzal', 'Gynae'],
      ['2023-NURSING-F-076', 'Aneela Ijaz', 'L/R'],
      ['2023-NURSING-F-082', 'Ayesha Qadir', 'Gynae'],
      ['2023-NURSING-F-083', 'Ayesha Manzoor', 'Gynae'],
      ['2023-NURSING-F-084', 'Muneeba', 'CCU'],
      ['2023-NURSING-F-090', 'Saira Zafar', 'L/R'],
      ['2023-NURSING-F-097', 'Aqsa bibi', 'Peads'],
      ['2023-NURSING-F-114', 'Muhammad Jawad Ali', 'Peads']
    ];
    for (const [roll, name, ward] of morningRoster) {
      insertStudent.run(roll, name, ward, 'morning');
    }

    const eveningRoster = [
      ['2023-NURSING-F-001', 'Sultan', 'MS'],
      ['2023-NURSING-F-013', 'Ahmad Jhanzaib', 'Emergency'],
      ['2023-NURSING-F-021', 'Muhammad Abdullah', 'Emergency'],
      ['2023-NURSING-F-045', 'Muhammad Shazaman', 'Triage'],
      ['2023-NURSING-F-027', 'M. Muzamil', 'Medical'],
      ['2023-NURSING-F-028', 'Syed Abdullah Hasnain Shah', 'Pulmo'],
      ['2023-NURSING-F-041', 'Abu Bakar', 'Peads'],
      ['2023-NURSING-F-079', 'Urwa shah', 'Pulmo'],
      ['2023-NURSING-F-086', 'Sawara Mushtaq', 'L/R'],
      ['2023-NURSING-F-071', 'Mishal Hanef', 'Gynae'],
      ['2023-NURSING-F-104', 'Shahbaz Ali', 'Medical'],
      ['2023-NURSING-F-105', 'Muhammad Ijaz', 'Surgical'],
      ['2023-NURSING-F-107', 'Aqsa Batool', 'Nursery'],
      ['2023-NURSING-F-108', 'Afshan Iqbal', 'L/R'],
      ['2023-NURSING-F-112', 'Muhammad Ayoob', 'CCU'],
      ['2023-NURSING-F-113', 'Alena Shahzadi', 'Peads'],
      ['2023-NURSING-F-116', 'Muhammad Awais', 'CCU'],
      ['2023-NURSING-F-115', 'Shahmeer Shaukat', 'Surgical']
    ];
    for (const [roll, name, ward] of eveningRoster) {
      insertStudent.run(roll, name, ward, 'evening');
    }
  }
}

seedDefaults();

module.exports = {
  db,
  DATA_DIR,
  UPLOADS_DIR
};
