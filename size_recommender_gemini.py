"""
잘 맞았던 옷 URL -> 구매 사이즈 -> 새 옷 URL -> 실측 비교 -> Gemini 추천
실행하면 URL과 사이즈를 input()으로 입력받습니다.
현재 무신사 상품 URL과 어깨·총장·가슴단면이 있는 상의를 지원합니다.
"""
import json
import re
import os
import getpass
import urllib.request
import urllib.error
import socket
import ssl
import time
import argparse
import math
import threading
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from urllib.parse import urlsplit
from datetime import datetime
from pathlib import Path

GEMINI_MODEL = ""
GEMINI_TIMEOUT_SECONDS = 180
GEMINI_DIAGNOSTIC_TIMEOUT_SECONDS = 20
PRODUCT_FETCH_TIMEOUT_SECONDS = 25
RESOURCE_CACHE_TTL = 300
RESOURCE_CACHE = {}
RESOURCE_LOCK = threading.Lock()
RESOURCE_BLOCKED_UNTIL = {}
RESOURCE_LAST_REQUEST = 0.0
GEMINI_API_KEY = ""


class ProductRateLimitError(RuntimeError):
    def __init__(self, seconds):
        self.retry_after = max(1, math.ceil(seconds))
        super().__init__(f'무신사가 요청을 일시 제한했습니다 (HTTP 429). '
                         f'{self.retry_after}초 후 다시 시도해 주세요. 대기 중에는 추가 요청을 보내지 않습니다.')


def retry_after_seconds(value):
    try:
        seconds = float(value)
        if math.isfinite(seconds):
            return max(1, math.ceil(seconds))
    except (ValueError, TypeError):
        pass
    try:
        return max(1, math.ceil(parsedate_to_datetime(value).timestamp() - time.time()))
    except (ValueError, TypeError, OverflowError, AttributeError):
        return 60


FIELD_NAMES = {
    "shoulder_cm": "어깨너비",
    "length_cm": "총장",
    "chest_width_cm": "가슴단면",
    "sleeve_cm": "소매길이",
}

REQUIRED_FIELDS = ["shoulder_cm", "length_cm", "chest_width_cm"]
OPTIONAL_FIELDS = ["sleeve_cm"]

# 기획 의도 기반 부위별 중요도 가중치 (어깨 40% / 가슴 40% / 총장 20%)
PLANNED_WEIGHTS = {
    "shoulder_cm": 0.40,
    "chest_width_cm": 0.40,
    "length_cm": 0.20,
}

VALID_RANGE_CM = {
    "shoulder_cm": (20.0, 80.0),
    "length_cm": (30.0, 120.0),
    "chest_width_cm": (30.0, 90.0),
    "sleeve_cm": (5.0, 40.0),
}
MISSING_MARKERS = {"", "-", "미제공", "none", "null"}


def musinsa_product_id(url):
    """지원하는 상품 URL에서 ID만 읽고 요청 주소는 고정된 도메인으로 구성합니다."""
    try:
        parsed = urlsplit(url.strip())
        if (parsed.scheme not in ('http', 'https')
                or parsed.hostname not in ('www.musinsa.com', 'musinsa.com', 'store.musinsa.com', 'm.musinsa.com')
                or parsed.username or parsed.password or parsed.port not in (None, 80, 443)):
            raise ValueError()
        match = re.fullmatch(r'/(?:products|app/goods|goods)/(\d+)/?', parsed.path)
        if not match:
            raise ValueError()
        return str(int(match.group(1)))
    except (ValueError, AttributeError):
        raise ValueError('무신사 상품 URL을 입력해 주세요. 예: https://www.musinsa.com/products/1032469') from None


class ProductPageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_data = False
        self.chunks = []

    def handle_starttag(self, tag, attrs):
        if tag == 'script' and dict(attrs).get('id') == '__NEXT_DATA__':
            self.in_data = True

    def handle_data(self, data):
        if self.in_data:
            self.chunks.append(data)

    def handle_endtag(self, tag):
        if tag == 'script':
            self.in_data = False


