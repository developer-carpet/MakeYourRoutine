// 배포(빌드) 단계에서 한 번만 실행되는 스키마 마이그레이션.
// Netlify 빌드 커맨드(netlify.toml)에서 호출한다. 실패 시 프로세스가 비정상 종료(exit 1)되어
// 빌드 자체가 멈추므로, 잘못된 스키마가 프로덕션 함수 런타임으로 넘어가지 않는다(이전 배포 유지).
// Netlify 빌드 환경인데 원격 DB 접속 정보가 없으면, 버려질 임시 로컬 파일에 마이그레이션하는
// 조용한 사고를 막기 위해 즉시 실패시킨다.
if (process.env.NETLIFY && !process.env.TURSO_DATABASE_URL) {
  console.error('TURSO_DATABASE_URL 환경변수가 없습니다. Netlify 사이트 설정에 DB 접속 정보를 등록해주세요.');
  process.exit(1);
}

const db = require('../server/db');

db.migrate()
  .then(() => {
    console.log('마이그레이션 완료');
    return db.close();
  })
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('마이그레이션 실패:', error);
    process.exit(1);
  });
