# VELORN-MULTIMEDIA-BREADTH-PRODUCT-02 — cierre final

**Autor:** Manus AI

**Fecha:** 10 de septiembre de 2026

**Rama:** `velorn-multimedia-specialist-complete-01-20260908`
**Base observada al iniciar:** `502e74100fceb34b952058909fbae2f5d33f41ef`

> El cierre demuestra producto únicamente para las rutas, artifacts, controles y proyectos exactos registrados. No transfiere `PRODUCT_PROVEN` a herramientas vecinas, modelos instalados ni capacidades sólo descubribles.

## Resultado binario

| Gate | Resultado |
|---|---:|
| Proyectos Velorn A–M existentes | **13/13** |
| Proyectos A–M con checkpoint, save y cierre real | **13/13** |
| Proyectos A–M reabiertos desde disco | **13/13** |
| Exportaciones materializadas y válidas por `ffprobe` | **13/13** |
| Proyectos y exports con SHA-256 | **13/13** |
| Carriles con receipt final | **20/20** |
| Validación final | **PASS** |

Los proyectos A–G fueron reabiertos en frío y reexportados. H–M se construyeron como proyectos Velorn nativos independientes con artifacts existentes, sin repetir llamadas comerciales, generación de medios, GPU ni benchmarks.

## Estado A–M

| Proyecto | Alcance exacto | Estado | Observación decisiva |
|---|---|---|---|
| A | Imagen e identidad | **PRODUCT_PROVEN** | Estructura, assets y exportación persistieron tras reapertura real. |
| B | Video y continuidad | **PRODUCT_PROVEN** | Timeline de 20 s reabierta y exportada desde disco. |
| C | Personaje, sonido y captions | **PRODUCT_PROVEN** | Captions y audio persistieron; exportación H.264/AAC válida. |
| D | Post, restauración y composición | **PRODUCT_PROVEN** | Las rutas exactas permanecen editables; el upscale comercial conserva su rechazo de calidad. |
| E | Avatar y voz | **PRODUCT_PROVEN** | Avatar con voz conservado como producto exacto; no prueba mocap ni clonación. |
| F | SFX/Foley A–B | **PRODUCT_PROVEN / QUALITY_REJECTED** | El proyecto y ambos comparables son reproducibles; ningún resultado ganó el gate cinematográfico. |
| G | Doblaje multilingüe | **PRODUCT_PROVEN** | Pistas y entrega persistieron; no se afirma lipsync del idioma destino. |
| H | Lipsync A–B–C | **PRODUCT_PROVEN** | Los tres candidatos son comparables dentro de un proyecto editable; Precision ganó sólo el input exacto. |
| I | Voz y cleanup | **PRODUCT_PROVEN** | Cinco fuentes, waveforms y level-match persistieron; DeepFilterNet ganó sólo el WAV probado. |
| J | Música y stems | **PRODUCT_PROVEN** | Stems independientes, prueba solo/mute reversible y reconstrucción persistente. |
| K | Meshy 3D | **PRODUCT_PROVEN** como proyecto editorial; **BLOCKED_EXTERNAL** para edición 3D nativa | El GLB se conserva externamente por hash; Velorn no expone contrato de importación/edición 3D. |
| L | Matte, foreground, alpha y RGBA | **PRODUCT_PROVEN_AUXILIARY** | Se demostró visible→hidden→restored; originals alpha/RGBA se preservan y proxies H.264 permiten el delivery. |
| M | Imagen multirreferencia | **PRODUCT_PROVEN** para dos artifacts materializados | No se fingen cuatro referencias y tres candidates editables por separado: esa granularidad no existe en los artifacts preservados. |

## Veinte carriles

La matriz final conserva estados compuestos cuando corresponde. NLE, composición, captions/localización, QC y finishing/delivery están probados para los proyectos exactos. Avatar, voz, lipsync, música, audio cleanup, VFX, matte, 3D, restauración y upscale conservan límites específicos por candidato. Tracking, producción virtual e interpolación continúan `BLOCKED_EXTERNAL`; color sigue `EXECUTABLE` sin un producto dedicado.

La evidencia completa está en `FINAL_20_LANE_MATRIX_20260910.md`, `FINAL_20_LANE_MATRIX_20260910.json` y `LANE_RECEIPTS_20260910.jsonl`.

## CalibrationProfile y Workflow Equalizer

El perfil publicado sigue siendo `wan-animate2-identity-motion-v1`, porque es el único candidato con ruta exacta, locks, rango y producto campeón directo. Se añadió un resolver de intención natural determinista y fail-closed. La frase registrada:

> Conserva al máximo la identidad, sigue el movimiento aprobado y bloquea la coreografía.

