const db = require('../../server/db');
const { finalizeDueClasses } = require('../../server/reward-service');

exports.handler = async () => {
  await db.init();
  const results = await finalizeDueClasses();
  return {
    statusCode: 200,
    body: JSON.stringify({ checked_at: new Date().toISOString(), finalized: results })
  };
};
