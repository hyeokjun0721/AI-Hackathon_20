import unittest
from unittest.mock import patch
from email.message import Message
from urllib.error import HTTPError
import size_recommender_gemini as app


class RateLimitTests(unittest.TestCase):
    def setUp(self):
        app.RESOURCE_CACHE.clear()
        app.RESOURCE_BLOCKED_UNTIL.clear()
        app.RESOURCE_LAST_REQUEST = 0

    def test_success_cached_then_expires(self):
        with patch.object(app.time, 'monotonic', return_value=1000) as clock, \
             patch.object(app, '_read_product_resource', return_value='real response') as read:
            self.assertEqual(app.read_product_resource('https://www.musinsa.com/products/123', ''), 'real response')
            app.read_product_resource('https://www.musinsa.com/products/123', '')
            self.assertEqual(read.call_count, 1)
            clock.return_value = 1301
            app.read_product_resource('https://www.musinsa.com/products/123', '')
            self.assertEqual(read.call_count, 2)

    def test_rate_limit_blocks_other_requests_on_same_host_until_expiry(self):
        with patch.object(app.time, 'monotonic', return_value=1000) as clock, \
             patch.object(app, '_read_product_resource', side_effect=[app.ProductRateLimitError(120), 'ok']) as read:
            with self.assertRaises(app.ProductRateLimitError):
                app.read_product_resource('https://www.musinsa.com/products/123', '')
            with self.assertRaises(app.ProductRateLimitError):
                app.read_product_resource('https://www.musinsa.com/products/456', '')
            self.assertEqual(read.call_count, 1)
            clock.return_value = 1121
            self.assertEqual(app.read_product_resource('https://www.musinsa.com/products/456', ''), 'ok')

    def test_retry_after_header_and_date(self):
        headers = Message()
        headers['Retry-After'] = '120'
        with patch.object(app.urllib.request, 'urlopen', side_effect=HTTPError('https://www.musinsa.com',429,'limited',headers,None)):
            with self.assertRaises(app.ProductRateLimitError) as error:
                app._read_product_resource('https://www.musinsa.com', '')
        self.assertEqual(error.exception.retry_after,120)
        self.assertEqual(app.retry_after_seconds(None),60)
        with patch.object(app.time,'time',return_value=0):
            self.assertEqual(app.retry_after_seconds('Thu, 01 Jan 1970 00:02:00 GMT'),120)


if __name__ == '__main__':
    unittest.main()
