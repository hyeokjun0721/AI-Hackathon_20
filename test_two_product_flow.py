import contextlib
import copy
import io
import unittest
from unittest.mock import patch

import size_recommender_gemini as app
from test_product_extraction import fixture


def product(product_id='123'):
    html, sizes = fixture()
    result = app.parse_musinsa_product(html, sizes, '123')
    result['source_url'] = f'https://www.musinsa.com/products/{product_id}'
    return result


class TwoProductTests(unittest.TestCase):
    def test_selected_reference_is_actual_measurement(self):
        reference = app.build_reference_clothes(product(), ' m ')
        self.assertEqual(reference['purchased_size'], 'M')
        self.assertEqual(reference['measurements']['shoulder_cm'], 51.5)
        self.assertEqual(reference['desired_fit'], '기준 옷과 비슷한 핏')

    def test_unknown_and_incomplete_reference_rejected(self):
        with self.assertRaises(ValueError):
            app.build_reference_clothes(product(), 'XL')
        missing = product()
        missing['raw_sizes']['M']['shoulder_cm'] = None
        with self.assertRaises(ValueError):
            app.build_reference_clothes(missing, 'M')

    def test_interactive_flow_passes_reference_and_new_sizes_to_gemini(self):
        old, new = product(), product('456')
        new['raw_sizes'] = {'L': copy.deepcopy(new['raw_sizes']['M'])}
        new['raw_sizes']['L']['shoulder_cm'] = '52.5cm'
        answer = {'ok': True, 'recommended_size': 'L', 'reason': 'test',
                  'diff_details': {'shoulder_cm': '+1.0cm'}, 'excluded': {}}
        with patch('builtins.input', side_effect=[old['source_url'], 'M', new['source_url']]), \
             patch.object(app, 'fetch_product_from_url', side_effect=[old, new]) as fetch, \
             patch.object(app, 'GEMINI_API_KEY', 'test-placeholder'), \
             patch.object(app, 'recommend_size', return_value=answer) as recommend, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(app.main([]), 0)
        self.assertEqual(fetch.call_count, 2)
        args = recommend.call_args.args
        self.assertEqual(args[0]['measurements']['shoulder_cm'], 51.5)
        self.assertEqual(args[1]['L']['measurements']['shoulder_cm'], 52.5)
        self.assertEqual(set(args[1]), {'L'})

    def test_bad_interactive_size_reprompts(self):
        old = product()
        with patch('builtins.input', side_effect=[old['source_url'], 'XXXL', 'm', old['source_url']]) as prompt, \
             patch.object(app, 'fetch_product_from_url', return_value=old) as fetch, \
             patch.object(app, 'recommend_size') as recommend, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(app.main(['--compare-only']), 0)
        self.assertEqual(prompt.call_count, 4)
        self.assertEqual(fetch.call_count, 1)
        recommend.assert_not_called()

    def test_cli_bad_size_stops_before_new_product_or_api(self):
        with patch.object(app, 'fetch_product_from_url', return_value=product()) as fetch, \
             patch.object(app, 'recommend_size') as recommend, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(app.main(['--reference-url', 'https://www.musinsa.com/products/123',
                                      '--reference-size', 'XXXL', '--url', 'https://www.musinsa.com/products/456']), 1)
        self.assertEqual(fetch.call_count, 1)
        recommend.assert_not_called()

    def test_comparison_sign_and_same_product(self):
        old = product()
        reference = app.build_reference_clothes(old, 'M')
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            app.show_comparison(reference, old, app.normalize_sizes(old['raw_sizes']))
        self.assertIn('어깨너비 +0.0cm', output.getvalue())


if __name__ == '__main__':
    unittest.main()