def read_product_resource(url, source_url):
    """같은 공개 응답은 5분간 재사용하며 동시 요청과 429 재요청을 억제합니다."""
    global RESOURCE_LAST_REQUEST
    host = urlsplit(url).hostname
    with RESOURCE_LOCK:
        now = time.monotonic()
        cached = RESOURCE_CACHE.get(url)
        if cached and now - cached[0] < RESOURCE_CACHE_TTL:
            return cached[1]
        remaining = RESOURCE_BLOCKED_UNTIL.get(host, 0) - now
        if remaining > 0:
            raise ProductRateLimitError(remaining)
        delay = 1 - (now - RESOURCE_LAST_REQUEST)
        if delay > 0:
            time.sleep(delay)
        RESOURCE_LAST_REQUEST = time.monotonic()
        try:
            content = _read_product_resource(url, source_url)
        except ProductRateLimitError as exc:
            RESOURCE_BLOCKED_UNTIL[host] = time.monotonic() + exc.retry_after
            raise
        for key in list(RESOURCE_CACHE):
            if time.monotonic() - RESOURCE_CACHE[key][0] >= RESOURCE_CACHE_TTL:
                RESOURCE_CACHE.pop(key)
        if len(RESOURCE_CACHE) >= 16:
            RESOURCE_CACHE.pop(next(iter(RESOURCE_CACHE)))
        RESOURCE_CACHE[url] = (time.monotonic(), content)
        return content


def _read_product_resource(url, source_url):
    """공개 상품 정보만 조회합니다. Gemini 키나 로그인 쿠키는 보내지 않습니다."""
    request = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json,text/html',
        'Referer': source_url,
    })
    try:
        with urllib.request.urlopen(request, timeout=PRODUCT_FETCH_TIMEOUT_SECONDS) as response:
            content = response.read(5_000_001)
        if len(content) > 5_000_000:
            raise RuntimeError('상품 응답이 너무 커서 수집을 중단했습니다.')
        return content.decode('utf-8')
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            raise ProductRateLimitError(retry_after_seconds(exc.headers.get('Retry-After'))) from None
        raise RuntimeError(f'무신사 정보 수집 실패 (HTTP {exc.code}). 접근 차단 또는 상품 상태를 확인해 주세요.') from None
    except (urllib.error.URLError, TimeoutError, ConnectionError, ssl.SSLError) as exc:
        raise RuntimeError('무신사 정보 수집 실패: ' + connection_error_message(exc, PRODUCT_FETCH_TIMEOUT_SECONDS)) from None
    except UnicodeError:
        raise RuntimeError('상품 응답의 문자 인코딩을 읽지 못했습니다.') from None


def parse_musinsa_product(page_html, size_response, product_id):
    """응답 구조가 바뀌거나 실측표가 없으면 추측하거나 예시 치수로 대체하지 않습니다."""
    parser = ProductPageParser()
    parser.feed(page_html)
    try:
        page = json.loads(''.join(parser.chunks))['props']['pageProps']
        detail = next(
            q['state']['data']['data']
            for q in page['dehydratedState']['queries']
            if q.get('queryKey') == ['Detail', int(product_id)]
        )
        if str(detail['goodsNo']) != product_id or not detail.get('goodsNm'):
            raise ValueError()
        if size_response['meta']['result'] != 'SUCCESS':
            raise ValueError()
        size_data = size_response['data']
        rows = size_data['sizes']
        if not isinstance(rows, list) or not rows:
            raise ValueError()
        fields = {label: field for field, label in FIELD_NAMES.items()}
        raw_sizes = {}
        for row in rows:
            size_name = row['name']
            if not isinstance(size_name, str) or not size_name.strip() or size_name in raw_sizes:
                raise ValueError()
            measurements = {field: None for field in FIELD_NAMES}
            seen = set()
            for item in row['items']:
                field = fields.get(item.get('name'))
                if field is None:
                    continue
                if field in seen:
                    raise ValueError()
                seen.add(field)
                value = item.get('value')
                if value is None or value == 0:
                    continue
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                    raise ValueError()
                measurements[field] = f'{value}cm'
            raw_sizes[size_name] = measurements
        price = detail.get('goodsPrice') or {}
        brand = detail.get('brandInfo') or {}
        return {
            'source_url': f'https://www.musinsa.com/products/{product_id}',
            'size_source_url': f'https://goods-detail.musinsa.com/api2/goods/{product_id}/actual-size',
            'fetched_at': datetime.now().astimezone().isoformat(timespec='seconds'),
            'product_id': product_id,
            'brand': brand.get('brandName') or detail.get('brand'),
            'product_name': detail['goodsNm'],
            'listed_price': price.get('salePrice'),
            'currency': price.get('currency', 'KRW'),
            'description': detail.get('mdOpinion') or '',
            'measurement_note': size_data.get('description') or '',
            'raw_sizes': raw_sizes,
        }
    except (ValueError, KeyError, TypeError, StopIteration, AttributeError):
        raise RuntimeError('상품 정보 또는 실측표를 읽지 못했습니다. 사이즈표 미제공이나 무신사 응답 구조 변경을 확인해 주세요.') from None


