import json
import tempfile
import unittest
import threading
import urllib.request
from pathlib import Path
from unittest.mock import patch
import size_webapp as app
from test_two_product_flow import product


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'fit_profile.json'
        self.path_patch = patch.object(app, 'PROFILE_PATH', self.path)
        self.path_patch.start()
        self.data = {'clothes': [{'url': f'https://www.musinsa.com/products/{i}', 'size': 'M'} for i in [123,456,789]]}

    def tearDown(self):
        self.path_patch.stop()
        self.temp.cleanup()

    def save(self):
        with patch.object(app.backend, 'fetch_product_from_url', side_effect=[product(str(i)) for i in [123,456,789]]):
            return app.save_profile(self.data)

    def test_persist_three_and_measurement_ranges(self):
        self.assertIsNone(app.load_profile())
        result = self.save()
        self.assertEqual(len(result['clothes']),3)
        self.assertEqual(app.load_profile(), result)
        self.assertEqual(result['measurement_preferences']['shoulder_cm'], {'min':51.5, 'max':51.5, 'average':51.5, 'count':3})
        self.assertNotIn('api_key',self.path.read_text(encoding='utf-8'))

    def test_bad_count_and_duplicate_rejected_before_fetch(self):
        with patch.object(app.backend, 'fetch_product_from_url') as fetch:
            with self.assertRaises(ValueError): app.save_profile({'clothes':self.data['clothes'][:2]})
            with self.assertRaises(ValueError): app.save_profile({'clothes':[self.data['clothes'][0]]*3})
            fetch.assert_not_called()

    def test_failed_update_preserves_previous_profile(self):
        original = self.save()
        with patch.object(app.backend, 'fetch_product_from_url', side_effect=[product(),RuntimeError('failed')]):
            with self.assertRaises(ValueError): app.save_profile(self.data)
        self.assertEqual(app.load_profile(),original)

    def test_stored_measurements_reused_without_refetch(self):
        self.save()
        with patch.object(app.backend, 'fetch_product_from_url', return_value=product('999')) as fetch:
            result = app.compare_products({'profile_index':1,'target_url':'https://www.musinsa.com/products/999','desired_fit':'비슷한 핏'})
            fetch.assert_called_once_with('https://www.musinsa.com/products/999')
        self.assertEqual(result['reference']['source_url'],'https://www.musinsa.com/products/456')

    def test_wrong_size_does_not_save(self):
        self.data['clothes'][1]['size']='XXXS'
        with patch.object(app.backend, 'fetch_product_from_url', return_value=product()):
            with self.assertRaisesRegex(ValueError,'2번째'): app.save_profile(self.data)
        self.assertFalse(self.path.exists())

    def test_invalid_index(self):
        self.save()
        for index in [-1,3,'0',True]:
            with self.assertRaises(ValueError): app.compare_products({'profile_index':index})

    def test_save_api_and_next_page(self):
        server = app.ThreadingHTTPServer(('127.0.0.1',0), app.Handler)
        thread = threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{server.server_port}'
        try:
            request = urllib.request.Request(base+'/api/profile',data=json.dumps(self.data).encode(),
                headers={'Content-Type':'application/json','X-Page-Token':app.CSRF_TOKEN})
            with patch.object(app.backend,'fetch_product_from_url',side_effect=[product(str(i)) for i in [123,456,789]]):
                with urllib.request.urlopen(request) as result:
                    self.assertEqual(len(json.load(result)['profile']['clothes']),3)
            with urllib.request.urlopen(base+'/api/profile') as result:
                self.assertEqual(len(json.load(result)['profile']['clothes']),3)
            with urllib.request.urlopen(base+'/compare') as result:
                html = result.read().decode()
                self.assertNotIn('saved-reference',html)
                self.assertIn(app.CSRF_TOKEN,html)
                self.assertNotIn('id="reference-url"',html)
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__': unittest.main()
