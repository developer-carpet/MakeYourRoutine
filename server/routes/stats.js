const express = require('express');
const db = require('../db');
const { todayStr, dowOf, rollDrawNumber } = require('../utils');
const { applyDrawToGrowth, finalizeDailyGrowth, campaignToJson } = require('../reward-service');
const router = express.Router();

// 진행 중인 공동 성장 캠페인 1건. 보드/대시보드 응답에 함께 실어 프런트가 별도 요청을 안 하도록 한다.
function activeCampaign(classId) {
  return db.prepare(
    `SELECT * FROM growth_campaigns WHERE class_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`
  ).get(classId).then(campaignToJson);
}

function pickMessageFrom(tiers, classId, rate) {
  for (const t of tiers) {
    if (rate >= t.min_rate && rate <= t.max_rate) return t.message;
  }
  return '';
}

// 학급 전체 활성 루틴을 한 번에 가져와 학생별로 필터링할 수 있게 그룹화
// (해당 학생이 그 루틴에서 제외되어 있으면 exclusionMap을 보고 목록에서 빼버림)
function groupRoutinesByStudent(routines, students, dow, exclusionMap, date) {
  const scheduled = routines.filter(r => {
    if (r.task_date) return r.task_date === date;
    return r.days_of_week && r.days_of_week.split(',').map(Number).includes(dow);
  });
  const common = scheduled.filter(r => r.student_id === null);
  const byStudent = new Map();
  for (const s of students) {
    const personal = scheduled.filter(r => r.student_id === s.id);
    const applicableCommon = common.filter(r => !(exclusionMap.get(r.id) && exclusionMap.get(r.id).has(s.id)));
    byStudent.set(s.id, [...applicableCommon, ...personal]);
  }
  return byStudent;
}

async function loadClassContext(classId, date, dow) {
  const [students, routines, checks, tiers, absences, notes, cls, exclusions, growthRows, closure] = await Promise.all([
    // routine_exempt(루틴을 할 수 없는 학생) 학생은 전자칠판/통계에 전혀 노출되지 않도록 조회 단계에서 제외
    db.prepare(`SELECT id, nickname, number, points, avatar_json FROM students WHERE class_id = ? AND routine_exempt = 0 ORDER BY number ASC`).all(classId),
    db.prepare(`SELECT * FROM routines WHERE class_id = ? AND active = 1`).all(classId),
    db.prepare(
      `SELECT rc.* FROM routine_checks rc
       JOIN students s ON s.id = rc.student_id
       WHERE s.class_id = ? AND rc.date = ?`
    ).all(classId, date),
    db.prepare(
      `SELECT * FROM encouragement_tiers WHERE class_id = ? OR class_id IS NULL ORDER BY (class_id IS NULL) ASC, sort_order ASC`
    ).all(classId),
    db.prepare(
      `SELECT sa.student_id FROM student_absences sa
       JOIN students s ON s.id = sa.student_id
       WHERE s.class_id = ? AND sa.date = ?`
    ).all(classId, date),
    db.prepare(`SELECT type FROM class_notes WHERE class_id = ? AND date = ?`).all(classId, date),
    db.prepare(`SELECT praise_weight, concern_weight, xp_target FROM classes WHERE id = ?`).get(classId),
    db.prepare(
      `SELECT re.routine_id, re.student_id FROM routine_exclusions re
       JOIN routines r ON r.id = re.routine_id
       WHERE r.class_id = ?`
    ).all(classId),
    db.prepare(`SELECT student_id, level, progress_xp, target_xp FROM student_growth WHERE class_id = ?`).all(classId),
    db.prepare(`SELECT date FROM daily_growth_closures WHERE class_id = ? AND date = ?`).get(classId, date)
  ]);

  const exclusionMap = new Map();
  for (const e of exclusions) {
    if (!exclusionMap.has(e.routine_id)) exclusionMap.set(e.routine_id, new Set());
    exclusionMap.get(e.routine_id).add(e.student_id);
  }
  const routinesByStudent = groupRoutinesByStudent(routines, students, dow, exclusionMap, date);
  const checksByStudent = new Map();
  for (const c of checks) {
    if (!checksByStudent.has(c.student_id)) checksByStudent.set(c.student_id, new Map());
    checksByStudent.get(c.student_id).set(c.routine_id, c);
  }
  const absentSet = new Set(absences.map(a => a.student_id));

  // 학급 전체의 오늘 칭찬/아쉬움 횟수 집계 (각 횟수 * 가중치만큼 학급 루틴 %에 +/- 됨)
  const noteCounts = { praise: 0, concern: 0 };
  for (const n of notes) noteCounts[n.type === 'praise' ? 'praise' : 'concern']++;
  const weights = {
    praise: cls && cls.praise_weight != null ? cls.praise_weight : 0.05,
    concern: cls && cls.concern_weight != null ? cls.concern_weight : 0.05
  };

  const growthMap = new Map(growthRows.map(row => [Number(row.student_id), row]));
  return {
    students,
    routinesByStudent,
    checksByStudent,
    tiers,
    absentSet,
    noteCounts,
    weights,
    growthMap,
    growthClosed: !!closure,
    growthTarget: Math.max(1, Number(cls?.xp_target || 25))
  };
}

