<div align="center">

# Velorn

**La estación de trabajo de vídeo con IA de código abierto: un editor de verdad para ti, y más de 100 herramientas MCP para tu agente.**

[![Latest Release](https://img.shields.io/github/v/release/VelornLabs/velorn?label=Latest&color=6C63FF)](https://github.com/VelornLabs/velorn/releases/latest)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue)](../../LICENSE)
[![Platforms](https://img.shields.io/badge/Platforms-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-444444)](https://github.com/VelornLabs/velorn/releases/latest)

[![Website](https://img.shields.io/badge/Website-velorn.ai-0A9396)](https://velorn.ai)
[![Follow on X](https://img.shields.io/badge/Follow-%40getvelorn-000000?logo=x&logoColor=white)](https://x.com/getvelorn)
[![Join our Discord](https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.gg/QWZUuUChVK)

[![Download for Windows](https://img.shields.io/badge/Windows-Descargar-0078D4?style=for-the-badge)](https://github.com/VelornLabs/velorn/releases/latest)
[![Download for macOS](https://img.shields.io/badge/macOS-Descargar-1a1a1a?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/VelornLabs/velorn/releases/latest)
[![Download for Linux](https://img.shields.io/badge/Linux-Descargar-E95420?style=for-the-badge&logo=linux&logoColor=white)](https://github.com/VelornLabs/velorn/releases/latest)

[English](../../README.md) · Español · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md)

</div>

<p align="center"><img src="../readme/agent-editing.gif" alt="Un prompt: Claude construye la edición en Velorn vía MCP" width="860"></p>
<p align="center"><i>Un solo prompt. El agente genera los medios, construye la línea de tiempo y mezcla el audio — en vivo, vía MCP.</i></p>

> Esta traducción se mantiene con el mejor esfuerzo posible. Si algo no queda claro, el [README en inglés](../../README.md) es la referencia autorizada. ¡Los PR con correcciones son bienvenidos!

Velorn es una estación de trabajo de vídeo con IA, de código abierto y para escritorio, pensada para creadores que usan ComfyUI. Reúne planificación, generación, gestión de assets, edición en línea de tiempo, subtítulos, efectos y exportación en una sola aplicación basada en proyectos.

Usa los flujos de trabajo locales y en la nube incluidos, trae tu propio JSON de workflow de la API de ComfyUI, o instala el Velorn Bridge incluido para que un grafo abierto en ComfyUI pueda enviarse de vuelta a Velorn.

<p align="center">
  <img src="../readme/editor-timeline.png" alt="Editor de Velorn con assets generados, previsualización, pistas de línea de tiempo e inspector" />
</p>

## Para qué sirve Velorn

- Crear vídeos musicales a partir de letras, sincronización, personajes, keyframes, tomas de vídeo y ediciones en la línea de tiempo.
- Construir anuncios estilo UGC para creadores y anuncios para pequeños negocios con planes de tomas editables.
- Ejecutar flujos de trabajo seleccionados de imagen/vídeo, locales y en la nube, desde un único espacio Generate.
- Ejecutar workflows personalizados de ComfyUI de imagen, vídeo, keyframes y vídeo musical dentro de la app.
- Editar los clips generados con pistas, transiciones, efectos, subtítulos, herramientas de proxy/caché y exportación.
- Mantener organizados los medios generados, los prompts, las salidas de los workflows y las líneas de tiempo dentro de un proyecto.

Velorn no sustituye a ComfyUI. Es la capa de producción alrededor de ComfyUI: planifica el trabajo, envía los trabajos a ComfyUI, recoge los resultados y termina la edición.

<p align="center">
  <img src="../readme/create-workflows.png" alt="Espacio Create de Velorn con creadores de UGC, anuncios de negocio, vídeo musical y cortometraje" />
</p>

## Descarga

La mayoría de los usuarios deberían descargar la aplicación de escritorio empaquetada desde la [página de Releases de GitHub](https://github.com/VelornLabs/velorn/releases).

Los archivos de cada release incluyen:

- `Windows Installer`
- `Windows Portable`
- `Mac (Apple Silicon)`
- `Mac (Intel)`
- `Linux AppImage`
- `Linux deb`

Ignora los archivos de código fuente generados automáticamente por GitHub, salvo que quieras compilar Velorn desde el código.

## Funciones principales

### Generate

Generate ejecuta workflows locales integrados, workflows en la nube/de partners y workflows personalizados de ComfyUI.

- Workflows locales de imagen, vídeo, edición de imagen, audio y utilidades.
- Workflows en la nube como Nano Banana 2, GPT Image 2, Seedance, Kling y otras rutas de nodos de partners donde estén disponibles.
- Workflows Custom Image y Custom Video para usuarios que quieran que Velorn ejecute sus propios grafos de la API de ComfyUI.
- Importación de JSON de API para usuarios avanzados que prefieran exportar workflows manualmente desde ComfyUI.
- Soporte de Velorn Bridge para que los grafos compatibles puedan enviarse desde ComfyUI al panel correcto de Velorn.
- Comprobaciones de configuración del workflow: nodos, modelos, credenciales y ajustes que falten.
- Un navegador Featured / My Workflows / Templates con filtros Local y Cloud. Los workflows de la comunidad importados aparecen en Featured junto a los integrados.

<p align="center">
  <img src="../readme/generate-featured.png" alt="Navegador Generate de Velorn con workflows destacados, filtros Local y Cloud y el verificador de dependencias" />
</p>

La pestaña Templates permite explorar el catálogo oficial de plantillas de ComfyUI (más de 500 plantillas con información de tamaño y popularidad) y abrir cualquiera de ellas en la pestaña de ComfyUI integrada.

<p align="center">
  <img src="../readme/generate-templates.png" alt="Navegador de plantillas de Velorn mostrando el catálogo oficial de plantillas de ComfyUI con categorías y filtros" />
</p>

### Create

Create contiene flujos de trabajo guiados para creadores, construidos sobre el motor Director Mode de Velorn.

- **Music Video Creation** - convierte una canción, la sincronización de la letra, personajes, referencias y un guion de dirección en keyframes, tomas de vídeo y una línea de tiempo editable.
- **UGC Creator** - construye anuncios sociales estilo creador con ganchos, diálogos, demostraciones de producto, try-ons, testimonios y salidas editables toma a toma.
- **Business Ad Creator** - construye anuncios centrados en la oferta para negocios locales, productos de ecommerce, eventos, servicios y equipos pequeños.
- **Short Film Creation** - flujo experimental de guion a cobertura de escenas. Todavía está muy en beta y puede tener aristas.

### Music Video Creation

El creador de vídeos musicales soporta:

- Importación de canciones y sincronización de letras.
- Transcripción ASR o alineación de letras pegadas a SRT.
- Configuración de personas/reparto, incluyendo fichas de personaje existentes.
- Prompts de keyframe por toma, imágenes de referencia, copia y edición de prompts, reemplazo de imágenes y repetición de tomas.
- Rutas de keyframes integradas como Qwen Image Edit y Nano Banana 2.
- Workflows de keyframes personalizados usando los nodos de endpoint de Velorn.
- Rutas de vídeo integradas como LTX 2.3 Music y WAN 2.2.
- Workflows de vídeo personalizados con inyección opcional de imagen de keyframe, prompt, seed, ancho, alto, FPS, duración y audio.
- Ensamblaje de la línea de tiempo a partir de los assets de tomas generados.

### Editor de línea de tiempo

El editor incluye:

- Navegador de assets del proyecto.
- Línea de tiempo multipista de vídeo/audio.
- Recorte y movimiento de clips, snapping, comportamiento de reemplazo por solapamiento y transiciones.
- Herramientas de texto, formas, títulos, color sólido, capas de ajuste, keyframes y efectos visuales.
- Controles del Inspector.
- Herramientas de proxy/caché para una reproducción más fluida.
- Panel de exportación para los renders finales.

### Subtítulos

Los subtítulos pueden generarse a partir del audio editado de la línea de tiempo y estilizarse dentro de la app.

- Transcripción consciente de la línea de tiempo.
- Presets de estilo de subtítulos.
- Controles de fuente, color, contorno, fondo, sombra y animación.
- Presets de estilo guardados para reutilizar.
- Previsualización en vivo con controles de reproducción/scrub y superposiciones de zonas seguras.
- Renders de subtítulos listos para exportar.

### Exportación

La pestaña Export incluye presets de render prácticos, opciones aceleradas por hardware donde estén disponibles, controles de cola y ajustes de salida conscientes del proyecto.

<p align="center">
  <img src="../readme/export-settings.png" alt="Ajustes de exportación de Velorn con presets, controles de códec y cola de exportación" />
</p>

### Stock

La pestaña Stock usa Pexels para que puedas buscar e importar fotos o vídeos directamente al proyecto actual. La clave de API de Pexels es opcional y puede añadirse en Settings.

<p align="center">
  <img src="../readme/stock-pexels.png" alt="Pestaña Stock de Velorn con búsqueda de fotos y vídeos de Pexels" />
</p>

### Integración con ComfyUI

Velorn se comunica con un servidor local de ComfyUI y también puede ayudar a lanzarlo.

- Endpoint por defecto: `http://127.0.0.1:8188`
- Soporte de puerto personalizado en Settings.
- Soporte de lanzador en Windows para un script de inicio de ComfyUI configurado.
- Soporte de lanzador en macOS para una `ComfyUI.app` configurada.
- Comportamiento opcional de auto-inicio, parada al salir y reinicio.
- Pestaña de ComfyUI integrada para abrir y editar grafos.
- Soporte de inicio de sesión de cuenta de ComfyUI dentro de la pestaña integrada.
- Visualización del saldo de créditos de ComfyUI cuando esté disponible.

La app de escritorio solo soporta endpoints de ComfyUI en localhost/loopback.

### Agentes de IA (MCP)

Velorn incluye un servidor MCP local con más de 100 herramientas para Codex, Claude Code, herramientas compatibles con Cursor y otros clientes MCP.

- Endpoint: `http://127.0.0.1:19790/mcp`
- Configuración en la app: `Settings > Agents (MCP)` (un comando de copiar y pegar por cliente)
- Guía: [docs/MCP.md](../MCP.md)

Los agentes pueden inspeccionar el proyecto abierto, revisar fotogramas de la línea de tiempo y las tomas visibles, diagnosticar la configuración de ComfyUI, previsualizar ediciones seguras de la línea de tiempo, poner en cola trabajos de generación aprobados e iniciar exportaciones de entrega.

Los agentes también pueden traer workflows de ComfyUI de la comunidad: pásale a uno un enlace o archivo de workflow, y analizará el grafo, informará de los nodos personalizados y modelos que falten, los instalará tras tu aprobación y ejecutará el workflow con los assets de tu línea de tiempo.

Las herramientas de escritura previsualizan primero su plan y solo lo aplican tras la aprobación, sobre la pila de deshacer normal de Velorn. MCP es la vía de automatización recomendada para revisión asistida por agentes, operaciones de línea de tiempo, pulido de gráficos y flujos de generación.

<p align="center">
  <img src="../readme/agents-mcp.png" alt="Ajustes de Agents (MCP) de Velorn con el servidor local en ejecución, comandos de conexión y la lista completa de herramientas" />
</p>

## Workflows personalizados

Los workflows personalizados son una de las principales razones por las que existe Velorn.

Los usuarios avanzados pueden:

1. Abrir un grafo inicial desde Velorn.
2. Modificarlo en ComfyUI.
3. Mantener los nodos de endpoint de Velorn requeridos.
4. Enviarlo de vuelta con el Velorn Bridge o importar el JSON del workflow de API manualmente.
5. Ejecutar ese grafo desde Velorn como parte de un flujo de creador o desde Generate.

Los títulos habituales de los nodos de endpoint de Velorn incluyen:

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

Se prefieren los títulos exactos `VELORN_*`, pero Velorn también reconoce títulos legibles como `Velorn input image`. Los grafos antiguos que todavía usan títulos de marcador `COMFYSTUDIO_*` siguen soportados por compatibilidad.

Si un endpoint está presente, Velorn puede inyectar ese valor. Si no está presente, el grafo controla ese ajuste por sí mismo.

<p align="center">
  <img src="../readme/comfyui-bridge.png" alt="Grafo de ComfyUI integrado con nodos de endpoint de Velorn y botón Send to Velorn" />
</p>
