# -*- coding: utf-8 -*-
"""Ai00-X 音乐源 sidecar 服务（musicdl 引擎）。

由 Rust music_source_manager.rs 启动：
    python server.py --port 0

约定：
- 启动完成后向 stdout 打印一行 JSON：{"event": "ready", "port": <N>}
  （--port 0 时由 OS 分配端口，Rust 端从该行解析实际端口）
- GET  /healthz          → {"ok": true}
- POST /search           → {"keyword": "..."} → {"songs": [OnlineSong]}
- GET  /charts           → {"charts": [{id, name, group}]}（网易国内榜 + iTunes 国际榜）
- POST /chart_tracks     → {"chartId": "netease:ID|itunes:CC"} → {"name", "tracks": [TrackRef]}
- GET  /radio_pool       → {"tracks": [TrackRef]}（多榜单并发取样 + 去重洗牌）
- POST /playlist         → {"url": "..."} → {"name", "tracks": [TrackRef]}
- POST /resolve          → {"name", "singers"} → {"song": OnlineSong}

TrackRef（榜单/歌单曲目，仅元数据，点击时再经 /resolve 取源）：
    trackId/name/singers/album/durationS/coverUrl

song 字段（Rust/前端消费，camelCase 与 Rust OnlineSong 的
serde(rename_all = "camelCase") 严格对齐）：
    source          musicdl 客户端类名（如 QQMusicClient）
    name/singers/album
    durationS       时长（秒，未知为 0）
    ext             扩展名（mp3/flac/...，已过滤加密格式）
    fileSizeBytes
    downloadUrl     直链（musicdl AudioLinkTester 已校验可用）
    lyric           LRC 歌词文本（可能为 null）
    coverUrl        封面直链（可能为 null）
    identifier      源内歌曲 ID
    dlHeaders       下载所需请求头（UA/Referer）

musicdl 上游：https://github.com/CharlesPikachu/musicdl
"""

import argparse
import json
import re
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests
from musicdl import musicdl

# 只保留 AudioMixer（symphonia）能解码的扩展名——酷我会返回 mgg 等
# 加密容器格式，下载后无法播放。
VALID_EXTS = {"mp3", "flac", "m4a", "aac", "wav", "ogg", "opus"}

# 启用的音源（musicdl 客户端类名 → 展示名由前端映射）。
# 国内源 + 国际源（国际版产品；国际源依赖网络环境，不可达时经并发
# 超时机制快速失败被自动跳过——VPN 可达即用，「读不到就算了」）。
MUSIC_SOURCES = [
    # 国内
    "QQMusicClient",
    "KuwoMusicClient",
    "MiguMusicClient",
    "NeteaseMusicClient",
    "KugouMusicClient",
    # 国际
    "YouTubeMusicClient",
    "SpotifyMusicClient",
    "SoundCloudMusicClient",
    "DeezerMusicClient",
    "JamendoMusicClient",
    "FMAMusicClient",
    "AudiusMusicClient",
]

# 每源搜索条数（musicdl 默认 5；搜索含取源校验（逐首测下载链路））
SEARCH_SIZE_PER_SOURCE = 3

# 单请求超时（秒）+ 重试次数：musicdl 默认 timeout=10 / max_retries=3，
# 一个挂掉的源取一首歌最坏可拖 30s+（10s×3 重试）——收紧到 6s/1 次，
# 让慢源快速失败（多源容灾下丢一个源无所谓）。
REQUEST_TIMEOUT = 6
MAX_RETRIES = 1

# 搜索总截止（秒）：按源并发 + 先完成先收，到截止放弃未完成的慢源。
# 实测快源（网易/咪咕/酷我）5-10s 完成，慢源（QQ 偶发）可拖 30s+——
# 15s 截止保证整体体验，被放弃的源下次搜索自然重试。
SEARCH_DEADLINE = 15

