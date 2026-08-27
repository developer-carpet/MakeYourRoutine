const express = require('express');
const db = require('../db');
const { todayStr } = require('../utils');
const {
  campaignToJson,
  normalizeMilestones,
  previewCampaign,
  loadStudentGrowthOverview,
  loadUnseenGrowthAdjustments,
  applyGrowthDelta,
  finalizeDailyGrowth,
  finalizeDueClasses,
  syncNoteGrowth
} = require('../reward-service');

const router = express.Router();

async function closeExpiredShop(classId) {
  await db.prepare(
    `UPDATE star_shop_sessions SET status = 'closed', closed_at = datetime('now')
     WHERE class_id = ? AND status = 'open' AND closes_at IS NOT NULL AND closes_at <= datetime('now')`
  ).run(classId);
}

async function ticketBalance(studentId) {
  const row = await db.prepare(`SELECT tickets FROM student_growth WHERE student_id = ?`).get(studentId);
  return Number(row?.tickets || 0);
}

function validatedMilestones(input, previous = []) {
  if (!Array.isArray(input)) throw new Error('중간 보상 목록 형식이 올바르지 않아요');
  if (input.length > 8) throw new Error('중간 보상은 최대 8개까지 만들 수 있어요');
  const percents = input.map(item => Math.round(Number(typeof item === 'number' ? item : item?.percent)));
  if (percents.some(percent => !Number.isFinite(percent) || percent <= 0 || percent >= 100)) throw new Error('중간 보상 시점은 1~99% 사이여야 해요');
  if (new Set(percents).size !== percents.length) throw new Error('같은 퍼센트의 중간 보상을 두 번 만들 수 없어요');
  if (input.some(item => typeof item !== 'number' && !String(item?.reward_text || '').trim())) throw new Error('각 중간 보상의 내용을 입력해주세요');
  return normalizeMilestones(input, previous, false);
}

router.post('/growth/preview', async (req, res) => {
  const cls = await db.prepare(`SELECT draw_config_json FROM classes WHERE id = ?`).get(req.body.class_id);
  const drawConfig = cls?.draw_config_json ? JSON.parse(cls.draw_config_json) : null;
  res.json(previewCampaign({ ...req.body, draw_config: drawConfig }));
});

router.get('/growth/current', async (req, res) => {
  const row = await db.prepare(
    `SELECT * FROM growth_campaigns WHERE class_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`
  ).get(req.query.class_id);
  res.json(campaignToJson(row));
});

router.get('/growth/history', async (req, res) => {
  const rows = await db.prepare(`SELECT * FROM growth_campaigns WHERE class_id = ? ORDER BY id DESC LIMIT 20`).all(req.query.class_id);
  res.json(rows.map(campaignToJson));
});

