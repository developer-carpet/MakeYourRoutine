(function () {
  const links = [
    ['dashboard', 'index.html', '대시보드'],
    ['board', 'board.html', '전자칠판'],
    ['routines', 'routines.html', '루틴 관리'],
    ['rewards', 'rewards.html', '보상 관리'],
    ['stats', 'stats.html', '통계']
  ];

  function renderTeacherNavigation() {
    document.querySelectorAll('[data-teacher-nav]').forEach(slot => {
      const current = slot.dataset.teacherNav;
      slot.innerHTML = `<nav class="teacher-nav" aria-label="교사 화면 이동">${links.map(([key, href, label]) => {
        const active = key === current;
        return `<a${active ? ' class="active" aria-current="page"' : ''} href="${href}">${label}</a>`;
      }).join('')}</nav>`;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderTeacherNavigation);
  } else {
    renderTeacherNavigation();
  }
})();
