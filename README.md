# Akkord

Visualizador de música para móvil (Expo / React Native). Reproduce archivos de audio locales, analiza el audio en vivo (FFT, bandas, beat) y usa esos datos para animar shaders SkSL dibujados con Skia (barras, galaxia, ASCII, cubo de Rubik).

Enlace video youtube: https://youtu.be/S6da9RQC0_M

## Cómo correrlo

La app usa módulos nativos (`react-native-audio-api`, Skia), por lo que **no funciona en Expo Go**: necesita un development build.

```bash
npm install
npm run android   # compila e instala el build de desarrollo en un dispositivo/emulador Android
```

Otros scripts útiles: `npm start` (servidor Metro), `npm run ios`, `npm run lint`, `npm run typecheck`, `npm run check:shaders` (valida los shaders en Node).

## Estructura del proyecto

```
akkord/
├── src/
│   ├── app/            # Rutas (Expo Router)
│   ├── audio/          # Reproducción y análisis de audio
│   ├── viz/            # Visualizadores: Skia, shaders y texturas
│   │   └── shaders/    # Un archivo por visualizador (SkSL)
│   └── components/     # Componentes de UI reutilizables
├── scripts/            # Herramientas de desarrollo en Node
│   └── lib/            # Utilidades de los scripts
├── docs/               # Documentación (guía para escribir shaders)
├── assets/             # Imágenes, iconos y pistas de audio incluidas
├── app.json            # Configuración de Expo
├── eas.json            # Perfiles de build de EAS
└── dev-plan.md         # Referencia técnica y plan de desarrollo
```

### `src/app/`
Pantallas con Expo Router. `_layout.tsx` define el layout raíz e `index.tsx` es la pantalla principal: junta el reproductor, el canvas del visualizador y los selectores de pista/visualizador.

### `src/audio/`
Todo lo relacionado con el sonido.
- `engine.ts`: grafo de audio (`AudioBufferSourceNode → AnalyserNode → salida`); decodifica el archivo completo y maneja play/pausa/seek.
- `features.ts`: convierte la salida cruda del analizador en números útiles para shaders (64 bandas logarítmicas, graves/medios/agudos, energía y detección de beat con seguimiento de tempo). TypeScript puro, sin dependencias de RN.
- `useAudioFeatures.ts`: bucle por frame que lee el analizador y publica las features en un shared value de Reanimated (sin re-renders de React).
- `usePlayer.ts`: estado del reproductor (estado, pista, duración, posición).
- `library.ts` / `tracks.ts`: pistas incluidas y archivos elegidos por el usuario con el selector de documentos.

### `src/viz/`
Renderizado.
- `ShaderCanvas.tsx`: canvas de Skia que ejecuta el shader activo y le pasa las uniforms de audio.
- `shaders/`: un visualizador por archivo (`bars`, `galaxy`, `ascii`, `rubik`), registrados en `index.ts`; `common.ts` tiene el código SkSL compartido y `defineVisualizer`.
- `effects.ts`: compila el SkSL (con errores legibles).
- `spectrumTexture.ts` / `useSpectrumTexture.ts`: codifican el espectro como textura (`uSpectrum`) para los shaders.
- `glyphAtlas.ts` / `ChildShaders.tsx`: atlas de glifos y texturas generadas en runtime (usado por el visualizador ASCII).
- `quality.ts`: escala de resolución de render para controlar el rendimiento.
- `DebugOverlay.tsx`: dibuja los valores crudos del audio para depurar.

### `src/components/`
UI: `PlayerControls.tsx` (controles de reproducción) y `Sheet.tsx` (panel inferior modal para los selectores).

### `scripts/`
Herramientas con `tsx`/`node`, fuera de la app: `check-shaders.ts` (compila los shaders con CanvasKit), `preview-shader.ts` (renderiza una vista previa en Node, usando `lib/` para simular el analizador y un pool de workers) y `generate-test-track.mjs` (genera una pista de prueba).

### `docs/`
`shaders.md` explica cómo crear un shader nuevo, qué significa cada uniform y los errores comunes.
