# 무신사 URL에서 상품 정보 가져오기

Python 표준 라이브러리만 사용합니다. 추가 패키지 설치는 필요 없습니다.

## 수집만 실행 (API 키 불필요)

```powershell
python size_recommender_gemini.py --url "https://www.musinsa.com/products/1032469" --extract-only
```

상품명, 브랜드, 표시 가격, S/M/L 등의 실측표, 재질, 최신 사용자 후기 1개와 출처를 표시합니다.
무신사 상품 페이지에 포함된 상품 정보와 페이지가 호출하는 실측 API를 읽습니다.
이 단계에서는 생성형 AI를 호출하지 않습니다.

URL을 실행 후 입력하고 JSON 데이터로 저장하려면:

```powershell
python size_recommender_gemini.py --extract-only --output product.json
```

`material`은 상품정보고시의 재질 원문입니다. `reviews`는 최신순 후기 최대 1개를 담는 배열이며,
본문(`content`), 작성일(`created_at`), 별점(`rating`), 구매 옵션(`purchased_option`), 원문 URL을 제공합니다.
후기 조회는 `sort=new&page=0&pageSize=1`로 요청합니다. 다른 색상 상품은 포함하지 않습니다.
`material_status`와 `reviews_status`는 `ok`, `not_available`(정보 없음), `error`(수집 실패)를 구분합니다.
재질 또는 후기 수집 실패 시 기존 실측 결과를 유지하고 `collection_warnings`에 이유를 담습니다.
웹 비교 화면에도 두 상품의 재질과 최신 후기를 표시합니다. 로컬 `/api/product`에도
`{"url": "무신사 상품 URL"}`을 POST하여 전체 데이터를 받을 수 있습니다(기존 페이지 토큰 필요).

## 두 상품을 비교하고 Gemini 추천

```powershell
python size_recommender_gemini.py
```

실행하면 잘 맞았던 옷 URL, 그 옷에서 입었던 사이즈, 새로 구매할 옷 URL을 차례대로 입력합니다.
두 페이지의 실제 실측표에서 선택한 기준 사이즈와 새 상품의 각 사이즈를 비교합니다.
기본 목표는 기존 옷과 비슷한 핏입니다. `--fit "여유로운 핏"`처럼 원하는 핏을 지정할 수도 있습니다.
실행 중 Gemini API 키를 입력합니다. 환경변수 `GEMINI_API_KEY`도 지원합니다.
키를 소스 코드에 넣어 커밋하지 마세요.
URL과 구매 사이즈를 실행 명령에 지정할 수도 있습니다.

```powershell
python size_recommender_gemini.py --reference-url "https://www.musinsa.com/products/1032469" --reference-size M --url "새 상품 URL"
```

`--compare-only`를 추가하면 Gemini 호출 없이 두 옷의 실측 차이까지만 표시합니다.
기준 사이즈가 표에 없으면 다시 입력받고, 필수 실측이 누락된 사이즈는 기준으로 쓰지 않습니다.
예시 기준 치수는 제거했습니다. 실측표 수집과 정규화 후, 추천할 사이즈를 고르는 단계만 Gemini가 수행합니다.

## 범위와 제한

- 동일 응답은 서버 실행 중 최대 5분간 재사용하고 외부 요청은 1초 이상 간격을 둡니다.
- HTTP 429가 발생하면 `Retry-After` 기간(미제공 시 60초) 동안 같은 서버에 추가 요청을 보내지 않습니다. 대기 종료가 제한 해제를 보장하지는 않습니다.
- 코드 변경 후 실행 중인 웹 서버를 Ctrl+C로 종료하고 `python size_webapp.py`로 다시 시작하세요.

- 현재 무신사 상품 URL(`/products/숫자`, `/app/goods/숫자`, `/goods/숫자`)만 지원합니다.
- 현재 치수 필드와 검수 범위는 반팔 상의 예시 기준입니다. 다른 의류 유형에는 조정이 필요합니다.
- 사이즈표가 없거나 차단된 경우 오류를 표시하며 가상 데이터로 대체하지 않습니다.
- 무신사 공개 웹페이지가 사용하는 내부 API이므로 외부 개발자용으로 보장된 인터페이스가 아닙니다. 사이트 변경 시 수정이 필요할 수 있습니다.
- 로그인, 접근 차단, CAPTCHA를 우회하지 않습니다. 구매 가능 재고를 검증하는 기능은 없습니다.
- 표시 가격은 할인·회원·첫 구매 조건 등에 따라 최종 결제 금액과 다를 수 있습니다.
- 하드코딩된 가상 상품 데이터와 `--demo` 모드는 제거했습니다.

## 확인한 데이터 출처 (2026-11-10)

- 상품 페이지: https://www.musinsa.com/products/1032469
- 해당 페이지의 실측 API: https://goods-detail.musinsa.com/api2/goods/1032469/actual-size
- M 실측: 총장 71 / 어깨 51.5 / 가슴단면 55.5 / 소매 25 cm. 기존 코드의 가상 치수와 다릅니다.

## 테스트

```powershell
python -m unittest test_product_extraction.py test_two_product_flow.py
```
