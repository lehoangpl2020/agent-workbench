# Agent Workbench: đánh giá hiện trạng và việc tiếp theo

> **Ghi chú:** đây là **bản chụp lịch sử** (2026-11-19, project khi đó tên Code Agent / Agent Playground), giữ lại như nhật ký học. Nhiều mục đã được xử lý (xem khung cập nhật bên dưới và [README](../../README.md)); đừng đọc nó như trạng thái hiện tại.

Ngày: 2026-11-19. Phạm vi: toàn bộ project (khi đó còn nằm trong repo học riêng của tác giả) theo working tree lúc đó, gồm cả phần Agent Studio chưa commit (thay cho `LiveFlow`, `FlowDiagram`, `flow.ts`).

> **Cập nhật 2026-11-19 (chặng 0 của [FEATURE_MAP](FEATURE_MAP.vi.md)):** đã xử lý P0.1 (B1, B2: bind `127.0.0.1`, CORS hẹp, cảnh báo local mode), P0.3 (B7: `max_iterations` = số lần chạy code, thêm lượt final review) và P0.2 (B3–B6: `.env.example`, xóa `RUN_GUIDE.vi.md` và thay bằng [TROUBLESHOOTING.vi.md](TROUBLESHOOTING.vi.md), sửa README, xóa `__MACOSX/`). Đánh giá dưới đây là bản chụp **trước** khi sửa; các mục khác (B8–B13, P1, P2) vẫn còn nguyên.

Mỗi nhận định được gắn một trong ba nhãn sau:

- **[Source]**: đã xác nhận bằng cách đọc code.
- **[Đã chạy]**: đã chạy lệnh và thấy kết quả.
- **[Giả thuyết]**: suy luận, chưa kiểm chứng.

Những gì đã chạy để kiểm chứng:

| Lệnh | Kết quả |
|---|---|
| `.venv/Scripts/python -m pytest tests -q` (Python 3.14.4, Windows) | **32 passed, 4 skipped**. 3 test cần sandbox Docker thật, 1 test symlink không chạy được trên Windows. Đây là test offline: planner giả, code chạy thật bằng `LocalExecutor`. |
| `cd web && npm run build` | OK (gồm `tsc -b`). Có cảnh báo bundle JS 554 KB. |
| `git status`, `git ls-files` | Phần Agent Studio chưa commit. `__MACOSX/` (16 file rác từ file zip) đang bị git track. |

Những gì **chưa chạy**: Docker Compose, sandbox thật, Claude API thật, UI bằng tay. Không có nhận định nào trong file này dựa trên một run thật với model.

---

## 1. Nhận xét tổng thể

**Lõi runtime chắc hơn mức demo thông thường.** Project có một agent loop duy nhất, và nút Stop kill process thật. Timeout có hai lớp, event loop không bị chặn. Lịch sử SQLite còn nguyên sau restart và có migration. Artifact được chặn path traversal, secret được che trong log. Có 32 test offline bảo vệ các hành vi này. Phần này đáng giữ và đáng dùng làm tài liệu học.

**Điểm yếu nằm ở ba chỗ:**

1. **Bề mặt chia sẻ chưa sẵn sàng.** Tài liệu lỗi thời và mâu thuẫn với code. Không có `.env.example`. Local mode không chạy được các demo có sẵn. Server mở ra cả mạng mà không có auth.
2. **Điều kiện dừng của agent có chỗ dễ gây hiểu sai.** Ví dụ: code chạy đúng ở iteration cuối vẫn bị báo "Iteration limit reached". Hay `max_iterations=1` thì không bao giờ có trạng thái `success`.
3. **Chưa có gì đo chất lượng agent (eval) hay chi phí theo run.** Hiện mới chỉ có unit test cho runtime.

