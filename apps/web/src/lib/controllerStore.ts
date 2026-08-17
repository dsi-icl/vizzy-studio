import { create } from 'zustand';

import { ERASER_DEFAULT_WIDTH, clampEraserWidth } from './eraser';
import { appendEraserPoint as appendBoundedEraserPoint } from './lineEraser';

export interface ControllerState {
    isDrawing: boolean;
    isErasing: boolean;
    eraserWidth: number;
    strokeColor: string;
    strokeWidth: number;
    strokeDash: number[];
    currentLine: number[];
    setDrawing: (isDrawing: boolean) => void;
    toggleDrawing: () => void;
    setErasing: (isErasing: boolean) => void;
    setEraserWidth: (width: number) => void;
    setStrokeColor: (strokeColor: string) => void;
    setStrokeWidth: (strokeWidth: number) => void;
    setStrokeDash: (strokeDash: number[]) => void;
    startLine: (x: number, y: number) => void;
    appendLinePoint: (x: number, y: number) => void;
    appendEraserPoint: (x: number, y: number) => number[] | null;
    clearCurrentLine: () => void;
    consumeCurrentLine: () => number[];
}

export type ControllerStateCreator = ReturnType<ReturnType<typeof create<ControllerState>>>;

export const useControllerStore =
    typeof window !== 'undefined' && window.__CONTROLLER_STORE__
        ? window.__CONTROLLER_STORE__
        : create<ControllerState>()((set, get) => ({
              isDrawing: false,
              isErasing: false,
              eraserWidth: ERASER_DEFAULT_WIDTH,
              strokeColor: '#ff0000',
              strokeWidth: 10,
              strokeDash: [],
              currentLine: [],
              setDrawing: (isDrawing) =>
                  set((s) => {
                      if (s.isDrawing === isDrawing && (isDrawing || s.currentLine.length === 0)) {
                          return s;
                      }
                      return {
                          isDrawing,
                          isErasing: isDrawing ? false : s.isErasing,
                          currentLine: []
                      };
                  }),
              toggleDrawing: () =>
                  set((s) => ({
                      isDrawing: !s.isDrawing,
                      isErasing: false,
                      currentLine: []
                  })),
              setErasing: (isErasing) => set({ isErasing, isDrawing: false, currentLine: [] }),
              setEraserWidth: (width) => set({ eraserWidth: clampEraserWidth(width) }),
              setStrokeColor: (strokeColor) => set({ strokeColor }),
              setStrokeWidth: (strokeWidth) => set({ strokeWidth }),
              setStrokeDash: (strokeDash) => set({ strokeDash }),
              startLine: (x, y) => set({ currentLine: [Math.round(x), Math.round(y)] }),
              appendLinePoint: (x, y) =>
                  set((s) => ({
                      currentLine: s.currentLine.concat([Math.round(x), Math.round(y)])
                  })),
              appendEraserPoint: (x, y) => {
                  const currentLine = get().currentLine;
                  const roundedX = Math.round(x);
                  const roundedY = Math.round(y);
                  if (
                      currentLine[currentLine.length - 2] === roundedX &&
                      currentLine[currentLine.length - 1] === roundedY
                  ) {
                      return null;
                  }

                  const path = [...currentLine];
                  const batch = appendBoundedEraserPoint(path, roundedX, roundedY);
                  set({ currentLine: path });
                  return batch;
              },
              clearCurrentLine: () =>
                  set((s) => (s.currentLine.length === 0 ? s : { currentLine: [] })),
              consumeCurrentLine: () => {
                  const line = get().currentLine;
                  if (line.length > 0) set({ currentLine: [] });
                  return line;
              }
          }));

if (typeof window !== 'undefined') window.__CONTROLLER_STORE__ = useControllerStore;

if (import.meta.hot) {
    import.meta.hot.accept();
    import.meta.hot.dispose((data) => {
        data.controllerState = useControllerStore.getState();
    });
    if (import.meta.hot.data.controllerState) {
        try {
            useControllerStore.setState(import.meta.hot.data.controllerState);
        } catch (e) {
            console.error('[HMR]: Failed to rehydrate controller store:', e);
        }
    }
}
