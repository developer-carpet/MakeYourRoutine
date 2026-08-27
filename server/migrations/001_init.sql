CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  teacher_pin TEXT NOT NULL,
  goal_gauge_target REAL DEFAULT 80,
  reward_text TEXT,
  auto_close_time TEXT DEFAULT '16:30',
  xp_target INTEGER DEFAULT 25,
  xp_decay_enabled INTEGER DEFAULT 1,
  xp_decay_misses INTEGER DEFAULT 3,
  xp_decay_amount INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  nickname TEXT NOT NULL,
  number INTEGER,
  login_code TEXT UNIQUE NOT NULL,
  avatar_json TEXT,
  points INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  student_id INTEGER REFERENCES students(id),
  title TEXT NOT NULL,
  icon TEXT DEFAULT '✅',
  time_slot TEXT DEFAULT '하루',
  days_of_week TEXT DEFAULT '0,1,2,3,4,5,6',
  target_count INTEGER DEFAULT 1,
  start_time TEXT,
  deadline_time TEXT,
  active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS routine_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id INTEGER NOT NULL REFERENCES routines(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  date TEXT NOT NULL,
  count INTEGER DEFAULT 0,
  completed INTEGER DEFAULT 0,
  completed_at TEXT,
  carried_over INTEGER DEFAULT 0,
  reflection_emoji TEXT,
  reflection_text TEXT,
  UNIQUE(routine_id, student_id, date)
);

CREATE TABLE IF NOT EXISTS streaks (
  student_id INTEGER NOT NULL,
  routine_id INTEGER,
  current_streak INTEGER DEFAULT 0,
  best_streak INTEGER DEFAULT 0,
  last_completed_date TEXT,
  PRIMARY KEY (student_id, routine_id)
);

CREATE TABLE IF NOT EXISTS encouragements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL,
  from_role TEXT,
  from_id INTEGER,
  to_student_id INTEGER NOT NULL,
  message TEXT,
  emoji TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  read_at TEXT
);

CREATE TABLE IF NOT EXISTS encouragement_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER,
  min_rate REAL NOT NULL,
  max_rate REAL NOT NULL,
  message TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS class_draws (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  date TEXT NOT NULL,
  rate REAL,
  number INTEGER,
  tier TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(class_id, date)
);

CREATE TABLE IF NOT EXISTS routine_exclusions (
  routine_id INTEGER NOT NULL REFERENCES routines(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  PRIMARY KEY (routine_id, student_id)
);

CREATE TABLE IF NOT EXISTS class_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS student_absences (
  student_id INTEGER NOT NULL REFERENCES students(id),
  date TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (student_id, date)
);

CREATE TABLE IF NOT EXISTS daily_class_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  total_routines INTEGER,
  completed_routines INTEGER,
  completion_rate REAL,
  participants INTEGER,
  UNIQUE(class_id, date)
);

-- 기간을 정해 운영하는 학급 공동 성장 캠페인
CREATE TABLE IF NOT EXISTS growth_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  name TEXT NOT NULL,
  theme TEXT NOT NULL DEFAULT 'tree',
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  weekdays_json TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
  excluded_dates_json TEXT NOT NULL DEFAULT '[]',
  difficulty TEXT NOT NULL DEFAULT 'normal',
  target_points INTEGER NOT NULL,
  current_points INTEGER NOT NULL DEFAULT 0,
  reward_text TEXT,
  milestones_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  auto_target INTEGER NOT NULL DEFAULT 1,
  completed_at TEXT,
  rewarded_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_one_active
ON growth_campaigns(class_id) WHERE status = 'active';

-- 한 번의 뽑기가 성장에 두 번 반영되지 않도록 원장으로 기록
CREATE TABLE IF NOT EXISTS growth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES growth_campaigns(id),
  class_draw_id INTEGER REFERENCES class_draws(id),
  points INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'draw',
  event_date TEXT,
  source_key TEXT,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(class_draw_id)
);

-- 보상 별 지급/사용 원장
CREATE TABLE IF NOT EXISTS student_star_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  type TEXT NOT NULL,
  reason TEXT,
  seen_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_star_unique