# 提前返回条件：≥2 个源完成且累计 ≥6 首歌时不再等慢源（快源通常
# 8-10s 达标）。两个条件都要求，避免单源刷满 6 首就草草返回。
EARLY_RETURN_MIN_SOURCES = 2
EARLY_RETURN_MIN_SONGS = 6

# ----------------------------------------------------------------------------
# 网易云歌单/排行榜（旧版公开 API，无需登录）
#   GET https://music.163.com/api/playlist/detail?id=<playlistId>
#   → {"result": {"name", "tracks": [{id, name, ar:[{name}], al:{name,picUrl}, dt}]}}
# 排行榜即官方歌单 ID（热歌榜 3778678 等）。
# ----------------------------------------------------------------------------

NETEASE_API = "https://music.163.com/api/playlist/detail?id={playlist_id}"
NETEASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "Referer": "https://music.163.com/",
}

# 网易云官方排行榜（歌单 ID → 展示名）。chartId 统一格式 "netease:<歌单ID>"。
NETEASE_CHARTS = [
    {"id": "netease:3778678", "name": "热歌榜", "group": "国内"},
    {"id": "netease:3779629", "name": "新歌榜", "group": "国内"},
    {"id": "netease:19723756", "name": "飙升榜", "group": "国内"},
    {"id": "netease:2884035", "name": "原创榜", "group": "国内"},
]

# iTunes 国际榜（旧版 RSS，大陆可达已验证）。chartId 格式 "itunes:<国家码>"。
ITUNES_CHARTS = [
    {"id": "itunes:us", "name": "美国榜", "group": "国际"},
    {"id": "itunes:gb", "name": "英国榜", "group": "国际"},
    {"id": "itunes:jp", "name": "日本榜", "group": "国际"},
    {"id": "itunes:kr", "name": "韩国榜", "group": "国际"},
]

ALL_CHARTS = NETEASE_CHARTS + ITUNES_CHARTS

# 电台曲池：各榜单取样条数（网易热歌 30 + 新歌 15 + iTunes 各国 12，混合洗牌）
RADIO_POOL_SIZES = {
    "netease:3778678": 30,
    "netease:3779629": 15,
    "itunes:us": 12,
    "itunes:gb": 10,
    "itunes:jp": 8,
    "itunes:kr": 8,
}

ITUNES_RSS = "https://itunes.apple.com/{cc}/rss/topsongs/limit={limit}/json"


def fetch_itunes_chart(country: str, limit: int = 30) -> list:
    """拉取 iTunes 国家榜（旧版 RSS，已验证大陆可达）。"""
    resp = requests.get(
        ITUNES_RSS.format(cc=country, limit=limit),
        headers={"User-Agent": NETEASE_HEADERS["User-Agent"]},
        timeout=10,
    )
    resp.raise_for_status()
    entries = resp.json().get("feed", {}).get("entry") or []
    # RSS 单条时不是数组，统一包列表
    if isinstance(entries, dict):
        entries = [entries]
    tracks = []
    for e in entries:
        try:
            images = e.get("im:image") or []
            # 取最大尺寸图（最后一张）并放大到 200x200（RSS 给 60-170）
            artwork = images[-1].get("label", "") if images else ""
            artwork = artwork.replace("/60x60", "/200x200").replace("/170x170", "/200x200")
            tracks.append({
                "trackId": f"itunes:{e.get('id', {}).get('attributes', {}).get('im:id', '')}",
                "name": sanitize_text(str((e.get("title") or {}).get("label") or "")),
                "singers": sanitize_text(str((e.get("im:artist") or {}).get("label") or "")),
                "album": sanitize_text(str(((e.get("category") or {}).get("attributes") or {}).get("term") or "")),
                "durationS": 0,  # RSS 不含时长，resolve 后由播放器取
                "coverUrl": artwork or None,
            })
        except Exception:
            continue
    return tracks


