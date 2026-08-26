const assert = require('assert/strict');

process.env.TURSO_DATABASE_URL = 'file::memory:';

const app = require('../server/app');
const db = require('../server/db');

function kstDate() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function addDays(date, count) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

async function main() {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, url, body, expected = 200) {
    const response = await fetch(base + url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(payload)}`);
    return payload;
  }

  try {
    const today = kstDate();
    const cls = await request('POST', '/api/classes', { name: `보상 테스트 ${Date.now()}`, teacher_pin: '1234' });
    await request('PUT', `/api/classes/${cls.id}`, { auto_close_time: '23:45', xp_target: 5, xp_decay_enabled: false });
    const student = await request('POST', '/api/students', { class_id: cls.id, nickname: '별이', number: 1 });
    const routines = [];
    for (let index = 1; index <= 5; index++) routines.push(await request('POST', '/api/routines', { class_id: cls.id, title: `테스트 루틴 ${index}`, task_date: today }));
    const routine = routines[0];

    const syncEvent = { event_id: 'sync-1', routine_id: routine.id, student_id: student.id, count: 1, completed: true };
    await request('POST', '/api/checks/sync', { events: [syncEvent] });
    await request('POST', '/api/checks/sync', { events: [syncEvent] });
    let state = await request('GET', `/api/checks/student-state?student_id=${student.id}`);
    assert.equal(state.growth.projected_percent, 20);
    assert.equal(state.student.points, 1, '절대 상태 재전송은 점수를 중복 지급하지 않아야 함');

    await request('POST', '/api/checks/sync', { events: routines.slice(1).map((item,index) => ({ event_id: `sync-${index+2}`, routine_id: item.id, student_id: student.id, count: 1, completed: true })) });
    state = await request('GET', `/api/checks/student-state?student_id=${student.id}`);
    assert.equal(state.growth.projected_level, 2);
    assert.equal(state.growth.tickets, 0, '자동 마감 전에는 보상권이 확정되지 않아야 함');

    const firstFinalize = await request('POST', '/api/rewards/progress/finalize', { class_id: cls.id });
    const secondFinalize = await request('POST', '/api/rewards/progress/finalize', { class_id: cls.id });
    assert.equal(firstFinalize.routines_awarded, 5);
    assert.equal(firstFinalize.levels_gained, 1);
    assert.equal(secondFinalize.already_finalized, true);

    let progress = await request('GET', `/api/rewards/progress/student?student_id=${student.id}`);
    assert.equal(progress.growth.level, 2);
    assert.equal(progress.tickets, 1);

    await request('POST', '/api/rewards/progress/grant', { class_id: cls.id, student_id: student.id, amount: 5, reason: '친구를 도와주었어요' });
    progress = await request('GET', `/api/rewards/progress/student?student_id=${student.id}`);
    assert.equal(progress.growth.level, 3);
    assert.equal(progress.tickets, 2);
    assert.equal(progress.unseen.filter(event => event.type === 'teacher_bonus').length, 1);

    const item = await request('POST', '/api/rewards/shop/items', { class_id: cls.id, name: '음악 선택', cost: 1, stock: 1 });
    await request('POST', '/api/rewards/shop/redeem', { student_id: student.id, item_id: item.id }, 403);
    await request('POST', '/api/rewards/shop/open', { class_id: cls.id, duration_minutes: 20 });
    const redemption = await request('POST', '/api/rewards/shop/redeem', { student_id: student.id, item_id: item.id });
    await request('POST', `/api/rewards/shop/redemptions/${redemption.id}/approve`, {});
    progress = await request('GET', `/api/rewards/progress/student?student_id=${student.id}`);
    assert.equal(progress.tickets, 1);

    const autoCls = await request('POST', '/api/classes', { name: `자동 마감 ${Date.now()}`, teacher_pin: '1234' });
    await request('PUT', `/api/classes/${autoCls.id}`, { auto_close_time: '00:00', xp_target: 5, xp_decay_enabled: false });
    const autoStudent = await request('POST', '/api/students', { class_id: autoCls.id, nickname: '마감이', number: 1 });
    const autoRoutine = await request('POST', '/api/routines', { class_id: autoCls.id, title: '자동 마감 루틴', task_date: today });
    await request('POST', '/api/checks/sync', { events: [{ event_id: 'auto-1', routine_id: autoRoutine.id, student_id: autoStudent.id, count: 1, completed: true }] });
    const autoOverview = await request('GET', `/api/rewards/progress/students?class_id=${autoCls.id}`);
    assert.equal(autoOverview[0].finalized, true, '설정 시간이 지나면 접근 시에도 자동 마감되어야 함');
    await request('POST', '/api/checks/sync', { events: [{ event_id: 'auto-2', routine_id: autoRoutine.id, student_id: autoStudent.id, count: 0, completed: false }] }, 409);

    const decayCls = await request('POST', '/api/classes', { name: `차감 테스트 ${Date.now()}`, teacher_pin: '1234' });
    await request('PUT', `/api/classes/${decayCls.id}`, { auto_close_time: '23:45', xp_target: 5, xp_decay_enabled: true, xp_decay_misses: 2, xp_decay_amount: 1 });
    const activeStudent = await request('POST', '/api/students', { class_id: decayCls.id, nickname: '활동이', number: 1 });
    const missedStudent = await request('POST', '/api/students', { class_id: decayCls.id, nickname: '꾸준이', number: 2 });
    const decayRoutine = await request('POST', '/api/routines', { class_id: decayCls.id, title: '매일 정리하기', days_of_week: '0,1,2,3,4,5,6' });
    await request('POST', '/api/rewards/progress/grant', { class_id: decayCls.id, student_id: missedStudent.id, amount: 2, reason: '차감 테스트 준비' });
    const decayDay1 = addDays(today, 10), decayDay2 = addDays(today, 11);
    await db.prepare(`INSERT INTO routine_checks (routine_id,student_id,date,count,completed,completed_at) VALUES (?,?,?,?,1,datetime('now'))`).run(decayRoutine.id, activeStudent.id, decayDay1, 1);
    await db.prepare(`INSERT INTO routine_checks (routine_id,student_id,date,count,completed,completed_at) VALUES (?,?,?,?,1,datetime('now'))`).run(decayRoutine.id, activeStudent.id, decayDay2, 1);
    const decayFirst = await request('POST', '/api/rewards/progress/finalize', { class_id: decayCls.id, date: decayDay1 });
    const decaySecond = await request('POST', '/api/rewards/progress/finalize', { class_id: decayCls.id, date: decayDay2 });
    assert.equal(decayFirst.penalties_applied, 0);
    assert.equal(decaySecond.penalties_applied, 1);
    const decayProgress = await request('GET', `/api/rewards/progress/student?student_id=${missedStudent.id}&date=${decayDay2}`);
    assert.equal(decayProgress.growth.progress_xp, 1);
    assert.equal(decayProgress.events.some(event => event.type === 'inactivity_penalty' && Number(event.amount) === -1), true);

    const campaign = await request('POST', '/api/rewards/growth/campaigns', {
      class_id: cls.id,
      name: '테스트 행복 나무',
      theme: 'tree',
      start_date: today,
      end_date: addDays(today, 13),
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      difficulty: 'normal',
      target_points: 1,
      auto_target: false,
      reward_text: '놀이 시간',
      milestones: [{ id: 'mid-50', percent: 50, reward_text: '노래 한 곡 듣기' }]
    });
    assert.equal(campaign.target_points, 1);
    assert.equal(campaign.milestones[0].reward_text, '노래 한 곡 듣기');

    let noteResult;
    for (let index = 0; index < 3; index++) noteResult = await request('POST', '/api/notes', { class_id: cls.id, type: 'praise', text: `칭찬 ${index + 1}` });
    assert.equal(noteResult.growth.applied_delta, 1);
    assert.equal(noteResult.growth.campaign.current_points, 1);
    const concerns = [];
    for (let index = 0; index < 3; index++) concerns.push(await request('POST', '/api/notes', { class_id: cls.id, type: 'concern', text: `아쉬움 ${index + 1}` }));
    assert.equal(concerns[2].growth.applied_delta, -1);
    assert.equal(concerns[2].growth.campaign.current_points, 0);
    const restored = await request('DELETE', `/api/notes/${concerns[2].id}`);
    assert.equal(restored.growth.applied_delta, 1, '아쉬움 기록을 취소하면 차감된 에너지도 돌아와야 함');

    const draw = await request('POST', '/api/stats/class-draw', { class_id: cls.id });
    assert.ok(draw.growth);
    assert.equal(draw.growth.completed, true);
    const milestoneRewarded = await request('POST', `/api/rewards/growth/campaigns/${campaign.id}/milestones/mid-50/rewarded`, {});
    assert.ok(milestoneRewarded.milestones[0].rewarded_at);
    await request('PUT', `/api/rewards/growth/campaigns/${campaign.id}`, { milestones: [] }, 400);
    const replay = await request('POST', '/api/stats/class-draw', { class_id: cls.id });
    assert.equal(replay.growth.points_added, 0);
    await request('DELETE', `/api/stats/class-draw?class_id=${cls.id}`, undefined, 409);

    console.log('Reward integration tests passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
