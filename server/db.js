const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

const url = process.env.TURSO_DATABASE_URL || `file:${path.join(__dirname, '..', 'data', 'routine.db')}`;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (url.startsWith('file:')) {
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

const client = createClient(authToken ? { url, authToken } : { url });

function rowToObject(row, columns) {
  const obj = {};
  columns.forEach((col, i) => { obj[col] = row[i]; });
  return obj;
}

function prepare(sql) {
  return {
    async run(...params) {
      const rs = await client.execute({ sql, args: params });
      return {
        lastInsertRowid: rs.lastInsertRowid !== undefined ? Number(rs.lastInsertRowid) : undefined,
        changes: rs.rowsAffected
      };
    },
    async get(...params) {
      const rs = await client.execute({ sql, args: params });
      return rs.rows[0] ? rowToObject(rs.rows[0], rs.columns) : undefined;
    },
    async all(...params) {
      const rs = await client.execute({ sql, args: params });
      return rs.rows.map(r => rowToObject(r, rs.columns));
    }
  };
}

// 여러 SQL을 한 번의 네트워크 왕복으로 실행 (원격 DB 환경에서 지연 누적 방지)
async function batch(statements) {
  const results = await client.batch(
    statements.map(s => ({ sql: s.sql, args: s.params || [] })),
    'write'
  );
  return results.map(rs => ({
    rows: rs.rows.map(r => rowToObject(r, rs.columns)),
    lastInsertRowid: rs.lastInsertRowid !== undefined ? Number(rs.lastInsertRowid) : undefined,
    changes: rs.rowsAffected
  }));
}

async function exec(sql) {
  const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    await client.execute(stmt);
  }
}

async function columnExists(table, column) {
  const rs = await client.execute(`PRAGMA table_info(${table})`);
  const nameIdx = rs.columns.indexOf('name');
  return rs.rows.some(r => r[nameIdx] === column);
}

async function ensureColumn(table, column, ddl) {
  if (!(await columnExists(table, column))) {
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

// 스키마 생성/보정 실제 작업. DB에 수십 회 왕복하므로 요청 경로가 아니라
// 배포(빌드) 단계의 scripts/migrate.js 또는 로컬 서버 기동 시에만 호출한다.
async function migrate() {
  const migrationPath = path.join(__dirname, 'migrations', '001_init.sql');
  if (!fs.existsSync(migrationPath)) {
    console.warn('마이그레이션 파일을 찾을 수 없어 건너뜁니다 (이미 적용된 스키마를 사용한다고 가정):', migrationPath);
    return;
  }
  const migration = fs.readFileSync(migrationPath, 'utf8');
  await exec(migration);
  await ensureColumn('routines', 'deadline_time', 'deadline_time TEXT');
      await ensureColumn('routines', 'start_time', 'start_time TEXT');
      await ensureColumn('routines', 'task_date', 'task_date TEXT');
      await ensureColumn('classes', 'draw_config_json', 'draw_config_json TEXT');
      await ensureColumn('students', 'routine_exempt', 'routine_exempt INTEGER DEFAULT 0');
      await ensureColumn('classes', 'praise_weight', 'praise_weight REAL DEFAULT 0.05');
      await ensureColumn('classes', 'concern_weight', 'concern_weight REAL DEFAULT 0.05');
      await ensureColumn('classes', 'daily_star_enabled', 'daily_star_enabled INTEGER DEFAULT 1');
      await ensureColumn('classes', 'daily_star_threshold', 'daily_star_threshold REAL DEFAULT 0.8');
      await ensureColumn('classes', 'auto_close_time', "auto_close_time TEXT DEFAULT '16:30'");
      await ensureColumn('classes', 'xp_target', 'xp_target INTEGER DEFAULT 25');
      await ensureColumn('classes', 'xp_decay_enabled', 'xp_decay_enabled INTEGER DEFAULT 1');
      await ensureColumn('classes', 'xp_decay_misses', 'xp_decay_misses INTEGER DEFAULT 3');
      await ensureColumn('classes', 'xp_decay_amount', 'xp_decay_amount INTEGER DEFAULT 1');
      await ensureColumn('growth_events', 'event_date', 'event_date TEXT');
      await ensureColumn('growth_events', 'source_key', 'source_key TEXT');
      await ensureColumn('student_xp_events', 'reversed_event_id', 'reversed_event_id INTEGER');
  await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_event_source_unique ON growth_events(source_key) WHERE source_key IS NOT NULL`);
  await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_student_xp_reversal_unique ON student_xp_events(reversed_event_id) WHERE reversed_event_id IS NOT NULL`);
}

let ready;
function init() {
  if (!ready) {
    ready = (async () => {
      // Netlify 함수 런타임에서는 스키마 마이그레이션을 배포(빌드) 단계의 scripts/migrate.js에서 이미 끝냈다.
      // 따라서 매 요청마다 DB 왕복 수십 회를 반복하지 않고 즉시 통과시킨다 (콜드스타트 지연/크레딧 절감).
      // 로컬 서버(server/index.js)나 마이그레이션 스크립트에서는 이 조건이 걸리지 않아 정상적으로 스키마를 보정한다.
      if (process.env.SKIP_MIGRATIONS === '1' || process.env.AWS_LAMBDA_FUNCTION_NAME) return;
      await migrate();
    })();
  }
  return ready;
}

function close() {
  if (typeof client.close === 'function') client.close();
}

module.exports = { prepare, exec, batch, init, migrate, close };
