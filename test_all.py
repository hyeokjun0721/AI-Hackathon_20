import json

import gemini_parser as gp
import size_recommender as sr
from run_with_gemini import SAMPLE_TABLE

gp.RETRY_WAIT_SECONDS = 0  # 테스트에서는 기다리지 않음


# ---------- 실제 무신사 화면에서 가져온 값 ----------
MUSINSA_REF = {
    "desired_fit": "기준 옷과 비슷한 핏",
    "measurements": {"length_cm": 67.0, "shoulder_cm": 52.0, "chest_width_cm": 55.0, "sleeve_cm": 23.0},
}
MUSINSA_FREE = {"FREE": {"length_cm": "69.0", "shoulder_cm": "49.0", "chest_width_cm": "53.0", "sleeve_cm": "21.5"}}
MUSINSA_COLORS = {
    f"{color}{size}": {"length_cm": str(l), "shoulder_cm": str(s), "chest_width_cm": str(c), "sleeve_cm": str(sl)}
    for color in ("화이트", "블랙")
    for size, l, s, c, sl in (("S", 67.0, 52.0, 55.0, 23.0), ("M", 71.0, 54.0, 58.0, 24.0), ("L", 74.0, 56.0, 61.0, 25.0))
}

EVEN_REF = {
    "desired_fit": "정사이즈",
    "measurements": {"length_cm": 70.0, "shoulder_cm": 45.0, "chest_width_cm": 52.0, "sleeve_cm": None},
}


def size_row(length, shoulder, chest):
    return {"length_cm": str(length), "shoulder_cm": str(shoulder), "chest_width_cm": str(chest), "sleeve_cm": "-"}


# ---------- 추천 엔진 ----------
def test_demo_recommends_m_and_skips_l():
    clean = sr.normalize_sizes(sr.raw_extracted_data["raw_sizes"])
    result = sr.recommend_size(sr.user_reference_clothes, clean)
    assert result["mode"] == "recommend" and not result["is_tie"]
    assert [r["size"] for r in result["recommendations"]] == ["M"]
    assert "L" in result["excluded"]


def test_exact_tie_shows_both():
    raw = {"S": size_row(69, 44, 51), "M": size_row(71, 46, 53)}
    result = sr.recommend_size(EVEN_REF, sr.normalize_sizes(raw))
    assert result["is_tie"]
    assert [r["size"] for r in result["recommendations"]] == ["S", "M"]


def test_near_tie_and_clear_winner():
    near = {"S": size_row(69, 44, 51), "M": size_row(71, 46, 53.4)}
    assert sr.recommend_size(EVEN_REF, sr.normalize_sizes(near))["is_tie"]

    far = {"S": size_row(69, 44, 51), "M": size_row(71, 46, 55)}
    result = sr.recommend_size(EVEN_REF, sr.normalize_sizes(far))
    assert not result["is_tie"] and result["recommendations"][0]["size"] == "S"


def test_real_free_size_case_is_tight():
    result = sr.recommend_size(MUSINSA_REF, sr.normalize_sizes(MUSINSA_FREE))
    row = result["recommendations"][0]
    assert result["mode"] == "recommend" and row["size"] == "FREE"
    assert row["fit_tag"] == "타이트함" and row["diffs"]["shoulder_cm"] == -3.0


def test_narrow_tolerance_gives_fit_report_not_dead_end():
    old = sr.TOLERANCE_CM
    sr.TOLERANCE_CM = 2.0
    try:
        result = sr.recommend_size(MUSINSA_REF, sr.normalize_sizes(MUSINSA_FREE))
    finally:
        sr.TOLERANCE_CM = old
    assert result["ok"] and result["mode"] == "fit_report"
    assert result["recommendations"][0]["fit_tag"] == "타이트함"


def test_color_variants_are_merged():
    result = sr.recommend_size(MUSINSA_REF, sr.normalize_sizes(MUSINSA_COLORS))
    assert not result["is_tie"]
    assert result["recommendations"][0]["size"] == "화이트S/블랙S"


def test_all_sizes_unreadable_returns_none():
    raw = {"M": {"length_cm": "-", "shoulder_cm": "-", "chest_width_cm": "-", "sleeve_cm": "-"}}
    result = sr.recommend_size(EVEN_REF, sr.normalize_sizes(raw))
    assert not result["ok"] and result["mode"] == "none"


def test_fit_tag_boundaries():
    assert sr.classify_fit_tag(-2.1) == "타이트함"
    assert sr.classify_fit_tag(-2.0) == "정핏"
    assert sr.classify_fit_tag(1.9) == "정핏"
    assert sr.classify_fit_tag(2.0) == "세미 오버핏"
    assert sr.classify_fit_tag(5.0) == "빅 오버핏"


def test_grades():
    def grade(raw):
        return sr.recommend_size(EVEN_REF, sr.normalize_sizes(raw))["grade"]

    assert grade({"S": size_row(70, 45, 52)}) == "완벽"        # 기준 옷과 완전히 같음
    assert grade({"S": size_row(72, 47, 54)}) == "잘 맞음"     # 모든 부위 2cm 차이
    assert grade({"S": size_row(69, 44, 51), "M": size_row(71, 46, 53)}) == "두 사이즈 추천"
    assert grade({"S": size_row(80, 55, 60)}) == "추천 불가"   # 허용 범위 밖


