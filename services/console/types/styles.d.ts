// Typecheck a fresh checkout before Next generates next-env.d.ts during a build.
// Global styles are loaded for their side effects; CSS module typing stays with Next.
declare module "*.css";
