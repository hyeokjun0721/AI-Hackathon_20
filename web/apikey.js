// 상단 API 키 입력/저장 바 (모든 페이지 공용). CSP(script-src 'self') 때문에 외부 파일로 둡니다.
(() => {
  const STORE = 'fitnote.geminiKey';
  const read = () => { try { return localStorage.getItem(STORE) || ''; } catch { return ''; } };
  const write = (v) => { try { v ? localStorage.setItem(STORE, v) : localStorage.removeItem(STORE); return true; } catch { return false; } };
  let memKey = read();                       // 저장소를 못 쓰는 환경에서도 이번 탭에서는 동작
  window.getApiKey = () => memKey;

  const build = () => {
    const header = document.querySelector('header.top');
    if (!header) return;
    const form = document.createElement('form');
    form.className = 'keybar'; form.autocomplete = 'off';
    form.innerHTML = '<label for="top-api-key">Gemini API 키</label>'
      + '<input id="top-api-key" type="password" autocomplete="off" maxlength="1024" spellcheck="false" placeholder="API 키 입력">'
      + '<button type="submit" class="keybar-save">저장</button>'
      + '<button type="button" class="keybar-clear" hidden>삭제</button>'
      + '<span class="keybar-state" role="status" aria-live="polite"></span>';
    const input = form.querySelector('input'), clear = form.querySelector('.keybar-clear'), state = form.querySelector('.keybar-state');
    const render = (msg) => {
      input.value = ''; input.placeholder = memKey ? '저장됨 · ••••' + memKey.slice(-4) : 'API 키 입력';
      clear.hidden = !memKey; state.textContent = msg || (memKey ? '✓ 저장됨' : '');
      state.classList.toggle('on', !!memKey);
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) { state.textContent = '키를 입력해 주세요'; state.classList.remove('on'); return; }
      memKey = v; const ok = write(v);
      render(ok ? '✓ 저장됨' : '이 탭에서만 유지돼요');
    });
    clear.addEventListener('click', () => { memKey = ''; write(''); render('삭제했어요'); });
    // 상단 바 오른쪽, 내비게이션 링크 앞에 배치
    const anchor = header.querySelector('.nav, .nav-3d');
    header.insertBefore(form, anchor || null);
    render();
  };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', build) : build();
})();