router.post('/growth/campaigns', async (req, res) => {
  const {
    class_id, name, theme = 'tree', start_date, end_date,
    weekdays = [1, 2, 3, 4, 5], excluded_dates = [], difficulty = 'normal',
    target_points, reward_text, milestones = [], auto_target = true
  } = req.body;
  if (!class_id || !name || !start_date || !end_date) return res.status(400).json({ error: '캠페인 이름과 기간을 입력해주세요' });
  if (end_date < start_date) return res.status(400).json({ error: '종료일은 시작일 이후여야 해요' });
  const active = await db.prepare(`SELECT id FROM growth_campaigns WHERE class_id = ? AND status = 'active'`).get(class_id);
  if (active) return res.status(409).json({ error: '진행 중인 캠페인을 먼저 마무리해주세요' });

  const cls = await db.prepare(`SELECT draw_config_json FROM classes WHERE id = ?`).get(class_id);
  const preview = previewCampaign({
    start_date, end_date, weekdays, excluded_dates, difficulty,
    draw_config: cls?.draw_config_json ? JSON.parse(cls.draw_config_json) : null
  });
  const target = auto_target ? preview.recommended_target : Math.max(1, Number(target_points) || 1);
  let normalizedMilestones;
  try { normalizedMilestones = validatedMilestones(milestones); } catch (error) { return res.status(400).json({ error: error.message }); }
  const info = await db.prepare(
    `INSERT INTO growth_campaigns
      (class_id, name, theme, start_date, end_date, weekdays_json, excluded_dates_json, difficulty, target_points, reward_text, milestones_json, auto_target)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(class_id, name, theme, start_date, end_date, JSON.stringify(weekdays), JSON.stringify(excluded_dates), difficulty, target, reward_text || null, JSON.stringify(normalizedMilestones), auto_target ? 1 : 0);
  const noteGrowth = await syncNoteGrowth(class_id, todayStr());
  const row = noteGrowth.campaign || campaignToJson(await db.prepare(`SELECT * FROM growth_campaigns WHERE id = ?`).get(info.lastInsertRowid));
  res.json({ ...row, preview });
});

router.put('/growth/campaigns/:id', async (req, res) => {
  const current = await db.prepare(`SELECT * FROM growth_campaigns WHERE id = ?`).get(req.params.id);
  if (!current) return res.status(404).json({ error: '캠페인을 찾을 수 없어요' });
  const previousMilestones = normalizeMilestones(JSON.parse(current.milestones_json || '[]'));
  let nextMilestones = previousMilestones;
  if (req.body.milestones !== undefined) {
    try { nextMilestones = validatedMilestones(req.body.milestones, previousMilestones); } catch (error) { return res.status(400).json({ error: error.message }); }
    for (const previous of previousMilestones.filter(item => item.rewarded_at)) {
      const saved = nextMilestones.find(item => item.id === previous.id);
      if (!saved) return res.status(400).json({ error: '이미 지급한 중간 보상은 삭제할 수 없어요' });
      saved.percent = previous.percent;
      saved.reward_text = previous.reward_text;
      saved.rewarded_at = previous.rewarded_at;
    }
  }
  const next = {
    name: req.body.name ?? current.name,
    theme: req.body.theme ?? current.theme,
    start_date: req.body.start_date ?? current.start_date,
    end_date: req.body.end_date ?? current.end_date,
    weekdays: req.body.weekdays ?? JSON.parse(current.weekdays_json),
    excluded_dates: req.body.excluded_dates ?? JSON.parse(current.excluded_dates_json),
    difficulty: req.body.difficulty ?? current.difficulty,
    reward_text: req.body.reward_text ?? current.reward_text,
    milestones: nextMilestones,
    auto_target: req.body.auto_target ?? !!current.auto_target
  };
  const cls = await db.prepare(`SELECT draw_config_json FROM classes WHERE id = ?`).get(current.class_id);
  const preview = previewCampaign({ ...next, draw_config: cls?.draw_config_json ? JSON.parse(cls.draw_config_json) : null });
  const target = next.auto_target ? preview.recommended_target : Math.max(Number(current.current_points), Number(req.body.target_points || current.target_points));
  await db.prepare(
    `UPDATE growth_campaigns SET name=?, theme=?, start_date=?, end_date=?, weekdays_json=?, excluded_dates_json=?, difficulty=?, target_points=?, reward_text=?, milestones_json=?, auto_target=?,
       completed_at=CASE WHEN current_points >= ? THEN COALESCE(completed_at, datetime('now')) ELSE NULL END WHERE id=?`
  ).run(next.name, next.theme, next.start_date, next.end_date, JSON.stringify(next.weekdays), JSON.stringify(next.excluded_dates), next.difficulty, Math.max(target, Number(current.current_points)), next.reward_text, JSON.stringify(next.milestones), next.auto_target ? 1 : 0, Math.max(target, Number(current.current_points)), current.id);
  const noteGrowth = await syncNoteGrowth(current.class_id, todayStr());
  res.json(noteGrowth.campaign || campaignToJson(await db.prepare(`SELECT * FROM growth_campaigns WHERE id = ?`).get(current.id)));
});

router.post('/growth/campaigns/:id/rewarded', async (req, res) => {
  const campaign = await db.prepare(`SELECT * FROM growth_campaigns WHERE id = ?`).get(req.params.id);
  if (!campaign) return res.status(404).json({ error: '캠페인을 찾을 수 없어요' });
  if (Number(campaign.current_points) < Number(campaign.target_points)) return res.status(400).json({ error: '아직 목표를 달성하지 못했어요' });
  await db.prepare(`UPDATE growth_campaigns SET status='rewarded', rewarded_at=datetime('now') WHERE id=?`).run(campaign.id);
  res.json({ ok: true });
});

router.post('/growth/campaigns/:id/milestones/:milestoneId/rewarded', async (req, res) => {
  const campaign = await db.prepare(`SELECT * FROM growth_campaigns WHERE id=?`).get(req.params.id);
  if (!campaign) return res.status(404).json({ error: '캠페인을 찾을 수 없어요' });
  const milestones = normalizeMilestones(JSON.parse(campaign.milestones_json || '[]'));
  const milestone = milestones.find(item => item.id === req.params.milestoneId);
  if (!milestone) return res.status(404).json({ error: '중간 보상을 찾을 수 없어요' });
  const percent = Number(campaign.target_points) ? Number(campaign.current_points) / Number(campaign.target_points) * 100 : 0;
  if (percent < milestone.percent) return res.status(400).json({ error: `아직 ${milestone.percent}% 중간 보상에 도달하지 못했어요` });
  if (!milestone.rewarded_at) milestone.rewarded_at = new Date().toISOString();
  await db.prepare(`UPDATE growth_campaigns SET milestones_json=? WHERE id=?`).run(JSON.stringify(milestones), campaign.id);
  res.json(campaignToJson(await db.prepare(`SELECT * FROM growth_campaigns WHERE id=?`).get(campaign.id)));
});

router.post('/growth/campaigns/:id/archive', async (req, res) => {
  await db.prepare(`UPDATE growth_campaigns SET status='archived' WHERE id=? AND status='active'`).run(req.params.id);
  res.json({ ok: true });
});

router.get('/progress/students', async (req, res) => {
  await finalizeDueClasses(req.query.class_id);
  res.json(await loadStudentGrowthOverview(req.query.class_id, req.query.date || todayStr()));
});

router.post('/progress/finalize', async (req, res) => {
  res.json(await finalizeDailyGrowth(req.body.class_id, req.body.date || todayStr()));
});

router.post('/progress/grant', async (req, res) => {
  const { class_id, student_id, amount, reason } = req.body;
  const requested = Number(amount);
  const cleanReason = String(reason || '').trim().slice(0, 80);
  if (!class_id || !student_id || !cleanReason) return res.status(400).json({ error: '학생, 조정할 별 개수, 이유가 필요해요' });
  if (!Number.isInteger(requested) || requested === 0 || Math.abs(requested) > 3) {
    return res.status(400).json({ error: '별은 한 번에 1~3개까지 추가하거나 차감할 수 있어요' });
  }
  const student = await db.prepare(`SELECT id FROM students WHERE id=? AND class_id=?`).get(student_id, class_id);
  if (!student) return res.status(404).json({ error: '이 학급의 학생을 찾을 수 없어요' });

  let value = requested;
  if (requested < 0) {
    const growth = await db.prepare(`SELECT progress_xp FROM student_growth WHERE student_id=? AND class_id=?`).get(student_id, class_id);
    const available = Math.max(0, Number(growth?.progress_xp || 0));
    value = -Math.min(Math.abs(requested), available);
    if (!value) return res.status(400).json({ error: '현재 차감할 수 있는 확정 성장 게이지가 없어요' });
  }

  const result = await applyGrowthDelta({
    classId: class_id,
    studentId: student_id,
    amount: value,
    date: todayStr(),
    type: value > 0 ? 'teacher_bonus' : 'teacher_deduction',
    reason: cleanReason
  });
  res.json({ ...result, requested_amount: requested, applied_amount: value });
});

router.get('/progress/adjustments', async (req, res) => {
  if (!req.query.class_id) return res.status(400).json({ error: '학급 정보가 필요해요' });
  const rows = await db.prepare(
    `SELECT e.id,e.student_id,e.amount,e.type,e.reason,e.created_at,s.nickname,
       CASE WHEN EXISTS(SELECT 1 FROM student_xp_events u WHERE u.reversed_event_id=e.id) THEN 1 ELSE 0 END AS reversed
     FROM student_xp_events e
     JOIN students s ON s.id=e.student_id
     WHERE e.class_id=? AND e.type IN ('teacher_bonus','teacher_deduction')
     ORDER BY e.id DESC LIMIT 30`
  ).all(req.query.class_id);
  res.json(rows.map(row => ({ ...row, reversed: !!row.reversed })));
});

router.post('/progress/adjustments/:id/undo', async (req, res) => {
  const classId = req.body.class_id;
  const original = await db.prepare(
    `SELECT e.*,s.nickname FROM student_xp_events e JOIN students s ON s.id=e.student_id
     WHERE e.id=? AND e.class_id=? AND e.type IN ('teacher_bonus','teacher_deduction')`
  ).get(req.params.id, classId);
  if (!original) return res.status(404).json({ error: '되돌릴 별 조정 기록을 찾을 수 없어요' });
  const alreadyUndone = await db.prepare(`SELECT id FROM student_xp_events WHERE reversed_event_id=?`).get(original.id);
  if (alreadyUndone) return res.status(409).json({ error: '이미 되돌린 별 조정이에요' });

  let value = -Number(original.amount);
  if (value < 0) {
    const growth = await db.prepare(`SELECT progress_xp FROM student_growth WHERE student_id=? AND class_id=?`).get(original.student_id, classId);
    value = -Math.min(Math.abs(value), Math.max(0, Number(growth?.progress_xp || 0)));
    if (!value) return res.status(409).json({ error: '획득한 휘장과 보상권을 보호하기 위해 현재 단계에서 더 되돌릴 수 없어요' });
  }

  const result = await applyGrowthDelta({
    classId,
    studentId: original.student_id,
    amount: value,
    date: todayStr(),
    type: 'teacher_adjustment_undo',
    reason: `교사 조정 되돌림 · ${original.reason || '사유 없음'}`,
    reversedEventId: Number(original.id)
  });
  res.json({ ...result, applied_amount: value, original_event_id: Number(original.id) });
});

router.get('/progress/student', async (req, res) => {
  const student = await db.prepare(`SELECT id, class_id, nickname FROM students WHERE id = ?`).get(req.query.student_id);
  if (!student) return res.status(404).json({ error: '학생을 찾을 수 없어요' });
  await finalizeDueClasses(student.class_id);
  const [events, overview, unseen] = await Promise.all([
    db.prepare(`SELECT * FROM student_xp_events WHERE student_id = ? ORDER BY id DESC LIMIT 50`).all(student.id),
    loadStudentGrowthOverview(student.class_id, req.query.date || todayStr()),
    loadUnseenGrowthAdjustments(student.id)
  ]);
  const growth = overview.find(row => row.student_id === Number(student.id)) || null;
  res.json({
    student,
    tickets: growth?.tickets || 0,
    unseen,
    events,
    growth
  });
});

router.post('/progress/seen', async (req, res) => {
  const ids = Array.isArray(req.body.event_ids) ? req.body.event_ids.map(Number).filter(Number.isFinite) : [];
  if (!ids.length) return res.json({ ok: true });
  const placeholders = ids.map(() => '?').join(',');
  await db.prepare(`UPDATE student_xp_events SET seen_at = datetime('now') WHERE student_id = ? AND id IN (${placeholders})`).run(req.body.student_id, ...ids);
  res.json({ ok: true });
});

router.get('/progress/closure', async (req, res) => {
  await finalizeDueClasses(req.query.class_id);
  const closure = await db.prepare(`SELECT * FROM daily_growth_closures WHERE class_id=? AND date=?`).get(req.query.class_id, req.query.date || todayStr());
  res.json({ finalized: !!closure, closure: closure || null });
});

router.get('/shop/items', async (req, res) => {
  const rows = await db.prepare(`SELECT * FROM star_shop_items WHERE class_id = ? ORDER BY sort_order, id`).all(req.query.class_id);
  res.json(rows);
});

router.post('/shop/items', async (req, res) => {
  const { class_id, name, cost, stock } = req.body;
  if (!name || Number(cost) < 1) return res.status(400).json({ error: '상품 이름과 1장 이상의 보상권 가격이 필요해요' });
  const info = await db.prepare(`INSERT INTO star_shop_items (class_id, name, cost, stock) VALUES (?, ?, ?, ?)`).run(class_id, name, Number(cost), stock === '' || stock == null ? null : Math.max(0, Number(stock)));
  res.json({ id: info.lastInsertRowid });
});

router.put('/shop/items/:id', async (req, res) => {
  const item = await db.prepare(`SELECT * FROM star_shop_items WHERE id = ?`).get(req.params.id);
  if (!item) return res.status(404).json({ error: '상품을 찾을 수 없어요' });
  await db.prepare(`UPDATE star_shop_items SET name=?, cost=?, stock=?, active=? WHERE id=?`).run(
    req.body.name ?? item.name,
    Math.max(1, Number(req.body.cost ?? item.cost)),
    req.body.stock === '' ? null : (req.body.stock ?? item.stock),
    req.body.active === undefined ? item.active : (req.body.active ? 1 : 0),
    item.id
  );
  res.json({ ok: true });
});

router.delete('/shop/items/:id', async (req, res) => {
  await db.prepare(`UPDATE star_shop_items SET active=0 WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

router.get('/shop/status', async (req, res) => {
  await closeExpiredShop(req.query.class_id);
  const session = await db.prepare(`SELECT * FROM star_shop_sessions WHERE class_id = ? AND status='open' ORDER BY id DESC LIMIT 1`).get(req.query.class_id);
  const items = session ? await db.prepare(`SELECT * FROM star_shop_items WHERE class_id = ? AND active=1 AND (stock IS NULL OR stock > 0) ORDER BY sort_order, id`).all(req.query.class_id) : [];
  res.json({ open: !!session, session: session || null, items });
});

router.post('/shop/open', async (req, res) => {
  const duration = Math.max(1, Math.min(180, Number(req.body.duration_minutes) || 20));
  await db.prepare(`UPDATE star_shop_sessions SET status='closed', closed_at=datetime('now') WHERE class_id=? AND status='open'`).run(req.body.class_id);
  const info = await db.prepare(
    `INSERT INTO star_shop_sessions (class_id, status, closes_at) VALUES (?, 'open', datetime('now', ?))`
  ).run(req.body.class_id, `+${duration} minutes`);
  res.json({ id: info.lastInsertRowid, duration_minutes: duration });
});

router.post('/shop/close', async (req, res) => {
  await db.prepare(`UPDATE star_shop_sessions SET status='closed', closed_at=datetime('now') WHERE class_id=? AND status='open'`).run(req.body.class_id);
  res.json({ ok: true });
});

router.post('/shop/redeem', async (req, res) => {
  const student = await db.prepare(`SELECT id, class_id FROM students WHERE id=?`).get(req.body.student_id);
  const item = await db.prepare(`SELECT * FROM star_shop_items WHERE id=? AND active=1`).get(req.body.item_id);
  if (!student || !item || Number(item.class_id) !== Number(student.class_id)) return res.status(404).json({ error: '상품을 찾을 수 없어요' });
  await closeExpiredShop(student.class_id);
  const session = await db.prepare(`SELECT * FROM star_shop_sessions WHERE class_id=? AND status='open' ORDER BY id DESC LIMIT 1`).get(student.class_id);
  if (!session) return res.status(403).json({ error: '보상 상점이 닫혀 있어요' });
  if (item.stock != null && Number(item.stock) <= 0) return res.status(409).json({ error: '상품 재고가 없어요' });
  if (await ticketBalance(student.id) < Number(item.cost)) return res.status(400).json({ error: '보상권이 부족해요' });
  const pending = await db.prepare(`SELECT id FROM star_redemptions WHERE session_id=? AND student_id=? AND item_id=? AND status='pending'`).get(session.id, student.id, item.id);
  if (pending) return res.status(409).json({ error: '이미 승인을 기다리고 있어요' });
  const info = await db.prepare(`INSERT INTO star_redemptions (session_id, item_id, student_id, cost) VALUES (?, ?, ?, ?)`).run(session.id, item.id, student.id, item.cost);
  res.json({ id: info.lastInsertRowid, status: 'pending' });
});

router.get('/shop/redemptions', async (req, res) => {
  const rows = await db.prepare(
    `SELECT sr.*, s.nickname, i.name AS item_name
     FROM star_redemptions sr JOIN star_shop_sessions ss ON ss.id=sr.session_id
     JOIN students s ON s.id=sr.student_id JOIN star_shop_items i ON i.id=sr.item_id
     WHERE ss.class_id=? AND (? IS NULL OR sr.status=?) ORDER BY sr.id DESC LIMIT 100`
  ).all(req.query.class_id, req.query.status || null, req.query.status || null);
  res.json(rows);
});

router.post('/shop/redemptions/:id/approve', async (req, res) => {
  const row = await db.prepare(
    `SELECT sr.*, ss.class_id, i.stock, i.name AS item_name FROM star_redemptions sr
     JOIN star_shop_sessions ss ON ss.id=sr.session_id JOIN star_shop_items i ON i.id=sr.item_id WHERE sr.id=?`
  ).get(req.params.id);
  if (!row || row.status !== 'pending') return res.status(409).json({ error: '처리할 수 없는 요청이에요' });
  if (await ticketBalance(row.student_id) < Number(row.cost)) return res.status(400).json({ error: '학생의 보상권이 부족해요' });
  if (row.stock != null && Number(row.stock) <= 0) return res.status(409).json({ error: '상품 재고가 없어요' });
  const writes = [
    { sql: `UPDATE star_redemptions SET status='approved', approved_at=datetime('now') WHERE id=? AND status='pending'`, params: [row.id] },
    { sql: `UPDATE student_growth SET tickets=tickets-?,updated_at=datetime('now') WHERE student_id=? AND tickets>=?`, params: [Number(row.cost), row.student_id, Number(row.cost)] },
    { sql: `INSERT INTO reward_ticket_events (class_id, student_id, date, amount, type, reason) VALUES (?, ?, ?, ?, 'spend', ?)`, params: [row.class_id, row.student_id, todayStr(), -Number(row.cost), `${row.item_name} 교환`] }
  ];
  if (row.stock != null) writes.push({ sql: `UPDATE star_shop_items SET stock=stock-1 WHERE id=? AND stock>0`, params: [row.item_id] });
  await db.batch(writes);
  res.json({ ok: true, tickets: await ticketBalance(row.student_id) });
});

router.post('/shop/redemptions/:id/reject', async (req, res) => {
  await db.prepare(`UPDATE star_redemptions SET status='rejected', rejected_at=datetime('now') WHERE id=? AND status='pending'`).run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
