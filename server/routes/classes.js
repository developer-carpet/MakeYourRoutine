const express = require('express');
const db = require('../db');
const { DEFAULT_DRAW_CONFIG } = require('../utils');
const router = express.Router();

router.get('/', async (req, res) => {
  const rows = await db.prepare(`SELECT id, name, created_at FROM classes ORDER BY created_at DESC`).all();
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { name, teacher_pin } = req.body;
  if (!name || !teacher_pin) return res.status(400).json({ error: 'name, teacher_pin 필요' });
  const dup = await db.prepare(`SELECT 1 FROM classes WHERE name = ?`).get(name);
  if (dup) return res.status(409).json({ error: '이미 같은 이름의 학급이 있어요. 기존 학급 목록에서 로그인해주세요.' });
  const info = await db.prepare(`INSERT INTO classes (name, teacher_pin) VALUES (?, ?)`).run(name, teacher_pin);
  res.json({ id: info.lastInsertRowid, name });
});

router.post('/:id/login', async (req, res) => {
  const { teacher_pin } = req.body;
  const cls = await db.prepare(`SELECT * FROM classes WHERE id = ?`).get(req.params.id);
  if (!cls || cls.teacher_pin !== teacher_pin) return res.status(401).json({ error: '비밀번호가 틀렸습니다' });
  res.json({ id: cls.id, name: cls.name });
});

router.get('/:id', async (req, res) => {
  const cls = await db.prepare(`SELECT id, name, goal_gauge_target, reward_text, draw_config_json, praise_weight, concern_weight, daily_star_enabled, daily_star_threshold, auto_close_time, xp_target, xp_decay_enabled, xp_decay_misses, xp_decay_amount, created_at FROM classes WHERE id = ?`).get(req.params.id);
  if (!cls) return res.status(404).json({ error: 'not found' });
  const draw_config = cls.draw_config_json ? JSON.parse(cls.draw_config_json) : DEFAULT_DRAW_CONFIG;
  delete cls.draw_config_json;
  res.json({ ...cls, draw_config });
});

router.put('/:id', async (req, res) => {
  const { goal_gauge_target, reward_text, draw_config, praise_weight, concern_weight, daily_star_enabled, daily_star_threshold, auto_close_time, xp_target, xp_decay_enabled, xp_decay_misses, xp_decay_amount, current_pin, new_pin } = req.body;
  let newPinValue;
  if (new_pin !== undefined) {
    if (!current_pin || !new_pin) return res.status(400).json({ error: '현재 비밀번호와 새 비밀번호를 입력해주세요' });
    const cls = await db.prepare(`SELECT teacher_pin FROM classes WHERE id = ?`).get(req.params.id);
    if (!cls) return res.status(404).json({ error: 'not found' });
    if (cls.teacher_pin !== current_pin) return res.status(401).json({ error: '현재 비밀번호가 일치하지 않습니다' });
    newPinValue = new_pin;
  }
  let drawConfigJson;
  if (draw_config) {
    const badNumbers = (draw_config.badNumbers || []).map(Number).filter(n => Number.isFinite(n));
    const lowNumbers = (draw_config.lowNumbers || []).map(Number).filter(n => Number.isFinite(n));
    const highNumbers = (draw_config.highNumbers || []).map(Number).filter(n => Number.isFinite(n));
    if (!lowNumbers.length || !highNumbers.length) {
      return res.status(400).json({ error: '보통 숫자와 특별한 숫자를 하나 이상 입력해주세요' });
    }
    drawConfigJson = JSON.stringify({
      badNumbers,
      badThreshold: Number(draw_config.badThreshold),
      lowNumbers,
      highNumbers,
      threshold: Number(draw_config.threshold),
      minChance: Number(draw_config.minChance),
      maxChance: Number(draw_config.maxChance)
    });
  }
  if (praise_weight !== undefined && praise_weight !== null && (typeof praise_weight !== 'number' || praise_weight < 0)) {
    return res.status(400).json({ error: '칭찬 가중치는 0 이상의 숫자여야 해요' });
  }
  if (concern_weight !== undefined && concern_weight !== null && (typeof concern_weight !== 'number' || concern_weight < 0)) {
    return res.status(400).json({ error: '아쉬움 가중치는 0 이상의 숫자여야 해요' });
  }
  if (daily_star_threshold !== undefined && daily_star_threshold !== null && (typeof daily_star_threshold !== 'number' || daily_star_threshold <= 0 || daily_star_threshold > 1)) {
    return res.status(400).json({ error: '개인 별 지급 기준은 1~100% 사이여야 해요' });
  }
  // 자동 마감 스케줄러(netlify.toml)가 KST 14:00~20:45에만 돌기 때문에, 마감 시각도 이 범위 안에서만 허용한다.
  // 범위를 벗어나면 그 시각에 스케줄러가 없어 마감이 다음날로 밀린다.
  if (auto_close_time !== undefined && !/^(1[4-9]|20):(00|15|30|45)$/.test(auto_close_time)) {
    return res.status(400).json({ error: '자동 마감 시간은 오후 2시~8시 45분 사이에서 15분 단위로 지정해주세요' });
  }
  if (xp_target !== undefined && (!Number.isInteger(xp_target) || xp_target < 5 || xp_target > 200)) {
    return res.status(400).json({ error: '레벨 목표는 5~200 사이의 정수여야 해요' });
  }
  if (xp_decay_misses !== undefined && (!Number.isInteger(xp_decay_misses) || xp_decay_misses < 2 || xp_decay_misses > 20)) {
    return res.status(400).json({ error: '경험치 차감 기준은 2~20회 사이여야 해요' });
  }
  if (xp_decay_amount !== undefined && (!Number.isInteger(xp_decay_amount) || xp_decay_amount < 1 || xp_decay_amount > 10)) {
    return res.status(400).json({ error: '경험치 차감량은 1~10 사이여야 해요' });
  }
  await db.prepare(
    `UPDATE classes SET
       goal_gauge_target = COALESCE(?, goal_gauge_target),
       reward_text = COALESCE(?, reward_text),
       draw_config_json = COALESCE(?, draw_config_json),
       praise_weight = COALESCE(?, praise_weight),
       concern_weight = COALESCE(?, concern_weight),
       daily_star_enabled = COALESCE(?, daily_star_enabled),
       daily_star_threshold = COALESCE(?, daily_star_threshold),
       auto_close_time = COALESCE(?, auto_close_time),
       xp_target = COALESCE(?, xp_target),
       xp_decay_enabled = COALESCE(?, xp_decay_enabled),
       xp_decay_misses = COALESCE(?, xp_decay_misses),
       xp_decay_amount = COALESCE(?, xp_decay_amount),
       teacher_pin = COALESCE(?, teacher_pin)
     WHERE id = ?`
  ).run(goal_gauge_target ?? null, reward_text ?? null, drawConfigJson ?? null, praise_weight ?? null, concern_weight ?? null,
    daily_star_enabled === undefined ? null : (daily_star_enabled ? 1 : 0), daily_star_threshold ?? null,
    auto_close_time ?? null, xp_target ?? null, xp_decay_enabled === undefined ? null : (xp_decay_enabled ? 1 : 0),
    xp_decay_misses ?? null, xp_decay_amount ?? null, newPinValue ?? null, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
