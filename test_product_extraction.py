import contextlib
import io
import json
import unittest
from unittest.mock import patch

import size_recommender_gemini as app


def fixture():
    detail = {'goodsNo': 123, 'goodsNm': '테스트 반팔', 'brandInfo': {'brandName': '테스트'}}
    page = {'props': {'pageProps': {'dehydratedState': {'queries': [
        {'queryKey': ['Detail', 123], 'state': {'data': {'data': detail}}},
    ]}}}}
    html = '<script id="__NEXT_DATA__" type="application/json">' + json.dumps(page) + '</script>'
    sizes = {'meta': {'result': 'SUCCESS'}, 'data': {'sizes': [
        {'name': 'M', 'items': [
            {'name': '총장', 'value': 71}, {'name': '어깨너비', 'value': 51.5},
            {'name': '가슴단면', 'value': 55.5}, {'name': '소매길이', 'value': 25},
        ]},
    ]}}
    return html, sizes


class ProductExtractionTests(unittest.TestCase):
    def test_supported_urls_and_tracking_removal(self):
        for url in ('https://www.musinsa.com/products/123?utm_source=test',
                    'https://store.musinsa.com/app/goods/123'):
            self.assertEqual(app.musinsa_product_id(url), '123')

    def test_reject_unrelated_and_invalid_urls(self):
        for url in ('file:///etc/passwd', 'https://www.musinsa.com.evil.test/products/123',
                    'https://www.musinsa.com@evil.test/products/123',
                    'https://www.musinsa.com:9999/products/123',
                    'https://www.musinsa.com/products/not-a-number'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                app.musinsa_product_id(url)

    def test_real_values_flow_into_normalization(self):
        html, sizes = fixture()
        product = app.parse_musinsa_product(html, sizes, '123')
        normalized = app.normalize_sizes(product['raw_sizes'])
        self.assertEqual(normalized['M']['measurements']['shoulder_cm'], 51.5)
        self.assertEqual(product['product_name'], '테스트 반팔')
        self.assertIn('/123/actual-size', product['size_source_url'])

    def test_zero_required_measurement_excludes_size(self):
        html, sizes = fixture()
        sizes['data']['sizes'][0]['items'][2]['value'] = 0
        product = app.parse_musinsa_product(html, sizes, '123')
        self.assertEqual(app.normalize_sizes(product['raw_sizes'])['M']['status'], 'needs_review')

    def test_missing_optional_measurement_stays_optional(self):
        html, sizes = fixture()
        sizes['data']['sizes'][0]['items'].pop()
        product = app.parse_musinsa_product(html, sizes, '123')
        self.assertEqual(app.normalize_sizes(product['raw_sizes'])['M']['status'], 'ok')

    def test_invalid_or_missing_data_is_not_invented(self):
        html, sizes = fixture()
        for bad_html, bad_sizes, product_id in [
            ('<html>blocked</html>', sizes, '123'),
            (html, {'meta': {'result': 'SUCCESS'}, 'data': {'sizes': []}}, '123'),
            (html, sizes, '456'),
        ]:
            with self.subTest(product_id=product_id), self.assertRaises(RuntimeError):
                app.parse_musinsa_product(bad_html, bad_sizes, product_id)

    def test_duplicate_size_rejected(self):
        html, sizes = fixture()
        sizes['data']['sizes'].append(sizes['data']['sizes'][0])
        with self.assertRaises(RuntimeError):
            app.parse_musinsa_product(html, sizes, '123')

    def test_extract_only_never_asks_for_key_or_calls_gemini(self):
        html, sizes = fixture()
        empty = json.dumps({'meta': {'result': 'SUCCESS'}, 'data': {'essentials': [], 'list': []}})
        with patch.object(app, 'read_product_resource', side_effect=[html, json.dumps(sizes), empty, empty]), \
             patch.object(app, 'recommend_size') as recommend, \
             patch.object(app.getpass, 'getpass') as key_input, \
             contextlib.redirect_stdout(io.StringIO()):
            result = app.main(['--url', 'https://www.musinsa.com/products/123', '--extract-only'])
        self.assertEqual(result, 0)
        recommend.assert_not_called()
        key_input.assert_not_called()

    def test_fetch_failure_does_not_fall_back_to_demo(self):
        with patch.object(app, 'fetch_product_from_url', side_effect=RuntimeError('HTTP 403')), \
             patch.object(app, 'recommend_size') as recommend, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(app.main(['--url', 'https://www.musinsa.com/products/123']), 1)
        recommend.assert_not_called()


if __name__ == '__main__':
    unittest.main()