def fetch_netease_playlist(playlist_id: str) -> dict:
    """拉取网易云歌单（含排行榜）元数据。

    旧版 API 的 track 字段是新格式（ar/al/dt）与旧格式（artists/album/
    duration）混用的——不同歌单返回不同格式，两者都兼容。
    """
    resp = requests.get(
        NETEASE_API.format(playlist_id=playlist_id),
        headers=NETEASE_HEADERS,
        timeout=10,
    )
    resp.raise_for_status()
    result = resp.json().get("result") or {}
    tracks = []
    for t in (result.get("tracks") or [])[:200]:
        try:
            artists = t.get("ar") or t.get("artists") or []
            album = t.get("al") or t.get("album") or {}
            duration_ms = t.get("dt") or t.get("duration") or 0
            tracks.append({
                "trackId": str(t.get("id") or ""),
                "name": sanitize_text(str(t.get("name") or "")),
                "singers": sanitize_text(
                    ",".join(a.get("name", "") for a in artists)
                ),
                "album": sanitize_text(str(album.get("name") or "")),
                "durationS": int(duration_ms) // 1000,
                "coverUrl": album.get("picUrl") or None,
            })
        except Exception:
            continue
    return {"name": sanitize_text(str(result.get("name") or "")), "tracks": tracks}


def fetch_chart_tracks(chart_id: str) -> dict:
    """按 chartId 分发：netease:<歌单ID> / itunes:<国家码>。"""
    if chart_id.startswith("netease:"):
        return fetch_netease_playlist(chart_id.removeprefix("netease:"))
    if chart_id.startswith("itunes:"):
        country = chart_id.removeprefix("itunes:")
        return {"name": f"iTunes {country.upper()} 榜", "tracks": fetch_itunes_chart(country)}
    raise ValueError(f"unknown chartId: {chart_id}")


def fetch_radio_pool() -> list:
    """电台曲池：多榜单（网易 + iTunes 国际）并发取样 + 合并洗牌。"""
    import random
    from concurrent.futures import ThreadPoolExecutor, as_completed

    chart_ids = list(RADIO_POOL_SIZES.keys())
    pool: list = []
    with ThreadPoolExecutor(max_workers=len(chart_ids)) as ex:
        futures = {
            ex.submit(fetch_chart_tracks, cid): cid for cid in chart_ids
        }
        for future in as_completed(futures, timeout=30):
            try:
                result = future.result()
                limit = RADIO_POOL_SIZES[futures[future]]
                pool.extend((result.get("tracks") or [])[:limit])
            except Exception as e:
                sys.stderr.write(
                    f"[music-source] radio pool chart {futures[future]} failed: {e}\n"
                )
    # 去重（同名同歌手）+ 洗牌
    seen, unique = set(), []
    for t in pool:
        key = (t.get("name"), t.get("singers"))
        if key in seen:
            continue
        seen.add(key)
        unique.append(t)
    random.shuffle(unique)
    return unique


def extract_playlist_id(url_like: str) -> str | None:
    text = (url_like or "").strip()
    if not text:
        return None
    if text.isdigit():
        return text
    if "music.163.com" not in text:
        return None
    # 匹配 id=123（含 hash 片段 #/playlist?id=123）
    matched = re.search(r"[?&]id=(\d+)", text)
    return matched.group(1) if matched else None


def sanitize_text(text: str) -> str:
    """去掉控制字符（歌词中偶见 NUL 等会破坏部分 JSON 解析器）。"""
    if not text:
        return text
    return "".join(ch for ch in text if ch >= " " or ch in "\n\r\t")


def parse_duration_to_seconds(duration: str) -> int:
    """'00:04:09' → 249；解析失败返回 0。"""
    try:
        parts = [int(p) for p in str(duration).split(":")]
        if len(parts) == 3:
            return parts[0] * 3600 + parts[1] * 60 + parts[2]
        if len(parts) == 2:
            return parts[0] * 60 + parts[1]
    except (ValueError, TypeError):
        pass
    return 0


