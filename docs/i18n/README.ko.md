<div align="center">

# Velorn

**오픈소스 AI 비디오 워크스테이션 — 당신에게는 진짜 편집기를, 당신의 에이전트에게는 100개 이상의 MCP 도구를.**

[![Latest Release](https://img.shields.io/github/v/release/VelornLabs/velorn?label=Latest&color=6C63FF)](https://github.com/VelornLabs/velorn/releases/latest)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue)](../../LICENSE)
[![Platforms](https://img.shields.io/badge/Platforms-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-444444)](https://github.com/VelornLabs/velorn/releases/latest)

[![Website](https://img.shields.io/badge/Website-velorn.ai-0A9396)](https://velorn.ai)
[![Follow on X](https://img.shields.io/badge/Follow-%40getvelorn-000000?logo=x&logoColor=white)](https://x.com/getvelorn)
[![Join our Discord](https://img.shields.io/badge/Discord-커뮤니티%20참여-5865F2?logo=discord&logoColor=white)](https://discord.gg/QWZUuUChVK)

[![Download for Windows](https://img.shields.io/badge/Windows-다운로드-0078D4?style=for-the-badge)](https://github.com/VelornLabs/velorn/releases/latest)
[![Download for macOS](https://img.shields.io/badge/macOS-다운로드-1a1a1a?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/VelornLabs/velorn/releases/latest)
[![Download for Linux](https://img.shields.io/badge/Linux-다운로드-E95420?style=for-the-badge&logo=linux&logoColor=white)](https://github.com/VelornLabs/velorn/releases/latest)

[English](../../README.md) · [Español](README.es.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · 한국어 · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md)

</div>

<p align="center"><img src="../readme/agent-editing.gif" alt="프롬프트 하나: Claude가 MCP를 통해 Velorn에서 편집을 완성" width="860"></p>
<p align="center"><i>프롬프트 하나. 에이전트가 미디어를 생성하고 타임라인을 조립하며 오디오를 믹싱합니다 — MCP를 통해 실시간으로.</i></p>

> 이 번역은 최선을 다해 관리되지만, 불분명한 부분이 있다면 [영어 README](../../README.md)가 기준입니다. 번역 개선 PR을 환영합니다!

Velorn은 ComfyUI를 사용하는 크리에이터를 위한 오픈소스 데스크톱 AI 비디오 워크스테이션입니다. 기획, 생성, 에셋 관리, 타임라인 편집, 자막, 이펙트, 내보내기를 프로젝트 기반의 하나의 앱으로 통합합니다.

내장된 로컬/클라우드 워크플로를 사용하거나, 자신의 ComfyUI API 워크플로 JSON을 가져오거나, 번들된 Velorn Bridge를 설치해 ComfyUI에서 열려 있는 그래프를 Velorn으로 다시 보낼 수 있습니다.

<p align="center">
  <img src="../readme/editor-timeline.png" alt="생성된 에셋, 프리뷰, 타임라인 트랙, 인스펙터가 표시된 Velorn 편집기" />
</p>

## Velorn의 용도

- 가사, 타이밍, 캐릭터, 키프레임, 비디오 숏, 타임라인 편집으로 뮤직비디오 제작.
- 편집 가능한 숏 플랜을 갖춘 UGC 스타일 크리에이터 광고와 소상공인 광고 제작.
- 엄선된 로컬/클라우드 이미지·비디오 워크플로를 하나의 Generate 워크스페이스에서 실행.
- 커스텀 ComfyUI 이미지, 비디오, 키프레임, 뮤직비디오 워크플로를 앱 안에서 실행.
- 생성된 클립을 트랙, 트랜지션, 이펙트, 자막, 프록시/캐시 도구, 내보내기로 편집.
- 생성된 미디어, 프롬프트, 워크플로 출력, 타임라인을 프로젝트 안에서 체계적으로 관리.

Velorn은 ComfyUI를 대체하지 않습니다. ComfyUI를 둘러싼 프로덕션 레이어입니다. 작업을 계획하고, 작업을 ComfyUI로 보내고, 출력을 모으고, 편집을 마무리합니다.

<p align="center">
  <img src="../readme/create-workflows.png" alt="UGC, 비즈니스 광고, 뮤직비디오, 단편 영화 크리에이터가 있는 Velorn Create 워크스페이스" />
</p>

## 다운로드

대부분의 사용자는 [GitHub Releases 페이지](https://github.com/VelornLabs/velorn/releases)에서 패키징된 데스크톱 앱을 다운로드하면 됩니다.

릴리스 에셋은 다음을 포함합니다:

- `Windows Installer`
- `Windows Portable`
- `Mac (Apple Silicon)`
- `Mac (Intel)`
- `Linux AppImage`
- `Linux deb`

소스에서 직접 빌드할 계획이 아니라면 GitHub이 자동 생성하는 소스 코드 아카이브는 무시하세요.

## 주요 기능

### Generate(생성)

Generate는 내장 로컬 워크플로, 클라우드/파트너 워크플로, 커스텀 ComfyUI 워크플로를 실행합니다.

- 로컬 이미지, 비디오, 이미지 편집, 오디오, 유틸리티 워크플로.
- Nano Banana 2, GPT Image 2, Seedance, Kling 등 이용 가능한 파트너 노드 경로의 클라우드 워크플로.
- 자신의 ComfyUI API 그래프를 Velorn에서 실행하고 싶은 사용자를 위한 Custom Image / Custom Video 워크플로.
- ComfyUI에서 워크플로를 수동으로 내보내길 선호하는 고급 사용자를 위한 API JSON 가져오기.
- 호환 그래프를 ComfyUI에서 Velorn의 올바른 패널로 보낼 수 있는 Velorn Bridge 지원.
- 누락된 노드, 모델, 자격 증명, 설정을 확인하는 워크플로 설정 검사.
- Local/Cloud 필터가 있는 Featured / My Workflows / Templates 브라우저. 가져온 커뮤니티 워크플로는 내장 워크플로와 나란히 Featured에 표시됩니다.

<p align="center">
  <img src="../readme/generate-featured.png" alt="추천 워크플로, Local/Cloud 필터, 의존성 검사기가 있는 Velorn Generate 브라우저" />
</p>

Templates 탭에서는 공식 ComfyUI 템플릿 카탈로그(크기와 인기 정보가 있는 500개 이상의 템플릿)를 둘러보고, 어떤 템플릿이든 내장 ComfyUI 탭에서 실행할 수 있습니다.

<p align="center">
  <img src="../readme/generate-templates.png" alt="카테고리와 필터가 있는 공식 ComfyUI 템플릿 카탈로그를 보여주는 Velorn 템플릿 브라우저" />
</p>

### Create(제작)

Create에는 Velorn의 Director Mode 엔진 위에 구축된 가이드형 크리에이터 워크플로가 있습니다.

- **Music Video Creation** - 곡, 가사 타이밍, 캐릭터, 레퍼런스, 연출 스크립트를 키프레임, 비디오 숏, 편집 가능한 타임라인으로 변환합니다.
- **UGC Creator** - 훅, 대사, 제품 시연, 착용 시연, 후기 등을 갖춘 크리에이터 스타일 소셜 광고를 숏 단위로 편집 가능하게 제작합니다.
- **Business Ad Creator** - 지역 상점, 이커머스 제품, 이벤트, 서비스, 소규모 팀을 위한 오퍼 중심 광고를 제작합니다.
- **Short Film Creation** - 대본에서 장면 커버리지를 만드는 실험적 워크플로. 아직 베타 단계라 거친 부분이 있을 수 있습니다.

### Music Video Creation(뮤직비디오 제작)

뮤직비디오 크리에이터는 다음을 지원합니다:

- 곡 가져오기와 가사 타이밍.
- ASR 전사 또는 붙여넣은 가사를 SRT로 정렬.
- 기존 캐릭터 시트를 포함한 인물/캐스트 설정.
- 숏별 키프레임 프롬프트, 레퍼런스 이미지, 프롬프트 복사·편집, 이미지 교체, 숏 재실행.
- Qwen Image Edit, Nano Banana 2 같은 내장 키프레임 경로.
- Velorn 엔드포인트 노드를 사용하는 커스텀 키프레임 워크플로.
- LTX 2.3 Music, WAN 2.2 같은 내장 비디오 경로.
- 키프레임 이미지, 프롬프트, 시드, 가로, 세로, FPS, 길이, 오디오를 선택적으로 주입하는 커스텀 비디오 워크플로.
- 생성된 숏 에셋으로 타임라인 조립.

### 타임라인 편집기

편집기에는 다음이 포함됩니다:

- 프로젝트 에셋 브라우저.
- 멀티트랙 비디오/오디오 타임라인.
- 클립 트리밍, 이동, 스냅, 겹침 교체 동작, 트랜지션.
- 텍스트, 도형, 타이틀, 단색, 조정 레이어, 키프레임, 비주얼 이펙트 도구.
- 인스펙터 컨트롤.
- 더 부드러운 재생을 위한 프록시/캐시 도구.
- 최종 렌더링을 위한 내보내기 패널.

### 자막

자막은 편집된 타임라인 오디오에서 생성해 앱 안에서 스타일링할 수 있습니다.

- 타임라인을 인식하는 전사.
- 자막 스타일 프리셋.
- 폰트, 색상, 외곽선, 배경, 그림자, 애니메이션 컨트롤.
- 재사용을 위한 자막 스타일 프리셋 저장.
- 재생/스크럽 컨트롤과 세이프존 오버레이가 있는 실시간 프리뷰.
- 내보내기 준비가 된 자막 렌더링.

### 내보내기

Export 탭에는 실용적인 렌더 프리셋, 가능한 경우 하드웨어 가속 옵션, 대기열 컨트롤, 프로젝트 인식 출력 설정이 포함됩니다.

<p align="center">
  <img src="../readme/export-settings.png" alt="프리셋, 코덱 컨트롤, 내보내기 대기열이 있는 Velorn 내보내기 설정" />
</p>

### Stock(스톡)

Stock 탭은 Pexels를 사용해 사진이나 비디오를 검색하고 현재 프로젝트로 바로 가져올 수 있습니다. Pexels API 키는 선택 사항이며 Settings에서 추가할 수 있습니다.

<p align="center">
  <img src="../readme/stock-pexels.png" alt="Pexels 사진·비디오 검색이 있는 Velorn Stock 탭" />
</p>

### ComfyUI 연동

Velorn은 로컬 ComfyUI 서버와 통신하며, 실행을 도울 수도 있습니다.

- 기본 엔드포인트: `http://127.0.0.1:8188`
- Settings에서 커스텀 포트 지원.
- 설정된 ComfyUI 시작 스크립트를 위한 Windows 런처 지원.
- 설정된 `ComfyUI.app`을 위한 macOS 런처 지원.
- 선택적 자동 시작, 종료 시 정지, 재시작 동작.
- 그래프를 열고 편집할 수 있는 내장 ComfyUI 탭.
- 내장 ComfyUI 탭에서 ComfyUI 계정 로그인 지원.
- 가능한 경우 ComfyUI 크레딧 잔액 표시.

데스크톱 앱은 localhost/루프백 ComfyUI 엔드포인트만 지원합니다.

### AI 에이전트(MCP)

Velorn에는 Codex, Claude Code, Cursor 호환 도구 및 기타 MCP 클라이언트를 위한 100개 이상의 도구를 갖춘 로컬 MCP 서버가 포함되어 있습니다.

- 엔드포인트: `http://127.0.0.1:19790/mcp`
- 앱 내 설정: `Settings > Agents (MCP)` (클라이언트마다 명령 한 줄 복사·붙여넣기)
- 가이드: [docs/MCP.md](../MCP.md)

에이전트는 열려 있는 프로젝트를 검사하고, 타임라인 프레임과 화면에 보이는 숏을 리뷰하고, ComfyUI 설정 문제를 진단하고, 안전한 타임라인 편집을 미리 보고, 승인된 생성 작업을 대기열에 넣고, 납품용 내보내기를 시작할 수 있습니다.

에이전트는 커뮤니티 ComfyUI 워크플로도 가져올 수 있습니다. 워크플로 링크나 파일을 건네면 그래프를 분석하고, 누락된 커스텀 노드와 모델을 보고하고, 승인 후 설치한 다음, 타임라인 에셋으로 그 워크플로를 실행합니다.

쓰기 도구는 먼저 계획을 미리 보여주고 승인 후에만 적용하며, 모두 Velorn의 일반 실행 취소 스택에 올라갑니다. MCP는 에이전트 지원 리뷰, 타임라인 작업, 그래픽 다듬기, 생성 워크플로에 권장되는 자동화 경로입니다.

<p align="center">
  <img src="../readme/agents-mcp.png" alt="실행 중인 로컬 서버, 연결 명령, 전체 도구 목록이 있는 Velorn Agents (MCP) 설정" />
</p>

## 커스텀 워크플로

커스텀 워크플로는 Velorn이 존재하는 주요 이유 중 하나입니다.

고급 사용자는 다음을 할 수 있습니다:

1. Velorn에서 스타터 그래프를 엽니다.
2. ComfyUI에서 수정합니다.
3. 필요한 Velorn 엔드포인트 노드를 유지합니다.
4. Velorn Bridge로 다시 보내거나 API 워크플로 JSON을 수동으로 가져옵니다.
5. 그 그래프를 크리에이터 플로의 일부로, 또는 Generate에서 Velorn으로 실행합니다.

자주 쓰는 Velorn 엔드포인트 노드 제목:

- Velorn input image - `VELORN_INPUT_IMAGE`
- Velorn prompt - `VELORN_PROMPT`
- Velorn seed - `VELORN_SEED`
- Velorn width - `VELORN_WIDTH`
- Velorn height - `VELORN_HEIGHT`
- Velorn FPS - `VELORN_FPS`
- Velorn duration - `VELORN_DURATION`
- Velorn audio - `VELORN_AUDIO`
- Velorn output image - `VELORN_OUTPUT_IMAGE`
- Velorn output video - `VELORN_OUTPUT_VIDEO`

정확한 `VELORN_*` 제목이 권장되지만, `Velorn input image` 같은 읽기 쉬운 제목도 인식됩니다. 여전히 `COMFYSTUDIO_*` 마커 제목을 사용하는 이전 그래프도 하위 호환을 위해 지원됩니다.

엔드포인트가 있으면 Velorn이 해당 값을 주입할 수 있습니다. 없으면 그래프가 그 설정을 스스로 제어합니다.

<p align="center">
  <img src="../readme/comfyui-bridge.png" alt="Velorn 엔드포인트 노드와 Send to Velorn 버튼이 있는 내장 ComfyUI 그래프" />
</p>