// 원래 완료율에 그날 학급 전체의 칭찬(+)/아쉬움(-) 횟수 * 가중치를 더해 0~1 사이로 보정
function applyNoteAdjustment(rawRate, noteCounts, weights) {
  const adjusted = rawRate + noteCounts.praise * weights.praise - noteCounts.concern * weights.concern;
  return Math.max(0, Math.min(1, adjusted));
}

// 교사 대시보드: 학급 전체 게이지 + 학생별 완료율 + 메시지
router.get('/board', async (req, res) => {
  res.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=10');
  const classId = req.query.class_id;
  const date = req.query.date || todayStr();
  const dow = dowOf(date);

  const [students, routines, checks, absences, notes, cls, exclusions, campaign] = await Promise.all([
    db.prepare(`SELECT id, nickname, avatar_json FROM students WHERE class_id = ? AND routine_exempt = 0 ORDER BY number ASC`).all(classId),
    db.prepare(`SELECT id, student_id, days_of_week, task_date FROM routines WHERE class_id = ? AND active = 1`).all(classId),
    db.prepare(`SELECT rc.routine_id, rc.student_id, rc.completed FROM routine_checks rc JOIN students s ON s.id = rc.student_id WHERE s.class_id = ? AND rc.date = ?`).all(classId, date),
    db.prepare(`SELECT sa.student_id FROM student_absences sa JOIN students s ON s.id = sa.student_id WHERE s.class_id = ? AND sa.date = ?`).all(classId, date),
    db.prepare(`SELECT type FROM class_notes WHERE class_id = ? AND date = ?`).all(classId, date),
    db.prepare(`SELECT praise_weight, concern_weight, reward_text FROM classes WHERE id = ?`).get(classId),
    db.prepare(`SELECT re.routine_id, re.student_id FROM routine_exclusions re JOIN routines r ON r.id = re.routine_id WHERE r.class_id = ?`).all(classId),
    activeCampaign(classId)
  ]);

  const exclusionMap = new Map();
  for (const e of exclusions) {
    if (!exclusionMap.has(e.routine_id)) exclusionMap.set(e.routine_id, new Set());
    exclusionMap.get(e.routine_id).add(e.student_id);
  }
  const absentSet = new Set(absences.map(a => a.student_id));
  const noteCounts = { praise: 0, concern: 0 };
  for (const n of notes) noteCounts[n.type === 'praise' ? 'praise' : 'concern']++;
  const weights = {
    praise: cls && cls.praise_weight != null ? cls.praise_weight : 0.05,
    concern: cls && cls.concern_weight != null ? cls.concern_weight : 0.05
  };

  const scheduled = routines.filter(r => {
    if (r.task_date) return r.task_date === date;
    return r.days_of_week && r.days_of_week.split(',').map(Number).includes(dow);
  });
  const common = scheduled.filter(r => r.student_id === null);
  const checksByStudent = new Map();
  for (const c of checks) {
    if (!checksByStudent.has(c.student_id)) checksByStudent.set(c.student_id, new Map());
    checksByStudent.get(c.student_id).set(c.routine_id, c);
  }

  let totalRoutines = 0, totalCompleted = 0;
  const studentStats = students.map(s => {
    const personal = scheduled.filter(r => r.student_id === s.id);
    const applicable = common.filter(r => !(exclusionMap.get(r.id) && exclusionMap.get(r.id).has(s.id)));
    const myRoutines = [...applicable, ...personal];
    const checkMap = checksByStudent.get(s.id) || new Map();
    const completedCount = myRoutines.reduce((n, r) => n + (checkMap.get(r.id)?.completed ? 1 : 0), 0);
    const rate = myRoutines.length ? completedCount / myRoutines.length : 0;
    if (!absentSet.has(s.id)) { totalRoutines += myRoutines.length; totalCompleted += completedCount; }
    return { id: s.id, nickname: s.nickname, avatar_json: s.avatar_json ? JSON.parse(s.avatar_json) : null, rate };
  });

  const classRate = applyNoteAdjustment(totalRoutines ? totalCompleted / totalRoutines : 0, noteCounts, weights);
  res.json({ class_rate: classRate, reward_text: cls ? cls.reward_text : null, students: studentStats, growth_campaign: campaign });
});

