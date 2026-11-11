import json
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit, parse_qs

import size_recommender_gemini as app
import size_webapp as web
from test_product_extraction import fixture


def response(data):
    return {'meta': {'result': 'SUCCESS'}, 'data': data}


def review():
    return {'no': 456, 'goods': {'goodsNo': 123}, 'content': '편안해요',
            'createDate': '2026-11-11T09:00:00+09:00', 'grade': '5', 'goodsOption': 'M'}


class ExtrasTests(unittest.TestCase):
    def test_full_fetch_and_latest_one_query(self):
        html, sizes = fixture()
        material = response({'essentials': [{'name': '제품 소재', 'value': '면 100%'}]})
        reviews = response({'list': [review(), review()]})
        with patch.object(app, 'read_product_resource', side_effect=[
                html, json.dumps(sizes), json.dumps(material), json.dumps(reviews)]) as read:
            product = app.fetch_product_from_url('https://www.musinsa.com/products/123')
        self.assertEqual(product['material'], '면 100%')
        self.assertEqual(len(product['reviews']), 1)
        self.assertEqual(product['reviews'][0]['rating'], 5)
        query = parse_qs(urlsplit(read.call_args.args[0]).query)
        self.assertEqual(query['sort'], ['new'])
        self.assertEqual(query['pageSize'], ['1'])
        self.assertEqual(query['page'], ['0'])
        self.assertEqual(query['selectedSimilarNo'], ['123'])
        self.assertEqual(web.public_product(product)['reviews'], product['reviews'])

    def test_missing_and_error_are_distinct(self):
        with patch.object(app, 'read_product_resource', side_effect=[
                json.dumps(response({'essentials': []})), json.dumps(response({'list': []}))]):
            empty = app.fetch_product_extras('123', 'https://www.musinsa.com/products/123')
        self.assertEqual(empty['material_status'], 'not_available')
        self.assertEqual(empty['reviews_status'], 'not_available')
        with patch.object(app, 'read_product_resource', side_effect=[RuntimeError('HTTP 403'), '{bad json']):
            failed = app.fetch_product_extras('123', 'https://www.musinsa.com/products/123')
        self.assertEqual(failed['material_status'], 'error')
        self.assertEqual(failed['reviews_status'], 'error')
        self.assertEqual(failed['reviews'], [])

    def test_wrong_product_and_invalid_date_rejected(self):
        row = review()
        with self.assertRaises(ValueError):
            app.parse_latest_reviews(response({'list': [row]}), '789')
        row['createDate'] = 'unknown'
        with self.assertRaises(ValueError):
            app.parse_latest_reviews(response({'list': [row]}), '123')

    def test_extra_failure_preserves_measurements(self):
        html, sizes = fixture()
        with patch.object(app, 'read_product_resource', side_effect=[
                html, json.dumps(sizes), RuntimeError('HTTP 503'), RuntimeError('HTTP 503')]):
            product = app.fetch_product_from_url('https://www.musinsa.com/products/123')
        self.assertEqual(product['raw_sizes']['M']['shoulder_cm'], '51.5cm')
        self.assertEqual(product['reviews_status'], 'error')


if __name__ == '__main__':
    unittest.main()