def parse_material(response):
    if response.get('meta', {}).get('result') != 'SUCCESS':
        raise ValueError('재질 조회 실패')
    items = response['data']['essentials']
    if not isinstance(items, list):
        raise ValueError('재질 응답 형식 변경')
    for item in items:
        if item.get('name', '').strip() in ('제품 소재', '소재', '재질'):
            value = item.get('value')
            if value is not None and not isinstance(value, str):
                raise ValueError('재질 응답 형식 변경')
            return (value.strip() or None) if value else None
    return None


def parse_latest_reviews(response, product_id):
    """서버 최신순 첫 페이지에서 최대 5개를 보존. 다른 상품 후기는 섞지 않습니다."""
    if response.get('meta', {}).get('result') != 'SUCCESS':
        raise ValueError('후기 조회 실패')
    rows = response['data']['list']
    if not isinstance(rows, list):
        raise ValueError('후기 응답 형식 변경')
    if not rows:
        return []
    reviews = []
    for row in rows[:5]:
        if str(row['goods']['goodsNo']) != product_id:
            continue
        content, created_at = row['content'], row['createDate']
        if not isinstance(content, str) or not isinstance(created_at, str):
            continue
        datetime.fromisoformat(created_at)
        review_id = str(row['no'])
        if not review_id.isdigit():
            continue
        rating = float(row['grade']) if row.get('grade') is not None else None
        if rating is not None and (not math.isfinite(rating) or not 0 <= rating <= 5):
            rating = None
        reviews.append({
            'review_id': review_id,
            'content': content,
            'created_at': created_at,
            'rating': rating,
            'purchased_option': row.get('goodsOption'),
            'source_url': f'https://www.musinsa.com/review/{review_id}',
        })
    return reviews


def fetch_product_extras(product_id, source_url):
    material_url = f'https://goods-detail.musinsa.com/api2/goods/{product_id}/essential'
    review_url = ('https://goods.musinsa.com/api2/review/v1/view/list'
                  f'?page=0&pageSize=5&goodsNo={product_id}&sort=new&selectedSimilarNo={product_id}')
    result = {'material': None, 'material_source_url': material_url,
              'reviews': [], 'review_source_url': review_url, 'review_sort': 'latest',
              'review_limit': 5, 'collection_warnings': []}
    for field, url, parse in [('material', material_url, parse_material),
                               ('reviews', review_url, lambda data: parse_latest_reviews(data, product_id))]:
        try:
            result[field] = parse(json.loads(read_product_resource(url, source_url)))
            result[field + '_status'] = 'ok' if result[field] else 'not_available'
        except (RuntimeError, ValueError, KeyError, TypeError, AttributeError) as exc:
            result[field + '_status'] = 'error'
            result['collection_warnings'].append(
                ('재질' if field == 'material' else '후기') + ' 수집 실패: ' + str(exc))
    return result


