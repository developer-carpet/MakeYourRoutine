const path = require('path');
const app = require('./app');
const express = require('express');
const db = require('./db');
const { finalizeDueClasses } = require('./reward-service');

app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Routine app listening on http://localhost:${PORT}`);
});

// 로컬 서버에서도 교사가 정한 시각에 자동 마감한다.
// Netlify 배포 환경에서는 netlify/functions/auto-finalize.js가 같은 역할을 맡는다.
const autoFinalizeTimer = setInterval(async () => {
  try {
    await db.init();
    await finalizeDueClasses();
  } catch (error) {
    console.error('자동 마감 확인 실패:', error.message);
  }
}, 60 * 1000);
autoFinalizeTimer.unref();
