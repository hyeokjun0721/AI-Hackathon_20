"""Run: python size_webapp.py  ->  http://127.0.0.1:8000 (stdlib only, Render ready)."""
import argparse
import importlib.util
import json
import os
import secrets
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
BACKEND_PATH = ROOT / 'size_recommender_gemini.py'
spec = importlib.util.spec_from_file_location('size_backend', BACKEND_PATH)
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)

CSRF_TOKEN = secrets.token_urlsafe(32)
CACHE = {}
CACHE_LOCK = threading.Lock()
CACHE_TTL = 15 * 60
FIELDS = ['length_cm', 'shoulder_cm', 'chest_width_cm', 'sleeve_cm']
PROFILE_PATH = ROOT / 'data' / 'fit_profile.json'
PROFILE_LOCK = threading.Lock()

# 대표 브랜드 상품별 S/M/L 실제 실측표 기준 데이터
BRAND_PRESETS = {
    "uniqlo_u": {
        "product": {
            "product_name": "[실측기준] 유니클로 U 크루넥 반팔 티셔츠",
            "brand": "UNIQLO",
            "source_url": "https://www.musinsa.com/products/1032469",
            "material": "면 100% (헤비웨이트)",
            "stretch": "보통",
        },
        "sizes": {
            "S": {"length_cm": 65.0, "shoulder_cm": 43.5, "chest_width_cm": 49.5, "sleeve_cm": 21.0},
            "M": {"length_cm": 68.0, "shoulder_cm": 45.5, "chest_width_cm": 52.5, "sleeve_cm": 22.0},
            "L": {"length_cm": 71.0, "shoulder_cm": 47.5, "chest_width_cm": 55.5, "sleeve_cm": 23.0},
        },
    },
    "musinsa_relax": {
        "product": {
            "product_name": "[실측기준] 무신사 스탠다드 릴렉스 핏 크루넥 티셔츠",
            "brand": "MUSINSA STANDARD",
            "source_url": "https://www.musinsa.com/products/1032469",
            "material": "면 100%",
            "stretch": "약간 있음",
        },
        "sizes": {
            "S": {"length_cm": 68.0, "shoulder_cm": 47.5, "chest_width_cm": 52.5, "sleeve_cm": 22.5},
            "M": {"length_cm": 70.0, "shoulder_cm": 49.5, "chest_width_cm": 55.0, "sleeve_cm": 23.5},
            "L": {"length_cm": 72.0, "shoulder_cm": 51.0, "chest_width_cm": 57.0, "sleeve_cm": 24.5},
        },
    },
    "nike_club": {
        "product": {
            "product_name": "[실측기준] 나이키 클럽 플리스 크루넥 맨투맨",
            "brand": "NIKE",
            "source_url": "https://www.musinsa.com/products/1032469",
            "material": "면 80%, 폴리에스터 20% (시보리 밑단)",
            "stretch": "약간 있음",
        },
        "sizes": {
            "S": {"length_cm": 66.0, "shoulder_cm": 47.0, "chest_width_cm": 54.0, "sleeve_cm": 61.0},
            "M": {"length_cm": 68.0, "shoulder_cm": 49.0, "chest_width_cm": 57.0, "sleeve_cm": 62.5},
            "L": {"length_cm": 70.0, "shoulder_cm": 51.5, "chest_width_cm": 60.0, "sleeve_cm": 64.0},
        },
    },
}


def load_profile():
    with PROFILE_LOCK:
        if not PROFILE_PATH.exists():
            return None
        try:
            profile = json.loads(PROFILE_PATH.read_text(encoding='utf-8'))
            if profile['version'] != 1 or not (1 <= len(profile['clothes']) <= 3):
                raise ValueError()
            return profile
        except (ValueError, KeyError, TypeError):
            raise RuntimeError('저장한 옷 정보를 읽지 못했습니다. 첫 화면에서 다시 등록해 주세요.') from None


