// api/_bundle/mcp-core.mjs（vite.mcp.config.ts が src/mcp/node.ts を束ねたもの）の型。tsconfig の paths で #mcp-node → src/mcp/node.ts
declare module '*/_bundle/mcp-core.mjs' {
  export * from '#mcp-node';
}