def serialize_song(song, dl_headers: dict) -> dict:
    # 字段名 camelCase，与 Rust OnlineSong（serde rename_all="camelCase"）
    # 严格对齐——snake_case 会导致 Rust 反序列化报 missing field。
    return {
        "source": str(song.source),
        "name": sanitize_text(str(song.song_name or "")),
        "singers": sanitize_text(str(song.singers or "")),
        "album": sanitize_text(str(getattr(song, "album", "") or "")),
        "durationS": int(getattr(song, "duration_s", 0) or 0)
        or parse_duration_to_seconds(getattr(song, "duration", "")),
        "ext": str(song.ext or ""),
        "fileSizeBytes": int(getattr(song, "file_size_bytes", 0) or 0),
        "downloadUrl": str(song.download_url or ""),
        "lyric": sanitize_text(str(song.lyric)) if getattr(song, "lyric", None) else None,
        "coverUrl": (str(song.cover_url) if getattr(song, "cover_url", None) else None),
        "identifier": str(getattr(song, "identifier", "") or ""),
        "dlHeaders": {str(k): str(v) for k, v in dl_headers.items()},
    }


def _build_client(source: str) -> musicdl.MusicClient:
    """构建单源 client（requests_overrides 的 timeout 透传给 requests）。"""
    return musicdl.MusicClient(
        music_sources=[source],
        init_music_clients_cfg={
            source: {
                "search_size_per_source": SEARCH_SIZE_PER_SOURCE,
                "max_retries": MAX_RETRIES,
            }
        },
        requests_overrides={source: {"timeout": REQUEST_TIMEOUT}},
    )


class MusicEngine:
    """musicdl 封装：按源并发搜索 + 先完成先收 + 总截止。"""

    def __init__(self):
        self._lock = threading.Lock()
        # 每源常驻一个 client（构造轻量；搜索线程安全由互斥锁保证）
        self._clients = {src: _build_client(src) for src in MUSIC_SOURCES}

    def _search_one(self, source: str, keyword: str) -> list:
        """搜索单个源并序列化（异常返回空——多源容灾）。"""
        try:
            client = self._clients[source]
            results = client.search(keyword=keyword)
            headers = dict(
                client.music_clients[source].default_download_headers or {}
            )
            songs = []
            for song in results.get(source) or []:
                try:
                    if not getattr(song, "download_url", None):
                        continue
                    ext = str(song.ext or "").lower()
                    if ext and ext not in VALID_EXTS:
                        continue
                    songs.append(serialize_song(song, headers))
                except Exception:
                    continue
            return songs
        except Exception:
            return []

    def search(self, keyword: str) -> list:
        with self._lock:
            from concurrent.futures import ThreadPoolExecutor, as_completed

            executor = ThreadPoolExecutor(max_workers=len(MUSIC_SOURCES))
            futures = {
                executor.submit(self._search_one, src, keyword): src
                for src in MUSIC_SOURCES
            }
            songs: list = []
            done_sources = 0
            try:
                # as_completed 的 timeout 即总截止：到期抛 TimeoutError，
                # 已完成的源结果照常收集，未完成的放弃（线程后台自灭）。
                # 够用即返回：≥2 源完成且 ≥6 首歌时 break，不等慢源。
                for future in as_completed(futures, timeout=SEARCH_DEADLINE):
                    result = future.result()
                    songs.extend(result)
                    done_sources += 1
                    if (
                        done_sources >= EARLY_RETURN_MIN_SOURCES
                        and len(songs) >= EARLY_RETURN_MIN_SONGS
                    ):
                        break
            except TimeoutError:
                pending = [futures[f] for f in futures if not f.done()]
                sys.stderr.write(
                    f"[music-source] search deadline hit, "
                    f"dropped {len(pending)} slow source(s): "
                    f"{', '.join(pending)}\n"
                )
            finally:
                # wait=False：不阻塞在卡住的源线程上（它们随请求结束自灭）
                executor.shutdown(wait=False, cancel_futures=True)
            return songs

    def resolve(self, name: str, singers: str) -> dict | None:
        """解析榜单/歌单曲目：多源搜索「歌名 歌手」+ 名称匹配取最优。

        榜单/歌单只拿到元数据（网易 API），播放前用此方法换回带校验
        直链的 OnlineSong。匹配优先级：歌名精确 + 歌手包含 > 歌名精确 >
        首个结果。
        """
        keyword = f"{name} {singers}".strip()
        songs = self.search(keyword)
        if not songs:
            return None

        def norm(text: str) -> str:
            return re.sub(r"\s+", "", (text or "").lower())

        target_name, target_singer = norm(name), norm(singers)
        exact_with_singer = next(
            (
                s
                for s in songs
                if norm(s["name"]) == target_name
                and target_singer
                and target_singer in norm(s["singers"])
            ),
            None,
        )
        exact = next((s for s in songs if norm(s["name"]) == target_name), None)
        return exact_with_singer or exact or songs[0]