**Về khái niệm:** đây là một *agent loop có workflow cố định với một tool ngầm (chạy Python)*. Model không chọn tool; nó chỉ quyết định viết code gì hoặc trả `DONE`. Structured output đi bằng JSON nằm trong text, không qua tool use. Tài liệu chưa nói rõ điều này, nên dễ nhầm khi đối chiếu với bài học về tool calling.

---

## 2. Hiện trạng chi tiết

### 2.1 Đã làm được và khá hoàn thiện (ở mức project học)

| Năng lực | Bằng chứng |
|---|---|
| Loop Plan → Execute → Evaluate. Lỗi, timeout và output được đưa lại cho model. | `agent.py` `CodeAgent._loop`, `planner.py` `_build_messages` [Source]. `test_agent_loop.py`, 12 test [Đã chạy]. |
| Stream code trong lúc model đang viết. | `planner.py` `_stream`, `extract_partial_json_string` [Source]. |
| Chống JSON hỏng: retry format 1 lần; dừng ngay khi gặp `max_tokens` hoặc `refusal`. | `LLMPlanner.generate_code` [Source]. `test_parse_error_is_logged_then_retried` [Đã chạy]. |
| 3 executor. Timeout `timeout -k 2` cộng `asyncio.wait_for`. Stop kill process thật. | `executor.py` [Source]. Test Stop/timeout với `LocalExecutor` [Đã chạy]; test Docker bị skip. |
| Auto `pip install` khi thiếu module (chỉ persistent sandbox). | `_run_with_auto_install` [Source]. |
| Run API chạy nền, 1 run một lúc (409), SSE, API cũ vẫn tương thích. | `runs.py`, `server.py` [Source]. `test_api.py` [Đã chạy]. |
| SQLite: lịch sử, migration, đánh dấu run bị gián đoạn khi restart. | `store.py` [Source]. `test_history_survives_restart`, `test_old_database_is_migrated` [Đã chạy]. |
| Artifact theo run, snapshot theo iteration, chặn traversal, header `CSP: sandbox`. | `workspace.py`, `server.get_artifact` [Source]. `test_artifacts_are_isolated_per_run` [Đã chạy]. |
| Activity log 4 nguồn (`runtime`/`llm`/`model`/`sandbox`), có che secret. | `runlog.py` [Source]. `test_logs.py` [Đã chạy]. |
| UI: Composer có preset, Timeline, các tab Preview/Code/Logs/Files, Live Flow (Agent Studio) có Replay. | `web/src` [Source]. Build OK [Đã chạy]; chưa thử bằng tay. |
| Sandbox: user không phải root, `cap_drop: ALL`, `no-new-privileges`, giới hạn memory/CPU. | `docker-compose.yml`, `Dockerfile.sandbox` [Source]. |

### 2.2 Còn thiếu hoặc mới ở mức demo

- **Không có eval chất lượng agent.** `tests/` chỉ kiểm runtime với `ScriptedPlanner` [Source].
- **Không tổng hợp tokens, latency hay chi phí theo run.** Tokens chỉ nằm rải rác trong `data` của các dòng log nguồn `llm`; UI không tổng hợp [Source].
- **Chỉ có một provider (Anthropic)**, gắn cứng trong `LLMPlanner`. Không có chế độ chạy không cần key [Source]. `.env` có biến `OPENAI_API_KEY` nhưng code không dùng.
- **Không có follow-up.** Mỗi run độc lập. `AgentRequest.session_id` được API nhận nhưng bị bỏ qua, vì `CodeAgent.new_state` không dùng nó [Source].
- **Không có test frontend.** Logic chuyển log thành các bước trong `web/src/lib/studio.ts` chưa có test.
- **Không pin version.** `requirements.txt` dùng `>=`; `Dockerfile.sandbox` cài package không pin. Venv dùng Python 3.14, image dùng 3.11 [Source].
- **Thiếu** `.env.example`, LICENSE, screenshot/GIF.

