/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" serves the API from MSW fixtures in the browser (no backend needed). */
  readonly VITE_MOCK_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
