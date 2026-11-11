const form = document.querySelector('#profile-form');
const statusBox = document.querySelector('#profile-status');
const errorBox = document.querySelector('#profile-error');
const savedBox = document.querySelector('#saved-profile');
let blockedUntil = 0;
let busy = false;
function showError(message) { errorBox.textContent = message; errorBox.hidden = false; }
async function loadProfile() {
  try {
    const response = await fetch('/api/profile');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    const profile = data.profile;
    if (profile) {
      profile.clothes.forEach((entry, index) => {
        document.querySelector(`#url-${index + 1}`).value = entry.product.source_url;
        document.querySelector(`#size-${index + 1}`).value = entry.size;
        const p = document.createElement('p');
        p.textContent = `${index + 1}. ${entry.product.product_name} · ${entry.size}`;
        document.querySelector('#saved-clothes').append(p);
      });
      const labels = {length_cm: '총장', shoulder_cm: '어깨', chest_width_cm: '가슴단면', sleeve_cm: '소매'};
      document.querySelector('#saved-traits').textContent = Object.entries(profile.measurement_preferences)
        .map(([field, value]) => `${labels[field]} ${value.min}–${value.max}cm`).join(' · ');
      savedBox.hidden = false;
    } else form.hidden = false;
    statusBox.textContent = '';
  } catch (error) { showError(error.message || '저장한 옷을 불러오지 못했어요.'); form.hidden = false; statusBox.textContent = ''; }
}
document.querySelector('#edit-profile').addEventListener('click', () => {
  savedBox.hidden = true; form.hidden = false; document.querySelector('#url-1').focus();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !form.reportValidity()) return;
  if (Date.now() < blockedUntil) { showError(`${Math.ceil((blockedUntil - Date.now()) / 1000)}초 후 다시 시도해 주세요.`); return; }
  const clothes = [1, 2, 3].map(i => ({url: document.querySelector(`#url-${i}`).value.trim(), size: document.querySelector(`#size-${i}`).value.trim()}));
  busy = true; errorBox.hidden = true; form.setAttribute('aria-busy', 'true');
  form.querySelectorAll('input,button').forEach(el => el.disabled = true);
  statusBox.textContent = '옷 3개의 실측과 정보를 확인하고 있어요. 완료되면 다음 화면으로 이동합니다. 잠시 기다려 주세요.';
  try {
    const response = await fetch('/api/profile', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Page-Token': document.querySelector('meta[name="page-token"]').content}, body: JSON.stringify({clothes})});
    const data = await response.json();
    if (response.status === 429 && data.retry_after) blockedUntil = Date.now() + data.retry_after * 1000;
    if (!response.ok) throw new Error(data.error || '저장하지 못했어요.');
    window.location.assign('/compare');
  } catch (error) { showError(error.message); statusBox.textContent = '입력은 그대로 남아 있어요. 정보를 확인하고 다시 시도해 주세요.'; }
  finally { busy = false; form.setAttribute('aria-busy', 'false'); form.querySelectorAll('input,button').forEach(el => el.disabled = false); }
});
loadProfile();
