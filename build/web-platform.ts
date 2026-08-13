/**
 * Exact DSH module-table identities used by this Client.
 *
 * The official frozen platform table at the audited source HEAD additionally
 * seeds `@deepseek-ai/dsh-client-ui-attachment` and
 * `@deepseek-ai/dsh-client-schema-form`; the Task 1 client uses only the
 * identities below, so this list is deliberately the exact subset the bundle
 * externalizes (see compatibility/ecosystem-audit.md).
 */
export const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const