produce los mismos controles `{identityFidelity: 96, motionAdherence: 75, choreographyLock: 100}`, los mismos parámetros técnicos y el mismo `CalibrationPatch` que la edición manual. Ambos caminos producen SHA-256 `9b6d1b0f36848e4284d60db71d6987f9bca63272769976883d538d8cfa94157a`.

Las intenciones desconocidas y los overrides manuales conflictivos fallan cerrados. Los perfiles candidatos HeyGen, ElevenLabs, DeepFilterNet, MatAnyone2, captions y mastering no se publican todavía como `CalibrationProfile` ejecutable nuevo porque carecen de un contrato genérico de patch enlazado a su ruta exacta.

## Defectos locales corregidos

| Defecto | Corrección | Regresión |
|---|---|---|
| Una ventana Velorn antigua podía cerrar tarde y poner `mainWindow=null` después de crear una ventana nueva, dejando el MCP vivo pero sin renderer | La referencia global sólo se limpia cuando la ventana cerrada sigue siendo la ventana rastreada | Dos pruebas cubren reemplazo conservado y cierre de la ventana actual |
| El Equalizer no aceptaba lenguaje natural con equivalencia demostrable | Resolver de intents registrados, normalizados, deterministas y fail-closed sobre el mismo `CalibrationPatch` | Equivalencia natural/manual y conflictos rechazados |
| El worker Chromium no podía exportar los originals `gray16le`/`qtrle` de L | Originals preservados por hash; proxies H.264 usados únicamente para el delivery | Cold reopen y exportación final válidos; prueba reversible preservada |

## Pruebas

| Prueba | Resultado |
|---|---:|
| Regresión focal de portafolio, catálogo, MCP, Equalizer y ciclo de ventana | **38/38 PASS** |
| Build Vite | **PASS** |
| `git diff --check` | **PASS** |
| Scan de formas de secretos en el diff | **PASS** |
| Validación A–M + 20 carriles | **PASS** |

El build conserva advertencias heredadas de chunks grandes e imports dinámicos/estáticos; no son regresiones de este cambio y no se modificó `package.json`.

## Bloqueos y delta frente al techo mundial

| Gap | Estado exacto | Acción que lo desbloquea |
|---|---|---|
| Mocap corporal/cámara | **BLOCKED_EXTERNAL** | Captura o entitlement válido y producto comparable |
| Tracking | **BLOCKED_EXTERNAL** | Runtime/pesos exactos, licencia comercial y artifact validado |
| Producción virtual | **BLOCKED_EXTERNAL** | Unreal/stage/tracking y brief de producto específico |
| Edición 3D nativa | **BLOCKED_EXTERNAL** | Contrato Velorn de GLB/scene/rig/material, no una importación fingida |
| Color IA | **EXECUTABLE sin producto** | Benchmark dedicado con scopes y referencia aprobada |
| Matte premium | **Producto auxiliar; gate premium no superado** | Artifact sin halo/flicker y comparación especializada |
| Restauración/upscale premium | **Baseline/rechazo preservados; sin campeón** | Ruta frontier licenciada y benchmark con el mismo input |
| Interpolación | **INSTALLED/DISCOVERABLE, no validada** | Graph exacto, artifact y QC de dobles/flicker/rostro/manos |
| Clonación y dubbing lipsync combinado | **BLOCKED_EXTERNAL** | Consentimiento, ruta exacta y producto combinado validado |
| Granularidad multirreferencia M | **No materializada** | Recuperar/generar las referencias y candidates individuales; no inferirlos de una lámina compuesta |

## Archivos de evidencia

| Archivo | Función |
|---|---|
| `FINAL_AM_PRODUCT_CLOSURE.json` | Censo hashado de los trece proyectos |
| `FINAL_20_LANE_MATRIX_20260910.md` | Matriz legible de los veinte carriles |
| `FINAL_20_LANE_MATRIX_20260910.json` | Matriz machine-readable |
| `LANE_RECEIPTS_20260910.jsonl` | Veinte receipts finales |
| `CALIBRATION_EQUIVALENCE_EVIDENCE.json` | Prueba natural/manual del Equalizer |
| `FINAL_CLOSURE_VALIDATION_20260910.json` | Validador final y gates K/L/M |
| `AG_COLD_REOPEN_CONTACT_SHEETS.png` | Evidencia visual A–G |
| `HIJ_COLD_REOPEN_CONTACT_SHEETS.png` | Evidencia visual H–J |
| `KLM_COLD_REOPEN_AND_L_REVERSIBILITY.png` | Evidencia visual K–M y ciclo reversible L |
| `K_SOURCE_VIEWS.png` | Cinco vistas Meshy preservadas para K |
| `I_WAVEFORM_INPUTS_MONTAGE.png` | Cinco waveforms I verificadas fuera del compositor |

No se fusiona `main`. El PR debe revisarse con CI antes de cualquier decisión de merge.
