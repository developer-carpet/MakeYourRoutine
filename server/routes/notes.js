const express = require('express');
const db = require('../db');
const { todayStr, addDays } = require('../utils');
const { syncNoteGrowth } = require('../reward-service');
const router = express.Router();

// 학급 전체 칭찬/아쉬움 기록 목록 (최근 N일, 통계 화면에서 수정/삭제용으로도 사용)
router.get('/', async (req, res) => {
  const { class_id } = req.query;
  const days = Number(req.query.days || 14);
  const since = addDays(todayStr(), -(days - 1));
  const rows = await db.prepare(
    `SELECT * FROM class_notes WHERE class_id = ? AND date >= ? ORDER BY date DESC, created_at DESC`
  ).all(class_id, since);
  res.json(rows);
});

// 칭찬/아쉬움 기록 추가: 루틴 % 가중치와 3회당 공동 성장 에너지 ±1에 함께 반영됨
router.post('/', async (req, res) => {
  const { class_id, type, text } = req.body;
  const date = req.body.date || todayStr();
  if (!class_id || !['praise', 'concern'].includes(type)) {
    return res.status(400).json({ error: 'class_id, type(praise 또는 concern)이 필요해요' });
  }
  const info = await db.prepare(
    `INSERT INTO class_notes (class_id, date, type, text) VALUES (?, ?, ?, ?)`
  ).run(class_id, date, type, text || null);
  const growth = await syncNoteGrowth(class_id, date);
  res.json({ id: info.lastInsertRowid, class_id, date, type, text: text || null, growth });
});

router.put('/:id', async (req, res) => {
  const { type, text } = req.body;
  if (type && !['praise', 'concern'].includes(type)) {
    return res.status(400).json({ error: 'type은 praise 또는 concern이어야 해요' });
  }
  const existing = await db.prepare(`SELECT * FROM class_notes WHERE id=?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: '기록을 찾을 수 없어요' });
  await db.prepare(
    `UPDATE class_notes SET
       type = COALESCE(?, type),
       text = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(type || null, text ?? null, req.params.id);
  res.json({ ok: true, growth: await syncNoteGrowth(existing.class_id, existing.date) });
});

router.delete('/:id', async (req, res) => {
  const existing = await db.prepare(`SELECT * FROM class_notes WHERE id=?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: '기록을 찾을 수 없어요' });
  await db.prepare(`DELETE FROM class_notes WHERE id = ?`).run(req.params.id);
  res.json({ ok: true, growth: await syncNoteGrowth(existing.class_id, existing.date) });
});

module.exports = router;
