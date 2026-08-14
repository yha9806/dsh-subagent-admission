/**
 * Analysis-only declaration bridge for external plugins.
 *
 * rc.6's Typert analyzer recognizes protocol symbols declared by the official
 * workspace package or inside this exact ambient module. An independently
 * installed plugin sees the protocol in node_modules, which is outside that
 * workspace registration inventory. The Host tsconfig maps type analysis to
 * this declaration while emitted JavaScript keeps the unchanged official
 * `@deepseek-ai/dsh-typert-protocol` import.
 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  import { Service, type Context } from '@deepseek-ai/cordis'

  export interface TypertGatewayBindingOptions {
    readonly namespace?: string
  }

  export abstract class TypertRemoteService<out T = never> extends Service<T> {
    protected constructor(
      ctx: Context,
      serviceKey: string,
      options?: TypertGatewayBindingOptions,
    )
  }

  type RemoteMethodDecorator = <
    This extends object,
    Args extends unknown[],
    Result,
  >(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<
      This,
      (this: This, ...args: Args) => Result
    >,
  ) => void

  export function Remote<
    This extends object,
    Args extends unknown[],
    Result,
  >(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<
      This,
      (this: This, ...args: Args) => Result
    >,
  ): void

  export function Remote(exportName: string): RemoteMethodDecorator
}