def save_profile(data):
    preset_brand = data.get('preset_brand')
    preset_size = data.get('preset_size')

    if preset_brand:
        if preset_brand not in BRAND_PRESETS:
            raise ValueError('선택한 대표 상품을 찾을 수 없습니다.')
        brand_item = BRAND_PRESETS[preset_brand]
        if preset_size not in brand_item['sizes']:
            raise ValueError('S, M, L 중 사이즈를 선택해 주세요.')
        clothes = [{
            'product': brand_item['product'],
            'size': preset_size,
            'measurements': brand_item['sizes'][preset_size],
        }]
    else:
        raw_entries = data.get('clothes')
        if not isinstance(raw_entries, list):
            raise ValueError('대표 브랜드 상품을 선택하거나 무신사 URL을 입력해 주세요.')
        entries = [x for x in raw_entries if isinstance(x, dict) and str(x.get('url', '')).strip()]
        if not (1 <= len(entries) <= 3):
            raise ValueError('대표 브랜드 상품을 선택하거나, 잘 맞았던 옷 URL을 최소 1개 입력해 주세요.')
        validated = [(required_text(x, 'url'), required_text(x, 'size', 80)) for x in entries]
        ids = [backend.musinsa_product_id(url) for url, _ in validated]
        if len(set(ids)) != len(ids):
            raise ValueError('서로 다른 옷을 입력해 주세요.')
        clothes = []
        for index, (url, size) in enumerate(validated, 1):
            try:
                product = backend.fetch_product_from_url(url)
                ref = backend.build_reference_clothes(product, size)
            except backend.ProductRateLimitError:
                raise
            except (ValueError, RuntimeError) as exc:
                raise ValueError(f'{index}번째 옷: {exc}') from None
            clothes.append({'product': product, 'size': ref['purchased_size'], 'measurements': ref['measurements']})

    traits = {}
    for field in FIELDS:
        values = [x['measurements'][field] for x in clothes if x['measurements'].get(field) is not None]
        if values:
            traits[field] = {'min': min(values), 'max': max(values), 'average': round(sum(values) / len(values), 1), 'count': len(values)}
    profile = {'version': 1, 'saved_at': datetime.now().astimezone().isoformat(timespec='seconds'),
               'clothes': clothes, 'measurement_preferences': traits,
               'note': '잘 맞았던 옷의 실측 범위입니다. 신체 치수나 체형을 뜻하지 않습니다.'}
    with PROFILE_LOCK:
        PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary = PROFILE_PATH.with_suffix('.tmp')
        temporary.write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(PROFILE_PATH)
    return profile


def required_text(data, key, maximum=2048):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f'{key}: 입력값을 확인해 주세요.')
    return value.strip()


def public_product(product):
    return {k: product.get(k) for k in ['product_name', 'brand', 'source_url', 'measurement_note',
            'material', 'material_status', 'material_source_url', 'reviews', 'reviews_status',
            'review_source_url', 'review_sort', 'review_limit', 'collection_warnings']}


def compare_products(data):
    if 'profile_index' in data:
        profile = load_profile()
        index = data['profile_index']
        if not profile or type(index) is not int or not (0 <= index < len(profile['clothes'])):
            raise ValueError('첫 화면에서 잘 맞았던 옷을 먼저 등록해 주세요.')
        saved = profile['clothes'][index]
        reference_url = saved['product']['source_url']
        target_url = required_text(data, 'target_url')
        fit = required_text(data, 'desired_fit', 160)
        target_id = backend.musinsa_product_id(target_url)
        old = saved['product']
        reference = {
            'reference_url': reference_url,
            'product_name': old['product_name'],
            'purchased_size': saved['size'],
            'fit_satisfaction': '잘 맞음',
            'material': old.get('material'),
            'stretch': old.get('stretch'),
            'desired_fit': fit,
            'measurements': dict(saved['measurements']),
        }
        new = backend.fetch_product_from_url(target_url)
    else:
        reference_url = required_text(data, 'reference_url')
        target_url = required_text(data, 'target_url')
        size = required_text(data, 'reference_size', 80)
        fit = required_text(data, 'desired_fit', 160)
        reference_id = backend.musinsa_product_id(reference_url)
        target_id = backend.musinsa_product_id(target_url)
        old = backend.fetch_product_from_url(reference_url)
        reference = backend.build_reference_clothes(old, size, fit)
        new = old if reference_id == target_id else backend.fetch_product_from_url(target_url)

    normalized = backend.normalize_sizes(new['raw_sizes'])
    if not any(row['status'] == 'ok' for row in normalized.values()):
        raise ValueError('새 상품에 비교 가능한 실측표가 없습니다.')
    rows = []
    for name, entry in normalized.items():
        measurements = entry['measurements']
        gaps = {
            field: round(measurements[field] - reference['measurements'][field], 1)
            for field in FIELDS if measurements.get(field) is not None
            and reference['measurements'].get(field) is not None
        }
        rows.append({'size': name, 'status': entry['status'], 'reason': entry['reason'],
                     'measurements': measurements, 'gaps': gaps})
    comparison_id = secrets.token_urlsafe(24)
    now = time.monotonic()
    with CACHE_LOCK:
        for key in list(CACHE):
            if now - CACHE[key]['created'] > CACHE_TTL:
                CACHE.pop(key)
        while len(CACHE) >= 64:
            CACHE.pop(next(iter(CACHE)))
        CACHE[comparison_id] = {'created': now, 'reference': reference, 'normalized': normalized, 'target_product': new}
    return {'comparison_id': comparison_id, 'reference': {**public_product(old),
            'size': reference['purchased_size'], 'measurements': reference['measurements']},
            'target': public_product(new), 'desired_fit': fit, 'sizes': rows}


