const express = require('express');
const db = require('../db');
const { todayStr, dowOf, addDays, isPastDeadline, isBeforeStart } = require('../utils');
const { loadStudentGrowthOverview, loadUnseenGrowthAdjustments, finalizeDueClasses } = require('../reward-service');
const router = express.Router();

async function activeRoutinesFor(classId, studentId, date) {
  const dow = dowOf(date);
  const rows = await db.prepare(
    `SELECT * FROM routines WHERE class_id = ? AND active = 1 AND (student_id IS NULL OR student_id = ?)
     AND id NOT IN (SELECT routine_id FROM routine_exclusions WHERE student_id = ?)`
  ).all(classId, studentId, studentId);
  return rows.filter(r => {
    if (r.task_date) return r.task_date === date;
    return r.days_of_week && r.days_of_week.split(',').map(Number).includes(dow);
  });
}

async function ensureCheckRow(routineId, studentId, date, carriedOver) {
  const row = await db.prepare(`SELECT * FROM routine_checks WHERE routine_id = ? AND student_id = ? AND date = ?`)
    .get(routineId, studentId, date);
  if (row) return row;
  await db.prepare(`INSERT INTO routine_checks (routine_id, student_id, date, carried_over) VALUES (?, ?, ?, ?)`)
    .run(routineId, studentId, date, carriedOver ? 1 : 0);
  return db.prepare(`SELECT * FROM routine_checks WHERE routine_id = ? AND student_id = ? AND date = ?`)
    .get(routineId, studentId, date);
}

// routineIds 전체에 대해 한 번의 SELECT + (필요시) 한 번의 INSERT로 체크 행을 준비 (N+1 회피)
async function ensureCheckRowsBatch(routineIds, studentId, date, carriedOver) {
  const map = new Map();
  if (!routineIds.length) return map;

  const placeholders = routineIds.map(() => '?').join(',');
  const existing = await db.prepare(
    `SELECT * FROM routine_checks WHERE student_id = ? AND date = ? AND routine_id IN (${placeholders})`
  ).all(studentId, date, ...routineIds);
  existing.forEach(c => map.set(c.routine_id, c));

  const missing = routineIds.filter(id => !map.has(id));
  if (missing.length) {
    const values = missing.map(() => '(?, ?, ?, ?)').join(', ');
    const params = [];
    missing.forEach(id => params.push(id, studentId, date, carriedOver ? 1 : 0));
    await db.prepare(`INSERT INTO routine_checks (routine_id, student_id, date, carried_over) VALUES ${values}`).run(...params);
    missing.forEach(id => map.set(id, {
      routine_id: id, student_id: Number(studentId), date,
      count: 0, completed: 0, completed_at: null,
      carried_over: carriedOver ? 1 : 0, reflection_emoji: null, reflection_text: null
    }));
  }
  return map;
}

// 전날 미완료 루틴을 오늘로 이월
async function carryOverRoutines(classId, studentId, date, scheduledIds) {
  const yesterday = addDays(date, -1);
  const missed = await db.prepare(
    `SELECT rc.* FROM routine_checks rc
     JOIN routines r ON r.id = rc.routine_id
     WHERE rc.student_id = ? AND rc.date = ? AND rc.completed = 0 AND r.active = 1 AND r.class_id = ?
     AND r.task_date IS NULL
     AND r.id NOT IN (SELECT routine_id FROM routine_exclusions WHERE student_id = ?)`
  ).all(studentId, yesterday, classId, studentId);

  const candidateIds = [...new Set(missed.map(mc => mc.routine_id).filter(id => !scheduledIds.has(id)))];
  if (!candidateIds.length) return [];

  const placeholders = candidateIds.map(() => '?').join(',');
  // 루틴 정보 조회와 체크 행 준비를 병렬 실행
  const [routines, checkMap] = await Promise.all([
    db.prepare(`SELECT * FROM routines WHERE id IN (${placeholders})`).all(...candidateIds),
    ensureCheckRowsBatch(candidateIds, studentId, date, true)
  ]);
  const routineMap = new Map(routines.map(r => [r.id, r]));

  return candidateIds
    .filter(id => routineMap.has(id))
    .map(id => ({ ...routineMap.get(id), check: checkMap.get(id) }));
}