def fetch_product_from_url(url):
    product_id = musinsa_product_id(url)
    source_url = f'https://www.musinsa.com/products/{product_id}'
    page = read_product_resource(source_url, source_url)
    api_url = f'https://goods-detail.musinsa.com/api2/goods/{product_id}/actual-size'
    try:
        sizes = json.loads(read_product_resource(api_url, source_url))
    except ValueError:
        raise RuntimeError('무신사 실측 API가 JSON을 반환하지 않았습니다.') from None
    product = parse_musinsa_product(page, sizes, product_id)
    product.update(fetch_product_extras(product_id, source_url))
    return product


def parse_measurement(field, raw_value):
    name = FIELD_NAMES[field]
    if raw_value is None:
        raise ValueError(f"{name} 누락")
    text = str(raw_value).strip()
    if text.lower() in MISSING_MARKERS:
        raise ValueError(f"{name} 누락")
    match = re.search(r"[+-]?\d+(?:\.\d+)?", text)
    if match is None:
        raise ValueError(f"{name} 숫자를 읽을 수 없음: '{text}'")
    value = float(match.group())
    if "mm" in text.lower():
        value = value / 10.0
    if field == "chest_width_cm" and "둘레" in text:
        value = value / 2.0
    low, high = VALID_RANGE_CM[field]
    if not (low <= value <= high):
        raise ValueError(f"{name} 값({value:.1f}cm)이 상식 범위({low:.0f}~{high:.0f}cm) 밖")
    return round(value, 1)


def normalize_sizes(raw_sizes):
    """
    Soft Fallback 적용:
    일부 부위가 누락되더라도 최소 2개 이상의 핵심 치수(어깨/가슴/총장)가 유효하면
    추천 후보로 살리고 missing_fields에 누락 부위만 기록합니다.
    """
    today = datetime.now().strftime("%Y-%m-%d")
    result = {}

    for size_name, raw in raw_sizes.items():
        entry = {
            "status": "ok",
            "reason": "",
            "missing_fields": [],
            "checked_at": today,
            "measurements": {},
        }
        valid_required = 0
        for field in REQUIRED_FIELDS:
            try:
                entry["measurements"][field] = parse_measurement(field, raw.get(field))
                valid_required += 1
            except ValueError as e:
                entry["measurements"][field] = None
                entry["missing_fields"].append(str(e))

        if valid_required < 2:
            entry["status"] = "needs_review"
            entry["reason"] = "비교 가능한 핵심 치수 부족 (" + ", ".join(entry["missing_fields"]) + ")"
            entry["measurements"] = {}
        else:
            if entry["missing_fields"]:
                entry["reason"] = "부분 측정 기반 (" + ", ".join(entry["missing_fields"]) + ")"
            for field in OPTIONAL_FIELDS:
                try:
                    entry["measurements"][field] = parse_measurement(field, raw.get(field))
                except ValueError:
                    entry["measurements"][field] = None

        result[size_name] = entry

    return result


def evaluate_planned_fit_score(ref_measurements, cand_measurements, target_material="", target_name=""):
    """
    기획안 반영 정량 평가 로직:
    1) 부위별 가중치: 어깨 40%, 가슴 40%, 총장 20%
    2) 원단 신축성 보정: 스판/폴리우레탄/니트/골지/저지 등은 타이트 허용치 완화
    3) 밑단 시보리 보정: 후드/맨투맨/시보리 언급 시 총장 +2~3cm 허용
    """
    material_text = f"{target_material or ''} {target_name or ''}".lower()
    is_stretchy = any(kw in material_text for kw in ("스판", "폴리우레탄", "elastane", "spandex", "니트", "골지", "저지", "울", "캐시미어"))
    has_hem_band = any(kw in material_text for kw in ("시보리", "밴딩", "후드", "스웨트", "맨투맨", "블루종", "점퍼"))

    total_weight = 0.0
    weighted_penalty = 0.0
    details = []

    for field, weight in PLANNED_WEIGHTS.items():
        r_val = ref_measurements.get(field)
        c_val = cand_measurements.get(field)
        if r_val is None or c_val is None:
            continue
        diff = round(c_val - r_val, 1)
        effective_diff = diff

        if is_stretchy and diff < 0:
            effective_diff = min(0.0, diff + 1.5)

        if field == "length_cm" and has_hem_band and diff > 0:
            effective_diff = max(0.0, diff - 2.5)

        penalty = abs(effective_diff)
        if effective_diff < 0:
            penalty *= 1.25

        weighted_penalty += penalty * weight
        total_weight += weight
        details.append(f"{FIELD_NAMES[field]} {diff:+.1f}cm")

    if total_weight == 0:
        return {"similarity_score": 50.0, "fit_tag": "정보 부족", "adjustments": [], "details": details}

    avg_penalty = weighted_penalty / total_weight
    similarity_score = round(max(0.0, min(100.0, 100.0 - avg_penalty * 11.5)), 1)

    if similarity_score >= 88:
        fit_tag = "이상적 정핏 일치"
    elif similarity_score >= 75:
        fit_tag = "자연스러운 착용 가능"
    elif similarity_score >= 60:
        fit_tag = "약간 여유/타이트한 변형 핏"
    else:
        fit_tag = "사이즈 편차 큼"

    adjustments = []
    if is_stretchy:
        adjustments.append("신축성 원단 보정 적용")
    if has_hem_band:
        adjustments.append("밑단 시보리 기장 보정 적용")

    return {
        "similarity_score": similarity_score,
        "fit_tag": fit_tag,
        "adjustments": adjustments,
        "details": details,
    }