def test_same_product_gives_perfect_for_bought_size():
    ref = {"desired_fit": "정사이즈",
           "measurements": {"length_cm": 71.0, "shoulder_cm": 54.0, "chest_width_cm": 58.0, "sleeve_cm": 24.0}}
    result = sr.recommend_size(ref, sr.normalize_sizes(MUSINSA_COLORS))
    assert result["grade"] == "완벽"
    assert result["recommendations"][0]["size"] == "화이트M/블랙M"


def test_format_result_shows_grade():
    perfect = sr.format_result(sr.recommend_size(EVEN_REF, sr.normalize_sizes({"S": size_row(70, 45, 52)})))
    assert "[완벽]" in perfect
    far = sr.format_result(sr.recommend_size(EVEN_REF, sr.normalize_sizes({"S": size_row(80, 55, 60)})))
    assert "[추천 불가]" in far and "S:" in far   # 추천 불가여도 핏 정보는 같이 나옴


def test_parse_measurement_rules():
    assert sr.parse_measurement("shoulder_cm", "440mm") == 44.0
    assert sr.parse_measurement("chest_width_cm", "가슴둘레 104cm") == 52.0
    for bad in ["-", "미제공", None, "abc", "200cm"]:
        try:
            sr.parse_measurement("shoulder_cm", bad)
        except ValueError:
            continue
        raise AssertionError(f"{bad!r} 는 에러가 나야 함")


# ---------- 파서 (가짜 모델 사용) ----------
class FakeAPIError(Exception):
    def __init__(self, code):
        super().__init__(f"HTTP {code}")
        self.code = code


def good_answer():
    return json.dumps({"sizes": [
        {"size": "S", "length_cm": "69", "shoulder_cm": "44", "chest_width_cm": "가슴둘레 104", "sleeve_cm": "24"},
        {"size": "M", "length_cm": "71", "shoulder_cm": "46", "chest_width_cm": "가슴둘레 108", "sleeve_cm": "25"},
        {"size": "L", "length_cm": "73", "shoulder_cm": "48", "chest_width_cm": "-", "sleeve_cm": "26"},
    ]}, ensure_ascii=False)


def invented_answer():
    data = json.loads(good_answer())
    data["sizes"][0]["chest_width_cm"] = "52"  # 원문에는 104만 있음
    return json.dumps(data, ensure_ascii=False)


def parse(call, models=("a",), text=SAMPLE_TABLE):
    return gp.parse_size_table(text, call_model=call, use_cache=False, models=list(models))


def expect_error(call, models=("a",), text=SAMPLE_TABLE):
    try:
        parse(call, models, text)
    except gp.ParsingError as e:
        return str(e)
    raise AssertionError("ParsingError가 나야 하는데 통과함")


def test_parser_to_recommendation_flow():
    raw = parse(lambda model, text: good_answer())
    result = sr.recommend_size(sr.user_reference_clothes, sr.normalize_sizes(raw))
    assert result["recommendations"][0]["size"] == "M" and "L" in result["excluded"]


def test_parser_rejects_invented_numbers():
    expect_error(lambda model, text: invented_answer())


def test_parser_rejects_bad_answers():
    expect_error(lambda model, text: "표를 읽을 수 없어요")
    expect_error(lambda model, text: json.dumps({"sizes": []}))
    row = {"size": "M", "length_cm": "71", "shoulder_cm": "46", "chest_width_cm": "가슴둘레 108", "sleeve_cm": "25"}
    expect_error(lambda model, text: json.dumps({"sizes": [row, row]}))
    expect_error(lambda model, text: good_answer(), text="   ")


def test_retry_same_model_on_server_error():
    calls = []

    def flaky(model, text):
        calls.append(model)
        if len(calls) < 3:
            raise FakeAPIError(503)
        return good_answer()

    parse(flaky)
    assert calls == ["a", "a", "a"]


def test_fallback_to_next_model_after_retries():
    calls = []

    def call(model, text):
        calls.append(model)
        if model == "a":
            raise FakeAPIError(503)
        return good_answer()

    parse(call, models=("a", "b"))
    assert calls == ["a", "a", "a", "b"]


def test_auth_error_stops_immediately():
    calls = []

    def call(model, text):
        calls.append(model)
        raise FakeAPIError(401)

    expect_error(call, models=("a", "b"))
    assert calls == ["a"]


def test_missing_model_skips_to_next_without_retry():
    calls = []

    def call(model, text):
        calls.append(model)
        if model == "a":
            raise FakeAPIError(404)
        return good_answer()

    parse(call, models=("a", "b"))
    assert calls == ["a", "b"]


def test_failed_validation_moves_to_next_model():
    calls = []

    def call(model, text):
        calls.append(model)
        return invented_answer() if model == "a" else good_answer()

    parse(call, models=("a", "b"))
    assert calls == ["a", "b"]


def test_all_models_fail_reports_each():
    message = expect_error(lambda model, text: "깨진 답변", models=("a", "b"))
    assert "a:" in message and "b:" in message


def run_all():
    tests = [(name, func) for name, func in globals().items() if name.startswith("test_") and callable(func)]
    for name, func in tests:
        func()
        print("통과:", name)
    print(f"\n{len(tests)}개 테스트 모두 통과")


if __name__ == "__main__":
    run_all()