router.get('/dashboard', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const classId = req.query.class_id;
  const date = req.query.date || todayStr();
  const dow = dowOf(date);

  const [{ students, routinesByStudent, checksByStudent, tiers, absentSet, noteCounts, weights, growthMap, growthClosed, growthTarget }, cls, campaign] = await Promise.all([
    loadClassContext(classId, date, dow),
    db.prepare(`SELECT goal_gauge_target, reward_text FROM classes WHERE id = ?`).get(classId),
    activeCampaign(classId)
  ]);

  let totalRoutines = 0;
  let totalCompleted = 0;

  const studentStats = students.map(s => {
    const isAbsent = absentSet.has(s.id);
    const routines = routinesByStudent.get(s.id) || [];
    const checkMap = checksByStudent.get(s.id) || new Map();

    let completedCount = 0;
    const routineDetail = routines.map(r => {
      const c = checkMap.get(r.id);
      const completed = c ? !!c.completed : false;
      if (completed) completedCount++;
      return {
        routine_id: r.id,
        title: r.title,
        icon: r.icon,
        completed,
        count: c ? c.count : 0,
        target_count: r.target_count
      };
    });

    const rate = routines.length ? completedCount / routines.length : 0;
    // 결석한 학생은 학급 전체 % 집계에서 제외 (개인 게이지는 그대로 보여주되 비활성 표시만 함)
    if (!isAbsent) {
      totalRoutines += routines.length;
      totalCompleted += completedCount;
    }

    const growth = growthMap.get(Number(s.id));
    let growthLevel = Math.max(1, Number(growth?.level || 1));
    let growthProgress = Math.max(0, Number(growth?.progress_xp || 0));
    const growthXpTarget = Math.max(1, Number(growth?.target_xp || growthTarget));
    if (!growthClosed && !isAbsent) {
      growthProgress += completedCount;
      while (growthProgress >= growthXpTarget) {
        growthProgress -= growthXpTarget;
        growthLevel += 1;
      }
    }

    return {
      student_id: s.id,
      nickname: s.nickname,
      number: s.number,
      points: s.points,
      avatar_json: s.avatar_json ? JSON.parse(s.avatar_json) : null,
      rate,
      completed_count: completedCount,
      total_count: routines.length,
      growth_level: growthLevel,
      growth_percent: Math.round(growthProgress / growthXpTarget * 100),
      is_absent: isAbsent,
      message: isAbsent ? '오늘은 결석이에요' : pickMessageFrom(tiers, classId, rate),
      routines: routineDetail
    };
  });

  // 학급 전체 칭찬/아쉬움 기록은 학생 개개인이 아니라 학급 전체 루틴 %에만 반영됨
  const rawClassRate = totalRoutines ? totalCompleted / totalRoutines : 0;
  const classRate = applyNoteAdjustment(rawClassRate, noteCounts, weights);

  res.json({
    date,
    class_rate: classRate,
    class_completed_count: totalCompleted,
    class_total_count: totalRoutines,
    class_note_counts: noteCounts,
    class_note_energy: {
      praise: Math.floor(noteCounts.praise / 3),
      concern: Math.floor(noteCounts.concern / 3),
      net: Math.floor(noteCounts.praise / 3) - Math.floor(noteCounts.concern / 3),
      praise_until_next: (3 - (noteCounts.praise % 3)) % 3 || 3,
      concern_until_next: (3 - (noteCounts.concern % 3)) % 3 || 3
    },
    goal_gauge_target: cls ? cls.goal_gauge_target : 80,
    reward_text: cls ? cls.reward_text : null,
    growth_campaign: campaign,
    students: studentStats
  });
});

// 하루 마감: 오늘(또는 지정 날짜)의 학급 통계를 daily_class_summary에 스냅샷으로 저장
router.post('/day-end', async (req, res) => {
  const classId = req.body.class_id;
  const date = req.body.date || todayStr();
  const dow = dowOf(date);

  const { students, routinesByStudent, checksByStudent, absentSet, noteCounts, weights } = await loadClassContext(classId, date, dow);

  let totalRoutines = 0;
  let totalCompleted = 0;
  let participants = 0;

  for (const s of students) {
    if (absentSet.has(s.id)) continue;
    const routines = routinesByStudent.get(s.id) || [];
    if (!routines.length) continue;
    const checkMap = checksByStudent.get(s.id) || new Map();
    const completedCount = routines.reduce((n, r) => n + (checkMap.get(r.id)?.completed ? 1 : 0), 0);
    totalRoutines += routines.length;
    totalCompleted += completedCount;
    if (completedCount > 0) participants++;
  }

  const completionRate = applyNoteAdjustment(totalRoutines ? totalCompleted / totalRoutines : 0, noteCounts, weights);

  await db.prepare(
    `INSERT INTO daily_class_summary (class_id, date, total_routines, completed_routines, completion_rate, participants)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(class_id, date) DO UPDATE SET
       total_routines = excluded.total_routines,
       completed_routines = excluded.completed_routines,
       completion_rate = excluded.completion_rate,
       participants = excluded.participants`
  ).run(classId, date, totalRoutines, totalCompleted, completionRate, participants);

  const growth = await finalizeDailyGrowth(classId, date);
  res.json({ date, total_routines: totalRoutines, completed_routines: totalCompleted, completion_rate: completionRate, participants, growth });
});