def connection_error_message(exc, timeout_seconds=None):
    if timeout_seconds is None:
        timeout_seconds = GEMINI_TIMEOUT_SECONDS
    reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
    if isinstance(reason, TimeoutError):
        return f'응답 대기 시간이 초과되었습니다 (최대 {timeout_seconds}초). 잠시 후 다시 실행해 주세요.'
    if isinstance(reason, socket.gaierror):
        return 'Google API 서버 주소를 찾지 못했습니다 (DNS 오류). 인터넷 또는 VPN 설정을 확인해 주세요.'
    if isinstance(reason, ssl.SSLCertVerificationError):
        return 'HTTPS 인증서 검증에 실패했습니다. PC 시간과 네트워크 인증서 설정을 확인해 주세요.'
    if isinstance(reason, ssl.SSLError):
        return 'Google API와 HTTPS 보안 연결을 맺지 못했습니다 (SSL 오류).'
    if isinstance(reason, ConnectionError):
        return f'서버 또는 중간 네트워크가 연결을 끊거나 거부했습니다 ({type(reason).__name__}).'
    return f'연결 오류: {type(reason).__name__}, 오류 번호 {getattr(reason, "errno", "없음")}.'


def select_model(api_key):
    configured = GEMINI_MODEL.strip() or os.environ.get('GEMINI_MODEL', '').strip()
    if configured:
        configured = configured.removeprefix('models/')
        if not re.fullmatch(r'[A-Za-z0-9._-]+', configured):
            raise ValueError('GEMINI_MODEL에는 모델 이름만 입력해 주세요.')
        return configured

    names = []
    page_token = ''
    while True:
        url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'
        if page_token:
            from urllib.parse import quote
            url += '&pageToken=' + quote(page_token, safe='')
        request = urllib.request.Request(url, headers={'x-goog-api-key': api_key})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.load(response)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f'모델 목록 조회 실패 (HTTP {exc.code}). API 키와 사용 권한을 확인해 주세요.') from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, ssl.SSLError) as exc:
            raise RuntimeError('모델 목록 조회 실패: ' + connection_error_message(exc, 30)) from None
        for entry in data.get('models', []):
            name = entry.get('name', '').removeprefix('models/')
            if 'generateContent' in entry.get('supportedGenerationMethods', []):
                names.append(name)
        page_token = data.get('nextPageToken', '')
        if not page_token:
            break

    lite = [name for name in names if re.fullmatch(r'gemini-\d+(?:\.\d+)?-flash-lite(?:-\d+)?', name)]
    if lite:
        return max(lite, key=lambda name: tuple(int(n) for n in re.findall(r'\d+', name)))
    stable = [name for name in names if re.fullmatch(r'gemini-\d+(?:\.\d+)?-flash(?:-\d+)?', name)]
    if stable:
        return max(stable, key=lambda name: tuple(int(n) for n in re.findall(r'\d+', name)))
    if 'gemini-flash-latest' in names:
        return 'gemini-flash-latest'
    raise RuntimeError('자동 선택할 Flash 모델이 없습니다. GEMINI_MODEL에 사용 가능한 텍스트 모델을 지정해 주세요.')