ON student_star_events(student_id, date, type) WHERE type = 'daily_goal';

-- 별은 즉시 경험치로 바뀌고, 학생에게는 퍼센트 성장 바로 보인다.
CREATE TABLE IF NOT EXISTS student_growth (
  student_id INTEGER PRIMARY KEY REFERENCES students(id),
  class_id INTEGER NOT NULL REFERENCES classes(id),
  level INTEGER NOT NULL DEFAULT 1,
  progress_xp INTEGER NOT NULL DEFAULT 0,
  target_xp INTEGER NOT NULL DEFAULT 25,
  tickets INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS student_xp_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  date TEXT NOT NULL,
  routine_id INTEGER REFERENCES routines(id),
  amount INTEGER NOT NULL,
  type TEXT NOT NULL,
  reason TEXT,
  seen_at TEXT,
  reversed_event_id INTEGER REFERENCES student_xp_events(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_xp_unique
ON student_xp_events(student_id, date, routine_id, type) WHERE type = 'routine_complete';

CREATE UNIQUE INDEX IF NOT EXISTS idx_student_xp_reversal_unique
ON student_xp_events(reversed_event_id) WHERE reversed_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reward_ticket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  type TEXT NOT NULL,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_growth_closures (
  class_id INTEGER NOT NULL REFERENCES classes(id),
  date TEXT NOT NULL,
  close_time TEXT NOT NULL,
  closed_at TEXT DEFAULT (datetime('now')),
  routines_awarded INTEGER NOT NULL DEFAULT 0,
  penalties_applied INTEGER NOT NULL DEFAULT 0,
  levels_gained INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (class_id, date)
);

CREATE TABLE IF NOT EXISTS routine_miss_state (
  student_id INTEGER NOT NULL REFERENCES students(id),
  routine_id INTEGER NOT NULL REFERENCES routines(id),
  consecutive_misses INTEGER NOT NULL DEFAULT 0,
  last_processed_date TEXT,
  last_penalty_date TEXT,
  PRIMARY KEY (student_id, routine_id)
);

CREATE TABLE IF NOT EXISTS star_shop_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  name TEXT NOT NULL,
  cost INTEGER NOT NULL,
  stock INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS star_shop_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  status TEXT NOT NULL DEFAULT 'open',
  opened_at TEXT DEFAULT (datetime('now')),
  closes_at TEXT,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS star_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES star_shop_sessions(id),
  item_id INTEGER NOT NULL REFERENCES star_shop_items(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  cost INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  approved_at TEXT,
  rejected_at TEXT
);

INSERT INTO encouragement_tiers (class_id, min_rate, max_rate, message, sort_order)
SELECT NULL, 1.0, 1.0, '오늘 루틴을 모두 끝냈어요! 최고예요 🎉', 1
WHERE NOT EXISTS (SELECT 1 FROM encouragement_tiers WHERE class_id IS NULL);

INSERT INTO encouragement_tiers (class_id, min_rate, max_rate, message, sort_order)
SELECT NULL, 0.7, 0.999, '루틴을 꾸준히 하고 있군요! 조금만 더 가볼까요?', 2
WHERE (SELECT COUNT(*) FROM encouragement_tiers WHERE class_id IS NULL) < 5;

INSERT INTO encouragement_tiers (class_id, min_rate, max_rate, message, sort_order)
SELECT NULL, 0.4, 0.699, '좋은 출발이에요! 하나씩 채워봐요 💪', 3
WHERE (SELECT COUNT(*) FROM encouragement_tiers WHERE class_id IS NULL) < 5;

INSERT INTO encouragement_tiers (class_id, min_rate, max_rate, message, sort_order)
SELECT NULL, 0.01, 0.399, '오늘도 시작이 중요해요, 화이팅!', 4
WHERE (SELECT COUNT(*) FROM encouragement_tiers WHERE class_id IS NULL) < 5;

INSERT INTO encouragement_tiers (class_id, min_rate, max_rate, message, sort_order)
SELECT NULL, 0.0, 0.0, '아직 오늘 루틴이 남아있어요!', 5
WHERE (SELECT COUNT(*) FROM encouragement_tiers WHERE class_id IS NULL) < 5;
