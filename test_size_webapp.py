import json
import threading
import unittest
import urllib.request
import urllib.error
from unittest.mock import patch

import size_webapp as app
from test_two_product_flow import product


class WebTests(unittest.TestCase):
    def setUp(self):
        app.CACHE.clear()
        self.data = {'reference_url': 'https://www.musinsa.com/products/123',
                     'target_url': 'https://www.musinsa.com/products/456',
                     'reference_size': 'M', 'desired_fit': '기준 옷과 비슷한 핏'}

    def compare(self):
        with patch.object(app.backend, 'fetch_product_from_url', side_effect=[product(), product('456')]):
            return app.compare_products(self.data)

    def test_actual_reference_and_target_rows(self):
        result = self.compare()
        self.assertEqual(result['reference']['measurements']['shoulder_cm'], 51.5)
        self.assertEqual(result['sizes'][0]['gaps']['shoulder_cm'], 0)
        self.assertNotIn('api_key', json.dumps(result))

    def test_recommend_uses_entered_key_and_never_caches_it(self):
        result = self.compare()
        with patch.object(app.backend, 'recommend_size', return_value={'ok': True, 'recommended_size': 'M'}) as recommend:
            app.recommend_comparison({'comparison_id': result['comparison_id'], 'api_key': 'temporary-test-key'})
            self.assertEqual(recommend.call_args.args[2], 'temporary-test-key')
        self.assertNotIn('temporary-test-key', json.dumps(app.CACHE))

    def test_failed_ai_keeps_comparison(self):
        result = self.compare()
        with patch.object(app.backend, 'recommend_size', side_effect=RuntimeError('Gemini HTTP 503')):
            with self.assertRaises(RuntimeError):
                app.recommend_comparison({'comparison_id': result['comparison_id'], 'api_key': 'test'})
        self.assertIn(result['comparison_id'], app.CACHE)

    def test_expired_comparison(self):
        result = self.compare()
        app.CACHE[result['comparison_id']]['created'] -= app.CACHE_TTL + 1
        with self.assertRaises(ValueError):
            app.recommend_comparison({'comparison_id': result['comparison_id'], 'api_key': 'test'})

    def test_bad_target_rejected_before_fetch(self):
        self.data['target_url'] = 'http://127.0.0.1/private'
        with patch.object(app.backend, 'fetch_product_from_url') as fetch:
            with self.assertRaises(ValueError):
                app.compare_products(self.data)
            fetch.assert_not_called()

    def test_http_routes_token_and_secret_file_access(self):
        server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{server.server_port}'
        try:
            with urllib.request.urlopen(base) as response:
                page = response.read().decode()
                self.assertIn(app.CSRF_TOKEN, page)
                self.assertEqual(response.headers['Cache-Control'], 'no-store')
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(base + '/through_url_data_extraction.py')
            self.assertEqual(error.exception.code, 404)
            request = urllib.request.Request(base + '/api/compare', data=json.dumps(self.data).encode(),
                                             headers={'Content-Type': 'application/json'})
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(request)
            self.assertEqual(error.exception.code, 403)
            request.add_header('X-Page-Token', app.CSRF_TOKEN)
            with patch.object(app.backend, 'fetch_product_from_url', side_effect=[product(), product('456')]):
                with urllib.request.urlopen(request) as response:
                    self.assertIn('comparison_id', json.load(response))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