def generation_config(model):
    config = {'maxOutputTokens': 4096}
    if re.match(r'^gemini-2\.5-flash(?:-|$)', model):
        config['thinkingConfig'] = {'thinkingBudget': 0}
    elif re.match(r'^gemini-3(?:\.|-)', model) and 'flash' in model:
        config['thinkingConfig'] = {'thinkingLevel': 'low'}
    return config


def make_generation_request(model, api_key, payload):
    return urllib.request.Request(
        f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'x-goog-api-key': api_key},
        method='POST',
    )


def recommend_size(user_ref, normalized_sizes, api_key, target_product=None):
    """
    인자 3개/4개 호환 + 부위별 가중치(40/40/20) 및 원단·시보리 보정 분석 결과를 결합해
    Gemini가 최종 추천 사이즈와 근거를 생성합니다.
    """
    available = {
        size: entry['measurements']
        for size, entry in normalized_sizes.items() if entry['status'] == 'ok'
    }
    excluded = {
        size: entry['reason']
        for size, entry in normalized_sizes.items() if entry['status'] != 'ok'
    }
    if not available:
        return {'ok': False, 'message': '검수를 통과한 사이즈가 없습니다.', 'excluded': excluded}

    target_product = target_product or {}
    target_material = target_product.get('material') or ''
    target_name = target_product.get('product_name') or ''
    target_reviews = [r.get('content', '') for r in target_product.get('reviews', []) if r.get('content')]

    planned_analysis = {}
    for size, meas in available.items():
        planned_analysis[size] = evaluate_planned_fit_score(
            user_ref['measurements'],
            meas,
            target_material=target_material,
            target_name=target_name,
        )

    model = select_model(api_key)

    schema = {
        'type': 'OBJECT',
        'properties': {
            'recommended_size': {'type': 'STRING', 'enum': list(available) + ['추천 불가']},
            'reason': {'type': 'STRING'},
            'limitations': {'type': 'STRING'},
        },
        'required': ['recommended_size', 'reason', 'limitations'],
    }
    instructions = (
        '당신은 의류 실측 데이터 기반 사이즈 추천 어시스턴트입니다. 제공된 데이터만 근거로 한국어로 답하세요. '
        'reference_clothes는 사용자의 신체 치수가 아니라 잘 맞았던 기준 옷의 실측(cm)입니다. '
        '부위별 중요도 가중치(어깨너비 40%, 가슴단면 40%, 총장 20%)와 원단 신축성 및 시보리 보정 점수가 담긴 '
        'planned_fit_analysis를 핵심 근거로 참고하여 available_sizes 중 가장 적합한 사이즈 하나를 반드시 선택하세요. '
        '새 상품 자체가 오버핏/드롭숄더 디자인이라 기준 옷보다 어깨나 가슴이 전반적으로 크더라도 "추천 불가"를 내지 말고, '
        'desired_fit(예: 널널한 핏, 비슷한 핏)에 가장 근접한 최선의 사이즈(예: 가장 작은 S 등)를 추천한 뒤 '
        'reason에 "원래 여유 있게 나온 오버핏 제품이라 기준 옷보다 어깨가 +7.5cm 여유롭지만, 선택지 중 가장 알맞다"는 식으로 구체적 수치를 들어 친절하게 설명하세요. '
        '"추천 불가"는 모든 사이즈가 기준 옷보다 현저히 작아 물리적으로 착용이 불가능한 극단적인 경우에만 제한적으로 사용하세요. '
        'limitations는 한 문장으로 작성하세요.'
    )
    payload = {
        'systemInstruction': {'parts': [{'text': instructions}]},
        'contents': [{'role': 'user', 'parts': [{'text': json.dumps({
            'reference_clothes': {
                'product_name': user_ref.get('product_name'),
                'purchased_size': user_ref.get('purchased_size'),
                'measurements': user_ref['measurements'],
                'desired_fit': user_ref.get('desired_fit'),
            },
            'target_product': {
                'product_name': target_name,
                'material': target_material,
                'recent_reviews': target_reviews,
            },
            'available_sizes': available,
            'planned_fit_analysis': planned_analysis,
        }, ensure_ascii=False)}]}],
        'generationConfig': {
            **generation_config(model),
            'responseMimeType': 'application/json',
            'responseSchema': schema,
        },
    }
    request = make_generation_request(model, api_key, payload)
    try:
        with urllib.request.urlopen(request, timeout=GEMINI_TIMEOUT_SECONDS) as response:
            envelope = json.load(response)
    except urllib.error.HTTPError as exc:
        messages = {
            400: 'API 키, 모델 이름 또는 요청 형식을 확인해 주세요.',
            401: 'API 키 인증에 실패했습니다.',
            403: '이 키의 Gemini API 사용 권한을 확인해 주세요.',
            404: f'{model} 모델 호출이 지원되지 않습니다.',
            429: 'API 사용량 또는 요청 횟수 제한에 도달했습니다.',
            503: 'Google Gemini 서버가 일시적으로 혼잡합니다. 5초 후 다시 시도해 주세요.',
        }
        raise RuntimeError(f'Gemini API 오류 ({exc.code}): ' + messages.get(exc.code, '잠시 후 다시 시도해 주세요.')) from None
    except (urllib.error.URLError, TimeoutError, ConnectionError, ssl.SSLError) as exc:
        raise RuntimeError(connection_error_message(exc)) from None
    except ValueError:
        raise RuntimeError('Google API가 JSON 형식의 응답을 반환하지 않았습니다.') from None

    try:
        candidate = envelope['candidates'][0]
        if candidate.get('finishReason') == 'MAX_TOKENS':
            raise RuntimeError('모델이 출력 한도 내에 답변을 끝내지 못했습니다.')
        if candidate.get('finishReason') != 'STOP':
            raise ValueError('응답 미완료')
        response_text = ''.join(
            part.get('text', '') for part in candidate['content']['parts']
            if not part.get('thought')
        )
        answer = json.loads(response_text)
        size = answer['recommended_size']
        if size not in list(available) + ['추천 불가']:
            raise ValueError('후보 밖의 사이즈')
        for field in ('reason', 'limitations'):
            if not isinstance(answer[field], str) or not answer[field].strip():
                raise ValueError('설명 누락')
    except (KeyError, IndexError, TypeError, ValueError):
        raise RuntimeError('Gemini가 유효한 추천 결과를 반환하지 않았습니다. 다시 시도해 주세요.') from None

    if size == '추천 불가':
        return {
            'ok': False,
            'message': answer['reason'],
            'limitations': answer['limitations'],
            'excluded': excluded,
        }

    differences = {
        field: f"{value - user_ref['measurements'][field]:+.1f}cm"
        for field, value in available[size].items()
        if value is not None and user_ref['measurements'].get(field) is not None
    }
    return {
        'ok': True,
        'recommended_size': size,
        'reason': answer['reason'],
        'limitations': answer['limitations'],
        'diff_details': differences,
        'planned_metrics': planned_analysis.get(size, {}),
        'excluded': excluded,
        'model': model,
    }


def build_reference_clothes(product, purchased_size, desired_fit='기준 옷과 비슷한 핏'):
    normalized = normalize_sizes(product['raw_sizes'])
    requested = purchased_size.strip().casefold()
    matches = [size for size in normalized if size.strip().casefold() == requested]
    if len(matches) != 1:
        raise ValueError('입력한 사이즈를 찾지 못했습니다. 표에 표시된 사이즈를 입력하세요: '
                         + ', '.join(normalized))
    size = matches[0]
    entry = normalized[size]
    if entry['status'] != 'ok':
        raise ValueError(f'기준 옷 {size}의 치수를 사용할 수 없습니다: {entry["reason"]}')
    return {
        'reference_url': product['source_url'],
        'product_name': product['product_name'],
        'purchased_size': size,
        'fit_satisfaction': '잘 맞음',
        'desired_fit': desired_fit,
        'measurements': dict(entry['measurements']),
    }