ENGINE: MusicEngine | None = None


class Handler(BaseHTTPRequestHandler):
    """HTTP 处理器。"""

    def log_message(self, fmt, *args):  # 静默默认访问日志（stderr 走 Rust 日志泵）
        sys.stderr.write(("[music-source] " + fmt % args) + "\n")

    def _send_json(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            self._send_json(200, {"ok": True})
        elif self.path == "/charts":
            self._send_json(200, {"charts": ALL_CHARTS})
        elif self.path == "/radio_pool":
            self._send_json(200, {"tracks": fetch_radio_pool()})
        else:
            self._send_json(404, {"error": "not found"})

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def do_POST(self):
        try:
            if self.path == "/search":
                req = self._read_body()
                keyword = str(req.get("keyword") or "").strip()
                if not keyword:
                    self._send_json(400, {"error": "keyword required"})
                    return
                songs = ENGINE.search(keyword) if ENGINE else []
                self._send_json(200, {"songs": songs})
            elif self.path == "/chart_tracks":
                req = self._read_body()
                chart_id = str(req.get("chartId") or "").strip()
                if ":" not in chart_id:
                    self._send_json(400, {"error": "chartId required (netease:*/itunes:*)"})
                    return
                self._send_json(200, fetch_chart_tracks(chart_id))
            elif self.path == "/playlist":
                req = self._read_body()
                url = str(req.get("url") or "").strip()
                playlist_id = extract_playlist_id(url)
                if not playlist_id:
                    self._send_json(
                        400,
                        {"error": "仅支持网易云音乐歌单链接或纯数字歌单 ID"},
                    )
                    return
                self._send_json(200, fetch_netease_playlist(playlist_id))
            elif self.path == "/resolve":
                req = self._read_body()
                name = str(req.get("name") or "").strip()
                singers = str(req.get("singers") or "").strip()
                if not name:
                    self._send_json(400, {"error": "name required"})
                    return
                song = ENGINE.resolve(name, singers) if ENGINE else None
                if not song:
                    self._send_json(404, {"error": "未找到可播放的音源"})
                    return
                self._send_json(200, {"song": song})
            else:
                self._send_json(404, {"error": "not found"})
        except Exception as e:
            sys.stderr.write(
                f"[music-source] {self.path} failed:\n" + traceback.format_exc()
            )
            self._send_json(500, {"error": str(e)})


def main():
    global ENGINE
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    port = server.server_address[1]

    # 引擎初始化放端口绑定后（musicdl import 已在模块顶部完成，
    # MusicClient 构造很快；搜索是请求时才发生）
    ENGINE = MusicEngine()

    print(json.dumps({"event": "ready", "port": port}), flush=True)
    sys.stderr.write(f"[music-source] listening on 127.0.0.1:{port}\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