**Chưa triển khai** (không được mô tả như đã có): eval, provider khác hoặc model local, chế độ mock/không cần key, follow-up/multi-turn, theo dõi chi phí, authentication, nhiều run song song, native tool calling, CI.

### 2.3 Bug, điểm không nhất quán, điểm dễ hiểu sai

| # | Vấn đề | Bằng chứng |
|---|---|---|
| B1 | **Server mở ra cả mạng, không auth, CORS `*`.** `uvicorn.run(host="0.0.0.0")`, compose publish `"8000:8000"`, `allow_origins=["*"]`. Máy khác cùng LAN gọi được `POST /api/runs`, tức là chạy được code và tiêu API key của sếp. Ở local mode, đó là chạy code tùy ý trên máy host. | [Source]. Một trang web lạ mở trong trình duyệt có gọi được `localhost:8000` hay không còn tùy chính sách Private Network Access của trình duyệt [Giả thuyết, chưa thử]. |
| B2 | Chạy `python server.py` mặc định dùng `LocalExecutor` (không cách ly), nhưng màn hình New run vẫn ghi *"runs in an isolated sandbox"*, bất kể executor nào. | `server.build_executor`, `App.tsx` `EmptyState` [Source]. |
| B3 | **Local mode không chạy được các demo có sẵn.** `requirements.txt` không có numpy/matplotlib…, venv hiện tại cũng không có. Vậy mà `SYSTEM_PROMPT` hứa các gói này có sẵn, còn `LocalExecutor` không auto-install. Preset "Draw a cute bee" / "Plot sin(x)" sẽ lỗi `ModuleNotFoundError` và lặp tới hết iteration. | [Source] + `pip list`. Chưa chạy run thật. |
| B4 | `python server.py` **không đọc `.env`** (không dùng python-dotenv); chỉ compose và `run.sh` nạp file này. Mục hybrid trong README ghi "API key đọc từ biến môi trường / .env": sai với người chạy bằng PowerShell. | [Source]. |
| B5 | **`RUN_GUIDE.vi.md` (43 KB) lỗi thời, mâu thuẫn với code.** Guide nói persistent mode "không có timeout", `timeout_seconds` "bị server bỏ qua", stream endpoint "tự viết vòng lặp riêng", sandbox "không cài seaborn/plotly/xlsxwriter", và nhắc `datetime.utcnow`. Code hiện tại đã sửa hết các điểm này. Guide còn chứa đường dẫn máy cá nhân và mục "trạng thái `.env` đã kiểm tra". | [Source]: so `RUN_GUIDE` mục 9–10 với `executor.py`, `Dockerfile.sandbox`, `schemas.py`. |
| B6 | README: đoạn code "Tích hợp vào AgentBook" không chạy được (không có package `code_agent`, thiếu import `AgentRequest`). README ghi memory 512 MB, nhưng ephemeral mode thực tế dùng `256m`. | [Source]. |
| B7 | **Điều kiện dừng dễ gây hiểu sai.** (a) Muốn `DONE` luôn phải gọi model thêm một lần và gửi lại toàn bộ lịch sử, nên task đơn giản nhất cũng tốn ít nhất 2 lần gọi LLM. (b) `max_iterations=1` không bao giờ ra `success`, dù validation và UI vẫn cho chọn 1. (c) Code chạy đúng ở iteration cuối vẫn thành `max_retries` ("Iteration limit reached"), vì model không còn lượt để xem kết quả. (d) Một "iteration" là một lần gọi model, không phải một lần chạy code; lượt trả `DONE` cũng tính là một iteration. | [Source]: `agent._loop`. Hành vi (c) được khóa bằng `test_success_without_done_hits_iteration_limit_and_keeps_partial`, nên là chủ ý; nhưng tài liệu và UI chưa giải thích. |
| B8 | **Heuristic "false success"** (`_detect_false_success`) đổi `exit_code` từ 0 thành 1 khi dòng đầu của stdout chứa từ khóa như "not found" hay "could not". Nó có thể bắt nhầm output hợp lệ. Từ khi có bước model xem lại output, heuristic này trùng vai trò. Exit code lưu trong DB cũng không còn là giá trị thật. Người học dễ tưởng đây là "model đánh giá". | [Source]. Ví dụ bắt nhầm là [Giả thuyết]. |
| B9 | Trường `language` model trả về được tin luôn. Executor có nhánh cho `javascript`/`bash`, nhưng image sandbox không có `node`, còn `LocalExecutor` chạy mọi thứ bằng python. Prompt chỉ yêu cầu python nên hiếm gặp. | [Source]. |
| B10 | stdout/stderr được đọc hết vào RAM rồi mới cắt còn 10 KB/5 KB (`communicate()`, `exec_run(demux=True)`). Code in ra liên tục trong 30 giây có thể làm server phình bộ nhớ. | [Giả thuyết, chưa thử]. |
| B11 | `CodeAgent.sessions` giữ mọi `AgentState` trong RAM, không bao giờ xóa, và không endpoint nào dùng. | [Source]. Ảnh hưởng nhỏ. |
| B12 | Live Flow phân loại một phần các bước dựa trên câu log tiếng Anh (`startsWith` trong `studio.ts`). Đổi câu log ở backend có thể làm Live Flow/Replay sai mà không test nào bắt được. | [Source]. |
| B13 | Ephemeral mode bind-mount theo đường dẫn của nơi server đang chạy. Khi server chạy trong container (compose), các đường dẫn đó không tồn tại trên host, nên rất có thể không chạy được. | [Giả thuyết]. RUN_GUIDE cũng chỉ ghi là "suy ra". |

