const form = document.querySelector('#compare-form');
const keyInput = document.querySelector('#api-key');
const retryKey = document.querySelector('#retry-api-key');
const errorBox = document.querySelector('#error');
const statusBox = document.querySelector('#status');
const panel = document.querySelector('.result-panel');
const tag = document.querySelector('#result-tag');
const retry = document.querySelector('#retry-button');
const retrySection = document.querySelector('#retry-section');
const recommendation = document.querySelector('#recommendation');
const loadingPanel = document.querySelector('#loading-panel');
const reasonContent = document.querySelector('#reason-content');
const fields = ['length_cm', 'shoulder_cm', 'chest_width_cm', 'sleeve_cm'];
const fieldLabels = ['총장', '어깨너비', '가슴단면', '소매길이'];
let comparison = null;
let busy = false;
let blockedUntil = 0;

function element(name, text, className) {
  const el = document.createElement(name);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function sourceLink(label, url) {
  const link = element('a', label);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return element('span', label);
    link.href = parsed.href;
  } catch { return element('span', label); }
  link.target = '_blank'; link.rel = 'noopener noreferrer';
  return link;
}
function setBusy(value) {
  busy = value;
  panel.setAttribute('aria-busy', String(value));
  form.setAttribute('aria-busy', String(value));
  document.querySelectorAll('input, button, select').forEach(el => el.disabled = value);
}
function showError(message) { errorBox.textContent = message; errorBox.hidden = false; }
function showView(view) {
  document.querySelector('#input-panel').hidden = view !== 'input';
  document.querySelector('#compare-intro').hidden = view !== 'input';
  loadingPanel.hidden = view !== 'loading';
  panel.hidden = view !== 'result';
}
function showLoading(stage) {
  showView('loading');
  document.querySelector('#loading-title').textContent = stage === 'collect' ? '옷을 살펴보는 중' : '핏을 찾는 중';
  document.querySelector('#loading-message').textContent = stage === 'collect' ? '상품 정보 확인 중' : '치수 · 소재 · 신축성 비교 중';
  for (const name of ['collect', 'fit']) {
    const step = document.querySelector(`#step-${name}`);
    if (name === stage) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
    step.classList.toggle('complete', name === 'collect' && stage === 'fit');
  }
}
function revealResult() {
  showView('result');
  document.querySelector('#result-title').focus();
}
async function api(path, body) {
  const response = await fetch(path, {method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Page-Token': document.querySelector('meta[name="page-token"]').content
  }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000)});
  const data = await response.json();
  if (response.status === 429 && data.retry_after) blockedUntil = Date.now() + data.retry_after * 1000;
  if (!response.ok) throw new Error(data.error || '요청을 처리하지 못했어요.');
  return data;
}
function showRecommendation(title, description, size) {
  recommendation.replaceChildren(element('h3', title));
  if (size) recommendation.append(element('div', size, 'size'));
  reasonContent.replaceChildren(element('p', description));
}
function renderFitSummary(size) {
  const summary = document.querySelector('#fit-summary');
  summary.replaceChildren();
  const row = comparison?.sizes.find(item => item.size === size && item.status === 'ok');
  if (row) fields.forEach((field, index) => {
    const gap = row.gaps[field];
    if (!Number.isFinite(gap)) return;
    const p = element('p', `${gap > 0 ? '+' : ''}${gap.toFixed(1)}cm`);
    p.prepend(element('small', fieldLabels[index])); summary.append(p);
  });
  const stretch = element('p', comparison.target.stretch ?? '미확인');
  stretch.prepend(element('small', '신축성')); stretch.classList.add('stretch-chip'); summary.append(stretch);
  document.querySelector('.summary-caption').hidden = !row;
  summary.hidden = false;
}
function renderComparison(data) {
  document.querySelector('#results').hidden = false;
  panel.querySelectorAll('details').forEach(detail => detail.open = false);
  document.querySelector('#wash-details').hidden = true;
  const product = data.target;
  const box = element('div', undefined, 'product');
  box.append(sourceLink(product.product_name, product.source_url));
  document.querySelector('#products').replaceChildren(box);
  const material = document.querySelector('#material-details');
  material.replaceChildren(
    element('p', '소재: ' + (product.material || (product.material_status === 'error' ? '수집 실패' : '미제공'))),
    element('p', '신축성: ' + (product.stretch ?? '미확인')),
    element('p', '신축성은 판매자의 정성적 표기이며, 실제 늘어나는 비율을 측정한 값은 아니에요.', 'hint'),
    sourceLink('상품 정보 원문', product.material_source_url || product.source_url)
  );
  const reviews = document.querySelector('#review-details'); reviews.replaceChildren();
  document.querySelector('#reviews-title').textContent = `후기 · ${product.reviews?.length || 0}`;
  for (const review of product.reviews || []) {
    reviews.append(element('p', review.content),
      element('p', `${review.created_at} · 별점 ${review.rating ?? '미제공'} · 구매 옵션 ${review.purchased_option ?? '미제공'}`, 'hint'),
      sourceLink('후기 원문', review.source_url));
  }
  if (!product.reviews?.length) reviews.append(element('p', product.reviews_status === 'error' ? '후기를 불러오지 못했어요.' : '등록된 후기가 없어요.'));
  else reviews.append(element('p', '최신 후기이며 전체 구매자의 의견을 대표하지 않아요.', 'hint'));
  document.querySelector('#reference-caption').textContent = `비교 기준: ${data.reference.product_name} · ${data.reference.size} / ${data.desired_fit}`;
  const rows = document.querySelector('#size-rows'); rows.replaceChildren();
  for (const item of data.sizes) {
    const tr = element('tr'); tr.dataset.size = item.size;
    const th = element('th', item.size); th.scope = 'row'; tr.append(th);
    if (item.status !== 'ok') {
      const td = element('td', '비교 제외: ' + item.reason); td.colSpan = 4; tr.append(td);
    } else fields.forEach(field => {
      const td = element('td', item.measurements[field] ?? '—');
      if (Number.isFinite(item.gaps[field])) {
        const gap = item.gaps[field]; td.append(element('small', (gap > 0 ? '+' : '') + gap.toFixed(1)));
      }
      tr.append(td);
    });
    rows.append(tr);
  }
  tag.textContent = '실측 비교';
  const count = data.sizes.filter(row => row.status === 'ok').length;
  showRecommendation('비교 가능한 사이즈', '실측표에서 기준 옷과의 차이를 확인하세요. AI 추천은 아래에서 추가할 수 있어요.', `${count}개`);
  renderFitSummary(); retrySection.hidden = false;
}
async function requestRecommendation(input = keyInput) {
  if (!input.value.trim()) { showError('AI 추천을 받으려면 API 키를 입력해 주세요.'); input.focus(); return; }
  const apiKey = input.value.trim(); input.value = '';
  showLoading('fit');
  tag.textContent = 'AI 추천 중';
  retrySection.open = false;
  document.querySelector('#wash-details').hidden = true;
  renderFitSummary();
  document.querySelectorAll('#size-rows tr').forEach(row => row.classList.remove('selected-row'));
  try {
    const result = await api('/api/recommend', {comparison_id: comparison.comparison_id, api_key: apiKey});
    if (result.ok) {
      showRecommendation('추천 사이즈', result.reason, result.recommended_size);
      renderFitSummary(result.recommended_size);
      const scenarios = Object.entries(result.wash_scenarios_cm ?? {});
      const wash = document.querySelector('#wash-content'); wash.replaceChildren();
      if (scenarios.length) {
        wash.append(element('p', '상품별 시험값이 아닌 비교용 가정이에요. 실제 수축률이나 상한을 뜻하지 않아요.', 'hint'));
        for (const [percent, measurements] of scenarios) {
          const values = fields.flatMap((field, index) => Number.isFinite(measurements[field])
            ? [`${fieldLabels[index]} ${measurements[field].toFixed(1)}cm`] : []);
          wash.append(element('p', `${percent}% 수축 가정 — ${values.join(', ')}`));
        }
        document.querySelector('#wash-details').hidden = false;
      }
      document.querySelectorAll('#size-rows tr').forEach(row => row.classList.toggle('selected-row', row.dataset.size === result.recommended_size));
      tag.textContent = '추천 완료';
    } else {
      showRecommendation('추천 보류', result.message, '—'); tag.textContent = '확인 필요';
      document.querySelector('#reason-details').open = true;
      document.querySelector('#measurements-detail').open = true;
    }
    if (result.limitations) reasonContent.append(element('p', result.limitations, 'hint'));
    statusBox.textContent = '';
  } catch (error) {
    showRecommendation('추천 연결 실패', '수집한 치수는 유지됩니다. API 키를 다시 입력해 재시도하세요.', '—');
    showError(error.name === 'TimeoutError' ? '응답이 늦어지고 있어요. 잠시 후 재시도해 주세요.' : error.message); tag.textContent = '실측 비교 가능'; statusBox.textContent = '';
    retrySection.open = true;
    document.querySelector('#measurements-detail').open = true;
  }
}
async function submit(withAI) {
  if (busy || !form.reportValidity()) return;
  if (Date.now() < blockedUntil) { showError(`${Math.ceil((blockedUntil - Date.now()) / 1000)}초 후 다시 시도해 주세요.`); return; }
  if (withAI && !keyInput.value.trim()) { showError('AI 추천을 받으려면 API 키를 입력해 주세요.'); keyInput.focus(); return; }
  errorBox.hidden = true;
  const body = Object.fromEntries(new FormData(form)); delete body.api_key;
  body.profile_index = 0;
  setBusy(true); comparison = null;
  showLoading('collect');
  document.querySelector('#loading-title').focus();
  try {
    comparison = await api('/api/compare', body); renderComparison(comparison);
    if (withAI) await requestRecommendation();
    else { document.querySelector('#measurements-detail').open = true; keyInput.value = ''; statusBox.textContent = ''; }
    revealResult();
  } catch (error) {
    keyInput.value = ''; showView('input');
    showError(error.name === 'TimeoutError' ? '응답이 늦어지고 있어요. 잠시 후 다시 시도해 주세요.' : error.message); statusBox.textContent = '';
  } finally {
    setBusy(false);
    if (!comparison) document.querySelector('#target-url').focus();
  }
}
form.addEventListener('submit', event => { event.preventDefault(); submit(Boolean(keyInput.value.trim())); });
retry.addEventListener('click', async () => {
  if (busy || !comparison) return;
  if (!retryKey.value.trim()) { showError('API 키를 입력한 뒤 다시 눌러 주세요.'); retryKey.focus(); return; }
  errorBox.hidden = true; setBusy(true);
  showLoading('fit'); document.querySelector('#loading-title').focus();
  try { await requestRecommendation(retryKey); } finally { setBusy(false); revealResult(); }
});
document.querySelector('#edit-comparison').addEventListener('click', () => {
  if (busy) return;
  retryKey.value = ''; errorBox.hidden = true; statusBox.textContent = ''; showView('input');
  document.querySelector('#target-url').focus();
});
form.addEventListener('input', event => {
  if (event.target !== keyInput) comparison = null;
});
async function loadSavedReferences() {
  setBusy(true);
  try {
    const response = await fetch('/api/profile'); const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (!data.profile) { window.location.replace('/'); return; }
  } catch (error) { showError(error.message || '저장한 옷을 불러오지 못했어요. 내 옷 관리에서 다시 등록해 주세요.'); }
  finally { setBusy(false); }
}
loadSavedReferences();
