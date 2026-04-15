# AlwaysLyrics

**YouTube Music 전용** 데스크톱 가사 표시 앱입니다.  
여러 플레이어를 두지 않고 **YouTube Music + Tuna + MusixMatch** 한 가지 흐름으로 쓰는 것을 목표로 합니다.

## 목표

- YouTube Music(데스크톱 앱)과만 연동
- 가사·번역·(선택) 한글 발음 등 **필요한 기능만 내장** — 플러그인 설치 없음
- 테마는 **하나로 고정** (커스텀 테마 UI 없음)
- 모니터 연결 변경 시에도 **창 위치가 기본 모니터로 튕기지 않도록** 복원 로직 개선
- 나중에 배포할 때만 **설치형(NSIS) / 포터블** 빌드
- Windows **시작 프로그램** 연동(추가 예정)

## 개발 환경

```bash
cd AlwaysLyrics
npm install
npm start
```

## YouTube Music 연동 (재생 정보)

**YouTube Music Desktop**([th-ch/youtube-music](https://github.com/th-ch/youtube-music/releases))에 **tuna-obs** 플러그인을 켜고, 전송 URL을 아래로 맞춥니다.

- `http://127.0.0.1:1608/` (기본 포트 **1608**)

1. AlwaysLyrics 실행 (`npm start`)
2. YouTube Music Desktop 실행 → 플러그인에서 **tuna-obs** 활성화
3. tuna 설정에서 위 주소로 POST 되도록 지정
4. 음악 재생 시 AlwaysLyrics 창에 제목·아티스트·진행 시간이 표시됨

> **참고:** **같은 포트(1608)를 쓰는 다른 프로그램**이 동시에 실행 중이면 한쪽만 수신할 수 있습니다. 한쪽만 켜거나, 나중에 AlwaysLyrics 포트 설정을 추가하면 됩니다.

## 현재 상태

- **완료:** Tuna 호환 HTTP 수신 (`src/main/tuna-server.js`), 재생 정보 UI, **창 위치 저장·모니터 변경 시 보정** (`window-bounds.json`), **Windows 시작 시 실행** 옵션(체크박스)
- **가사:** 동기 가사 검색은 **MusixMatch만** 사용합니다(다른 가사 API·플러그인 소스 없음). Shazam(ISRC)·제목 매칭은 MusixMatch까지 곡을 찾기 위한 보조일 뿐입니다.

## 문제 해결

### 재생 정보가 안 올 때

1. **1608 포트**를 이미 쓰는 프로그램이 없는지 확인하세요. 같은 포트를 두 프로세스가 동시에 열 수 없습니다.  
2. YouTube Music 플러그인 URL은 **`http://127.0.0.1:1608/`** 로 두는 것을 권장합니다. (`localhost`는 환경에 따라 IPv6 `::1`로만 붙어서, `127.0.0.1`에만 열린 서버와 안 맞을 수 있습니다.)  
3. 창 상단의 **회색 통계 줄**을 보세요.  
   - **「아직 HTTP 요청 없음」**이면 유튜브 뮤직이 이 PC로 POST를 안 보내는 것입니다 → 플러그인 켜짐·URL·AlwaysLyrics 실행 여부를 확인하세요.  
   - **HTTP 수신은 늘는데 유효 Tuna가 0**이면 요청은 오는데 JSON 형식이 기대와 다르거나 `data.status`가 없는 경우입니다 → `npm run start:debug` 로 터미널 로그를 확인하세요.  
4. 요청 경로는 **`/`가 아니어도** 본문이 Tuna 형식이면 수신합니다. `status` 대소문자(`PLAYING` 등)도 허용합니다.

### 디버그 로그

프로젝트 폴더에서 (한 번 `npm install` 후):

```bash
npm run start:debug
```

**참고:** `$env:ALWAYSLYRICS_DEBUG=1` 은 **PowerShell** 전용입니다. **cmd(명령 프롬프트)** 에서 쓰면 구문 오류가 납니다. cmd에서는 아래처럼 쓰거나, 위 `npm run start:debug` 를 쓰세요.

```bat
set ALWAYSLYRICS_DEBUG=1
npm start
```

거부된 POST·404가 있으면 터미널에 `[AlwaysLyrics][tuna]` 로그가 남습니다.

개발자 도구(Chromium)를 띄우려면:

```bat
set ALWAYSLYRICS_DEVTOOLS=1
npm start
```

PowerShell: `$env:ALWAYSLYRICS_DEVTOOLS="1"; npm start`

렌더러는 **약 1.2초마다 메인 프로세스 상태(`getTunaState`)를 폴링**해 화면을 맞춥니다. IPC만으로는 갱신이 안 되는 환경에서도 재생 정보가 보이도록 한 백업입니다.

### 「서버 준비 중」만 보일 때

- 메인에서 `listen` 완료 후 창을 띄우고, 렌더러는 **`tuna:get-state`**로 스냅샷을 받습니다.  
- 그래도 안 되면 **1608 포트 충돌** 여부를 확인하세요.

## 빌드(초안)

```bash
npm run dist
```

`release/` 폴더에 Windows 설치 파일·포터블이 생성되도록 `electron-builder`를 넣어 두었습니다.