---

## 3. Đánh giá theo ba mục tiêu

| Mục tiêu | Điểm mạnh | Khoảng trống chính |
|---|---|---|
| **Learning** | Code tách rõ phần model quyết định và phần runtime làm, kể cả trong log (`source`). Comment tiếng Việt. Live Flow cho thấy dữ liệu đi giữa model, runtime và sandbox. | Chưa giải thích "đây là loại agent gì" và điều kiện dừng (B7). Không đo được chất lượng, nên chưa trả lời được câu "prompt/model này tốt hơn không". Không thấy được chi phí của từng thiết kế. |
| **Showcase** | UI chỉn chu, Live Flow/Replay, có preset, artifact xem ngay trong trình duyệt. | Không có screenshot/GIF hay phần giới thiệu nổi bật ở đầu README. Không có cách xem demo khi không có key. Trạng thái "Iteration limit reached" xuất hiện khi kết quả đúng làm demo kém thuyết phục. |
| **Sharing** (tự chạy local) | Compose chạy bằng một lệnh, QUICKSTART ngắn. | Thiếu `.env.example`; tài liệu mâu thuẫn (B5, B6); local mode hỏng demo (B3, B4); server mở ra mạng (B1); không pin version; phải có API key trả phí mới chạy được bất cứ thứ gì. |

---

## 4. Danh sách ưu tiên

Quy ước effort: **nhỏ** ≤ nửa ngày · **vừa** 1–2 ngày · **lớn** > 2 ngày.

### P0: làm trước khi đưa cho người khác chạy

#### P0.1 Chỉ mở cho máy mình, và cảnh báo rõ khi code không được cách ly

- **Vấn đề:** B1, B2.
- **Giá trị:** Sharing (an toàn cho người clone về). Learning (hiểu rủi ro của một agent được quyền chạy code).
- **Kết quả cần đạt:**
  - Compose publish `127.0.0.1:8000:8000`. `python server.py` mặc định nghe ở `127.0.0.1`, đổi được qua biến môi trường.
  - CORS chỉ cho origin dev (`http://localhost:5173`), vì UI build sẵn đã chạy cùng origin.
  - UI có cảnh báo rõ khi executor là `local`, và không ghi "isolated" khi điều đó không đúng.