// 전자칠판에서 진행하는 학급 전체 뽑기: 그날 우리 반이 루틴을 한 만큼(완료율)에 비례해 숫자를 뽑음.
// 같은 날 이미 뽑았으면 다시 뽑지 않고 그 결과를 그대로 돌려줌(공정성을 위해 재추첨 방지).
router.post('/class-draw', async (req, res) => {
  const classId = req.body.class_id;
  const date = req.body.date || todayStr();
  const dow = dowOf(date);

  const existing = await db.prepare(`SELECT date, rate, number, tier FROM class_draws WHERE class_id = ? AND date = ?`).get(classId, date);
  if (existing) {
    const growth = await applyDrawToGrowth(classId, date, existing.number);
    return res.json({ ...existing, growth });
  }

  const { students, routinesByStudent, checksByStudent, absentSet, noteCounts, weights } = await loadClassContext(classId, date, dow);
  const cls = await db.prepare(`SELECT draw_config_json FROM classes WHERE id = ?`).get(classId);
  const drawConfig = cls && cls.draw_config_json ? JSON.parse(cls.draw_config_json) : null;

  let totalRoutines = 0;
  let totalCompleted = 0;
  for (const s of students) {
    if (absentSet.has(s.id)) continue;
    const routines = routinesByStudent.get(s.id) || [];
    const checkMap = checksByStudent.get(s.id) || new Map();
    totalRoutines += routines.length;
    totalCompleted += routines.reduce((n, r) => n + (checkMap.get(r.id)?.completed ? 1 : 0), 0);
  }
  const rate = applyNoteAdjustment(totalRoutines ? totalCompleted / totalRoutines : 0, noteCounts, weights);
  const { number, tier } = rollDrawNumber(rate, drawConfig);

  await db.prepare(
    `INSERT INTO class_draws (class_id, date, rate, number, tier) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(class_id, date) DO UPDATE SET rate = excluded.rate, number = excluded.number, tier = excluded.tier`
  ).run(classId, date, rate, number, tier);

  const growth = await applyDrawToGrowth(classId, date, number);
  res.json({ date, rate, number, tier, growth });
});

// 오늘 학급 뽑기 결과 (아직 안 뽑았으면 null)
router.get('/class-draw', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { class_id } = req.query;
  const date = req.query.date || todayStr();
  const row = await db.prepare(`SELECT date, rate, number, tier FROM class_draws WHERE class_id = ? AND date = ?`).get(class_id, date);
  res.json(row || null);
});

// 오늘 학급 뽑기 결과 초기화 (다시 뽑을 수 있게 함)
router.delete('/class-draw', async (req, res) => {
  const { class_id } = req.query;
  const date = req.query.date || todayStr();
  const applied = await db.prepare(
    `SELECT ge.id FROM growth_events ge JOIN class_draws cd ON cd.id=ge.class_draw_id WHERE cd.class_id=? AND cd.date=?`
  ).get(class_id, date);
  if (applied) return res.status(409).json({ error: '이미 공동 성장에 반영된 뽑기는 초기화할 수 없어요' });
  await db.prepare(`DELETE FROM class_draws WHERE class_id = ? AND date = ?`).run(class_id, date);
  res.json({ ok: true });
});

router.get('/weekly', async (req, res) => {
  const classId = req.query.class_id;
  const days = Number(req.query.days || 7);
  const rows = await db.prepare(
    `SELECT date, COUNT(*) as total, SUM(completed) as completed
     FROM routine_checks
     WHERE student_id IN (SELECT id FROM students WHERE class_id = ?)
     GROUP BY date ORDER BY date DESC LIMIT ?`
  ).all(classId, days);
  res.json(rows.reverse());
});

router.get('/csv', async (req, res) => {
  const classId = req.query.class_id;
  const rows = await db.prepare(
    `SELECT s.nickname, s.number, r.title, rc.date, rc.completed, rc.count
     FROM routine_checks rc
     JOIN students s ON s.id = rc.student_id
     JOIN routines r ON r.id = rc.routine_id
     WHERE s.class_id = ?
     ORDER BY rc.date, s.number`
  ).all(classId);

  let csv = '날짜,번호,닉네임,루틴,완료여부,진행수\n';
  for (const r of rows) {
    csv += `${r.date},${r.number || ''},${r.nickname},${r.title},${r.completed ? '완료' : '미완료'},${r.count}\n`;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="routine_export.csv"');
  res.send('﻿' + csv);
});

module.exports = router;
