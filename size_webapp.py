"""Run: python size_webapp.py  ->  http://127.0.0.1:8000 (stdlib only)."""
import argparse
import importlib.util
import json
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
BACKEND_PATH = ROOT / 'through_url_data_extraction.py'
if not BACKEND_PATH.exists():
    BACKEND_PATH = ROOT / 'size_recommender_gemini.py'
spec = importlib.util.spec_from_file_location('size_backend', BACKEND_PATH)
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)

CSRF_TOKEN = secrets.token_urlsafe(32)
CACHE = {}
CACHE_LOCK = threading.Lock()
CACHE_TTL = 15 * 60
FIELDS = ['length_cm', 'shoulder_cm', 'chest_width_cm', 'sleeve_cm']


def required_text(data, key, maximum=2048):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f'{key}: 입력값을 확인해 주세요.')
    return value.strip()


def public_product(product):
    return {k: product.get(k) for k in ['product_name', 'brand', 'source_url', 'measurement_note']}


def compare_products(data):
    reference_url = required_text(data, 'reference_url')
    target_url = required_text(data, 'target_url')
    size = required_text(data, 'reference_size', 80)
    fit = required_text(data, 'desired_fit', 160)
    # Validate both addresses before making any network call.
    reference_id = backend.musinsa_product_id(reference_url)
    target_id = backend.musinsa_product_id(target_url)
    old = backend.fetch_product_from_url(reference_url)
    reference = backend.build_reference_clothes(old, size, fit)
    new = old if reference_id == target_id else backend.fetch_product_from_url(target_url)
    normalized = backend.normalize_sizes(new['raw_sizes'])
    if not any(row['status'] == 'ok' for row in normalized.values()):
        raise ValueError('새 상품에 비교 가능한 실측표가 없습니다. 어깨·총장·가슴단면이 있는 상의로 시도해 주세요.')
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
        CACHE[comparison_id] = {'created': now, 'reference': reference, 'normalized': normalized}
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
        # Use only the key entered on this page, never a key hardcoded in the CLI module.
        return backend.recommend_size(stored['reference'], stored['normalized'], api_key)
    except (RuntimeError, ValueError) as exc:
        raise RuntimeError(str(exc).replace(api_key, '[숨김]')) from None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # Do not record request content or keys.

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

    def valid_host(self):
        port = self.server.server_port
        return self.headers.get('Host') in (f'127.0.0.1:{port}', f'localhost:{port}')

    def do_GET(self):
        if not self.valid_host():
            return self.send_json(403, {'error': '로컬 주소로 접속해 주세요.'})
        path = urlsplit(self.path).path
        assets = {'/': ('index.html', 'text/html; charset=utf-8'),
                  '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
                  '/style.css': ('style.css', 'text/css; charset=utf-8')}
        if path not in assets:
            return self.send_json(404, {'error': '페이지를 찾지 못했습니다.'})
        name, content_type = assets[path]
        body = (ROOT / 'web' / name).read_bytes()
        if name == 'index.html':
            body = body.replace(b'__CSRF_TOKEN__', CSRF_TOKEN.encode())
        self.send_body(200, body, content_type)

    def do_POST(self):
        origin = self.headers.get('Origin')
        expected = f'http://{self.headers.get("Host")}'
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
            if self.path == '/api/compare':
                result = compare_products(data)
            elif self.path == '/api/recommend':
                result = recommend_comparison(data)
            else:
                return self.send_json(404, {'error': '요청 경로를 찾지 못했습니다.'})
            self.send_json(200, result)
        except (ValueError, UnicodeError) as exc:
            self.send_json(400, {'error': str(exc)})
        except RuntimeError as exc:
            self.send_json(502, {'error': str(exc)})
        except Exception:
            self.send_json(500, {'error': '처리 중 문제가 생겼습니다. 입력을 확인한 뒤 다시 시도해 주세요.'})


def main():
    parser = argparse.ArgumentParser(description='사이즈 비교 로컬 웹사이트')
    parser.add_argument('--port', type=int, default=8000)
    args = parser.parse_args()
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    except OSError:
        raise SystemExit('포트를 사용할 수 없습니다. python size_webapp.py --port 8001 로 실행해 주세요.')
    print(f'웹사이트: http://127.0.0.1:{server.server_port}', flush=True)
    print('종료: Ctrl+C', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