- **Tiêu chí hoàn thành:** máy khác trong LAN không mở được `:8000`. Có test API kiểm tra request từ origin lạ không nhận được header CORS cho phép. Chạy local mode thì thấy banner cảnh báo.
- **Effort:** nhỏ. **Dependency:** không.

#### P0.2 Một đường cài đặt chuẩn, tài liệu khớp với code

- **Vấn đề:** B3, B4, B5, B6. Thiếu `.env.example`. `__MACOSX/` bị track. Phần Agent Studio chưa commit.
- **Giá trị:** chủ yếu là Sharing. Thêm Learning, vì không ai học sai từ guide cũ.
- **Kết quả cần đạt:**
  - Có `.env.example` liệt kê đủ biến, không chứa giá trị thật.
  - `RUN_GUIDE.vi.md` bị xóa, hoặc viết lại thành `TROUBLESHOOTING.vi.md` ngắn: chỉ giữ điều còn đúng, không có đường dẫn cá nhân.
  - README:
    - Đường chính là Docker Compose.
    - Local mode ghi rõ giới hạn: không cách ly, không tự đọc `.env`, cần các gói data science. Nếu được, dùng một danh sách package chung cho `Dockerfile.sandbox`, local mode và `SYSTEM_PROMPT`.
    - Sửa hoặc bỏ đoạn AgentBook, sửa con số memory.
  - Xóa `__MACOSX/` khỏi git và commit phần Agent Studio.
- **Tiêu chí hoàn thành:**
  - Một người chưa từng thấy project, dùng Windows và có Docker Desktop, làm theo README là chạy được 3 preset trong khoảng 15 phút.
  - Mọi lệnh trong tài liệu đã được chạy thử ít nhất một lần.
  - Tài liệu không còn chứa đường dẫn máy cá nhân.
- **Effort:** vừa. **Dependency:** làm sau P0.1 để tài liệu mô tả đúng cấu hình mới.

#### P0.3 Làm rõ, và sửa nếu cần, điều kiện dừng của agent loop

- **Vấn đề:** B7, liên quan B8.
- **Giá trị:** Learning: điều kiện tiếp tục/dừng là phần cốt lõi của mọi agent loop. Showcase: không báo "limit reached" khi kết quả đúng.
- **Kết quả cần đạt:** chọn một ngữ nghĩa rõ ràng rồi ghi lại. Sếp cần quyết ba câu hỏi:
  - Lần chạy thành công ở iteration cuối có được thêm một lượt để model xem kết quả không? Hay vẫn là `max_retries` nhưng UI hiển thị nhãn dễ hiểu hơn?
  - `max_iterations` đếm số lần gọi model hay số lần chạy code?
  - Có cho phép model trả "code này là bước cuối" ngay trong một lần, để bỏ lượt gọi chỉ để trả `DONE` không? Câu này đổi protocol nên cần cân nhắc kỹ.
- **Tiêu chí hoàn thành:**
  - Bảng trạng thái trong `ARCHITECTURE.vi.md` và tooltip trên UI khớp với code.
  - Có test cho từng trường hợp biên: `max_iterations=1`, thành công ở iteration cuối, `DONE` ngay lượt đầu.
  - Tài liệu ghi số lần gọi LLM của task "2 + 2".
- **Effort:** nhỏ nếu chỉ sửa tài liệu và nhãn; vừa nếu đổi hành vi và test. **Dependency:** không. Nếu đã có P1.1 thì đo được ảnh hưởng tới chi phí.

### P1: tăng giá trị học và showcase

Thứ tự đề xuất trong nhóm: P1.1 → P1.2 → P1.3 → P1.4 → P1.5 → P1.6 → P1.7.

#### P1.1 Tổng hợp chi phí và thời gian theo run

