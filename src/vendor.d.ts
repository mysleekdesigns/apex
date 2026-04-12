/**
 * Type declarations for optional dependencies.
 *
 * @huggingface/transformers is dynamically imported and may not be installed.
 * This declaration prevents TypeScript errors on the dynamic import() call.
 */
declare module '@huggingface/transformers' {
  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ): Promise<any>;
}
