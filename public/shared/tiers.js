(function () {
  const tiers = [
    { name: '반짝 씨앗 휘장', chapter: '땅의 성장' },
    { name: '초록 새싹 휘장', chapter: '땅의 성장' },
    { name: '싱그러운 잎새 휘장', chapter: '땅의 성장' },
    { name: '두근두근 꽃봉오리 휘장', chapter: '땅의 성장' },
    { name: '활짝 꽃빛 휘장', chapter: '땅의 성장' },
    { name: '산들바람 휘장', chapter: '하늘의 모험' },
    { name: '몽실구름 휘장', chapter: '하늘의 모험' },
    { name: '따스한 햇살 휘장', chapter: '하늘의 모험' },
    { name: '반짝노을 휘장', chapter: '하늘의 모험' },
    { name: '찬란한 무지개 휘장', chapter: '하늘의 모험' },
    { name: '고요한 달빛 휘장', chapter: '우주의 빛' },
    { name: '빛나는 별 휘장', chapter: '우주의 빛' },
    { name: '신비한 은하 휘장', chapter: '우주의 빛' },
    { name: '오로라 보석 휘장', chapter: '우주의 빛' },
    { name: '우주 왕관 휘장', chapter: '우주의 빛' }
  ];

  function get(level) {
    const safeLevel = Math.max(1, Math.floor(Number(level) || 1));
    const tierNumber = Math.min(15, safeLevel);
    const starRank = Math.max(0, safeLevel - 15);
    const tier = tiers[tierNumber - 1];
    const displayName = starRank ? `${tier.name} ★${starRank}` : tier.name;
    const nextName = tierNumber < 15
      ? tiers[tierNumber].name
      : `${tiers[14].name} ★${starRank + 1}`;
    const column = (tierNumber - 1) % 5;
    const row = Math.floor((tierNumber - 1) / 5);
    return {
      ...tier,
      level: safeLevel,
      tierNumber,
      starRank,
      displayName,
      nextName,
      x: column * 25,
      y: row * 50
    };
  }

  function badge(level, sizeClass = '') {
    const tier = get(level);
    return `<span class="tier-badge ${sizeClass}" style="--tier-x:${tier.x}%;--tier-y:${tier.y}%;" role="img" aria-label="${tier.displayName}"></span>`;
  }

  window.GrowthTiers = Object.freeze({ tiers: Object.freeze(tiers), get, badge });
})();