async function buildTodayState(classId, studentId) {
  const date = todayStr();
  const routines = await activeRoutinesFor(classId, studentId, date);
  const scheduledIds = new Set(routines.map(r => r.id));

  // 체크 상태 준비와 이월 루틴 조회를 병렬 실행
  const [checkMap, carriedRows, closure] = await Promise.all([
    ensureCheckRowsBatch(routines.map(r => r.id), studentId, date, false),
    carryOverRoutines(classId, studentId, date, scheduledIds),
    db.prepare(`SELECT 1 FROM daily_growth_closures WHERE class_id=? AND date=?`).get(classId, date)
  ]);
  const scheduled = routines.map(r => ({
    ...r, check: checkMap.get(r.id), carried_over: false,
    not_started: isBeforeStart(r.start_time),
    locked: !!closure || isPastDeadline(r.deadline_time) || isBeforeStart(r.start_time)
  }));

  const carried = carriedRows.map(r => ({
    ...r, carried_over: true,
    not_started: isBeforeStart(r.start_time),
    locked: !!closure || isPastDeadline(r.deadline_time) || isBeforeStart(r.start_time)
  }));

  const result = [...scheduled, ...carried].sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
  return { date, routines: result, finalized: !!closure };
}

// 오늘 학생의 루틴 + 체크 상태
router.get('/today', async (req, res) => {
  res.json(await buildTodayState(req.query.class_id, req.query.student_id));
});

// 로그인 시 한 번만 가져오는 학생 통합 상태. 상점 상태는 키오스크 진입 때 별도로 확인한다.
router.get('/student-state', async (req, res) => {
  const student = await db.prepare(`SELECT id,class_id,nickname,number,points FROM students WHERE id=?`).get(req.query.student_id);
  if (!student) return res.status(404).json({ error: '학생을 찾을 수 없어요' });
  await finalizeDueClasses(student.class_id);
  const [today, growthRows, encouragements, unseenAdjustments] = await Promise.all([
    buildTodayState(student.class_id, student.id),
    loadStudentGrowthOverview(student.class_id),
    db.prepare(`SELECT * FROM encouragements WHERE to_student_id=? AND read_at IS NULL ORDER BY created_at DESC LIMIT 10`).all(student.id),
    loadUnseenGrowthAdjustments(student.id)
  ]);
  res.json({
    student,
    ...today,
    growth: growthRows.find(row => row.student_id === Number(student.id)) || null,
    encouragements,
    unseen_adjustments: unseenAdjustments
  });
});

