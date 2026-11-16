const form = document.querySelector('#compare-form');
const getKey = () => (window.getApiKey ? window.getApiKey() : '').trim();
const topKey = () => document.querySelector('#top-api-key');
const errorBox = document.querySelector('#error');
const statusBox = document.querySelector('#status');
const panel = document.querySelector('.result-panel');
const tag = document.querySelector('#result-tag');
const retry = document.querySelector('#retry-button');
const recommendation = document.querySelector('#recommendation');
const reviewSummary = document.querySelector('#review-summary');
const reviewSummaryButton = document.querySelector('#review-summary-button');
const fields = ['length_cm', 'shoulder_cm', 'chest_width_cm', 'sleeve_cm'];
let comparison = null;
let busy = false;
let blockedUntil = 0;

function element(name, text, className) {
  const el = document.createElement(name);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function setBusy(value) {
  busy = value;
  panel.setAttribute('aria-busy', String(value));
  document.querySelectorAll('input, button, select').forEach(el => el.disabled = value);
}
function showError(message) { errorBox.textContent = message; errorBox.hidden = false; }
async function api(path, body) {
  const response = await fetch(path, {method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Page-Token': document.querySelector('meta[name="page-token"]').content
  }, body: JSON.stringify(body)});
  const data = await response.json();
  if (response.status === 429 && data.retry_after) blockedUntil = Date.now() + data.retry_after * 1000;
  if (!response.ok) throw new Error(data.error || '요청을 처리하지 못했어요.');
  return data;
}
function showRecommendation(title, description, size) {
  recommendation.replaceChildren(element('h3', title));
  if (size) recommendation.append(element('div', size, 'size'));
  recommendation.append(element('p', description));
}
function renderComparison(data) {
  document.querySelector('#empty-state').hidden = true;
  document.querySelector('#results').hidden = false;
  const products = document.querySelector('#products'); products.replaceChildren();
  for (const [label, product] of [['새로 구매할 옷', data.target]]) {
    const box = element('div', undefined, 'product');
    const link = element('a', product.product_name); link.href = product.source_url;
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    box.append(element('small', label), link);
    box.append(element('p', '재질: ' + (product.material || (product.material_status === 'error' ? '수집 실패' : '미제공'))));
    products.append(box);
  }
  renderReviews(data.target);
  const rows = document.querySelector('#size-rows'); rows.replaceChildren();
  for (const item of data.sizes) {
    const tr = element('tr'); tr.dataset.size = item.size;
    const th = element('th', item.size); th.scope = 'row'; tr.append(th);
    if (item.status !== 'ok') {
      const td = element('td', '비교 제외: ' + item.reason); td.colSpan = 4; tr.append(td);
    } else fields.forEach(field => {
      const td = element('td', item.measurements[field] ?? '—');
      if (item.gaps[field] !== undefined) {
        const gap = item.gaps[field]; td.append(element('small', (gap > 0 ? '+' : '') + gap.toFixed(1)));
      }
      tr.append(td);
    });
    rows.append(tr);
  }
  tag.textContent = '실측 비교 완료';
  showRecommendation('치수 비교가 준비됐어요.', 'AI 추천을 받으려면 상단에 Gemini API 키를 저장해 주세요. 원하는 핏: ' + data.desired_fit);
  retry.hidden = false;
}
function renderReviews(product) {
  const reviews = product.reviews || [];
  const list = document.querySelector('#review-list'); list.replaceChildren();
  const details = document.querySelector('#review-details');
  details.open = false;
  details.hidden = !reviews.length;
  reviewSummaryButton.hidden = !reviews.length;
  reviewSummaryButton.textContent = 'AI 후기 요약받기';
  document.querySelector('#review-count').textContent = `최근 후기 ${reviews.length}개 원문 보기`;
  reviewSummary.textContent = reviews.length
    ? `최근 후기 ${reviews.length}개를 가져왔어요. Gemini API 키로 요약할 수 있어요.`
    : (product.reviews_status === 'error' ? '후기를 가져오지 못했어요.' : '요약할 구매 후기가 없어요.');
  for (const review of reviews) {
    const item = element('article', undefined, 'review-item');
    item.append(element('p', review.content));
    item.append(element('small', `${review.created_at} · 별점 ${review.rating ?? '미제공'} · 구매 옵션 ${review.purchased_option ?? '미제공'}`));
    const source = element('a', '후기 원문'); source.href = review.source_url;
    source.target = '_blank'; source.rel = 'noopener noreferrer'; item.append(source);
    list.append(item);
  }
}
async function requestReviewSummary() {
  if (!comparison?.target.reviews?.length) return;
  const apiKey = getKey();
  if (!apiKey) { reviewSummary.textContent = '후기 요약을 받으려면 상단에 Gemini API 키를 저장해 주세요.'; topKey()?.focus(); return; }
  reviewSummary.textContent = '최근 구매 후기를 요약하고 있어요…';
  reviewSummaryButton.hidden = true;
  try {
    const result = await api('/api/review-summary', {comparison_id: comparison.comparison_id, api_key: apiKey});
    reviewSummary.textContent = result.summary
      ? `최근 후기 ${result.review_count}개 기준 AI 요약\n${result.summary}`
      : '요약할 구매 후기가 없어요.';
  } catch (error) {
    reviewSummary.textContent = '후기 요약에 실패했어요. ' + error.message;
    reviewSummaryButton.textContent = '후기 요약 다시 받기';
    reviewSummaryButton.hidden = false;
  }
}
async function requestRecommendation() {
  const apiKey = getKey();
  if (!apiKey) { showError('상단에 Gemini API 키를 입력하고 저장해 주세요. 키 없이 치수 비교만 할 수도 있어요.'); topKey()?.focus(); return; }
  statusBox.textContent = 'AI가 치수와 원하는 핏을 비교하고 있어요. 잠시 기다려 주세요.';
  tag.textContent = 'AI 추천 중'; retry.hidden = true;
  showRecommendation('내 옷과 가장 가까운 사이즈를 찾고 있어요.', '위 비교표는 이미 수집한 실제 치수입니다.');
  try {
    const result = await api('/api/recommend', {comparison_id: comparison.comparison_id, api_key: apiKey});
    if (result.ok) {
      showRecommendation('새 옷의 추천 사이즈', result.reason, result.recommended_size);
      document.querySelectorAll('#size-rows tr').forEach(row => row.classList.toggle('selected-row', row.dataset.size === result.recommended_size));
      tag.textContent = '추천 완료';
    } else {
      showRecommendation('확실한 사이즈를 고르기 어려워요.', result.message);
      tag.textContent = '추천 보류';
    }
    if (result.limitations) recommendation.append(element('small', result.limitations));
    statusBox.textContent = '완료됐어요. 비교표와 추천 이유를 함께 확인해 주세요.';
  } catch (error) {
    showRecommendation('치수 비교는 완료했어요.', 'AI 추천에 연결하지 못했어요. 비교 결과는 그대로 남아 있습니다.');
    showError(error.message); tag.textContent = 'AI 추천 실패'; statusBox.textContent = '';
  } finally { retry.hidden = false; }
  await requestReviewSummary();
}
async function submit(withAI) {
  if (busy || !form.reportValidity()) return;
  if (Date.now() < blockedUntil) {
    showError(`무신사 요청 제한 대기 중입니다. ${Math.ceil((blockedUntil - Date.now()) / 1000)}초 후 다시 시도해 주세요.`);
    return;
  }
  if (withAI && !getKey()) { showError('AI 추천을 받으려면 상단에 API 키를 입력하고 저장해 주세요.'); topKey()?.focus(); return; }
  errorBox.hidden = true;
  const body = Object.fromEntries(new FormData(form));
  body.profile_index = 0; // 기존 기본 기준(첫 번째 저장한 옷)을 내부적으로 재사용합니다.
  setBusy(true); comparison = null; retry.hidden = true;
  document.querySelector('#results').hidden = true; document.querySelector('#empty-state').hidden = false;
  tag.textContent = '정보 수집 중'; statusBox.textContent = '새 상품의 사이즈표, 재질, 최근 후기 최대 5개를 가져오고 있어요…';
  try {
    comparison = await api('/api/compare', body); renderComparison(comparison);
    if (withAI) await requestRecommendation();
    else statusBox.textContent = '비교를 완료했어요. 반복 요청을 줄이기 위해 수집 정보는 최대 5분간 재사용합니다.';
  } catch (error) {
    showError(error.message); tag.textContent = '입력 확인'; statusBox.textContent = '';
  } finally { setBusy(false); }
}
form.addEventListener('submit', event => { event.preventDefault(); submit(true); });
document.querySelector('#compare-button').addEventListener('click', () => submit(false));
reviewSummaryButton.addEventListener('click', async () => {
  if (busy || !comparison) return;
  setBusy(true);
  try { await requestReviewSummary(); } finally { setBusy(false); }
});
retry.addEventListener('click', async () => {
  if (busy || !comparison) return;
  if (!getKey()) { showError('상단에 API 키를 입력하고 저장한 뒤 다시 눌러 주세요.'); topKey()?.focus(); return; }
  errorBox.hidden = true; setBusy(true);
  try { await requestRecommendation(); } finally { setBusy(false); }
});
form.addEventListener('input', event => {
  if (!comparison) return;
  comparison = null; retry.hidden = true;
  document.querySelector('#results').hidden = true; document.querySelector('#empty-state').hidden = false;
  tag.textContent = '다시 비교 필요'; statusBox.textContent = '입력이 바뀌었어요. 다시 비교해 주세요.';
});

async function loadSavedReferences() {
  setBusy(true);
  try {
    const response = await fetch('/api/profile');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (!data.profile) { window.location.replace('/'); return; }
    setBusy(false);
  } catch (error) { showError(error.message || '저장한 옷을 불러오지 못했어요. 첫 화면에서 다시 등록해 주세요.'); }
}
loadSavedReferences();
