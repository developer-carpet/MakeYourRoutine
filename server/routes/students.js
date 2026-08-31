const express = require('express');
const db = require('../db');
const { genCode } = require('../utils');
const router = express.Router();

router.get('/', async (req, res) => {
  const classId = req.query.class_id;
  const rows = await db.prepare(
    `SELECT id, class_id, nickname, number, login_code, points, avatar_json, routine_exempt FROM students WHERE class_id = ? ORDER BY number ASC`
  ).all(classId);
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const row = await db.prepare(
    `SELECT id, class_id, nickname, number, points, avatar_json, routine_exempt FROM students WHERE id = ?`
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

router.put('/:id/avatar', async (req, res) => {
  const { avatar_json } = req.body;
  await db.prepare(`UPDATE students SET avatar_json = ? WHERE id = ?`).run(JSON.stringify(avatar_json || {}), req.params.id);
  res.json({ ok: true });
});

// 루틴을 할 수 없는 학생 예외 처리: 켜두면 전자칠판/통계의 루틴 % 집계에서 완전히 제외됨
router.put('/:id/exempt', async (req, res) => {
  const { routine_exempt } = req.body;
  await db.prepare(`UPDATE students SET routine_exempt = ? WHERE id = ?`).run(routine_exempt ? 1 : 0, req.params.id);
  res.json({ ok: true, routine_exempt: !!routine_exempt });
});

router.post('/', async (req, res) => {
  const { class_id, nickname, number } = req.body;
  if (!class_id || !nickname) return res.status(400).json({ error: 'class_id, nickname 필요' });
  let code;
  if (number) {
    const numberCode = String(number).padStart(4, '0');
    const exists = await db.prepare(`SELECT 1 FROM students WHERE login_code = ?`).get(numberCode);
    if (!exists) code = numberCode;
  }
  if (!code) {
    for (let i = 0; i < 20; i++) {
      code = genCode(4);
      const exists = await db.prepare(`SELECT 1 FROM students WHERE login_code = ?`).get(code);
      if (!exists) break;
    }
  }
  const info = await db.prepare(
    `INSERT INTO students (class_id, nickname, number, login_code) VALUES (?, ?, ?, ?)`
  ).run(class_id, nickname, number || null, code);
  res.json({ id: info.lastInsertRowid, nickname, number, login_code: code });
});

router.put('/bulk/login-codes', async (req, res) => {
  const { updates } = req.body;
  if (!Array.isArray(updates) || !updates.length) return res.status(400).json({ error: 'updates 배열이 필요해요' });
  for (const u of updates) {
    if (!/^\d{4}$/.test(u.login_code || '')) return res.status(400).json({ error: `코드는 숫자 4자리여야 해요 (id: ${u.id})` });
  }
  const codes = updates.map(u => u.login_code);
  if (new Set(codes).size !== codes.length) return res.status(400).json({ error: '입력한 코드 중에 중복된 값이 있어요' });
  for (const u of updates) {
    const dup = await db.prepare(`SELECT 1 FROM students WHERE login_code = ? AND id != ?`).get(u.login_code, u.id);
    if (dup) return res.status(409).json({ error: `이미 다른 학생이 쓰고 있는 코드예요 (id: ${u.id})` });
  }
  for (const u of updates) {
    await db.prepare(`UPDATE students SET login_code = ? WHERE id = ?`).run(u.login_code, u.id);
  }
  res.json({ ok: true, count: updates.length });
});

router.put('/:id', async (req, res) => {
  const { login_code } = req.body;
  if (!login_code) return res.status(400).json({ error: 'login_code 필요' });
  if (!/^\d{4}$/.test(login_code)) return res.status(400).json({ error: '코드는 숫자 4자리여야 해요' });
  const dup = await db.prepare(`SELECT 1 FROM students WHERE login_code = ? AND id != ?`).get(login_code, req.params.id);
  if (dup) return res.status(409).json({ error: '이미 다른 학생이 쓰고 있는 코드예요' });
  await db.prepare(`UPDATE students SET login_code = ? WHERE id = ?`).run(login_code, req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: '올바른 학생 ID가 필요해요' });
  const student = await db.prepare(`SELECT id FROM students WHERE id = ?`).get(id);
  if (!student) return res.status(404).json({ error: '삭제할 학생을 찾을 수 없어요' });

  // 학생 삭제 전에 새 보상 체계까지 포함한 모든 연결 기록을 한 트랜잭션에서 정리한다.
  // 개인 루틴을 참조하는 기록도 먼저 지워 외래 키 오류가 생기지 않게 한다.
  await db.batch([
    { sql: `DELETE FROM star_redemptions WHERE student_id = ?`, params: [id] },
    { sql: `DELETE FROM reward_ticket_events WHERE student_id = ?`, params: [id] },
    { sql: `DELETE FROM student_star_events WHERE student_id = ?`, params: [id] },
    { sql: `DELETE FROM encouragements WHERE to_student_id = ?`, params: [id] },
    { sql: `DELETE FROM student_absences WHERE student_id = ?`, params: [id] },
    { sql: `DELETE FROM routine_exclusions WHERE student_id = ? OR routine_id IN (SELECT id FROM routines WHERE student_id = ?)`, params: [id, id] },
    { sql: `DELETE FROM routine_checks WHERE student_id = ? OR routine_id IN (SELECT id FROM routines WHERE student_id = ?)`, params: [id, id] },
    { sql: `DELETE FROM streaks WHERE student_id = ? OR routine_id IN (SELECT id FROM routines WHERE student_id = ?)`, params: [id, id] },
    { sql: `DELETE FROM routine_miss_state WHERE student_id = ? OR routine_id IN (SELECT id FROM routines WHERE student_id = ?)`, params: [id, id] },
    { sql: `DELETE FROM student_xp_events WHERE student_id = ? OR routine_id IN (SELECT id FROM routines WHERE student_id = ?)`, params: [id, id] },
    { sql: `DELETE FROM student_growth WHERE student_id = ?`, params: [id] },
    { sql: `DELETE FROM routines WHERE student_id = ?`, params: [id] },
    { sql: `DELETE FROM students WHERE id = ?`, params: [id] }
  ]);
  res.json({ ok: true });
});

router.post('/login', async (req, res) => {
  const { login_code } = req.body;
  const student = await db.prepare(`SELECT * FROM students WHERE login_code = ?`).get(login_code);
  if (!student) return res.status(401).json({ error: '코드가 올바르지 않습니다' });
  res.json({ id: student.id, nickname: student.nickname, class_id: student.class_id });
});

module.exports = router;