// 체크 toggle/증가
router.post('/toggle', async (req, res) => {
  const { routine_id, student_id } = req.body;
  const date = todayStr();
  const yesterday = addDays(date, -1);

  // 읽기 3건을 한 번의 왕복으로 처리 (원격 DB 지연 누적 방지)
  const [routineRes, checkRes, streakRes, studentRes, closureRes] = await db.batch([
    { sql: `SELECT * FROM routines WHERE id = ?`, params: [routine_id] },
    { sql: `SELECT * FROM routine_checks WHERE routine_id = ? AND student_id = ? AND date = ?`, params: [routine_id, student_id, date] },
    { sql: `SELECT * FROM streaks WHERE student_id = ? AND routine_id = ?`, params: [student_id, routine_id] },
    { sql: `SELECT points FROM students WHERE id = ?`, params: [student_id] },
    { sql: `SELECT 1 FROM daily_growth_closures dgc JOIN students s ON s.class_id=dgc.class_id WHERE s.id=? AND dgc.date=?`, params: [student_id, date] }
  ]);

  if (closureRes.rows[0]) return res.status(409).json({ error: '오늘 성장이 이미 마감되어 수정할 수 없어요' });

  const routine = routineRes.rows[0];
  if (!routine) return res.status(404).json({ error: 'routine not found' });
  if (isBeforeStart(routine.start_time)) {
    return res.status(403).json({ error: `시작 시간(${routine.start_time}) 이전에는 체크할 수 없어요` });
  }
  if (isPastDeadline(routine.deadline_time)) {
    return res.status(403).json({ error: `마감 시간(${routine.deadline_time})이 지나서 체크할 수 없어요` });
  }

  const existingCheck = checkRes.rows[0];
  const prevCompleted = existingCheck ? existingCheck.completed : 0;
  const prevCount = existingCheck ? existingCheck.count : 0;

  let count, completed;
  if (prevCompleted) {
    count = 0;
    completed = 0;
  } else {
    count = Math.min(prevCount + 1, routine.target_count);
    completed = count >= routine.target_count ? 1 : 0;
  }
  const completedAt = completed ? new Date().toISOString() : null;

  let pointsDelta = 0;
  if (completed === 1 && !prevCompleted) pointsDelta = 1;
  else if (completed === 0 && prevCompleted) pointsDelta = -1;

  const currentPoints = studentRes.rows[0] ? studentRes.rows[0].points : 0;
  const newPoints = Math.max(currentPoints + pointsDelta, 0);

  const writes = [{
    sql: `INSERT INTO routine_checks (routine_id, student_id, date, count, completed, completed_at, carried_over)
          VALUES (?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT(routine_id, student_id, date)
          DO UPDATE SET count = excluded.count, completed = excluded.completed, completed_at = excluded.completed_at`,
    params: [routine_id, student_id, date, count, completed, completedAt]
  }];

  if (pointsDelta !== 0) {
    writes.push({ sql: `UPDATE students SET points = ? WHERE id = ?`, params: [newPoints, student_id] });
  }

  if (completed === 1) {
    const streakRow = streakRes.rows[0];
    if (!streakRow) {
      writes.push({
        sql: `INSERT INTO streaks (student_id, routine_id, current_streak, best_streak, last_completed_date) VALUES (?, ?, 1, 1, ?)`,
        params: [student_id, routine_id, date]
      });
    } else if (streakRow.last_completed_date !== date) {
      const newStreak = streakRow.last_completed_date === yesterday ? streakRow.current_streak + 1 : 1;
      const best = Math.max(newStreak, streakRow.best_streak);
      writes.push({
        sql: `UPDATE streaks SET current_streak = ?, best_streak = ?, last_completed_date = ? WHERE student_id = ? AND routine_id = ?`,
        params: [newStreak, best, date, student_id, routine_id]
      });
    }
  }

  // 쓰기도 한 번의 왕복으로 처리
  await db.batch(writes);

  res.json({ count, completed: !!completed, target_count: routine.target_count, points: newPoints });
});

