(function () {
  let currentEvents = [];
  let currentOptions = {};
  let currentKey = '';

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function ensureOverlay() {
    let overlay = document.getElementById('growthNoticeOverlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'growthNoticeOverlay';
    overlay.className = 'growth-notice-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'growthNoticeTitle');
    overlay.innerHTML = `<div class="growth-notice-card">
      <h2 id="growthNoticeTitle">새로운 성장 소식이 있어요!</h2>
      <div class="growth-notice-visual" id="growthNoticeVisual" aria-hidden="true"></div>
      <div class="growth-notice-total" id="growthNoticeTotal"></div>
      <div class="growth-notice-reasons" id="growthNoticeReasons"></div>
      <div class="growth-notice-gauge" aria-label="현재 성장 게이지"><div class="growth-notice-gauge-fill" id="growthNoticeGaugeFill"></div></div>
      <div id="growthNoticeGaugeLabel" style="color:var(--color-graphite);font-size:13px;font-weight:800;"></div>
      <button id="growthNoticeConfirm" type="button" style="margin-top:16px;">확인했어요! 루틴 시작하기</button>
      <p class="growth-notice-error" id="growthNoticeError" aria-live="polite"></p>
    </div>`;
    document.body.appendChild(overlay);
    document.getElementById('growthNoticeConfirm').addEventListener('click', confirmNotice);
    return overlay;
  }

  function show(events, options = {}) {
    const normalized = (Array.isArray(events) ? events : []).filter(event => Number.isFinite(Number(event.id)));
    if (!normalized.length) return false;
    const key = normalized.map(event => event.id).join(',');
    const overlay = ensureOverlay();
    if (overlay.classList.contains('show') && currentKey === key) return true;
    currentEvents = normalized;
    currentOptions = options;
    currentKey = key;

    const positive = normalized.reduce((sum, event) => sum + Math.max(0, Number(event.amount) || 0), 0);
    const negative = normalized.reduce((sum, event) => sum + Math.abs(Math.min(0, Number(event.amount) || 0)), 0);
    const title = positive && negative ? '새로운 성장 별 소식이 있어요!'
      : positive ? '선생님에게 성장 별을 받았어요!'
      : '선생님이 성장 별을 조정했어요';
    document.getElementById('growthNoticeTitle').textContent = title;

    const visual = document.getElementById('growthNoticeVisual');
    if (positive && !negative) {
      const count = Math.min(positive, 6);
      visual.innerHTML = Array.from({ length: count }, (_, index) => `<span class="growth-notice-star" style="animation-delay:${index * .11}s">⭐</span>`).join('');
    } else if (negative && !positive) {
      visual.innerHTML = '<span class="growth-notice-star deduct">⭐</span>';
    } else {
      visual.innerHTML = '<span class="growth-notice-star">⭐</span><span style="font-size:38px;font-weight:900;color:var(--color-graphite);">↕</span>';
    }

    const total = document.getElementById('growthNoticeTotal');
    const net = positive - negative;
    total.classList.toggle('negative', net < 0);
    total.textContent = positive && negative ? `성장 별 ${net >= 0 ? '+' : ''}${net}` : positive ? `성장 별 +${positive}` : `성장 별 -${negative}`;
    document.getElementById('growthNoticeReasons').innerHTML = normalized.map(event => {
      const amount = Number(event.amount) || 0;
      return `<div class="growth-notice-reason"><strong>별 ${amount > 0 ? '+' : ''}${amount}</strong> · ${escapeHtml(event.reason || '성장 기록')}</div>`;
    }).join('');

    const growth = options.growth || {};
    const percent = Math.max(0, Math.min(100, Number(growth.projected_percent ?? growth.percent ?? 0)));
    const fill = document.getElementById('growthNoticeGaugeFill');
    fill.style.width = '0%';
    document.getElementById('growthNoticeGaugeLabel').textContent = `현재 성장 게이지 ${Math.round(percent)}%`;
    document.getElementById('growthNoticeError').textContent = '';
    const button = document.getElementById('growthNoticeConfirm');
    button.disabled = false;
    button.textContent = '확인했어요! 루틴 시작하기';
    overlay.classList.add('show');
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${percent}%`; }));
    setTimeout(() => button.focus(), 80);
    return true;
  }

  async function confirmNotice() {
    const button = document.getElementById('growthNoticeConfirm');
    button.disabled = true;
    button.textContent = '확인 중…';
    document.getElementById('growthNoticeError').textContent = '';
    try {
      await API.post('/api/rewards/progress/seen', {
        student_id: currentOptions.studentId,
        event_ids: currentEvents.map(event => Number(event.id))
      });
      ensureOverlay().classList.remove('show');
      const confirmed = currentEvents.slice();
      currentEvents = [];
      currentKey = '';
      if (typeof currentOptions.onConfirmed === 'function') currentOptions.onConfirmed(confirmed);
      currentOptions = {};
    } catch (error) {
      button.disabled = false;
      button.textContent = '다시 확인하기';
      document.getElementById('growthNoticeError').textContent = '확인 내용을 저장하지 못했어요. 연결을 확인하고 다시 눌러주세요.';
    }
  }

  window.StudentGrowthNotice = { show };
})();
