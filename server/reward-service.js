const db = require('./db');
const { todayStr, dowOf, addDays, nowHM, normalizeDrawConfig } = require('./utils');

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; }
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function normalizeMilestones(value, previous = [], preserveSourceStatus = true) {
  const previousById = new Map((previous || []).map(item => [String(item.id), item]));
  const seen = new Set();
  return (Array.isArray(value) ? value : []).map((item, index) => {
    const source = typeof item === 'number' ? { percent: item } : (item || {});
    const percent = Math.round(Number(source.percent ?? source.value));
    if (!Number.isFinite(percent) || percent <= 0 || percent >= 100 || seen.has(percent)) return null;
    seen.add(percent);
    const id = String(source.id || `milestone-${percent}-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    const previousItem = previousById.get(id);
    return {
      id,
      percent,
      reward_text: String(source.reward_text ?? source.reward ?? `${percent}% 중간 보상`).trim().slice(0, 200),
      rewarded_at: previousItem?.rewarded_at || (preserveSourceStatus ? source.rewarded_at : null) || null
    };
  }).filter(Boolean).sort((a, b) => a.percent - b.percent).slice(0, 8);
}

function dateRangeDays(startDate, endDate, weekdays, excludedDates = []) {
  const allowed = new Set((weekdays || [1, 2, 3, 4, 5]).map(Number));
  const excluded = new Set(excludedDates || []);
  let count = 0;
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    if (allowed.has(cursor.getUTCDay()) && !excluded.has(date)) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

function weightedMean(numbers, bias) {
  if (!numbers.length) return 0;
  let weighted = 0;
  let total = 0;
  numbers.forEach((number, index) => {
    const weight = 1 + bias * index;
    weighted += Number(number) * weight;
    total += weight;
  });
  return total ? weighted / total : 0;
}

function expectedDrawValue(config, referenceRate = 0.8) {
  const cfg = normalizeDrawConfig(config);
  const rate = clamp01(referenceRate);
  if (cfg.badNumbers.length && rate < cfg.badThreshold) {
    const howBad = (cfg.badThreshold - rate) / Math.max(cfg.badThreshold, 0.0001);
    return Math.max(0, weightedMean(cfg.badNumbers, howBad));
  }
  const lowMean = weightedMean(cfg.lowNumbers, rate);
  if (rate < cfg.threshold) return Math.max(0, lowMean);
  const bonus = (rate - cfg.threshold) / Math.max(1 - cfg.threshold, 0.0001);
  const highChance = cfg.minChance + bonus * (cfg.maxChance - cfg.minChance);
  const highMean = weightedMean(cfg.highNumbers, bonus);
  return Math.max(0, lowMean * (1 - highChance) + highMean * highChance);
}

function previewCampaign({ start_date, end_date, weekdays, excluded_dates, difficulty, draw_config }) {
  const eligibleDays = dateRangeDays(start_date, end_date, weekdays, excluded_dates);
  const expectedDaily = expectedDrawValue(draw_config, 0.8);
  const factors = { easy: 0.75, normal: 0.9, challenge: 1.05 };
  const factor = factors[difficulty] || factors.normal;
  return {
    eligible_days: eligibleDays,
    expected_daily: Math.round(expectedDaily * 10) / 10,
    recommended_target: Math.max(1, Math.round(eligibleDays * expectedDaily * factor))
  };
}

function campaignToJson(row) {
  if (!row) return null;
  return {
    ...row,
    weekdays: parseJson(row.weekdays_json, [1, 2, 3, 4, 5]),
    excluded_dates: parseJson(row.excluded_dates_json, []),
    milestones: normalizeMilestones(parseJson(row.milestones_json, []))
  };
}

function isCampaignDate(campaign, date) {
  if (!campaign || date < campaign.start_date || date > campaign.end_date) return false;
  const weekdays = parseJson(campaign.weekdays_json, [1, 2, 3, 4, 5]);
  const excluded = parseJson(campaign.excluded_dates_json, []);
  return weekdays.includes(dowOf(date)) && !excluded.includes(date);
}

// 그날 칭찬/아쉬움 3회 묶음을 공동 성장 에너지 ±1로 맞춘다.
// 현재 기록에서 기대되는 값과 원장 값을 비교하므로 추가·수정·삭제와 재시도 모두 중복 없이 처리된다.
async function syncNoteGrowth(classId, date = todayStr()) {
  const [campaign, counts] = await Promise.all([
    db.prepare(`SELECT * FROM growth_campaigns WHERE class_id=? AND status='active' ORDER BY id DESC LIMIT 1`).get(classId),
    db.prepare(`SELECT type,COUNT(*) AS count FROM class_notes WHERE class_id=? AND date=? GROUP BY type`).all(classId, date)
  ]);
  const praiseCount = Number(counts.find(row => row.type === 'praise')?.count || 0);
  const concernCount = Number(counts.find(row => row.type === 'concern')?.count || 0);
  const praiseEnergy = Math.floor(praiseCount / 3);
  const concernEnergy = Math.floor(concernCount / 3);
  const desiredContribution = praiseEnergy - concernEnergy;
  const base = { praise_count: praiseCount, concern_count: concernCount, praise_energy: praiseEnergy, concern_energy: concernEnergy, desired_contribution: desiredContribution };
  if (!campaign || !isCampaignDate(campaign, date)) return { ...base, applied_delta: 0, campaign: campaignToJson(campaign) };

  const sourceKey = `class-notes:${campaign.id}:${date}`;
  const previousEvent = await db.prepare(`SELECT * FROM growth_events WHERE source_key=?`).get(sourceKey);
  const previousContribution = Number(previousEvent?.points || 0);
  const requestedDelta = desiredContribution - previousContribution;
  const previousPoints = Number(campaign.current_points || 0);
  const nextPoints = Math.max(0, Math.min(Number(campaign.target_points), previousPoints + requestedDelta));
  const appliedDelta = nextPoints - previousPoints;
  const storedContribution = previousContribution + appliedDelta;
  const reason = `칭찬 ${praiseCount}회(+${praiseEnergy}) · 아쉬움 ${concernCount}회(-${concernEnergy})`;
  const writes = [];
  if (previousEvent) {
    writes.push({ sql: `UPDATE growth_events SET points=?,reason=? WHERE id=?`, params: [storedContribution, reason, previousEvent.id] });
  } else if (storedContribution !== 0) {
    writes.push({ sql: `INSERT INTO growth_events (campaign_id,points,type,event_date,source_key,reason) VALUES (?,?,'class_note',?,?,?)`, params: [campaign.id, storedContribution, date, sourceKey, reason] });
  }
  if (appliedDelta !== 0) {
    writes.push({
      sql: `UPDATE growth_campaigns SET current_points=?,completed_at=CASE WHEN ?>=target_points THEN COALESCE(completed_at,datetime('now')) ELSE NULL END WHERE id=?`,
      params: [nextPoints, nextPoints, campaign.id]
    });
  }
  if (writes.length) await db.batch(writes);
  const updated = appliedDelta !== 0 ? await db.prepare(`SELECT * FROM growth_campaigns WHERE id=?`).get(campaign.id) : campaign;
  return { ...base, previous_contribution: previousContribution, contribution: storedContribution, applied_delta: appliedDelta, campaign: campaignToJson(updated) };
}

async function applyDrawToGrowth(classId, date, drawNumber) {
  const campaign = await db.prepare(
    `SELECT * FROM growth_campaigns WHERE class_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`
  ).get(classId);
  if (!campaign || !isCampaignDate(campaign, date)) return null;

  const draw = await db.prepare(`SELECT id FROM class_draws WHERE class_id = ? AND date = ?`).get(classId, date);
  if (!draw) return null;
  const previous = Number(campaign.current_points || 0);
  const points = Math.max(0, Number(drawNumber) || 0);
  const inserted = await db.prepare(
    `INSERT INTO growth_events (campaign_id, class_draw_id, points, type, reason)
     VALUES (?, ?, ?, 'draw', ?)
     ON CONFLICT(class_draw_id) DO NOTHING`
  ).run(campaign.id, draw.id, points, `오늘의 뽑기 ${drawNumber}`);

  if (inserted.changes) {
    const next = Math.min(Number(campaign.target_points), previous + points);
    await db.prepare(
      `UPDATE growth_campaigns
       SET current_points = ?, completed_at = CASE WHEN ? >= target_points THEN COALESCE(completed_at, datetime('now')) ELSE completed_at END
       WHERE id = ?`
    ).run(next, next, campaign.id);
  }

  let updated = await db.prepare(`SELECT * FROM growth_campaigns WHERE id = ?`).get(campaign.id);
  // 0점에서 먼저 발생한 아쉬움도 뽑기로 에너지가 생기면 즉시 반영되도록 다시 맞춘다.
  const noteGrowth = await syncNoteGrowth(classId, date);
  if (noteGrowth.campaign) updated = noteGrowth.campaign;
  return {
    campaign: updated.milestones ? updated : campaignToJson(updated),
    points_added: inserted.changes ? points : 0,
    previous_points: previous,
    current_points: Number(updated.current_points),
    completed: Number(updated.current_points) >= Number(updated.target_points),
    note_growth: noteGrowth
  };
}

function scheduledOn(routine, date) {
  if (routine.task_date) return routine.task_date === date;
  return (routine.days_of_week || '').split(',').map(Number).includes(dowOf(date));
}

async function ensureGrowthRows(classId, students, targetXp) {
  if (!students.length) return;
  await db.batch(students.map(student => ({
    sql: `INSERT OR IGNORE INTO student_growth (student_id, class_id, target_xp) VALUES (?, ?, ?)`,
    params: [student.id, classId, targetXp]
  })));
}

function projectGrowth(growth, extraXp, nextTarget) {
  let level = Number(growth.level || 1);
  let progress = Math.max(0, Number(growth.progress_xp || 0) + Number(extraXp || 0));
  let target = Math.max(1, Number(growth.target_xp || nextTarget || 25));
  let levelsGained = 0;
  while (progress >= target) {
    progress -= target;
    level += 1;
    levelsGained += 1;
    target = Math.max(1, Number(nextTarget || target));
  }
  return { level, progress, target, levelsGained, percent: Math.round(progress / target * 100) };
}

async function loadStudentGrowthOverview(classId, date = todayStr()) {
  const [cls, students, routines, checks, exclusions, absences, closure, missRows] = await Promise.all([
    db.prepare(`SELECT xp_target, auto_close_time, xp_decay_enabled, xp_decay_misses, xp_decay_amount FROM classes WHERE id = ?`).get(classId),
    db.prepare(`SELECT id, nickname, number FROM students WHERE class_id = ? AND routine_exempt = 0 ORDER BY number ASC`).all(classId),
    db.prepare(`SELECT id, student_id, days_of_week, task_date, target_count FROM routines WHERE class_id = ? AND active = 1`).all(classId),
    db.prepare(`SELECT rc.routine_id, rc.student_id, rc.count, rc.completed FROM routine_checks rc JOIN students s ON s.id = rc.student_id WHERE s.class_id = ? AND rc.date = ?`).all(classId, date),
    db.prepare(`SELECT re.routine_id, re.student_id FROM routine_exclusions re JOIN routines r ON r.id = re.routine_id WHERE r.class_id = ?`).all(classId),
    db.prepare(`SELECT sa.student_id FROM student_absences sa JOIN students s ON s.id = sa.student_id WHERE s.class_id = ? AND sa.date = ?`).all(classId, date),
    db.prepare(`SELECT * FROM daily_growth_closures WHERE class_id = ? AND date = ?`).get(classId, date),
    db.prepare(`SELECT rms.* FROM routine_miss_state rms JOIN students s ON s.id=rms.student_id WHERE s.class_id=?`).all(classId)
  ]);
  if (!cls) return [];
  const targetXp = Math.max(1, Number(cls.xp_target || 25));
  await ensureGrowthRows(classId, students, targetXp);
  const growthRows = await db.prepare(`SELECT * FROM student_growth WHERE class_id = ?`).all(classId);
  const growthMap = new Map(growthRows.map(row => [Number(row.student_id), row]));
  const scheduled = routines.filter(routine => scheduledOn(routine, date));
  const common = scheduled.filter(routine => routine.student_id === null);
  const checkMap = new Map(checks.map(check => [`${check.student_id}:${check.routine_id}`, check]));
  const excludedSet = new Set(exclusions.map(row => `${row.student_id}:${row.routine_id}`));
  const absentSet = new Set(absences.map(row => Number(row.student_id)));
  const missMap = new Map(missRows.map(row => [`${row.student_id}:${row.routine_id}`, row]));

  return students.map(student => {
    const personal = scheduled.filter(routine => Number(routine.student_id) === Number(student.id));
    const applicable = [...common.filter(routine => !excludedSet.has(`${student.id}:${routine.id}`)), ...personal];
    const completedCount = applicable.filter(routine => checkMap.get(`${student.id}:${routine.id}`)?.completed).length;
    const growth = growthMap.get(Number(student.id));
    const pendingXp = closure || absentSet.has(Number(student.id)) ? 0 : completedCount;
    const projected = projectGrowth(growth, pendingXp, targetXp);
    const warningCount = Number(cls.xp_decay_enabled) === 0 ? 0 : applicable.filter(routine => {
      const misses = Number(missMap.get(`${student.id}:${routine.id}`)?.consecutive_misses || 0);
      return misses >= Math.max(1, Number(cls.xp_decay_misses || 3) - 1) && !checkMap.get(`${student.id}:${routine.id}`)?.completed;
    }).length;
    return {
      student_id: Number(student.id),
      nickname: student.nickname,
      number: student.number,
      level: Number(growth.level),
      progress_xp: Number(growth.progress_xp),
      target_xp: Number(growth.target_xp),
      percent: Math.round(Number(growth.progress_xp) / Math.max(1, Number(growth.target_xp)) * 100),
      projected_level: projected.level,
      projected_progress_xp: projected.progress,
      projected_percent: projected.percent,
      pending_xp: pendingXp,
      tickets: Number(growth.tickets || 0),
      completed_count: completedCount,
      total_count: applicable.length,
      is_absent: absentSet.has(Number(student.id)),
      decay_warning: warningCount > 0,
      decay_warning_count: warningCount,
      finalized: !!closure
    };
  });
}

async function applyGrowthDelta({ classId, studentId, amount, date, type, reason, routineId = null, seenAt = null, reversedEventId = null }) {
  const cls = await db.prepare(`SELECT xp_target FROM classes WHERE id = ?`).get(classId);
  if (!cls) throw new Error('class not found');
  const nextTarget = Math.max(1, Number(cls.xp_target || 25));
  await db.prepare(`INSERT OR IGNORE INTO student_growth (student_id, class_id, target_xp) VALUES (?, ?, ?)`).run(studentId, classId, nextTarget);
  const growth = await db.prepare(`SELECT * FROM student_growth WHERE student_id = ?`).get(studentId);
  const projected = projectGrowth(growth, amount, nextTarget);
  const writes = [{
    sql: `INSERT INTO student_xp_events (class_id, student_id, date, routine_id, amount, type, reason, seen_at, reversed_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [classId, studentId, date, routineId, amount, type, reason || null, seenAt, reversedEventId]
  }, {
    sql: `UPDATE student_growth SET level=?, progress_xp=?, target_xp=?, tickets=tickets+?, updated_at=datetime('now') WHERE student_id=?`,
    params: [projected.level, projected.progress, projected.target, projected.levelsGained, studentId]
  }];
  if (projected.levelsGained) {
    writes.push({
      sql: `INSERT INTO reward_ticket_events (class_id, student_id, date, amount, type, reason) VALUES (?, ?, ?, ?, 'level_up', ?)`,
      params: [classId, studentId, date, projected.levelsGained, `레벨 ${projected.level} 달성`]
    });
  }
  const results = await db.batch(writes);
  return { ...projected, event_id: results[0]?.lastInsertRowid, tickets: Number(growth.tickets || 0) + projected.levelsGained };
}

// 교사가 직접 조정한 성장 별 중 학생이 아직 확인해야 하는 기록만 반환한다.
// 교사가 학생 확인 전에 조정을 되돌렸다면 원본과 되돌림을 모두 숨기고,
// 학생이 원본을 본 뒤 되돌린 경우에만 되돌림 소식을 새로 보여준다.
async function loadUnseenGrowthAdjustments(studentId) {
  return db.prepare(
    `SELECT e.id,e.student_id,e.amount,e.type,e.reason,e.created_at
     FROM student_xp_events e
     WHERE e.student_id=? AND e.seen_at IS NULL AND (
       (e.type IN ('teacher_bonus','teacher_deduction')
        AND NOT EXISTS(SELECT 1 FROM student_xp_events undo WHERE undo.reversed_event_id=e.id))
       OR
       (e.type='teacher_adjustment_undo'
        AND EXISTS(SELECT 1 FROM student_xp_events original WHERE original.id=e.reversed_event_id AND original.seen_at IS NOT NULL))
     )
     ORDER BY e.id ASC LIMIT 20`
  ).all(studentId);
}

async function finalizeDailyGrowth(classId, date = todayStr(), closeTimeOverride) {
  const existing = await db.prepare(`SELECT * FROM daily_growth_closures WHERE class_id = ? AND date = ?`).get(classId, date);
  if (existing) return { already_finalized: true, ...existing };

  const [cls, students, routines, checks, exclusions, absences, missRows, notes, weeklyPenalties] = await Promise.all([
    db.prepare(`SELECT xp_target, auto_close_time, xp_decay_enabled, xp_decay_misses, xp_decay_amount, praise_weight, concern_weight FROM classes WHERE id = ?`).get(classId),
    db.prepare(`SELECT id FROM students WHERE class_id = ? AND routine_exempt = 0`).all(classId),
    db.prepare(`SELECT id, student_id, title, days_of_week, task_date FROM routines WHERE class_id = ? AND active = 1`).all(classId),
    db.prepare(`SELECT rc.routine_id, rc.student_id, rc.completed FROM routine_checks rc JOIN students s ON s.id=rc.student_id WHERE s.class_id=? AND rc.date=?`).all(classId, date),
    db.prepare(`SELECT re.routine_id, re.student_id FROM routine_exclusions re JOIN routines r ON r.id=re.routine_id WHERE r.class_id=?`).all(classId),
    db.prepare(`SELECT sa.student_id FROM student_absences sa JOIN students s ON s.id=sa.student_id WHERE s.class_id=? AND sa.date=?`).all(classId, date),
    db.prepare(`SELECT rms.* FROM routine_miss_state rms JOIN students s ON s.id=rms.student_id WHERE s.class_id=?`).all(classId),
    db.prepare(`SELECT type FROM class_notes WHERE class_id=? AND date=?`).all(classId, date),
    db.prepare(`SELECT student_id,COALESCE(-SUM(amount),0) AS used FROM student_xp_events WHERE class_id=? AND type='inactivity_penalty' AND date BETWEEN ? AND ? GROUP BY student_id`).all(classId, addDays(date, -6), date)
  ]);
  if (!cls) throw new Error('class not found');
  const scheduled = routines.filter(routine => scheduledOn(routine, date));
  const common = scheduled.filter(routine => routine.student_id === null);
  const checkMap = new Map(checks.map(check => [`${check.student_id}:${check.routine_id}`, check]));
  const excludedSet = new Set(exclusions.map(row => `${row.student_id}:${row.routine_id}`));
  const absentSet = new Set(absences.map(row => Number(row.student_id)));
  const missMap = new Map(missRows.map(row => [`${row.student_id}:${row.routine_id}`, row]));
  const classHadActivity = checks.some(check => Number(check.completed) === 1);
  const missLimit = Math.max(1, Number(cls.xp_decay_misses || 3));
  const penaltyAmount = Math.max(1, Number(cls.xp_decay_amount || 1));
  const weeklyPenaltyCap = Math.max(1, Math.floor(Math.max(1, Number(cls.xp_target || 25)) * 0.2));
  const weeklyPenaltyMap = new Map(weeklyPenalties.map(row => [Number(row.student_id), Number(row.used || 0)]));
  const deltas = new Map();
  const events = [];
  const missWrites = [];
  let routinesAwarded = 0;
  let penaltiesApplied = 0;
  let totalRoutines = 0;
  let completedRoutines = 0;
  let participants = 0;

  for (const student of students) {
    if (absentSet.has(Number(student.id))) continue;
    const personal = scheduled.filter(routine => Number(routine.student_id) === Number(student.id));
    const applicable = [...common.filter(routine => !excludedSet.has(`${student.id}:${routine.id}`)), ...personal];
    const studentCompleted = applicable.filter(routine => checkMap.get(`${student.id}:${routine.id}`)?.completed).length;
    totalRoutines += applicable.length;
    completedRoutines += studentCompleted;
    if (studentCompleted > 0) participants += 1;
    for (const routine of applicable) {
      const key = `${student.id}:${routine.id}`;
      const completed = !!checkMap.get(key)?.completed;
      const previousMiss = missMap.get(key);
      if (completed) {
        routinesAwarded += 1;
        deltas.set(student.id, (deltas.get(student.id) || 0) + 1);
        events.push({ studentId: student.id, routineId: routine.id, amount: 1, type: 'routine_complete', reason: `${routine.title} 완료` });
        missWrites.push({ sql: `INSERT INTO routine_miss_state (student_id,routine_id,consecutive_misses,last_processed_date) VALUES (?,?,0,?) ON CONFLICT(student_id,routine_id) DO UPDATE SET consecutive_misses=0,last_processed_date=excluded.last_processed_date`, params: [student.id, routine.id, date] });
      } else if (classHadActivity) {
        const misses = Number(previousMiss?.consecutive_misses || 0) + 1;
        const lastPenalty = previousMiss?.last_penalty_date;
        const weeklyAllowed = !lastPenalty || date >= addDays(lastPenalty, 7);
        const usedThisWeek = weeklyPenaltyMap.get(Number(student.id)) || 0;
        const penalize = Number(cls.xp_decay_enabled) !== 0 && misses % missLimit === 0 && weeklyAllowed && usedThisWeek < weeklyPenaltyCap;
        const appliedPenalty = penalize ? Math.min(penaltyAmount, weeklyPenaltyCap - usedThisWeek) : 0;
        if (appliedPenalty) {
          penaltiesApplied += 1;
          weeklyPenaltyMap.set(Number(student.id), usedThisWeek + appliedPenalty);
          deltas.set(student.id, (deltas.get(student.id) || 0) - appliedPenalty);
          events.push({ studentId: student.id, routineId: routine.id, amount: -appliedPenalty, type: 'inactivity_penalty', reason: `${routine.title} ${misses}회 연속 미완료` });
        }
        missWrites.push({ sql: `INSERT INTO routine_miss_state (student_id,routine_id,consecutive_misses,last_processed_date,last_penalty_date) VALUES (?,?,?,?,?) ON CONFLICT(student_id,routine_id) DO UPDATE SET consecutive_misses=excluded.consecutive_misses,last_processed_date=excluded.last_processed_date,last_penalty_date=COALESCE(excluded.last_penalty_date,routine_miss_state.last_penalty_date)`, params: [student.id, routine.id, misses, date, appliedPenalty ? date : null] });
      }
    }
  }

  const targetXp = Math.max(1, Number(cls.xp_target || 25));
  await ensureGrowthRows(classId, students, targetXp);
  const growthRows = await db.prepare(`SELECT * FROM student_growth WHERE class_id = ?`).all(classId);
  const growthMap = new Map(growthRows.map(row => [Number(row.student_id), row]));
  const writes = [...missWrites];
  let levelsGained = 0;
  for (const event of events) {
    writes.push({
      sql: `INSERT OR IGNORE INTO student_xp_events (class_id,student_id,date,routine_id,amount,type,reason,seen_at) VALUES (?,?,?,?,?,?,?,CASE WHEN ?='routine_complete' THEN datetime('now') ELSE NULL END)`,
      params: [classId, event.studentId, date, event.routineId, event.amount, event.type, event.reason, event.type]
    });
  }
  for (const student of students) {
    const growth = growthMap.get(Number(student.id));
    const projected = projectGrowth(growth, deltas.get(student.id) || 0, targetXp);
    levelsGained += projected.levelsGained;
    writes.push({ sql: `UPDATE student_growth SET level=?,progress_xp=?,target_xp=?,tickets=tickets+?,updated_at=datetime('now') WHERE student_id=?`, params: [projected.level, projected.progress, projected.target, projected.levelsGained, student.id] });
    if (projected.levelsGained) writes.push({ sql: `INSERT INTO reward_ticket_events (class_id,student_id,date,amount,type,reason) VALUES (?,?,?,?, 'level_up',?)`, params: [classId, student.id, date, projected.levelsGained, `레벨 ${projected.level} 달성`] });
  }
  const praiseCount = notes.filter(note => note.type === 'praise').length;
  const concernCount = notes.filter(note => note.type !== 'praise').length;
  const rawRate = totalRoutines ? completedRoutines / totalRoutines : 0;
  const completionRate = Math.max(0, Math.min(1, rawRate + praiseCount * Number(cls.praise_weight ?? 0.05) - concernCount * Number(cls.concern_weight ?? 0.05)));
  writes.push({
    sql: `INSERT INTO daily_class_summary (class_id,date,total_routines,completed_routines,completion_rate,participants) VALUES (?,?,?,?,?,?) ON CONFLICT(class_id,date) DO UPDATE SET total_routines=excluded.total_routines,completed_routines=excluded.completed_routines,completion_rate=excluded.completion_rate,participants=excluded.participants`,
    params: [classId, date, totalRoutines, completedRoutines, completionRate, participants]
  });
  writes.push({ sql: `INSERT INTO daily_growth_closures (class_id,date,close_time,routines_awarded,penalties_applied,levels_gained) VALUES (?,?,?,?,?,?)`, params: [classId, date, closeTimeOverride || cls.auto_close_time || '16:30', routinesAwarded, penaltiesApplied, levelsGained] });
  await db.batch(writes);
  return { date, routines_awarded: routinesAwarded, penalties_applied: penaltiesApplied, levels_gained: levelsGained, total_routines: totalRoutines, completed_routines: completedRoutines, completion_rate: completionRate, participants, already_finalized: false };
}

async function finalizeDueClasses(classId = null) {
  const classes = classId
    ? [await db.prepare(`SELECT id, auto_close_time FROM classes WHERE id=?`).get(classId)].filter(Boolean)
    : await db.prepare(`SELECT id, auto_close_time FROM classes`).all();
  const date = todayStr();
  const yesterday = addDays(date, -1);
  const time = nowHM();
  const closedRows = await db.prepare(`SELECT class_id,date FROM daily_growth_closures WHERE date IN (?,?)`).all(yesterday, date);
  const closedSet = new Set(closedRows.map(row => `${row.class_id}:${row.date}`));
  const results = [];
  for (const cls of classes) {
    const closeTime = cls.auto_close_time || '16:30';
    // 배포 지연이나 일시적인 장애가 있어도 다음 실행에서 전날 마감을 복구한다.
    if (!closedSet.has(`${cls.id}:${yesterday}`)) results.push(await finalizeDailyGrowth(cls.id, yesterday, closeTime));
    if (time >= closeTime && !closedSet.has(`${cls.id}:${date}`)) results.push(await finalizeDailyGrowth(cls.id, date, closeTime));
  }
  return results;
}

module.exports = {
  parseJson,
  campaignToJson,
  normalizeMilestones,
  previewCampaign,
  applyDrawToGrowth,
  syncNoteGrowth,
  loadStudentGrowthOverview,
  loadUnseenGrowthAdjustments,
  applyGrowthDelta,
  finalizeDailyGrowth,
  finalizeDueClasses
};