// 학생 화면의 여러 선반응 결과를 절대 상태로 한 번에 저장한다.
// toggle 명령이 아니라 최종 count를 보내므로 네트워크 재시도에도 상태가 뒤집히지 않는다.
router.post('/sync', async (req, res) => {
  const events = Array.isArray(req.body.events) ? req.body.events.slice(0, 50) : [];
  if (!events.length) return res.json({ states: [] });
  const studentId = Number(events[0].student_id);
  if (!studentId || events.some(event => Number(event.student_id) !== studentId)) {
    return res.status(400).json({ error: '한 학생의 완료 기록만 함께 저장할 수 있어요' });
  }
  const date = todayStr();
  const routineIds = [...new Set(events.map(event => Number(event.routine_id)).filter(Number.isFinite))];
  if (!routineIds.length) return res.status(400).json({ error: '저장할 루틴이 없어요' });
  const placeholders = routineIds.map(() => '?').join(',');
  const [studentRes, routineRes, checkRes, streakRes, closureRes] = await db.batch([
    { sql: `SELECT id,class_id,points FROM students WHERE id=?`, params: [studentId] },
    { sql: `SELECT * FROM routines WHERE id IN (${placeholders})`, params: routineIds },
    { sql: `SELECT * FROM routine_checks WHERE student_id=? AND date=? AND routine_id IN (${placeholders})`, params: [studentId, date, ...routineIds] },
    { sql: `SELECT * FROM streaks WHERE student_id=? AND routine_id IN (${placeholders})`, params: [studentId, ...routineIds] },
    { sql: `SELECT 1 FROM daily_growth_closures dgc JOIN students s ON s.class_id=dgc.class_id WHERE s.id=? AND dgc.date=?`, params: [studentId, date] }
  ]);
  const student = studentRes.rows[0];
  if (!student) return res.status(404).json({ error: '학생을 찾을 수 없어요' });
  if (closureRes.rows[0]) return res.status(409).json({ error: '오늘 성장이 이미 마감되어 수정할 수 없어요' });

  const routineMap = new Map(routineRes.rows.map(routine => [Number(routine.id), routine]));
  const checkMap = new Map(checkRes.rows.map(check => [Number(check.routine_id), check]));
  const streakMap = new Map(streakRes.rows.map(streak => [Number(streak.routine_id), streak]));
  const writes = [];
  const states = [];
  let pointsDelta = 0;
  for (const event of events) {
    const routine = routineMap.get(Number(event.routine_id));
    if (!routine || Number(routine.class_id) !== Number(student.class_id) || Number(routine.active) === 0) continue;
    if (routine.student_id != null && Number(routine.student_id) !== studentId) continue;
    if (isBeforeStart(routine.start_time) || isPastDeadline(routine.deadline_time)) continue;
    const previous = checkMap.get(Number(routine.id));
    const previousCompleted = !!previous?.completed;
    const target = Math.max(1, Number(routine.target_count) || 1);
    const requestedCount = event.completed && event.count == null ? target : Number(event.count || 0);
    const count = Math.max(0, Math.min(target, requestedCount));
    const completed = count >= target;
    if (completed && !previousCompleted) pointsDelta += 1;
    if (!completed && previousCompleted) pointsDelta -= 1;
    writes.push({
      sql: `INSERT INTO routine_checks (routine_id,student_id,date,count,completed,completed_at,carried_over) VALUES (?,?,?,?,?,?,0) ON CONFLICT(routine_id,student_id,date) DO UPDATE SET count=excluded.count,completed=excluded.completed,completed_at=excluded.completed_at`,
      params: [routine.id, studentId, date, count, completed ? 1 : 0, completed ? new Date().toISOString() : null]
    });
    if (completed && !previousCompleted) {
      const streak = streakMap.get(Number(routine.id));
      const yesterday = addDays(date, -1);
      const nextStreak = streak?.last_completed_date === yesterday ? Number(streak.current_streak || 0) + 1 : 1;
      writes.push({
        sql: `INSERT INTO streaks (student_id,routine_id,current_streak,best_streak,last_completed_date) VALUES (?,?,?,?,?) ON CONFLICT(student_id,routine_id) DO UPDATE SET current_streak=excluded.current_streak,best_streak=MAX(streaks.best_streak,excluded.best_streak),last_completed_date=excluded.last_completed_date`,
        params: [studentId, routine.id, nextStreak, Math.max(nextStreak, Number(streak?.best_streak || 0)), date]
      });
    }
    checkMap.set(Number(routine.id), { completed: completed ? 1 : 0, count });
    states.push({ event_id: event.event_id || null, routine_id: Number(routine.id), count, completed, target_count: target });
  }
  if (pointsDelta) writes.push({ sql: `UPDATE students SET points=MAX(points+?,0) WHERE id=?`, params: [pointsDelta, studentId] });
  if (writes.length) await db.batch(writes);
  res.json({ states, points: Math.max(0, Number(student.points || 0) + pointsDelta) });
});

// 결석/등교 안 함 표시 토글 (전자칠판에서): 표시된 날은 루틴 %·게이지 계산에서 제외됨
router.post('/absence', async (req, res) => {
  const { student_id, absent } = req.body;
  const date = req.body.date || todayStr();
  if (absent) {
    await db.prepare(`INSERT INTO student_absences (student_id, date) VALUES (?, ?) ON CONFLICT(student_id, date) DO NOTHING`)
      .run(student_id, date);
  } else {
    await db.prepare(`DELETE FROM student_absences WHERE student_id = ? AND date = ?`).run(student_id, date);
  }
  res.json({ student_id, date, absent: !!absent });
});

// 한 줄 회고
router.post('/reflection', async (req, res) => {
  const { routine_id, student_id, emoji, text } = req.body;
  const date = todayStr();
  const row = await ensureCheckRow(routine_id, student_id, date);
  await db.prepare(`UPDATE routine_checks SET reflection_emoji = ?, reflection_text = ? WHERE id = ?`)
    .run(emoji || null, text || null, row.id);
  res.json({ ok: true });
});

router.get('/streaks', async (req, res) => {
  const { student_id } = req.query;
  const rows = await db.prepare(`SELECT * FROM streaks WHERE student_id = ?`).all(student_id);
  res.json(rows);
});

module.exports = router;