- **Vấn đề:** tokens và latency đã được log nhưng nằm rải rác. Không biết một run tốn bao nhiêu, cũng không biết thời gian nằm ở model hay ở sandbox.
- **Giá trị:** Learning (cost và latency là hai tiêu chí sếp muốn biết cách đánh giá). Showcase.
- **Kết quả cần đạt:** mỗi run có phần tổng kết, hiện trên UI và trả qua API:
  - số lần gọi LLM (kể cả format retry);
  - input/output tokens;
  - tổng thời gian LLM và thời gian tới first token;
  - tổng thời gian chạy sandbox;
  - chi phí ước tính theo bảng giá người dùng tự cấu hình (không hard-code giá).

  Dữ liệu này đã có sẵn trong `_response_meta` và bảng `run_logs`.
- **Tiêu chí hoàn thành:** test offline với planner giả có trả `usage` cho ra phần tổng kết đúng. Run cũ không có `usage` hiển thị "không có dữ liệu", không hiển thị 0.
- **Effort:** nhỏ–vừa. **Dependency:** không.

#### P1.2 False success: giữ dữ liệu thật, quyết định có giữ heuristic không

- **Vấn đề:** B8.
- **Kết quả cần đạt:** lưu exit code thật, còn `false_success` là một cờ riêng. Sau đó chọn một trong hai:
  - bỏ heuristic, để bước model xem lại output tự đánh giá;
  - giữ heuristic nhưng ghi rõ trên UI và log đây là *runtime heuristic*, không phải model đánh giá.
- **Tiêu chí hoàn thành:**
  - Nếu bỏ heuristic: task cố ý in "File not found" như một output hợp lệ không bị biến thành lỗi.
  - Trong cả hai trường hợp: UI phân biệt được "runtime đánh giá" với "model đánh giá", và test được cập nhật theo.
- **Effort:** nhỏ. **Dependency:** nên làm cùng P0.3.

#### P1.3 Chế độ chạy không cần API key (planner kịch bản)

- **Vấn đề:** bạn học không có key thì không thấy được gì. Demo phụ thuộc mạng và tiền.
- **Giá trị:** Sharing rất cao. Showcase: demo offline ổn định. Learning: thấy rõ planner chỉ là một thành phần thay thế được (giống inject một implementation khác qua DI; đây là đối chiếu thêm, không phải nội dung khóa học).
- **Kết quả cần đạt:**
  - Một biến môi trường chọn planner: `anthropic` hoặc `scripted`.
  - Planner `scripted` dùng kịch bản viết sẵn (tận dụng `ScriptedPlanner` trong `tests/conftest.py`) cho các preset, gồm ít nhất một kịch bản "lỗi → model sửa".
  - UI và log ghi rõ đang dùng "mock model".
- **Tiêu chí hoàn thành:** chạy `docker compose up` khi không có key vẫn chạy được các preset từ đầu đến cuối qua sandbox thật. Log ghi `provider=scripted`.
- **Effort:** nhỏ–vừa. **Dependency:** không. Đây là nền cho P2.1.

#### P1.4 Bộ eval nhỏ, tách khỏi unit test

- **Vấn đề:** chưa trả lời được "agent có làm đúng không", hay "đổi prompt/model thì tốt hơn hay tệ hơn".
- **Giá trị:** Learning: eval là kỹ năng cốt lõi, khác hẳn unit test của runtime. Showcase: có con số thật.
- **Kết quả cần đạt:**
  - 8–12 task, mỗi task có checker tự động: stdout chứa giá trị đúng, file tồn tại và mở được, số iteration.
  - Một script chạy thủ công, gọi API thật, lưu kết quả (pass rate, iterations, tokens, thời gian) để so sánh giữa các lần chạy.
  - README phân biệt rõ: `pytest` kiểm runtime, offline, miễn phí; eval kiểm chất lượng agent, gọi model thật, tốn tiền.
