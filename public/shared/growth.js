const GrowthUI = (() => {
  const stages = {
    tree: [
      { icon: '🌰', label: '씨앗' },
      { icon: '🌱', label: '새싹' },
      { icon: '🌿', label: '어린 나무' },
      { icon: '🌳', label: '튼튼한 나무' },
      { icon: '🌸', label: '꽃이 핀 나무' },
      { icon: '🍎', label: '열매가 열렸어요!' }
    ],
    butterfly: [
      { icon: '🥚', label: '작은 알' },
      { icon: '🐛', label: '아기 애벌레' },
      { icon: '🐛', label: '통통한 애벌레' },
      { icon: '🍃', label: '번데기 준비' },
      { icon: '🟤', label: '번데기' },
      { icon: '🦋', label: '나비가 되었어요!' }
    ]
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }

  function getProgress(campaign) {
    return campaign?.target_points ? Math.min(1, Number(campaign.current_points || 0) / Number(campaign.target_points)) : 0;
  }

  function stageOf(progress) {
    if (progress >= 1) return 5;
    if (progress >= 0.75) return 4;
    if (progress >= 0.5) return 3;
    if (progress >= 0.25) return 2;
    if (progress > 0) return 1;
    return 0;
  }

  function milestonesOf(campaign) {
    return (Array.isArray(campaign?.milestones) ? campaign.milestones : []).map((item, index) => {
      const source = typeof item === 'number' ? { percent: item, reward_text: `${item}% 중간 보상` } : item;
      return { id: source.id || `milestone-${index}`, percent: Math.round(Number(source.percent)), reward_text: source.reward_text || source.reward || '중간 보상', rewarded_at: source.rewarded_at || null };
    }).filter(item => item.percent > 0 && item.percent < 100).sort((a, b) => a.percent - b.percent);
  }

  function render(element, campaign, options = {}) {
    if (!element) return;
    if (!campaign) {
      element.innerHTML = `<div class="growth-empty">🌱 아직 진행 중인 공동 성장 캠페인이 없어요.</div>`;
      return;
    }
    const progress = getProgress(campaign);
    const percent = Math.round(progress * 100);
    const theme = campaign.theme === 'butterfly' ? 'butterfly' : 'tree';
    const stage = stages[theme][stageOf(progress)];
    const milestones = milestonesOf(campaign);
    const unlockedMilestone = [...milestones].reverse().find(item => percent >= item.percent && !item.rewarded_at);
    const nextMilestone = milestones.find(item => percent < item.percent);
    const sparkleCount = Math.max(1, Math.floor(percent / 10));
    const sparkles = Array.from({ length: sparkleCount }, (_, index) =>
      `<span class="growth-sparkle" style="--i:${index}; --x:${8 + ((index * 17) % 82)}%; --y:${12 + ((index * 29) % 70)}%">${theme === 'tree' ? (index % 3 === 0 ? '🌼' : '🍃') : (index % 3 === 0 ? '✨' : '🍀')}</span>`
    ).join('');
    const reward = campaign.reward_text
      ? `<div class="growth-reward">🎁 ${escapeHtml(campaign.reward_text)}</div>`
      : '';
    const progressMessage = unlockedMilestone
      ? `<div class="growth-milestone-unlocked">🎉 ${unlockedMilestone.percent}% 중간 보상 열림: ${escapeHtml(unlockedMilestone.reward_text)}</div>`
      : nextMilestone
        ? `<div class="growth-next">다음 중간 보상 ${nextMilestone.percent}% · ${escapeHtml(nextMilestone.reward_text)}</div>`
        : '';
    const milestoneMarkers = milestones.map(item => `<span class="growth-milestone-marker ${percent>=item.percent?'unlocked':''} ${item.rewarded_at?'rewarded':''}" style="left:${item.percent}%" title="${item.percent}% ${escapeHtml(item.reward_text)}">${item.rewarded_at?'✓':'🎁'}</span>`).join('');
    const milestoneList = milestones.length ? `<div class="growth-milestone-list">${milestones.map(item=>`<div class="growth-milestone-chip ${percent>=item.percent?'unlocked':''} ${item.rewarded_at?'rewarded':''}"><strong>${item.percent}%</strong> ${escapeHtml(item.reward_text)} ${item.rewarded_at?'✓':''}</div>`).join('')}</div>` : '';
    const completed = progress >= 1
      ? `<div class="growth-complete">목표 달성! ${campaign.rewarded_at ? '보상 지급 완료' : '보상이 열렸어요 🎉'}</div>`
      : (progressMessage || `<div class="growth-next">다음 성장까지 함께 힘을 모아봐요!</div>`);
    element.innerHTML = `
      <section class="growth-widget ${options.animate ? 'growth-animate' : ''}" aria-label="${escapeHtml(campaign.name)} 진행률 ${percent}%">
        <div class="growth-scene">
          ${sparkles}
          <div class="growth-character" role="img" aria-label="${escapeHtml(stage.label)}">${stage.icon}</div>
          <div class="growth-stage-label">${escapeHtml(stage.label)}</div>
        </div>
        <div class="growth-info">
          <div class="growth-title-row"><strong>${escapeHtml(campaign.name)}</strong><span>${percent}%</span></div>
          <div class="growth-progress-wrap"><div class="growth-progress"><div style="width:${percent}%"></div></div>${milestoneMarkers}</div>
          <div class="growth-score">${Number(campaign.current_points || 0)} / ${Number(campaign.target_points || 0)} 성장 에너지</div>
          ${completed}${milestoneList}${reward}
        </div>
      </section>`;
  }

  return { render, getProgress, stageOf, milestonesOf };
})();
