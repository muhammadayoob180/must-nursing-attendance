const fs = require('fs');
const PDFDocument = require('pdfkit');

/**
 * Streams a MUST-style Teacher Daily Clinical Duty Attendance Report PDF.
 */
function generateAttendancePDF(res, reportData) {
  const {
    settings,
    date,
    shift,
    subject,
    session,
    markedByName,
    presentStudents,
    absentStudents,
    totalStudents,
    logoDiskPath
  } = reportData;

  const doc = new PDFDocument({
    size: 'A4',
    margin: 38,
    info: {
      Title: `Attendance Report - ${date} - ${shift.toUpperCase()} - ${subject.name}`,
      Author: settings.university_name || 'Multan University of Science & Technology'
    }
  });

  const safeSubject = subject.name.replace(/[^a-zA-Z0-9_-]+/g, '_');
  const filename = `Attendance_${date}_${shift}_${safeSubject}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  doc.pipe(res);

  const pageWidth = doc.page.width;
  const contentWidth = pageWidth - 76;
  const primary = '#0f172a';
  const accentBlue = '#1d4ed8';
  const borderGray = '#cbd5e1';
  const lightBlueBg = '#f0f7ff';
  const lightBlueBorder = '#bfdbfe';

  // --- CENTERED HEADER WITH LOGO (MUST STYLE) ---
  let curY = 28;
  const hasLogo = logoDiskPath && fs.existsSync(logoDiskPath);
  if (hasLogo) {
    try {
      doc.image(logoDiskPath, (pageWidth - 58) / 2, curY, { fit: [58, 38], align: 'center' });
      curY += 42;
    } catch {
      curY += 6;
    }
  }

  doc.fillColor(primary).font('Helvetica-Bold').fontSize(15).text(
    (settings.university_name || 'MULTAN UNIVERSITY OF SCIENCE & TECHNOLOGY').toUpperCase(),
    38,
    curY,
    { width: contentWidth, align: 'center' }
  );
  curY = doc.y + 2;

  doc.fillColor('#334155').font('Helvetica-Bold').fontSize(9.5).text(
    settings.department_name || 'School of Nursing — BS Nursing 7th Semester (Section-B)',
    38,
    curY,
    { width: contentWidth, align: 'center' }
  );
  curY = doc.y + 8;

  // Rounded pill banner
  const pillW = 360;
  const pillX = (pageWidth - pillW) / 2;
  doc.save();
  doc.roundedRect(pillX, curY, pillW, 24, 6).lineWidth(1).fillAndStroke('#ffffff', '#cbd5e1');
  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(10).text(
    'DAILY CLINICAL DUTY ATTENDANCE REPORT — TEACHER COPY',
    pillX,
    curY + 7,
    { width: pillW, align: 'center' }
  );
  doc.restore();
  curY += 34;

  // --- LIGHT BLUE METADATA BAR ---
  doc.save();
  doc.roundedRect(38, curY, contentWidth, 54, 6).lineWidth(0.9).fillAndStroke(lightBlueBg, lightBlueBorder);
  doc.restore();

  const col1X = 50;
  const col2X = 310;
  const shiftLabel = shift.charAt(0).toUpperCase() + shift.slice(1) + ' Shift';
  const subjectLabel = subject.name || 'Clinical Duty';

  doc.fontSize(9);
  doc.fillColor('#475569').font('Helvetica').text('Date: ', col1X, curY + 9, { continued: true });
  doc.fillColor(accentBlue).font('Helvetica-Bold').text(date);

  doc.fillColor('#475569').font('Helvetica').text('Shift: ', col2X, curY + 9, { continued: true });
  doc.fillColor(accentBlue).font('Helvetica-Bold').text(shiftLabel);

  doc.fillColor('#475569').font('Helvetica').text('Placement / Duty: ', col1X, curY + 23, { continued: true });
  doc.fillColor('#0f766e').font('Helvetica-Bold').text(subjectLabel, { width: 175, ellipsis: true });

  doc.fillColor('#475569').font('Helvetica').text('Faculty: ', col2X, curY + 23, { continued: true });
  doc.fillColor(primary).font('Helvetica-Bold').text(subject.teacher_name || '—', { width: 170, ellipsis: true });

  doc.fillColor('#475569').font('Helvetica').text('Class Info: ', col1X, curY + 37, { continued: true });
  doc.fillColor(primary).font('Helvetica-Bold').text(settings.class_name || '—', { width: 205, ellipsis: true });

  doc.fillColor('#475569').font('Helvetica').text('Marked By: ', col2X, curY + 37, { continued: true });
  doc.fillColor(primary).font('Helvetica-Bold').text(
    `${markedByName || 'CR'}${session?.time_slot ? ' (' + session.time_slot + ')' : ''}`
  );

  curY += 64;

  // --- 4 SUMMARY CARDS ---
  const cardGap = 8;
  const cardW = (contentWidth - cardGap * 3) / 4;
  const presentPct = totalStudents > 0 ? Math.round((presentStudents.length / totalStudents) * 100) : 0;

  const cards = [
    { label: 'Total Students', value: String(totalStudents), bg: '#f8fafc', fg: '#1d4ed8', border: '#bfdbfe' },
    { label: 'Present', value: `${presentStudents.length} (${presentPct}%)`, bg: '#f0fdf4', fg: '#047857', border: '#bbf7d0' },
    { label: 'Absent', value: String(absentStudents.length), bg: '#fef2f2', fg: '#b91c1c', border: '#fecaca' },
    { label: 'Policy Requirement', value: '100% Compulsory', bg: '#fffbeb', fg: '#b45309', border: '#fde68a', small: true }
  ];

  cards.forEach((c, idx) => {
    const cx = 38 + idx * (cardW + cardGap);
    doc.save();
    doc.roundedRect(cx, curY, cardW, 40, 6).lineWidth(0.9).fillAndStroke(c.bg, c.border);
    doc.fillColor('#475569').font('Helvetica').fontSize(7.5).text(c.label, cx + 6, curY + 7, { width: cardW - 12, align: 'center' });
    doc.fillColor(c.fg).font('Helvetica-Bold').fontSize(c.small ? 9.5 : 12.5).text(c.value, cx + 6, curY + 19, {
      width: cardW - 12,
      align: 'center'
    });
    doc.restore();
  });

  curY += 52;

  // --- STUDENT TABLES WITH WARD COLUMN ---
  function drawSection(title, students, headerBg, statusText, statusColor, emptyMsg) {
    if (curY > doc.page.height - 105) {
      doc.addPage();
      curY = 38;
    }

    doc.save();
    doc.rect(38, curY, contentWidth, 20).fill(headerBg);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9.5).text(`${title} (${students.length})`, 46, curY + 5);
    doc.restore();
    curY += 21;

    if (students.length === 0) {
      doc.save();
      doc.rect(38, curY, contentWidth, 22).lineWidth(0.5).strokeColor(borderGray).stroke();
      doc.fillColor('#475569').font('Helvetica-Oblique').fontSize(9).text(emptyMsg, 46, curY + 6);
      doc.restore();
      curY += 30;
      return;
    }

    const rowH = 18;
    const colSr = 38;
    const colRoll = 70;
    const colName = 200;
    const colWard = 395;
    const colStatus = 480;

    function drawTableHeader() {
      doc.save();
      doc.rect(38, curY, contentWidth, rowH).fill('#e2e8f0');
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(8.2);
      doc.text('Sr.', colSr + 6, curY + 5, { width: 26 });
      doc.text('Roll No', colRoll + 6, curY + 5, { width: 120 });
      doc.text('Student Name', colName + 6, curY + 5, { width: 185 });
      doc.text('Ward', colWard + 6, curY + 5, { width: 80 });
      doc.text('Status', colStatus + 6, curY + 5, { width: 68 });
      doc.restore();
      curY += rowH;
    }

    drawTableHeader();

    students.forEach((st, i) => {
      if (curY > doc.page.height - 55) {
        doc.addPage();
        curY = 38;
        drawTableHeader();
      }

      const bg = i % 2 === 0 ? '#ffffff' : '#f8fafc';
      doc.save();
      doc.rect(38, curY, contentWidth, rowH).fill(bg);
      doc.rect(38, curY, contentWidth, rowH).lineWidth(0.4).strokeColor(borderGray).stroke();
      doc.fillColor('#0f172a').font('Helvetica').fontSize(8.5);
      doc.text(String(i + 1), colSr + 6, curY + 5, { width: 26 });
      doc.font('Helvetica-Bold').text(st.roll_no, colRoll + 6, curY + 5, { width: 120 });
      doc.font('Helvetica').text(st.name, colName + 6, curY + 5, { width: 185, ellipsis: true });
      doc.fillColor('#334155').text(st.ward || '—', colWard + 6, curY + 5, { width: 80, ellipsis: true });
      doc.fillColor(statusColor).font('Helvetica-Bold').text(statusText, colStatus + 6, curY + 5, { width: 68 });
      doc.restore();
      curY += rowH;
    });

    curY += 12;
  }

  drawSection(
    'ABSENT STUDENTS',
    absentStudents,
    '#991b1b',
    'ABSENT',
    '#b91c1c',
    'No students were absent — 100% attendance!'
  );

  drawSection(
    'PRESENT STUDENTS',
    presentStudents,
    '#065f46',
    'PRESENT',
    '#047857',
    'No students marked present.'
  );

  if (session?.remarks) {
    if (curY > doc.page.height - 75) {
      doc.addPage();
      curY = 38;
    }
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(8.8).text('Remarks: ', 38, curY, { continued: true });
    doc.font('Helvetica').text(session.remarks);
    curY = doc.y + 12;
  }

  if (curY > doc.page.height - 60) {
    doc.addPage();
    curY = 38;
  }

  const footY = Math.max(curY + 8, doc.page.height - 62);
  doc.save();
  doc.moveTo(38, footY).lineTo(38 + contentWidth, footY).lineWidth(0.5).strokeColor(borderGray).stroke();
  doc.fillColor('#64748b').font('Helvetica').fontSize(7.8).text(
    `Generated on ${new Date().toLocaleString()} • ${settings.department_name || 'School of Nursing'}`,
    38,
    footY + 8
  );
  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(8.5).text(
    'CR Signature: ______________________',
    38,
    footY + 8,
    { width: contentWidth, align: 'right' }
  );
  doc.fillColor('#64748b').font('Helvetica').fontSize(7.5).text(
    'Developed & Designed by AR BROTHERS',
    38,
    footY + 22,
    { width: contentWidth, align: 'center' }
  );
  doc.restore();

  doc.end();
}

module.exports = { generateAttendancePDF };