def recommend_comparison(data):
    comparison_id = required_text(data, 'comparison_id', 100)
    api_key = required_text(data, 'api_key', 1024)
    with CACHE_LOCK:
        stored = CACHE.get(comparison_id)
        if stored is None or time.monotonic() - stored['created'] > CACHE_TTL:
            CACHE.pop(comparison_id, None)
            raise ValueError('비교 정보가 만료되었습니다. 치수 비교를 다시 실행해 주세요.')
    try:
        return backend.recommend_size(stored['reference'], stored['normalized'], api_key, stored.get('target_product'))
    except (RuntimeError, ValueError) as exc:
        raise RuntimeError(str(exc).replace(api_key, '[숨김]')) from None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def send_body(self, code, body, content_type):
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_json(self, code, data):
        self.send_body(code, json.dumps(data, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')

    def is_external_https(self, hostname):
        return hostname.endswith('.trycloudflare.com') or hostname.endswith('.onrender.com')

    def valid_host(self):
        hostname = self.headers.get('Host', '').split(':')[0]
        return hostname in ('127.0.0.1', 'localhost') or self.is_external_https(hostname)

    def do_GET(self):
        if not self.valid_host():
            return self.send_json(403, {'error': '허용되지 않은 접속 주소입니다.'})
        path = urlsplit(self.path).path
        if path == '/api/profile':
            try:
                return self.send_json(200, {'profile': load_profile()})
            except RuntimeError as exc:
                return self.send_json(500, {'error': str(exc)})
        assets = {'/': ('index.html', 'text/html; charset=utf-8'),
                  '/compare': ('compare.html', 'text/html; charset=utf-8'),
                  '/onboarding.js': ('onboarding.js', 'text/javascript; charset=utf-8'),
                  '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
                  '/style.css': ('style.css', 'text/css; charset=utf-8')}
        if path not in assets:
            return self.send_json(404, {'error': '페이지를 찾지 못했습니다.'})
        name, content_type = assets[path]
        body = (ROOT / 'web' / name).read_bytes()
        if name.endswith('.html'):
            body = body.replace(b'__CSRF_TOKEN__', CSRF_TOKEN.encode())
        self.send_body(200, body, content_type)

    def do_POST(self):
        origin = self.headers.get('Origin')
        host = self.headers.get('Host', '')
        hostname = host.split(':')[0]
        scheme = 'https' if self.is_external_https(hostname) else 'http'
        expected = f'{scheme}://{host}'
        if (not self.valid_host() or (origin is not None and origin != expected)
                or not secrets.compare_digest(self.headers.get('X-Page-Token', ''), CSRF_TOKEN)):
            return self.send_json(403, {'error': '페이지를 새로고침한 뒤 다시 시도해 주세요.'})
        if self.headers.get_content_type() != 'application/json':
            return self.send_json(415, {'error': 'JSON 요청이 필요합니다.'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 16384:
                return self.send_json(413, {'error': '입력 크기가 너무 큽니다.'})
            self.connection.settimeout(15)
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError('입력 형식을 확인해 주세요.')
            if self.path == '/api/profile':
                result = {'profile': save_profile(data)}
            elif self.path == '/api/product':
                result = backend.fetch_product_from_url(required_text(data, 'url'))
            elif self.path == '/api/compare':
                result = compare_products(data)
            elif self.path == '/api/recommend':
                result = recommend_comparison(data)
            else:
                return self.send_json(404, {'error': '요청 경로를 찾지 못했습니다.'})
            self.send_json(200, result)
        except (ValueError, UnicodeError) as exc:
            self.send_json(400, {'error': str(exc)})
        except backend.ProductRateLimitError as exc:
            self.send_json(429, {'error': str(exc), 'retry_after': exc.retry_after})
        except RuntimeError as exc:
            self.send_json(502, {'error': str(exc)})
        except Exception:
            self.send_json(500, {'error': '처리 중 문제가 생겼습니다. 입력을 확인한 뒤 다시 시도해 주세요.'})


def main():
    default_port = int(os.environ.get('PORT', '8000'))
    default_host = '0.0.0.0' if 'PORT' in os.environ else '127.0.0.1'
    parser = argparse.ArgumentParser(description='사이즈 비교 웹사이트')
    parser.add_argument('--port', type=int, default=default_port)
    parser.add_argument('--host', default=default_host)
    args = parser.parse_args()
    try:
        server = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError:
        raise SystemExit(f'포트({args.port})를 사용할 수 없습니다.')
    print(f'웹사이트: http://{args.host}:{server.server_port}', flush=True)
    print('종료: Ctrl+C', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
