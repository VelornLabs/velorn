<div align="center">

# Velorn

**A estação de trabalho de vídeo com IA de código aberto — um editor de verdade para você, e mais de 100 ferramentas MCP para o seu agente.**

[![Latest Release](https://img.shields.io/github/v/release/VelornLabs/velorn?label=Latest&color=6C63FF)](https://github.com/VelornLabs/velorn/releases/latest)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue)](../../LICENSE)
[![Platforms](https://img.shields.io/badge/Platforms-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-444444)](https://github.com/VelornLabs/velorn/releases/latest)

[![Website](https://img.shields.io/badge/Website-velorn.ai-0A9396)](https://velorn.ai)
[![Follow on X](https://img.shields.io/badge/Follow-%40getvelorn-000000?logo=x&logoColor=white)](https://x.com/getvelorn)
[![Join our Discord](https://img.shields.io/badge/Discord-Entre%20na%20comunidade-5865F2?logo=discord&logoColor=white)](https://discord.gg/QWZUuUChVK)

[![Download for Windows](https://img.shields.io/badge/Windows-Baixar-0078D4?style=for-the-badge)](https://github.com/VelornLabs/velorn/releases/latest)
[![Download for macOS](https://img.shields.io/badge/macOS-Baixar-1a1a1a?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/VelornLabs/velorn/releases/latest)
[![Download for Linux](https://img.shields.io/badge/Linux-Baixar-E95420?style=for-the-badge&logo=linux&logoColor=white)](https://github.com/VelornLabs/velorn/releases/latest)

[English](../../README.md) · [Español](README.es.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · Português (Brasil) · [Français](README.fr.md)

</div>

> Esta tradução é mantida com o melhor esforço possível. Em caso de dúvida, o [README em inglês](../../README.md) é a referência oficial. PRs com correções são bem-vindos!

O Velorn é uma estação de trabalho de vídeo com IA, de código aberto e para desktop, feita para criadores que usam o ComfyUI. Ele reúne planejamento, geração, gestão de assets, edição em linha do tempo, legendas, efeitos e exportação em um único app baseado em projetos.

Use os fluxos de trabalho locais e em nuvem integrados, traga seu próprio JSON de workflow da API do ComfyUI, ou instale o Velorn Bridge incluso para que um grafo aberto no ComfyUI possa ser enviado de volta ao Velorn.

<p align="center">
  <img src="../readme/editor-timeline.png" alt="Editor do Velorn com assets gerados, preview, trilhas da linha do tempo e inspetor" />
</p>

## Para que serve o Velorn

- Criar videoclipes a partir de letras, sincronização, personagens, keyframes, planos de vídeo e edições na linha do tempo.
- Construir anúncios estilo UGC para criadores e anúncios para pequenos negócios com planos de cena editáveis.
- Executar fluxos de trabalho selecionados de imagem/vídeo, locais e em nuvem, a partir de um único espaço Generate.
- Executar workflows personalizados do ComfyUI de imagem, vídeo, keyframes e videoclipe dentro do app.
- Editar os clipes gerados com trilhas, transições, efeitos, legendas, ferramentas de proxy/cache e exportação.
- Manter mídias geradas, prompts, saídas de workflows e linhas do tempo organizados dentro de um projeto.

O Velorn não substitui o ComfyUI. Ele é a camada de produção em torno do ComfyUI: planeje o trabalho, envie os jobs ao ComfyUI, colete as saídas e finalize a edição.

<p align="center">
  <img src="../readme/create-workflows.png" alt="Espaço Create do Velorn com criadores de UGC, anúncios, videoclipes e curtas" />
</p>

## Download

A maioria dos usuários deve baixar o app desktop empacotado na [página de Releases do GitHub](https://github.com/VelornLabs/velorn/releases).

Os arquivos de cada release incluem:

- `Windows Installer`
- `Windows Portable`
- `Mac (Apple Silicon)`
- `Mac (Intel)`
- `Linux AppImage`
- `Linux deb`

Ignore os arquivos de código-fonte gerados automaticamente pelo GitHub, a menos que você pretenda compilar o Velorn a partir do código.

## Principais recursos

### Generate

O Generate executa workflows locais integrados, workflows em nuvem/de parceiros e workflows personalizados do ComfyUI.

- Workflows locais de imagem, vídeo, edição de imagem, áudio e utilitários.
- Workflows em nuvem como Nano Banana 2, GPT Image 2, Seedance, Kling e outras rotas de nós de parceiros, quando disponíveis.
- Workflows Custom Image e Custom Video para quem quer que o Velorn execute seus próprios grafos da API do ComfyUI.
- Importação de JSON de API para usuários avançados que preferem exportar workflows manualmente do ComfyUI.
- Suporte ao Velorn Bridge para que grafos compatíveis possam ser enviados do ComfyUI ao painel correto do Velorn.
- Verificações de configuração do workflow: nós, modelos, credenciais e ajustes faltantes.
- Um navegador Featured / My Workflows / Templates com filtros Local e Cloud. Workflows da comunidade importados aparecem em Featured ao lado dos integrados.

<p align="center">
  <img src="../readme/generate-featured.png" alt="Navegador Generate do Velorn com workflows em destaque, filtros Local e Cloud e o verificador de dependências" />
</p>

A aba Templates navega pelo catálogo oficial de templates do ComfyUI (mais de 500 templates com informações de tamanho e popularidade) e abre qualquer um deles na aba integrada do ComfyUI.

<p align="center">
  <img src="../readme/generate-templates.png" alt="Navegador de templates do Velorn mostrando o catálogo oficial de templates do ComfyUI com categorias e filtros" />
</p>

### Create

O Create contém fluxos de trabalho guiados para criadores, construídos sobre o motor Director Mode do Velorn.

- **Music Video Creation** - transforma uma música, sincronização de letra, personagens, referências e um roteiro de direção em keyframes, planos de vídeo e uma linha do tempo editável.
- **UGC Creator** - constrói anúncios sociais no estilo criador de conteúdo, com ganchos, diálogos, demonstrações de produto, try-ons, depoimentos e saídas editáveis plano a plano.
- **Business Ad Creator** - constrói anúncios focados na oferta para negócios locais, produtos de e-commerce, eventos, serviços e equipes pequenas.
- **Short Film Creation** - fluxo experimental de roteiro para cobertura de cenas. Ainda está bem beta e pode ter arestas.

### Music Video Creation

O criador de videoclipes suporta:

- Importação de músicas e sincronização de letras.
- Transcrição ASR ou alinhamento de letras coladas em SRT.
- Configuração de pessoas/elenco, incluindo fichas de personagens existentes.
- Prompts de keyframe por plano, imagens de referência, cópia e edição de prompts, substituição de imagens e reexecução de planos.
- Rotas de keyframe integradas como Qwen Image Edit e Nano Banana 2.
- Workflows de keyframe personalizados usando os nós de endpoint do Velorn.
- Rotas de vídeo integradas como LTX 2.3 Music e WAN 2.2.
- Workflows de vídeo personalizados com injeção opcional de imagem de keyframe, prompt, seed, largura, altura, FPS, duração e áudio.
- Montagem da linha do tempo a partir dos assets de planos gerados.

### Editor de linha do tempo

O editor inclui:

- Navegador de assets do projeto.
- Linha do tempo multipista de vídeo/áudio.
- Corte e movimentação de clipes, snapping, comportamento de substituição por sobreposição e transições.
- Ferramentas de texto, formas, títulos, cor sólida, camadas de ajuste, keyframes e efeitos visuais.
- Controles do Inspector.
- Ferramentas de proxy/cache para reprodução mais fluida.
- Painel de exportação para renders finais.

### Legendas

As legendas podem ser geradas a partir do áudio editado da linha do tempo e estilizadas no app.

- Transcrição que entende a linha do tempo.
- Presets de estilo de legenda.
- Controles de fonte, cor, contorno, fundo, sombra e animação.
- Presets de estilo salvos para reutilização.
- Preview ao vivo com controles de reprodução/scrub e sobreposições de zonas seguras.
- Renders de legenda prontos para exportar.

### Exportação

A aba Export inclui presets de render práticos, opções com aceleração de hardware quando disponíveis, controles de fila e configurações de saída conscientes do projeto.

<p align="center">
  <img src="../readme/export-settings.png" alt="Configurações de exportação do Velorn com presets, controles de codec e fila de exportação" />
</p>

### Stock

A aba Stock usa o Pexels para você pesquisar e importar fotos ou vídeos diretamente para o projeto atual. A chave de API do Pexels é opcional e pode ser adicionada em Settings.

<p align="center">
  <img src="../readme/stock-pexels.png" alt="Aba Stock do Velorn com busca de fotos e vídeos do Pexels" />
</p>

### Integração com o ComfyUI

O Velorn se comunica com um servidor local do ComfyUI e também pode ajudar a iniciá-lo.

- Endpoint padrão: `http://127.0.0.1:8188`
- Suporte a porta personalizada em Settings.
- Suporte a launcher no Windows para um script de inicialização do ComfyUI configurado.
- Suporte a launcher no macOS para um `ComfyUI.app` configurado.
- Comportamento opcional de início automático, parada ao sair e reinício.
- Aba integrada do ComfyUI para abrir e editar grafos.
- Suporte a login de conta do ComfyUI dentro da aba integrada.
- Exibição do saldo de créditos do ComfyUI quando disponível.

O app desktop suporta apenas endpoints do ComfyUI em localhost/loopback.

### Agentes de IA (MCP)

O Velorn inclui um servidor MCP local com mais de 100 ferramentas para Codex, Claude Code, ferramentas compatíveis com Cursor e outros clientes MCP.

- Endpoint: `http://127.0.0.1:19790/mcp`
- Configuração no app: `Settings > Agents (MCP)` (um comando de copiar e colar por cliente)
- Guia: [docs/MCP.md](../MCP.md)

Os agentes podem inspecionar o projeto aberto, revisar quadros da linha do tempo e os planos visíveis, diagnosticar a configuração do ComfyUI, pré-visualizar edições seguras na linha do tempo, enfileirar trabalhos de geração aprovados e iniciar exportações de entrega.

Os agentes também podem trazer workflows do ComfyUI da comunidade: entregue a um deles um link ou arquivo de workflow, e ele analisa o grafo, informa os nós personalizados e modelos faltantes, instala-os após sua aprovação e executa o workflow com os assets da sua linha do tempo.

As ferramentas de escrita mostram o plano primeiro e só aplicam após aprovação, na pilha normal de desfazer do Velorn. O MCP é o caminho de automação recomendado para revisão assistida por agentes, operações na linha do tempo, acabamento de gráficos e fluxos de geração.

<p align="center">
  <img src="../readme/agents-mcp.png" alt="Configurações de Agents (MCP) do Velorn com o servidor local em execução, comandos de conexão e a lista completa de ferramentas" />
</p>

## Workflows personalizados

Os workflows personalizados são uma das principais razões pelas quais o Velorn existe.

Usuários avançados podem:

1. Abrir um grafo inicial a partir do Velorn.
2. Modificá-lo no ComfyUI.
3. Manter os nós de endpoint do Velorn necessários.
4. Enviá-lo de volta com o Velorn Bridge ou importar o JSON do workflow de API manualmente.
5. Executar esse grafo do Velorn como parte de um fluxo de criador ou pelo Generate.

Os títulos comuns dos nós de endpoint do Velorn incluem:

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

Títulos exatos `VELORN_*` são preferidos, mas o Velorn também reconhece títulos legíveis como `Velorn input image`. Grafos antigos que ainda usam títulos de marcador `COMFYSTUDIO_*` continuam suportados por compatibilidade.

Se um endpoint estiver presente, o Velorn pode injetar aquele valor. Se não estiver, o próprio grafo controla aquela configuração.

<p align="center">
  <img src="../readme/comfyui-bridge.png" alt="Grafo do ComfyUI integrado com nós de endpoint do Velorn e botão Send to Velorn" />
</p>