- **Tiêu chí hoàn thành:** chạy eval 2 lần với cùng cấu hình thì có bảng kết quả so sánh được. Báo cáo ghi rõ đã gọi API thật và chi phí ước tính.
- **Effort:** vừa. **Dependency:** P1.1 (để có tokens), P0.3 (để ý nghĩa của status ổn định). Cần sếp đồng ý chi phí API.

#### P1.5 Tài liệu "Agent này là gì, không là gì" và lần theo một run

- **Vấn đề:** dễ nhầm với tool-calling agent. Chưa có walkthrough nối từng dòng log về code.
- **Giá trị:** Learning, trực tiếp cho mục tiêu "tự giải thích được hệ thống".
- **Kết quả cần đạt:** thêm một mục trong `ARCHITECTURE.vi.md`, gồm:
  1. Loại agent: workflow cố định, một tool ngầm, model chỉ quyết định code hoặc `DONE`.
  2. Structured output bằng JSON trong text, so với dùng tool use hoặc API structured output.
  3. Context gửi cho model ở mỗi lượt gồm những gì và lớn dần ra sao.
  4. Một run thật lấy từ tab Logs, mỗi dòng trỏ về hàm đã tạo ra nó.
  5. Đối chiếu với .NET, ghi rõ là phần suy luận thêm.
- **Tiêu chí hoàn thành:** sếp tự giải thích lại được luồng một run mà không phải mở code. Tiêu chí này do sếp tự đánh giá.
- **Effort:** nhỏ. **Dependency:** sau P0.3, để mô tả đúng điều kiện dừng.

#### P1.6 Môi trường tái lập được

- **Vấn đề:** không pin version; Python 3.14 (venv) khác 3.11 (image); danh sách package nằm ở ba nơi.
- **Kết quả cần đạt:**
  - Pin version cho Python dependencies và cho các package trong `Dockerfile.sandbox`.
  - Thống nhất phiên bản Python, hoặc ghi rõ các phiên bản được hỗ trợ.
  - Danh sách package trong `SYSTEM_PROMPT` và Dockerfile lấy từ cùng một nguồn, hoặc có test so khớp hai bên.
  - Nếu repo lên GitHub: CI đơn giản chạy `pytest` và `npm run build`.
- **Tiêu chí hoàn thành:** build lại image sau một thời gian vẫn ra cùng version. Test bắt được khi prompt và Dockerfile lệch nhau.
- **Effort:** nhỏ. **Dependency:** không.

#### P1.7 Gói demo cho showcase

- **Kết quả cần đạt:**
  - Phần đầu README có 1 GIF Live Flow và 2–3 screenshot.
  - Kịch bản demo 3 phút gồm: một task thành công, một task tự sửa lỗi, và Stop/timeout.
  - Sơ đồ kiến trúc ngắn.
- **Tiêu chí hoàn thành:** người đọc README hiểu project làm gì trong khoảng 1 phút mà không cần chạy.
- **Effort:** nhỏ. **Dependency:** sau P0.3 và P1.1, để demo không hiện trạng thái khó hiểu và có số liệu chi phí. Nếu có P1.3 thì demo được cả khi offline.

### P2: để sau

| # | Việc | Lý do để sau / dependency | Effort |
|---|---|---|---|
| P2.1 | Tách lớp provider; thêm model khác hoặc model local (OpenAI, Ollama…). | Chưa biết khóa học dùng provider nào. Nên làm sau P1.3 (interface planner đã rõ) và P1.4 (có số để so sánh). Model local nhỏ có thể không theo được JSON protocol; eval sẽ cho thấy điều đó. | vừa |
| P2.2 | Biến thể dùng native tool calling (tool `execute_python`) để so sánh với protocol JSON-trong-text. | Giá trị học cao về tool calling, nhưng chỉ có ý nghĩa khi đã có eval (P1.4) để so sánh. | vừa |
| P2.3 | Follow-up/multi-turn (ví dụ "đổi con ong sang màu xanh"); đồng thời xử lý `session_id` đang bị bỏ qua (bỏ khỏi schema hoặc triển khai thật). | Phải thiết kế state giữa các run; mở rộng phạm vi đáng kể. | vừa–lớn |
| P2.4 | Quản lý context: đo kích thước context theo iteration, sau đó mới cân nhắc cắt code cũ hoặc dùng prompt caching. | Cần số liệu từ P1.1 trước; hiện chưa có bằng chứng context là vấn đề. | nhỏ–vừa |
| P2.5 | Robustness nhỏ: giới hạn stdout khi đang đọc (B10, cần thử để xác nhận trước), bỏ `CodeAgent.sessions` (B11), chỉ chấp nhận `language = python` (B9). | Rủi ro thấp với cách dùng local hiện tại. | nhỏ |
| P2.6 | Live Flow chỉ dựa vào tag `flow` thay vì câu log (B12); thêm test cho `studio.ts`. | Cần thêm dev dependency (ví dụ vitest), phải hỏi trước. | nhỏ–vừa |
| P2.7 | Tách bundle JS (cảnh báo 554 KB). | Chỉ là chuyện tối ưu, không ảnh hưởng chạy local. | nhỏ |

---

## 5. Ba việc nên làm ngay

1. **P0.1: chỉ mở cho máy mình, cảnh báo local mode.** Effort nhỏ, nhưng loại được rủi ro thật (chạy code tùy ý, tiêu API key) trước khi có ai khác chạy project.
2. **P0.2: một đường cài đặt chuẩn, tài liệu khớp code.** `RUN_GUIDE.vi.md` đang dạy sai nhiều điểm, và người mới bị chặn ngay ở bước cấu hình (không có `.env.example`, local mode hỏng demo). Việc chia sẻ phụ thuộc hoàn toàn vào việc này.
3. **P0.3: làm rõ điều kiện dừng.** Đây là phần cốt lõi của agent loop. Tự giải thích được nó là mục tiêu học quan trọng nhất, và đồng thời sửa luôn trạng thái gây khó hiểu khi demo.

Nếu muốn chia sẻ sớm cho các bạn chưa có API key, việc tiếp theo nên là **P1.3**; nếu muốn tập trung vào học, việc tiếp theo nên là **P1.1 → P1.4**.

---

## 6. Những việc nên để sau

- **Nhiều provider, model local:** chưa biết khóa học dùng provider nào, và chưa có eval để so sánh. Đổi model lúc này chỉ là đoán.
- **Native tool calling, follow-up:** học được nhiều nhưng mở rộng phạm vi. Nên làm khi phần nền (điều kiện dừng, số liệu, eval) đã chắc.
- **Auth, nhiều người dùng, nhiều run song song, mỗi run một container, bỏ mount `docker.sock`, tắt network của sandbox:** đây là yêu cầu của một dịch vụ online. Với bản mỗi người tự chạy local, chỉ cần P0.1 và một mục tài liệu nêu rõ rủi ro còn lại. Chưa mở rộng thành SaaS.
- **Multi-agent, RAG, vector DB, queue, ORM, microservices:** không giải quyết vấn đề nào ở trên.
- **Test E2E và test frontend đầy đủ:** chi phí cao so với lợi ích hiện tại; P2.6 là bước nhỏ hợp lý hơn.

---

## 7. Câu hỏi cần sếp quyết

1. Bài thực hành của khóa học dùng provider và model nào? Câu trả lời ảnh hưởng tới P2.1 và cấu hình mặc định.
2. Điều kiện dừng mong muốn là gì? Xem ba câu hỏi ở P0.3.
3. Ngân sách cho eval gọi API thật (P1.4) là bao nhiêu?
4. Sẽ chia sẻ qua git repo (public hay private) hay qua file zip? Project hiện có dấu vết đến từ file zip (`__MACOSX/`). Nếu chia sẻ bằng zip mà không cẩn thận, `.env` (có key thật), `data/` (lịch sử prompt) và `.venv/` sẽ đi kèm.
